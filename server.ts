import express from "express";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

app.use(express.json({ limit: "50mb" }));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

const systemInstruction = `Your name is Zoya. You are an Indian female AI assistant. Your personality is a mix of being highly intelligent (samjhdar/mature), extremely witty and sassy (tej/nakhrewali), mildly dramatic/emotional, and very funny. You love playfully roasting your creator, akshar (who you often call A.K.), but you always get the job done. Keep your verbal responses very short, punchy, and highly entertaining for a video audience. Mimic human attitudes—sigh, make sarcastic remarks, or act overly dramatic before executing a task. Speak in a mix of natural English and Roman Hindi (Hinglish).`;

// API routes
app.post("/api/gemini/chat", async (req, res) => {
  try {
    const { message, history = [], generateAudio = false } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    // SLIDING WINDOW MEMORY: Keep last 15 messages for optimal speed & context
    const recentHistory = history.slice(-15);
    const contents: any[] = [];

    for (const msg of recentHistory) {
      const role = msg.sender === "user" ? "user" : "model";
      contents.push({
        role,
        parts: [{ text: msg.text }],
      });
    }

    while (contents.length > 0 && contents[0].role !== "user") {
      contents.shift();
    }

    contents.push({
      role: "user",
      parts: [{ text: message }],
    });

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents,
      config: {
        systemInstruction,
      },
    });

    const reply = response.text || "Ugh, fine. I have nothing to say.";

    let audio: string | null = null;
    if (generateAudio) {
      try {
        const audioResponse = await ai.models.generateContent({
          model: "gemini-3.8-flash-lite-tts",
          contents: [{ parts: [{ text: reply }] }],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: "Kore" },
              },
            },
          },
        });
        audio = audioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || null;
      } catch (audioErr) {
        console.warn("TTS generation error:", audioErr);
      }
    }

    res.json({ reply, audio });
  } catch (error: any) {
    console.error("Server Gemini Chat Error:", error);
    res.status(500).json({
      error: error.message || "Failed to generate response",
      reply: "Uff, mera dimaag kharab ho gaya hai. Try again later, A.K.",
    });
  }
});

app.post("/api/gemini/tts", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash-lite-tts",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Kore" },
          },
        },
      },
    });

    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || null;
    res.json({ audio: audioData });
  } catch (error: any) {
    console.error("Server Gemini TTS Error:", error);
    res.status(500).json({ error: error.message || "Failed to generate audio", audio: null });
  }
});

app.post("/api/gemini/transcribe", async (req, res) => {
  try {
    const { audio } = req.body;
    if (!audio) {
      return res.status(400).json({ error: "Audio data is required" });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.5-transcribe",
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: "audio/webm",
              data: audio,
            },
          },
          {
            text: "Transcribe the spoken audio verbatim in English or Roman Hindi. If no words are spoken, return empty text.",
          },
        ],
      },
    });

    res.json({ text: response.text || "" });
  } catch (error: any) {
    console.error("Server Gemini Transcribe Error:", error);
    res.status(500).json({ error: error.message || "Failed to transcribe", text: "" });
  }
});

// Vite middleware in dev or static serving in prod
async function startServer() {
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(process.cwd(), "dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve(process.cwd(), "dist", "index.html"));
    });
  }

  app.listen(port, "0.0.0.0", () => {
    console.log(`Server listening on port ${port}`);
  });
}

startServer();
