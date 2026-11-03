import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '15mb' }));

  app.post('/api/gemini', async (req, res) => {
    try {
      const { prompt, currentCode, mode } = req.body as {
        prompt?: string;
        currentCode?: string;
        mode?: 'generate' | 'fix' | 'optimize';
      };

      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: "So'rov matni kiritilmadi." });
        return;
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        res.status(500).json({
          error: "GEMINI_API_KEY topilmadi. Settings > Secrets bo'limidan kalitni tekshiring.",
        });
        return;
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const systemInstruction = `Sen OrzuKod kod dvigatelining ichki sun'iy intellekt dasturchisisan.
Barcha javob va izohlarni faqat O'ZBEK tilida yoz.
Agar foydalanuvchi veb-ilova, o'yin, HTML/CSS/JS yoki Telegram bot so'rasa, to'liq ishlaydigan, yagona faylli (HTML ichida CSS va JS bilan yoki sof JS) toza kod qaytar.
Kodni \`\`\`html yoki \`\`\`javascript bloki ichida ber. Ortiqcha uzun nazariy matn yozma.`;

      const fullPrompt = currentCode && currentCode.trim().length > 0
        ? `Joriy muharrir kodi:\n\`\`\`\n${currentCode}\n\`\`\`\n\nRejim: ${mode || 'generate'}\nFoydalanuvchi topshirig'i: ${prompt}`
        : `Topshiriq: ${prompt}`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: fullPrompt,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });

      const rawText = response.text ?? '';
      const codeBlockMatch = rawText.match(/```(?:html|javascript|js|css|ts)?\s*([\s\S]*?)```/i);
      const extractedCode = codeBlockMatch ? codeBlockMatch[1].trim() : '';

      res.json({
        text: rawText,
        code: extractedCode,
      });
    } catch (error: unknown) {
      const errMessage = error instanceof Error ? error.message : "Noma'lum server xatosi";
      res.status(500).json({ error: errMessage });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`OrzuKod server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
