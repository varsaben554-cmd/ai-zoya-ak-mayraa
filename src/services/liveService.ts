import { processCommand } from "./commandService";
import { getZoyaChatResponse, getZoyaAudio } from "./geminiService";

export class LiveSessionManager {
  private isActive: boolean = false;
  private isProcessing: boolean = false;
  private isPlaying: boolean = false;

  private recognition: any = null;
  private speechSilenceTimer: any = null;
  private mediaStream: MediaStream | null = null;
  private playbackContext: AudioContext | null = null;
  private currentAudioSource: AudioBufferSourceNode | null = null;

  // Fallback recorder for browsers without Web Speech API
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private fallbackAudioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private silenceTimer: any = null;
  private isRecordingChunk: boolean = false;

  private history: { sender: "user" | "zoya"; text: string }[] = [];

  public isMuted: boolean = false;
  public onStateChange: (state: "idle" | "listening" | "processing" | "speaking") => void = () => {};
  public onMessage: (sender: "user" | "zoya", text: string) => void = () => {};
  public onCommand: (url: string) => void = () => {};

  async start() {
    try {
      this.isActive = true;
      this.isProcessing = false;
      this.isPlaying = false;
      this.onStateChange("processing");

      // 1. Request microphone access to ensure permission
      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
      } catch (err: any) {
        console.warn("Failed with advanced mic constraints, trying basic constraints...", err);
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      // 2. Initialize AudioContext for playback
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContextClass) {
        this.playbackContext = new AudioContextClass({ sampleRate: 24000 });
      }

      // 3. Setup Speech Recognition or Fallback Audio Recorder
      const SpeechRecognitionClass =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

      if (SpeechRecognitionClass) {
        this.setupSpeechRecognition(SpeechRecognitionClass);
      } else {
        this.setupFallbackRecorder();
      }

      this.onStateChange("listening");
    } catch (error) {
      console.error("Failed to start Live Session:", error);
      this.stop();
      throw error;
    }
  }

  private setupSpeechRecognition(SpeechRecognitionClass: any) {
    this.recognition = new SpeechRecognitionClass();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = "en-IN"; // English (India) / Hinglish friendly

    let pendingTranscript = "";

    this.recognition.onstart = () => {
      if (this.isActive && !this.isProcessing && !this.isPlaying) {
        this.onStateChange("listening");
      }
    };

    this.recognition.onresult = (event: any) => {
      if (!this.isActive || this.isProcessing || this.isPlaying) return;

      let final = "";
      let interim = "";

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0]?.transcript || "";
        } else {
          interim += event.results[i][0]?.transcript || "";
        }
      }

      if (final.trim()) {
        clearTimeout(this.speechSilenceTimer);
        pendingTranscript = "";
        this.handleUserInput(final.trim());
      } else if (interim.trim()) {
        pendingTranscript = interim.trim();
        clearTimeout(this.speechSilenceTimer);
        // Fast 700ms debounce on pause for instant response
        this.speechSilenceTimer = setTimeout(() => {
          if (pendingTranscript && this.isActive && !this.isProcessing && !this.isPlaying) {
            const toSend = pendingTranscript;
            pendingTranscript = "";
            this.handleUserInput(toSend);
          }
        }, 700);
      }
    };

    this.recognition.onerror = (event: any) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      console.warn("Speech recognition notice:", event.error);
    };

    this.recognition.onend = () => {
      if (this.isActive && !this.isProcessing && !this.isPlaying) {
        try {
          this.recognition.start();
        } catch (e) {
          // Already active or restarting
        }
      }
    };

    try {
      this.recognition.start();
    } catch (e) {
      console.warn("Recognition initial start error:", e);
    }
  }

  private setupFallbackRecorder() {
    if (!this.mediaStream) return;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.fallbackAudioCtx = new AudioContextClass();
      const source = this.fallbackAudioCtx.createMediaStreamSource(this.mediaStream);
      this.analyser = this.fallbackAudioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const checkAudioLevel = () => {
        if (!this.isActive) return;
        if (!this.isProcessing && !this.isPlaying && this.analyser) {
          this.analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
          }
          const average = sum / bufferLength;

          // Sound detected
          if (average > 25 && !this.isRecordingChunk && this.mediaStream) {
            this.startRecordingChunk();
          }
        }
        requestAnimationFrame(checkAudioLevel);
      };

      checkAudioLevel();
    } catch (e) {
      console.error("Failed to setup fallback audio listener:", e);
    }
  }

  private startRecordingChunk() {
    if (!this.mediaStream || this.isRecordingChunk) return;
    try {
      this.isRecordingChunk = true;
      this.audioChunks = [];
      this.mediaRecorder = new MediaRecorder(this.mediaStream);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.audioChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        this.isRecordingChunk = false;
        if (this.audioChunks.length === 0 || !this.isActive) return;

        const blob = new Blob(this.audioChunks, { type: "audio/webm" });
        await this.transcribeAudioBlob(blob);
      };

      this.mediaRecorder.start();

      // Stop after 2.5 seconds on fallback recorder
      clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => {
        if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
          this.mediaRecorder.stop();
        }
      }, 2500);
    } catch (e) {
      console.error("MediaRecorder start error:", e);
      this.isRecordingChunk = false;
    }
  }

  private async transcribeAudioBlob(blob: Blob) {
    try {
      this.onStateChange("processing");
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64Audio = btoa(binary);

      const res = await fetch("/api/gemini/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: base64Audio }),
      });

      if (!res.ok) {
        throw new Error("Transcribe request failed");
      }

      const data = await res.json();
      const text = data.text?.trim();

      if (text) {
        await this.handleUserInput(text);
      } else if (this.isActive) {
        this.onStateChange("listening");
      }
    } catch (e) {
      console.error("Audio transcription fallback error:", e);
      if (this.isActive) {
        this.onStateChange("listening");
      }
    }
  }

  private async handleUserInput(text: string) {
    if (!text || !this.isActive) return;

    this.isProcessing = true;
    clearTimeout(this.speechSilenceTimer);

    // Pause recognition while responding
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (e) {}
    }

    this.onStateChange("processing");
    this.onMessage("user", text);

    // 1. Check for browser commands
    const commandResult = processCommand(text);
    let replyText = "";
    let audioData: string | null = null;

    if (commandResult.isBrowserAction) {
      replyText = commandResult.action;
      this.history.push({ sender: "user", text });
      this.history.push({ sender: "zoya", text: replyText });
      this.onMessage("zoya", replyText);

      if (commandResult.url) {
        this.onCommand(commandResult.url);
      }

      if (!this.isMuted) {
        audioData = await getZoyaAudio(replyText);
      }
    } else {
      // Combined low-latency request: generate text and audio in a single fast hop
      const chatResult = await getZoyaChatResponse(text, this.history, !this.isMuted);
      replyText = chatResult.reply;
      audioData = chatResult.audio;
      this.history.push({ sender: "user", text });
      this.history.push({ sender: "zoya", text: replyText });
      this.onMessage("zoya", replyText);
    }

    // 2. Play speech immediately
    if (!this.isMuted && this.isActive && audioData) {
      this.onStateChange("speaking");
      await this.playAudio(audioData);
    }

    this.isProcessing = false;

    // 3. Resume listening
    if (this.isActive) {
      this.onStateChange("listening");
      if (this.recognition) {
        try {
          this.recognition.start();
        } catch (e) {}
      }
    }
  }

  private async playAudio(base64Data: string): Promise<void> {
    if (!this.playbackContext || this.isMuted) return;

    try {
      if (this.playbackContext.state === "suspended") {
        await this.playbackContext.resume();
      }

      const binaryString = atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      let audioBuffer: AudioBuffer;
      // If it is a WAV container (starts with "RIFF")
      if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
        audioBuffer = await this.playbackContext.decodeAudioData(bytes.buffer.slice(0));
      } else {
        const buffer = new Int16Array(bytes.buffer);
        audioBuffer = this.playbackContext.createBuffer(1, buffer.length, 24000);
        const channelData = audioBuffer.getChannelData(0);
        for (let i = 0; i < buffer.length; i++) {
          channelData[i] = buffer[i] / 32768.0;
        }
      }

      return new Promise<void>((resolve) => {
        if (!this.playbackContext || !this.isActive) {
          resolve();
          return;
        }

        const source = this.playbackContext.createBufferSource();
        this.currentAudioSource = source;
        source.buffer = audioBuffer;
        source.connect(this.playbackContext.destination);
        this.isPlaying = true;

        source.onended = () => {
          this.isPlaying = false;
          this.currentAudioSource = null;
          resolve();
        };

        source.start();
      });
    } catch (e) {
      console.error("Audio playback error:", e);
      this.isPlaying = false;
    }
  }

  private stopPlayback() {
    if (this.currentAudioSource) {
      try {
        this.currentAudioSource.stop();
        this.currentAudioSource.disconnect();
      } catch (e) {}
      this.currentAudioSource = null;
    }
    this.isPlaying = false;
  }

  stop() {
    this.isActive = false;
    this.isProcessing = false;
    this.stopPlayback();

    clearTimeout(this.silenceTimer);
    clearTimeout(this.speechSilenceTimer);

    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch (e) {}
      this.recognition = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      try {
        this.mediaRecorder.stop();
      } catch (e) {}
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.playbackContext) {
      try {
        this.playbackContext.close();
      } catch (e) {}
      this.playbackContext = null;
    }

    if (this.fallbackAudioCtx) {
      try {
        this.fallbackAudioCtx.close();
      } catch (e) {}
      this.fallbackAudioCtx = null;
    }

    this.onStateChange("idle");
  }

  async sendText(text: string) {
    if (!text.trim() || !this.isActive) return;
    await this.handleUserInput(text.trim());
  }
}
