/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  RoomData,
  RoomFile,
  loadWallpaperFromDB,
  saveWallpaperToDB,
  loadAllRoomsFromDB,
  saveRoomToDB,
  deleteRoomFromDB,
} from './storage';
import { sanitizeMobileCode } from './cleanPaste';

interface MqttClient {
  on: (event: string, cb: (...args: any[]) => void) => void;
  subscribe: (topic: string | string[], opts?: any, cb?: (err?: any) => void) => void;
  publish: (topic: string, message: string, opts?: any, cb?: (err?: any) => void) => void;
  end: (force?: boolean) => void;
  connected?: boolean;
}

declare global {
  interface Window {
    mqtt?: {
      connect: (url: string, opts?: Record<string, any>) => MqttClient;
    };
  }
}

const MASTER_NAMESPACE = 'OrzuTest_Uz2010';
const PRIMARY_BROKER = 'wss://broker.emqx.io:8084/mqtt';
const FALLBACK_BROKER = 'wss://broker.hivemq.com:8884/mqtt';

function buildBroadcastHtml(rawCode: string, libraries: string[]): string {
  const libTags = libraries
    .map((pkg) => {
      if (pkg.startsWith('http://') || pkg.startsWith('https://')) {
        return `<script src="${pkg}"></script>`;
      }
      return `<script type="module">import * as _pkg from "https://esm.sh/${pkg}"; window["${pkg.replace(/[^a-zA-Z0-9_$]/g, '_')}"] = _pkg;</script><script src="https://cdn.jsdelivr.net/npm/${pkg}"></script>`;
    })
    .join('\n');

  const trimmed = rawCode.trim();
  if (!trimmed) {
    return `<!doctype html><html><head><meta charset="utf-8">${libTags}</head><body></body></html>`;
  }

  const looksLikeHtml =
    /<!doctype\s+html/i.test(trimmed) ||
    /<html[\s>]/i.test(trimmed) ||
    /<head[\s>]/i.test(trimmed) ||
    /<body[\s>]/i.test(trimmed) ||
    /<div[\s>]/i.test(trimmed) ||
    /<style[\s>]/i.test(trimmed) ||
    /<script[\s>]/i.test(trimmed) ||
    /<canvas[\s>]/i.test(trimmed);

  if (looksLikeHtml) {
    if (libTags && /<\/head>/i.test(trimmed)) {
      return trimmed.replace(/<\/head>/i, `${libTags}\n</head>`);
    }
    return `${libTags}\n${trimmed}`;
  }

  return `<!doctype html>
<html lang="uz">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
${libTags}
</head>
<body style="margin:0;background:#090d16;color:#fff;font-family:sans-serif;">
<div id="app"></div>
<script>
${rawCode}
</script>
</body>
</html>`;
}

function extractWorkerScript(rawCode: string): string {
  const trimmed = rawCode.trim();
  if (!trimmed) return '';

  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  const scripts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(trimmed)) !== null) {
    if (match[1] && match[1].trim()) {
      scripts.push(match[1].trim());
    }
  }

  if (scripts.length > 0) {
    return scripts.join('\n;\n');
  }

  const looksLikeHtml = /^\s*</.test(trimmed);
  if (!looksLikeHtml) {
    return trimmed;
  }
  return '';
}

