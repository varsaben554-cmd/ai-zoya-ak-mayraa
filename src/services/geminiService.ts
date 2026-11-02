export function resetZoyaSession() {
  // Session reset hook if needed
}

export interface ZoyaChatResult {
  reply: string;
  audio: string | null;
}

export async function getZoyaChatResponse(
  prompt: string,
  history: { sender: "user" | "zoya"; text: string }[] = [],
  generateAudio: boolean = false
): Promise<ZoyaChatResult> {
  try {
    const res = await fetch("/api/gemini/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: prompt, history, generateAudio }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.error("Gemini server API error:", errData);
      return {
        reply: errData.reply || "Uff, mera dimaag kharab ho gaya hai. Try again later, A.K.",
        audio: null,
      };
    }

    const data = await res.json();
    return {
      reply: data.reply || "Ugh, fine. I have nothing to say.",
      audio: data.audio || null,
    };
  } catch (error) {
    console.error("Gemini Client Error:", error);
    return {
      reply: "Uff, mera dimaag kharab ho gaya hai. Try again later, A.K.",
      audio: null,
    };
  }
}

export async function getZoyaResponse(
  prompt: string,
  history: { sender: "user" | "zoya"; text: string }[] = []
): Promise<string> {
  const result = await getZoyaChatResponse(prompt, history, false);
  return result.reply;
}

export async function getZoyaAudio(text: string): Promise<string | null> {
  try {
    const res = await fetch("/api/gemini/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      console.error("TTS server API error:", res.statusText);
      return null;
    }

    const data = await res.json();
    return data.audio || null;
  } catch (error) {
    console.error("TTS Client Error:", error);
    return null;
  }
}
