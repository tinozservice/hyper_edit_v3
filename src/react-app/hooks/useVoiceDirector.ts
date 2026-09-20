import { useCallback, useEffect, useRef, useState } from 'react';

// Voice-to-voice loop for the Director agent.
//
//   mic (Web Speech API) → transcript → Director routes/executes → reply spoken
//   (OpenAI TTS via the FFmpeg server, browser speechSynthesis as fallback)
//   → mic re-arms while voice mode stays on.
//
// Speech recognition runs in the browser (Chrome / Edge / Safari) so the
// user hears nothing until the Director has an answer; Jev-backed routing on
// the server keeps the turnaround short enough for a conversation.

const SERVER = 'http://localhost:3333';

// Minimal typings for the (still prefixed) Web Speech API.
interface SpeechRecognitionResultLike { isFinal: boolean; 0: { transcript: string } }
interface SpeechRecognitionEventLike { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> }
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/** Strip markdown / code so the spoken reply sounds natural. */
export function toSpeakable(text: string, maxChars = 420): string {
  let t = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[*_#>]+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    t = cut.slice(0, Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '), maxChars - 60) + 1).trim();
  }
  return t;
}

export interface VoicePersona {
  /** OpenAI TTS voice id (alloy, echo, fable, onyx, nova, shimmer, ...). */
  voice?: string;
  /** Delivery instructions; when set the server uses gpt-4o-mini-tts, which honours accent and tone. */
  instructions?: string;
  /** Browser speechSynthesis fallback: preferred voice names in order, then a BCP-47 language prefix. */
  browserVoiceNames?: string[];
  browserLang?: string;
  rate?: number;
  pitch?: number;
}

interface UseVoiceDirectorOptions {
  /** Called with the final transcript of one utterance. */
  onTranscript: (text: string) => void;
  /** Live partial transcript while the user is talking. */
  onInterim?: (text: string) => void;
  persona?: VoicePersona;
}

function pickBrowserVoice(persona?: VoicePersona): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  if (voices.length === 0) return null;
  for (const name of persona?.browserVoiceNames ?? []) {
    const hit = voices.find((v) => v.name.toLowerCase().startsWith(name.toLowerCase()));
    if (hit) return hit;
  }
  if (persona?.browserLang) {
    const hit = voices.find((v) => v.lang.toLowerCase().replace('_', '-').startsWith(persona.browserLang!.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

export function useVoiceDirector({ onTranscript, onInterim, persona }: UseVoiceDirectorOptions) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const finalRef = useRef('');
  const onTranscriptRef = useRef(onTranscript);
  const onInterimRef = useRef(onInterim);
  const personaRef = useRef(persona);
  onTranscriptRef.current = onTranscript;
  onInterimRef.current = onInterim;
  personaRef.current = persona;

  useEffect(() => {
    setSupported(Boolean(getRecognitionCtor()));
    // Voice lists load lazily in some browsers; touching them early warms the fallback.
    try { window.speechSynthesis?.getVoices?.(); } catch { /* ignore */ }
  }, []);

  const stopListening = useCallback(() => {
    const r = recognitionRef.current;
    if (r) {
      try { r.stop(); } catch { /* already stopped */ }
    }
  }, []);

  const startListening = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) { setLastError('Speech recognition is not supported in this browser (use Chrome, Edge or Safari).'); return; }
    if (recognitionRef.current) return; // already listening

    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    finalRef.current = '';

    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalRef.current += r[0].transcript;
        else interim += r[0].transcript;
      }
      onInterimRef.current?.((finalRef.current + ' ' + interim).trim());
    };
    rec.onerror = (e) => {
      // 'no-speech' and 'aborted' are routine; surface the rest.
      if (e.error !== 'no-speech' && e.error !== 'aborted') setLastError(`Mic error: ${e.error}`);
    };
    rec.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      const text = finalRef.current.trim();
      finalRef.current = '';
      if (text) onTranscriptRef.current(text);
    };

    recognitionRef.current = rec;
    setLastError(null);
    setListening(true);
    try { rec.start(); } catch (err) {
      recognitionRef.current = null;
      setListening(false);
      setLastError(err instanceof Error ? err.message : 'Could not start the microphone');
    }
  }, []);

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    setSpeaking(false);
  }, []);

  const speakInner = async (text: string) => {
    try {
      // Preferred: server-side OpenAI TTS (natural voice). Falls back below.
      const res = await fetch(`${SERVER}/director/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: personaRef.current?.voice, instructions: personaRef.current?.instructions }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        await new Promise<void>((resolve) => {
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
          audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
          audio.play().catch(() => resolve());
        });
        audioRef.current = null;
        return;
      }
    } catch { /* fall through to browser TTS */ }

    try {
      await new Promise<void>((resolve) => {
        const synth = window.speechSynthesis;
        if (!synth) { resolve(); return; }
        const u = new SpeechSynthesisUtterance(text);
        const p = personaRef.current;
        const v = pickBrowserVoice(p);
        if (v) u.voice = v;
        u.rate = p?.rate ?? 1.05;
        u.pitch = p?.pitch ?? 1;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        synth.cancel();
        synth.speak(u);
      });
    } catch { /* nothing left to try */ }
  };


  /** Speak text; resolves when playback ends. Never throws. */
  const speak = useCallback(async (raw: string) => {
    const text = toSpeakable(raw);
    if (!text) return;
    stopListening(); // never listen to ourselves
    setSpeaking(true);
    try {
      await speakInner(text);
    } finally {
      setSpeaking(false);
    }
  }, [stopListening]);

  // Turning voice mode off stops everything.
  useEffect(() => {
    if (!voiceMode) { stopListening(); stopSpeaking(); }
  }, [voiceMode, stopListening, stopSpeaking]);

  useEffect(() => () => { stopListening(); stopSpeaking(); }, [stopListening, stopSpeaking]);

  return { supported, listening, speaking, voiceMode, setVoiceMode, lastError, startListening, stopListening, speak, stopSpeaking };
}
