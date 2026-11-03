export interface RoomFile {
  name: string;
  size: number;
  content: string;
  type: string;
}

export interface RoomData {
  id: string;
  name: string;
  code: string;
  linkedPin: string;
  isRunning: boolean;
  fontSize: number;
  files: RoomFile[];
  libraries: string[];
  updatedAt: number;
}

const DB_NAME = 'com.orzukod.code.db';
const DB_VERSION = 1;
const STORE_SETTINGS = 'settings';
const STORE_ROOMS = 'rooms';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS);
      }
      if (!db.objectStoreNames.contains(STORE_ROOMS)) {
        db.createObjectStore(STORE_ROOMS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveWallpaperToDB(dataUrl: string | null): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SETTINGS, 'readwrite');
    const store = tx.objectStore(STORE_SETTINGS);
    if (dataUrl === null) {
      store.delete('wallpaper');
    } else {
      store.put(dataUrl, 'wallpaper');
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadWallpaperFromDB(): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SETTINGS, 'readonly');
    const store = tx.objectStore(STORE_SETTINGS);
    const req = store.get('wallpaper');
    req.onsuccess = () => resolve((req.result as string) || null);
    req.onerror = () => reject(req.error);
  });
}

export async function loadAllRoomsFromDB(): Promise<RoomData[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ROOMS, 'readonly');
    const store = tx.objectStore(STORE_ROOMS);
    const req = store.getAll();
    req.onsuccess = () => {
      const list = (req.result as RoomData[]) || [];
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveRoomToDB(room: RoomData): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ROOMS, 'readwrite');
    const store = tx.objectStore(STORE_ROOMS);
    store.put(room);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteRoomFromDB(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ROOMS, 'readwrite');
    const store = tx.objectStore(STORE_ROOMS);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