export default function App() {
  const [wallpaper, setWallpaper] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomData[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [storageOpen, setStorageOpen] = useState<boolean>(false);

  // Room creation modal state
  const [newRoomModalOpen, setNewRoomModalOpen] = useState<boolean>(false);
  const [newRoomName, setNewRoomName] = useState<string>('');

  // Connection & File Modal state
  const [connectionModalOpen, setConnectionModalOpen] = useState<boolean>(false);
  const [mqttStatus, setMqttStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [detectedPins, setDetectedPins] = useState<string[]>([]);
  const [pinInput, setPinInput] = useState<string>('');
  const [pinLockMessage, setPinLockMessage] = useState<string>('');
  const [npmInput, setNpmInput] = useState<string>('');
  const [statusToast, setStatusToast] = useState<string>('');

  // Gemini AI Modal state
  const [geminiModalOpen, setGeminiModalOpen] = useState<boolean>(false);
  const [geminiPrompt, setGeminiPrompt] = useState<string>('');
  const [geminiLoading, setGeminiLoading] = useState<boolean>(false);
  const [geminiError, setGeminiError] = useState<string>('');
  const [geminiResultCode, setGeminiResultCode] = useState<string>('');
  const [geminiResultText, setGeminiResultText] = useState<string>('');

  // Fallback manual paste modal if clipboard API is denied in iframe
  const [pasteFallbackOpen, setPasteFallbackOpen] = useState<boolean>(false);
  const [pasteFallbackText, setPasteFallbackText] = useState<string>('');

  // Refs
  const wallpaperInputRef = useRef<HTMLInputElement | null>(null);
  const fileUploadInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lineNumbersRef = useRef<HTMLDivElement | null>(null);
  const mqttClientRef = useRef<MqttClient | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const activeRoom = useMemo(
    () => rooms.find((r) => r.id === activeRoomId) || null,
    [rooms, activeRoomId]
  );

  const showToast = useCallback((msg: string) => {
    setStatusToast(msg);
    window.setTimeout(() => {
      setStatusToast((prev) => (prev === msg ? '' : prev));
    }, 2600);
  }, []);

  // Load wallpaper and rooms from IndexedDB on startup
  useEffect(() => {
    loadWallpaperFromDB()
      .then((wp) => {
        if (wp) setWallpaper(wp);
      })
      .catch(() => {});

    loadAllRoomsFromDB()
      .then((loaded) => {
        const resetRunning = loaded.map((r) => ({ ...r, isRunning: false }));
        setRooms(resetRunning);
      })
      .catch(() => {});
  }, []);

  // Cleanup worker & MQTT on unmount
  useEffect(() => {
    return () => {
      if (heartbeatIntervalRef.current) {
        window.clearInterval(heartbeatIntervalRef.current);
      }
      if (workerRef.current) {
        workerRef.current.terminate();
      }
      if (mqttClientRef.current) {
        mqttClientRef.current.end(true);
      }
    };
  }, []);

  // Sync pinInput when switching rooms
  useEffect(() => {
    if (activeRoom) {
      setPinInput(activeRoom.linkedPin || '');
      if (activeRoom.linkedPin) {
        setPinLockMessage(`🟢 Xona #${activeRoom.linkedPin} bilan ulandi!`);
      } else {
        setPinLockMessage('');
      }
    }
  }, [activeRoomId]);

  const updateRoom = useCallback(async (updated: RoomData) => {
    setRooms((prev) =>
      prev.map((r) => (r.id === updated.id ? updated : r))
    );
    try {
      await saveRoomToDB(updated);
    } catch {
      // Ignore IndexedDB quota error
    }
  }, []);

  // Calculate dynamic storage usage
  const storageStats = useMemo(() => {
    let bytes = 0;
    for (const r of rooms) {
      bytes += new Blob([r.code || '']).size;
      for (const f of r.files || []) {
        bytes += f.size || new Blob([f.content || '']).size;
      }
    }
    if (wallpaper) {
      bytes += wallpaper.length;
    }
    const dynamicMb = +(bytes / (1024 * 1024)).toFixed(2);
    return {
      headerUsedMb: dynamicMb > 0 ? dynamicMb : 0,
      internalUsedMb: 700,
      internalTotalGb: 1,
      externalUsedGb: 3,
      externalTotalGb: 4,
    };
  }, [rooms, wallpaper]);

  // Wallpaper picker handler
  const handlePickWallpaper = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const result = reader.result as string;
      setWallpaper(result);
      await saveWallpaperToDB(result);
      showToast('🖼️ Fon saqlandi');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // Create new room
  const handleCreateRoom = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmedName = newRoomName.trim() || `Xona-${rooms.length + 1}`;
    const newRoom: RoomData = {
      id: `room_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: trimmedName,
      code: '',
      linkedPin: '',
      isRunning: false,
      fontSize: 14,
      files: [],
      libraries: [],
      updatedAt: Date.now(),
    };
    const nextRooms = [newRoom, ...rooms];
    setRooms(nextRooms);
    await saveRoomToDB(newRoom);
    setNewRoomName('');
    setNewRoomModalOpen(false);
    setActiveRoomId(newRoom.id);
  };

  const handleDeleteRoom = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRooms((prev) => prev.filter((r) => r.id !== id));
    await deleteRoomFromDB(id);
    if (activeRoomId === id) {
      setActiveRoomId(null);
    }
  };

  // Connect to MQTT Broker (EMQX with HiveMQ fallback)
  const connectMqttBroker = useCallback(
    (onConnectedCallback?: (client: MqttClient) => void) => {
      if (!window.mqtt) {
        showToast("🔴 MQTT yuklanmadi");
        setMqttStatus('disconnected');
        return;
      }

      if (mqttClientRef.current && mqttStatus === 'connected') {
        mqttClientRef.current.subscribe(`${MASTER_NAMESPACE}/rooms/+`, { qos: 1 });
        mqttClientRef.current.subscribe(`${MASTER_NAMESPACE}/stream/+`, { qos: 1 });
        if (onConnectedCallback) onConnectedCallback(mqttClientRef.current);
        return;
      }

      if (mqttClientRef.current) {
        try {
          mqttClientRef.current.end(true);
        } catch {}
        mqttClientRef.current = null;
      }

      setMqttStatus('connecting');

      const connectWithUrl = (url: string, isFallback: boolean) => {
        const clientId = `OrzuKod_${Math.random().toString(16).slice(2, 10)}`;
        const client = window.mqtt!.connect(url, {
          clientId,
          clean: true,
          connectTimeout: 4000,
          reconnectPeriod: 3000,
        });

        mqttClientRef.current = client;

        let settled = false;
        const fallbackTimer = window.setTimeout(() => {
          if (!settled && !isFallback) {
            settled = true;
            try {
              client.end(true);
            } catch {}
            connectWithUrl(FALLBACK_BROKER, true);
          }
        }, 3800);

        client.on('connect', () => {
          settled = true;
          window.clearTimeout(fallbackTimer);
          setMqttStatus('connected');

          client.subscribe(
            [
              `${MASTER_NAMESPACE}/rooms/+`,
              `${MASTER_NAMESPACE}/active/+`,
              `${MASTER_NAMESPACE}/stream/+`,
            ],
            { qos: 1 }
          );

          if (onConnectedCallback) {
            onConnectedCallback(client);
          }
        });

        client.on('message', (topic: string, payloadBuffer: any) => {
          const parts = topic.split('/');
          const maybePin = parts[parts.length - 1];
          if (/^\d{4}$/.test(maybePin)) {
            let textPayload = '';
            try {
              textPayload = payloadBuffer ? payloadBuffer.toString() : '';
            } catch {}

            if (textPayload) {
              try {
                const parsed = JSON.parse(textPayload);
                if (parsed && (parsed.status === 'OFFLINE' || parsed.closed === true)) {
                  setDetectedPins((prev) => prev.filter((p) => p !== maybePin));
                  return;
                }
              } catch {}
            }

            setDetectedPins((prev) =>
              prev.includes(maybePin) ? prev : [maybePin, ...prev]
            );
          }
        });

        client.on('error', () => {
          window.clearTimeout(fallbackTimer);
          if (!settled && !isFallback) {
            settled = true;
            try {
              client.end(true);
            } catch {}
            connectWithUrl(FALLBACK_BROKER, true);
          } else if (isFallback) {
            setMqttStatus('disconnected');
          }
        });

        client.on('close', () => {
          if (settled) {
            setMqttStatus('disconnected');
          }
        });
      };

      connectWithUrl(PRIMARY_BROKER, false);
    },
    [mqttStatus, showToast]
  );

  // Verify and lock 4-digit PIN to room
  const handleSendPin = async () => {
    if (!activeRoom) return;
    const cleanPin = pinInput.replace(/\D/g, '').slice(0, 4);
    if (cleanPin.length !== 4) {
      setPinLockMessage('🔴 4-xonali kod kiriting!');
      return;
    }

    const updated: RoomData = {
      ...activeRoom,
      linkedPin: cleanPin,
      updatedAt: Date.now(),
    };
    await updateRoom(updated);
    setPinInput(cleanPin);
    setPinLockMessage(`🟢 Xona #${cleanPin} bilan ulandi!`);

    const publishLink = (client: MqttClient) => {
      client.publish(
        `${MASTER_NAMESPACE}/rooms/${cleanPin}`,
        JSON.stringify({
          type: 'LINKED',
          pin: cleanPin,
          roomName: updated.name,
          timestamp: Date.now(),
        }),
        { retain: true, qos: 1 }
      );
      setDetectedPins((prev) => (prev.includes(cleanPin) ? prev : [cleanPin, ...prev]));
    };

    if (mqttClientRef.current && mqttStatus === 'connected') {
      publishLink(mqttClientRef.current);
    } else {
      connectMqttBroker((client) => publishLink(client));
    }
  };

  // Start background Web Worker for JS / Telegram Bot execution
  const startBackgroundWorker = useCallback((rawCode: string) => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }

    const jsToRun = extractWorkerScript(rawCode);
    if (!jsToRun) return;

    const workerBootstrap = `
      self.window = self;
      self.document = {
        getElementById: () => ({ innerHTML: '', style: {}, addEventListener: () => {} }),
        querySelector: () => ({ innerHTML: '', style: {}, addEventListener: () => {} }),
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, appendChild: () => {}, setAttribute: () => {} }),
        body: { style: {}, appendChild: () => {} },
        addEventListener: () => {}
      };
      try {
        ${jsToRun}
      } catch (err) {
        self.postMessage({ type: 'ERROR', error: err && err.message ? err.message : String(err) });
      }
    `;

    try {
      const blob = new Blob([workerBootstrap], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      workerRef.current = worker;
      URL.revokeObjectURL(url);
    } catch {
      // Ignore worker syntax error if DOM-heavy script
    }
  }, []);

  // [ 🚀 Ishga Tushirish ] handler
  const handleStartServer = async () => {
    if (!activeRoom) return;

    const updated: RoomData = {
      ...activeRoom,
      isRunning: true,
      updatedAt: Date.now(),
    };
    await updateRoom(updated);

    const finalHtml = buildBroadcastHtml(updated.code, updated.libraries || []);

    // Run JS/Telegram bot in background worker simultaneously
    startBackgroundWorker(updated.code);

    const publishStartAndHeartbeat = (client: MqttClient) => {
      const targetPin = updated.linkedPin;
      if (targetPin) {
        const startPayload = JSON.stringify({
          type: 'START',
          html: finalHtml,
          timestamp: Date.now(),
        });
        client.publish(`${MASTER_NAMESPACE}/stream/${targetPin}`, startPayload, {
          retain: true,
          qos: 1,
        });
      }

      if (heartbeatIntervalRef.current) {
        window.clearInterval(heartbeatIntervalRef.current);
      }

      heartbeatIntervalRef.current = window.setInterval(() => {
        if (mqttClientRef.current && targetPin) {
          mqttClientRef.current.publish(
            `${MASTER_NAMESPACE}/heartbeat/${targetPin}`,
            JSON.stringify({
              type: 'HEARTBEAT',
              pin: targetPin,
              timestamp: Date.now(),
            }),
            { retain: false, qos: 0 }
          );
        }
      }, 2000);
    };

    if (mqttClientRef.current && mqttStatus === 'connected') {
      publishStartAndHeartbeat(mqttClientRef.current);
      showToast(
        updated.linkedPin
          ? `🚀 #${updated.linkedPin} serverda ishga tushdi!`
          : '🚀 Ishga tushirildi!'
      );
    } else {
      connectMqttBroker((client) => {
        publishStartAndHeartbeat(client);
        showToast(
          updated.linkedPin
            ? `🚀 #${updated.linkedPin} serverda ishga tushdi!`
            : '🚀 Ishga tushirildi!'
        );
      });
    }
  };

  // [ 🛑 To'xtatish ] handler — STOP SERVER = STOP SITE
  const handleStopServer = async () => {
    if (!activeRoom) return;

    if (heartbeatIntervalRef.current) {
      window.clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }

    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }

    const updated: RoomData = {
      ...activeRoom,
      isRunning: false,
      updatedAt: Date.now(),
    };
    await updateRoom(updated);

    const targetPin = updated.linkedPin;
    const sendStopPacket = (client: MqttClient) => {
      if (targetPin) {
        client.publish(
          `${MASTER_NAMESPACE}/stream/${targetPin}`,
          JSON.stringify({
            type: 'STOP',
            timestamp: Date.now(),
          }),
          { retain: true, qos: 1 }
        );
      }
    };

    if (mqttClientRef.current && mqttStatus === 'connected') {
      sendStopPacket(mqttClientRef.current);
      showToast('🛑 Server va sayt to‘xtatildi!');
    } else if (targetPin) {
      connectMqttBroker((client) => {
        sendStopPacket(client);
        showToast('🛑 Server va sayt to‘xtatildi!');
      });
    } else {
      showToast('🛑 To‘xtatildi!');
    }
  };

  // [ 🪄 Toza Qo'yish ] handler
  const insertSanitizedText = async (rawText: string) => {
    if (!activeRoom) return;
    const clean = sanitizeMobileCode(rawText);
    const el = textareaRef.current;

    let nextCode = clean;
    let nextCursor = clean.length;

    if (el) {
      const start = el.selectionStart ?? activeRoom.code.length;
      const end = el.selectionEnd ?? activeRoom.code.length;
      const before = activeRoom.code.slice(0, start);
      const after = activeRoom.code.slice(end);
      nextCode = before + clean + after;
      nextCursor = start + clean.length;
    } else {
      nextCode = activeRoom.code ? `${activeRoom.code}\n${clean}` : clean;
      nextCursor = nextCode.length;
    }

    const updated: RoomData = {
      ...activeRoom,
      code: nextCode,
      updatedAt: Date.now(),
    };
    await updateRoom(updated);

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextCursor, nextCursor);
      }
    });

    showToast("🪄 Toza kod qo'yildi!");
  };

  const handleCleanPaste = async () => {
    if (!activeRoom) return;
    try {
      const clipText = await navigator.clipboard.readText();
      if (clipText) {
        await insertSanitizedText(clipText);
      } else {
        setPasteFallbackText('');
        setPasteFallbackOpen(true);
      }
    } catch {
      setPasteFallbackText('');
      setPasteFallbackOpen(true);
    }
  };

  // Synchronized scroll between textarea and line numbers
  const handleEditorScroll = () => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Editor Tab key handling
  const handleEditorKeyDown = async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' && activeRoom) {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const nextCode =
        activeRoom.code.substring(0, start) + '  ' + activeRoom.code.substring(end);
      await updateRoom({
        ...activeRoom,
        code: nextCode,
        updatedAt: Date.now(),
      });
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 2;
      });
    }
  };

  // Font Zoom Controls [ A- ] [ A+ ] & 2-Finger Pinch-to-Zoom
  const pinchStartDistRef = useRef<number | null>(null);
  const pinchStartFontSizeRef = useRef<number>(14);

  const handleFontDelta = async (delta: number) => {
    if (!activeRoom) return;
    const nextSize = Math.min(32, Math.max(10, (activeRoom.fontSize || 14) + delta));
    await updateRoom({
      ...activeRoom,
      fontSize: nextSize,
      updatedAt: Date.now(),
    });
  };

  const handleEditorTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && activeRoom) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStartDistRef.current = Math.hypot(dx, dy);
      pinchStartFontSizeRef.current = activeRoom.fontSize || 14;
    }
  };

  const handleEditorTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && pinchStartDistRef.current && activeRoom) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDist = Math.hypot(dx, dy);
      if (pinchStartDistRef.current > 0) {
        const scale = currentDist / pinchStartDistRef.current;
        const nextSize = Math.min(
          32,
          Math.max(10, Math.round(pinchStartFontSizeRef.current * scale))
        );
        if (nextSize !== activeRoom.fontSize) {
          updateRoom({
            ...activeRoom,
            fontSize: nextSize,
            updatedAt: Date.now(),
          });
        }
      }
    }
  };

  const handleEditorTouchEnd = () => {
    pinchStartDistRef.current = null;
  };

  // File Upload into Room
  const handleRoomFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !activeRoom) return;

    const file = files[0];
    const reader = new FileReader();
    reader.onload = async () => {
      const content = sanitizeMobileCode(String(reader.result || ''));
      const newFile: RoomFile = {
        name: file.name,
        size: file.size,
        content,
        type: file.type || 'text/plain',
      };
      const updatedFiles = [
        newFile,
        ...(activeRoom.files || []).filter((f) => f.name !== file.name),
      ];
      const updated: RoomData = {
        ...activeRoom,
        code: content,
        files: updatedFiles,
        updatedAt: Date.now(),
      };
      await updateRoom(updated);
      showToast(`📂 ${file.name} yuklandi!`);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // Add NPM Library
  const handleAddNpmLibrary = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeRoom) return;
    const pkg = npmInput.trim();
    if (!pkg) return;
    const currentLibs = activeRoom.libraries || [];
    if (!currentLibs.includes(pkg)) {
      const updated: RoomData = {
        ...activeRoom,
        libraries: [...currentLibs, pkg],
        updatedAt: Date.now(),
      };
      await updateRoom(updated);
    }
    setNpmInput('');
    showToast(`📦 ${pkg} ulandi!`);
  };

  const handleRemoveNpmLibrary = async (pkg: string) => {
    if (!activeRoom) return;
    const updated: RoomData = {
      ...activeRoom,
      libraries: (activeRoom.libraries || []).filter((item) => item !== pkg),
      updatedAt: Date.now(),
    };
    await updateRoom(updated);
  };

  // Gemini AI Handler
  const handleAskGemini = async (mode: 'generate' | 'fix' | 'optimize' = 'generate') => {
    if (!activeRoom) return;
    const query =
      geminiPrompt.trim() ||
      (mode === 'fix'
        ? "Koddagi xatolarni topib to'g'rilab ber"
        : mode === 'optimize'
        ? 'Kodni tezlashtirib va zamonaviy qilib ber'
        : '');
    if (!query) return;

    setGeminiLoading(true);
    setGeminiError('');
    try {
      const res = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: query,
          currentCode: activeRoom.code,
          mode,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setGeminiError(data.error || 'AI xatosi yuz berdi');
      } else {
        setGeminiResultCode(sanitizeMobileCode(data.code || ''));
        setGeminiResultText(data.text || '');
      }
    } catch {
      setGeminiError('Server bilan aloqa xatosi');
    } finally {
      setGeminiLoading(false);
    }
  };

  const lineCount = useMemo(() => {
    if (!activeRoom || !activeRoom.code) return 1;
    return activeRoom.code.split('\n').length;
  }, [activeRoom?.code]);

  const lineNumbersArray = useMemo(() => {
    return Array.from({ length: Math.max(1, lineCount) }, (_, i) => i + 1);
  }, [lineCount]);

  return (
    <div className="relative min-h-dvh w-full overflow-x-hidden flex flex-col select-none">
      {/* Full-Screen Customizable Wallpaper Background */}
      {wallpaper ? (
        <div
          className="fixed inset-0 z-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: `url(${wallpaper})` }}
        />
      ) : (
        <div
          className="fixed inset-0 z-0"
          style={{
            background:
              'radial-gradient(circle at 18% 18%, rgba(14, 165, 233, 0.28) 0%, transparent 45%), radial-gradient(circle at 82% 22%, rgba(59, 130, 246, 0.24) 0%, transparent 50%), radial-gradient(circle at 50% 85%, rgba(16, 185, 129, 0.18) 0%, transparent 55%), linear-gradient(160deg, #060911 0%, #0d1526 52%, #070b14 100%)',
          }}
        />
      )}
      <div className="fixed inset-0 z-0 bg-black/25 pointer-events-none" />

      {/* Hidden File Input for Wallpaper */}
      <input
        ref={wallpaperInputRef}
        type="file"
        accept="image/*"
        onChange={handlePickWallpaper}
        className="hidden"
      />

      {/* Toast Feedback */}
      {statusToast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 ios-glass-strong px-4 py-2 rounded-2xl text-xs text-white shadow-2xl pointer-events-none whitespace-nowrap">
          {statusToast}
        </div>
      )}

      {/* ==================== HOME SCREEN ==================== */}
      {!activeRoom ? (
        <div className="relative z-10 flex-1 flex flex-col max-w-4xl w-full mx-auto px-4 py-4 gap-3.5 spring-view">
          {/* Header: ⚡ OrzuKod + [ 🖼️ Fon ] */}
          <header className="ios-glass rounded-2xl px-4 py-3 flex items-center justify-between shadow-xl">
            <span className="text-lg sm:text-xl tracking-tight text-white whitespace-nowrap">
              ⚡ OrzuKod
            </span>
            <button
              type="button"
              onClick={() => wallpaperInputRef.current?.click()}
              className="spring-btn ios-glass px-3.5 py-2 rounded-xl text-xs sm:text-sm text-white hover:bg-white/15 active:scale-95 whitespace-nowrap cursor-pointer"
            >
              [ 🖼️ Fon ]
            </button>
          </header>

          {/* Collapsible Storage Bar (CLOSED by default) */}
          <div className="ios-glass rounded-2xl overflow-hidden shadow-xl">
            <button
              type="button"
              onClick={() => setStorageOpen((prev) => !prev)}
              className="spring-btn w-full px-4 py-3 flex items-center justify-between text-left text-xs sm:text-sm text-sky-100 hover:bg-white/5 cursor-pointer"
            >
              <span className="truncate">
                [ 💎 Xotira Holati ({storageStats.headerUsedMb} MB / 1 GB) {storageOpen ? '▴' : '▾'} ]
              </span>
            </button>

            {storageOpen && (
              <div className="px-4 pb-4 pt-1 border-t border-white/15 flex flex-col gap-3 text-xs">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-slate-200">
                    <span>com.orzukod.code</span>
                    <span>
                      {storageStats.internalUsedMb} MB / {storageStats.internalTotalGb} GB
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-sky-400 rounded-full"
                      style={{ width: '70%' }}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-slate-200">
                    <span>Media Xotira</span>
                    <span>
                      {storageStats.externalUsedGb} GB / {storageStats.externalTotalGb} GB
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-emerald-400 rounded-full"
                      style={{ width: '75%' }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* [ ➕ Yangi Xona Ochish ] Button */}
          <button
            type="button"
            onClick={() => {
              setNewRoomName(`Xona ${rooms.length + 1}`);
              setNewRoomModalOpen(true);
            }}
            className="spring-btn ios-glass w-full py-3.5 px-4 rounded-2xl text-sm sm:text-base text-white hover:bg-white/15 shadow-xl text-center cursor-pointer"
          >
            [ ➕ Yangi Xona Ochish ]
          </button>

          {/* List of Created Rooms (NO extra text or instructions) */}
          {rooms.length > 0 && (
            <div className="flex flex-col gap-2.5 pb-6">
              {rooms.map((room) => (
                <div
                  key={room.id}
                  onClick={() => setActiveRoomId(room.id)}
                  className="spring-btn ios-glass rounded-2xl px-4 py-3.5 flex items-center justify-between gap-3 cursor-pointer hover:bg-white/10 shadow-lg"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm sm:text-base text-white truncate">
                      {room.name}
                    </span>
                    <span className="text-xs text-slate-300 whitespace-nowrap">
                      {room.linkedPin ? `🟢 #${room.linkedPin}` : '⚪ Ulanmagan'}
                    </span>
                    {room.isRunning && (
                      <span className="text-xs text-emerald-300 whitespace-nowrap">
                        · 🚀 Ishlamoqda
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={(e) => handleDeleteRoom(room.id, e)}
                    className="spring-btn ios-glass px-2.5 py-1.5 rounded-xl text-xs text-rose-300 hover:bg-rose-500/20 shrink-0 cursor-pointer"
                  >
                    [ 🗑️ O'chirish ]
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* ==================== ROOM VIEW ==================== */
        <div className="relative z-10 flex-1 flex flex-col h-dvh w-full max-w-6xl mx-auto px-2.5 sm:px-4 py-2.5 gap-2 spring-view">
          {/* Room Top Bar */}
          <header className="ios-glass rounded-2xl px-2.5 sm:px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 shadow-xl shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={() => setActiveRoomId(null)}
                className="spring-btn ios-glass px-2.5 py-1.5 rounded-xl text-xs text-white hover:bg-white/15 whitespace-nowrap cursor-pointer"
              >
                [ 🔙 Orqaga ]
              </button>

              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs sm:text-sm text-white truncate max-w-[110px] sm:max-w-[200px]">
                  {activeRoom.name}
                </span>
                <span className="text-[11px] sm:text-xs text-slate-200 whitespace-nowrap">
                  {activeRoom.linkedPin
                    ? `🟢 Ulangan: #${activeRoom.linkedPin}`
                    : '⚪ Ulanmagan'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => handleFontDelta(-2)}
                className="spring-btn ios-glass px-2.5 py-1.5 rounded-xl text-xs text-white hover:bg-white/15 whitespace-nowrap cursor-pointer"
              >
                [ A- ]
              </button>
              <button
                type="button"
                onClick={() => handleFontDelta(2)}
                className="spring-btn ios-glass px-2.5 py-1.5 rounded-xl text-xs text-white hover:bg-white/15 whitespace-nowrap cursor-pointer"
              >
                [ A+ ]
              </button>
              <button
                type="button"
                onClick={() => setConnectionModalOpen(true)}
                className="spring-btn ios-glass px-2.5 py-1.5 rounded-xl text-xs text-sky-200 hover:bg-white/15 whitespace-nowrap cursor-pointer"
              >
                [ 🔗 Aloqa va Fayl ]
              </button>
            </div>
          </header>

          {/* Room Action Bar */}
          <div className="ios-glass rounded-2xl px-2.5 py-2 grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-2 shadow-xl shrink-0">
            <button
              type="button"
              onClick={handleStartServer}
              className={`spring-btn ios-glass py-2 px-2.5 rounded-xl text-xs sm:text-sm text-center whitespace-nowrap cursor-pointer ${
                activeRoom.isRunning
                  ? 'bg-emerald-500/35 border-emerald-400/50 text-emerald-100'
                  : 'text-emerald-200 hover:bg-emerald-500/20'
              }`}
            >
              [ 🚀 Ishga Tushirish ]
            </button>

            <button
              type="button"
              onClick={handleStopServer}
              className="spring-btn ios-glass py-2 px-2.5 rounded-xl text-xs sm:text-sm text-rose-200 hover:bg-rose-500/25 text-center whitespace-nowrap cursor-pointer"
            >
              [ 🛑 To'xtatish ]
            </button>

            <button
              type="button"
              onClick={handleCleanPaste}
              className="spring-btn ios-glass py-2 px-2.5 rounded-xl text-xs sm:text-sm text-amber-200 hover:bg-amber-500/20 text-center whitespace-nowrap cursor-pointer"
            >
              [ 🪄 Toza Qo'yish ]
            </button>

            <button
              type="button"
              onClick={() => {
                setGeminiError('');
                setGeminiModalOpen(true);
              }}
              className="spring-btn ios-glass py-2 px-2.5 rounded-xl text-xs sm:text-sm text-purple-200 hover:bg-purple-500/20 text-center whitespace-nowrap cursor-pointer"
            >
              [ 🧠 Gemini AI ]
            </button>
          </div>

          {/* Anti-Corruption Synchronized Code Editor */}
          <div
            onTouchStart={handleEditorTouchStart}
            onTouchMove={handleEditorTouchMove}
            onTouchEnd={handleEditorTouchEnd}
            style={{
              flex: 1,
              height: '100%',
              overflowY: 'auto',
              overflowX: 'auto',
              display: 'flex',
              alignItems: 'stretch',
              position: 'relative',
              WebkitOverflowScrolling: 'touch',
            }}
            className="editor-scroll-container ios-glass rounded-2xl shadow-2xl min-h-0"
          >
            {/* Synchronized Line Numbers */}
            <div
              ref={lineNumbersRef}
              style={{
                fontSize: `${activeRoom.fontSize || 14}px`,
                lineHeight: '1.6',
                minHeight: `${Math.max(
                  (activeRoom.code ? activeRoom.code.split('\n').length : 1) *
                    ((activeRoom.fontSize || 14) * 1.6) +
                    100,
                  600
                )}px`,
              }}
              className="code-editor-font select-none py-3 px-2.5 text-right text-slate-400/80 bg-black/30 border-r border-white/15 shrink-0 min-w-[3rem]"
            >
              {lineNumbersArray.map((num) => (
                <div key={num}>{num}</div>
              ))}
            </div>

            {/* Anti-Corruption Textarea */}
            <textarea
              ref={textareaRef}
              value={activeRoom.code}
              onChange={(e) => {
                const cleaned = sanitizeMobileCode(e.target.value);
                updateRoom({
                  ...activeRoom,
                  code: cleaned,
                  updatedAt: Date.now(),
                });
              }}
              onScroll={handleEditorScroll}
              onKeyDown={handleEditorKeyDown}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              data-gramm="false"
              style={{
                flex: 1,
                width: '100%',
                minHeight: '100%',
                height: `${Math.max(
                  (activeRoom.code ? activeRoom.code.split('\n').length : 1) *
                    ((activeRoom.fontSize || 14) * 1.6) +
                    100,
                  600
                )}px`,
                overflow: 'hidden',
                resize: 'none',
                fontSize: `${activeRoom.fontSize || 14}px`,
                lineHeight: '1.6',
                tabSize: 2,
              }}
              className="code-editor-font p-3 bg-transparent text-slate-100 focus:outline-none whitespace-pre"
            />
          </div>
        </div>
      )}

      {/* ==================== NEW ROOM MODAL ==================== */}
      {newRoomModalOpen && (
        <div
          onClick={() => setNewRoomModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <form
            onSubmit={handleCreateRoom}
            onClick={(e) => e.stopPropagation()}
            className="ios-glass-strong rounded-3xl p-5 w-full max-w-sm flex flex-col gap-3.5 shadow-2xl spring-view"
          >
            <div className="flex items-center justify-between">
              <span className="text-base text-white">➕ Yangi Xona Ochish</span>
              <button
                type="button"
                onClick={() => setNewRoomModalOpen(false)}
                className="spring-btn ios-glass px-2.5 py-1 rounded-xl text-xs text-slate-200 cursor-pointer"
              >
                [ ✖ Yopish ]
              </button>
            </div>

            <input
              type="text"
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder="Xona nomi..."
              autoFocus
              className="ios-glass rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-400 focus:outline-none"
            />

            <button
              type="submit"
              className="spring-btn ios-glass py-2.5 px-4 rounded-xl text-sm text-emerald-200 hover:bg-emerald-500/20 cursor-pointer"
            >
              [ ✅ Yaratish ]
            </button>
          </form>
        </div>
      )}

      {/* ==================== 3-STEP CONNECTION & FILE MODAL ==================== */}
      {connectionModalOpen && activeRoom && (
        <div
          onClick={() => setConnectionModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="ios-glass-strong rounded-3xl p-4 sm:p-5 w-full max-w-lg flex flex-col gap-4 shadow-2xl spring-view my-auto max-h-[92dvh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-white/15 pb-3">
              <span className="text-sm sm:text-base text-white">
                [ 🔗 Aloqa va Fayl ]
              </span>
              <button
                type="button"
                onClick={() => setConnectionModalOpen(false)}
                className="spring-btn ios-glass px-3 py-1 rounded-xl text-xs text-white cursor-pointer"
              >
                [ ✖ Yopish ]
              </button>
            </div>

            {/* Section 1: [ 🔗 OrzuKod bilan Aloqa ] */}
            <div className="ios-glass rounded-2xl p-3.5 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs sm:text-sm text-sky-200">
                  [ 🔗 OrzuKod bilan Aloqa ]
                </span>
                <span className="text-xs whitespace-nowrap">
                  {mqttStatus === 'connected'
                    ? '🟢 Server Bilan Aloqa Bor'
                    : mqttStatus === 'connecting'
                    ? '🟡 Ulanmoqda...'
                    : "🔴 Aloqa Yo'q"}
                </span>
              </div>

              {/* Step 1: [ 📡 OrzuKod Bilan Ulanish ] */}
              <button
                type="button"
                onClick={() => connectMqttBroker()}
                className="spring-btn ios-glass w-full py-2.5 px-3 rounded-xl text-xs sm:text-sm text-white hover:bg-sky-500/25 text-center cursor-pointer"
              >
                [ 📡 OrzuKod Bilan Ulanish ]
              </button>

              {/* Step 2: 4-Xonali Kod Kiritish + Detected Active PIN Chips */}
              <div className="flex flex-col gap-2">
                <label className="text-xs text-slate-200">
                  4-Xonali Kod Kiritish
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  value={pinInput}
                  onChange={(e) =>
                    setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))
                  }
                  placeholder="5380"
                  className="ios-glass rounded-xl px-3.5 py-2.5 text-base tracking-widest text-center text-white placeholder-slate-400 focus:outline-none"
                />

                {detectedPins.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    {detectedPins.map((pin) => (
                      <button
                        key={pin}
                        type="button"
                        onClick={() => setPinInput(pin)}
                        className={`spring-btn px-2.5 py-1 rounded-xl text-xs cursor-pointer ${
                          pinInput === pin
                            ? 'bg-emerald-500/40 border border-emerald-300 text-white'
                            : 'ios-glass text-emerald-200 hover:bg-white/15'
                        }`}
                      >
                        #{pin}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Step 3: [ 🎯 4-Xonalik Kodni Yuborish ] */}
              <button
                type="button"
                onClick={handleSendPin}
                className="spring-btn ios-glass w-full py-2.5 px-3 rounded-xl text-xs sm:text-sm text-emerald-200 hover:bg-emerald-500/25 text-center cursor-pointer"
              >
                [ 🎯 4-Xonalik Kodni Yuborish ]
              </button>

              {pinLockMessage && (
                <div className="text-xs text-center text-emerald-300 pt-0.5">
                  {pinLockMessage}
                </div>
              )}
            </div>

            {/* Section 2: [ 📂 Fayl Yuklash ] */}
            <div className="ios-glass rounded-2xl p-3.5 flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs sm:text-sm text-amber-200">
                  [ 📂 Fayl Yuklash ]
                </span>
                <button
                  type="button"
                  onClick={() => fileUploadInputRef.current?.click()}
                  className="spring-btn ios-glass px-3 py-1.5 rounded-xl text-xs text-white hover:bg-white/15 cursor-pointer"
                >
                  [ 📂 Fayl Yuklash ]
                </button>
              </div>

              <input
                ref={fileUploadInputRef}
                type="file"
                accept=".html,.htm,.js,.ts,.css,.json,.txt,.py,.md"
                onChange={handleRoomFileUpload}
                className="hidden"
              />

              {activeRoom.files && activeRoom.files.length > 0 && (
                <div className="flex flex-col gap-1.5 pt-1">
                  {activeRoom.files.map((f) => (
                    <div
                      key={f.name}
                      onClick={() =>
                        updateRoom({
                          ...activeRoom,
                          code: f.content,
                          updatedAt: Date.now(),
                        })
                      }
                      className="spring-btn ios-glass px-3 py-1.5 rounded-xl flex items-center justify-between text-xs cursor-pointer hover:bg-white/10"
                    >
                      <span className="truncate text-white">{f.name}</span>
                      <span className="text-slate-300 whitespace-nowrap">
                        {(f.size / 1024).toFixed(1)} KB
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Section 3: [ 📦 NPM Kutubxona ] */}
            <div className="ios-glass rounded-2xl p-3.5 flex flex-col gap-2.5">
              <span className="text-xs sm:text-sm text-purple-200">
                [ 📦 NPM Kutubxona ]
              </span>

              <form onSubmit={handleAddNpmLibrary} className="flex gap-2">
                <input
                  type="text"
                  value={npmInput}
                  onChange={(e) => setNpmInput(e.target.value)}
                  placeholder="three, gsap, axios..."
                  className="ios-glass flex-1 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none"
                />
                <button
                  type="submit"
                  className="spring-btn ios-glass px-3 py-2 rounded-xl text-xs text-white hover:bg-purple-500/25 whitespace-nowrap cursor-pointer"
                >
                  [ ➕ Qo'shish ]
                </button>
              </form>

              {activeRoom.libraries && activeRoom.libraries.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {activeRoom.libraries.map((pkg) => (
                    <button
                      key={pkg}
                      type="button"
                      onClick={() => handleRemoveNpmLibrary(pkg)}
                      className="spring-btn ios-glass px-2.5 py-1 rounded-xl text-xs text-purple-200 hover:bg-rose-500/25 cursor-pointer"
                    >
                      📦 {pkg} ✖
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==================== GEMINI AI MODAL ==================== */}
      {geminiModalOpen && activeRoom && (
        <div
          onClick={() => setGeminiModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="ios-glass-strong rounded-3xl p-4 sm:p-5 w-full max-w-lg flex flex-col gap-3.5 shadow-2xl spring-view my-auto max-h-[92dvh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-white/15 pb-2.5">
              <span className="text-sm sm:text-base text-purple-200">
                [ 🧠 Gemini AI ]
              </span>
              <button
                type="button"
                onClick={() => setGeminiModalOpen(false)}
                className="spring-btn ios-glass px-3 py-1 rounded-xl text-xs text-white cursor-pointer"
              >
                [ ✖ Yopish ]
              </button>
            </div>

            <textarea
              value={geminiPrompt}
              onChange={(e) => setGeminiPrompt(e.target.value)}
              rows={3}
              placeholder="Qanday kod yoki veb-ilova yozib beray?"
              className="ios-glass rounded-2xl p-3 text-xs sm:text-sm text-white placeholder-slate-400 focus:outline-none resize-none"
            />

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={geminiLoading}
                onClick={() => handleAskGemini('generate')}
                className="spring-btn ios-glass py-2 px-2 rounded-xl text-xs text-purple-200 hover:bg-purple-500/25 cursor-pointer disabled:opacity-50"
              >
                [ ⚡ Kod Yaratish ]
              </button>
              <button
                type="button"
                disabled={geminiLoading}
                onClick={() => handleAskGemini('fix')}
                className="spring-btn ios-glass py-2 px-2 rounded-xl text-xs text-amber-200 hover:bg-amber-500/25 cursor-pointer disabled:opacity-50"
              >
                [ 🛠️ Xatoni Tuzatish ]
              </button>
              <button
                type="button"
                disabled={geminiLoading}
                onClick={() => handleAskGemini('optimize')}
                className="spring-btn ios-glass py-2 px-2 rounded-xl text-xs text-sky-200 hover:bg-sky-500/25 cursor-pointer disabled:opacity-50"
              >
                [ 🚀 Kuchaytirish ]
              </button>
            </div>

            {geminiLoading && (
              <div className="text-xs text-center text-purple-200 py-2">
                🧠 Gemini AI kod tayyorlamoqda...
              </div>
            )}

            {geminiError && (
              <div className="text-xs text-rose-300 ios-glass p-2.5 rounded-xl">
                🔴 {geminiError}
              </div>
            )}

            {(geminiResultCode || geminiResultText) && (
              <div className="flex flex-col gap-2 pt-1">
                <pre className="code-editor-font ios-glass rounded-xl p-3 text-xs text-slate-100 max-h-52 overflow-auto whitespace-pre-wrap">
                  {geminiResultCode || geminiResultText}
                </pre>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const codeToUse = sanitizeMobileCode(
                        geminiResultCode || geminiResultText
                      );
                      await updateRoom({
                        ...activeRoom,
                        code: codeToUse,
                        updatedAt: Date.now(),
                      });
                      setGeminiModalOpen(false);
                      showToast("🧠 AI kodi o'rnatildi!");
                    }}
                    className="spring-btn ios-glass py-2 px-3 rounded-xl text-xs text-emerald-200 hover:bg-emerald-500/25 cursor-pointer"
                  >
                    [ 🔄 Kodni Almashtirish ]
                  </button>

                  <button
                    type="button"
                    onClick={async () => {
                      const codeToUse = sanitizeMobileCode(
                        geminiResultCode || geminiResultText
                      );
                      await insertSanitizedText(codeToUse);
                      setGeminiModalOpen(false);
                    }}
                    className="spring-btn ios-glass py-2 px-3 rounded-xl text-xs text-sky-200 hover:bg-sky-500/25 cursor-pointer"
                  >
                    [ 📥 Davomiga Qo'shish ]
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================== CLEAN PASTE FALLBACK MODAL ==================== */}
      {pasteFallbackOpen && activeRoom && (
        <div
          onClick={() => setPasteFallbackOpen(false)}
          className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="ios-glass-strong rounded-3xl p-4 w-full max-w-md flex flex-col gap-3 shadow-2xl spring-view"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm text-amber-200">[ 🪄 Toza Qo'yish ]</span>
              <button
                type="button"
                onClick={() => setPasteFallbackOpen(false)}
                className="spring-btn ios-glass px-2.5 py-1 rounded-xl text-xs text-white cursor-pointer"
              >
                [ ✖ Yopish ]
              </button>
            </div>

            <textarea
              value={pasteFallbackText}
              onChange={(e) => setPasteFallbackText(e.target.value)}
              rows={5}
              autoFocus
              placeholder="Kodni shu yerga joylang..."
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              className="code-editor-font ios-glass rounded-xl p-3 text-xs text-white placeholder-slate-400 focus:outline-none resize-none"
            />

            <button
              type="button"
              onClick={async () => {
                await insertSanitizedText(pasteFallbackText);
                setPasteFallbackOpen(false);
                setPasteFallbackText('');
              }}
              className="spring-btn ios-glass py-2.5 px-4 rounded-xl text-xs text-emerald-200 hover:bg-emerald-500/25 cursor-pointer"
            >
              [ 🪄 Toza Qo'yish ]
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
