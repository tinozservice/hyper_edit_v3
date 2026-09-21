import { useState, useRef, useEffect } from 'react';
import { Database, Send, Loader2, Plus, Check, Clock, Tag, Film, Image as ImageIcon, AlertTriangle, Zap, Mic, Headphones, Square } from 'lucide-react';
import { useVoiceDirector, type VoicePersona } from '@/react-app/hooks/useVoiceDirector';

// Obsidian agent: searches the "Marketing OS Broll" vault (a media knowledge
// graph of logos, brand assets and b-roll clips) and imports matches straight
// into the asset library. Jev is the media agent: a singular ask imports the
// one best file automatically; a plural ask lists every match to pick from.
// Backend: GET /session/:id/obsidian/status, POST .../obsidian/search, POST .../obsidian/import.

interface ObsidianRow {
  id: string;
  name: string;
  brand: string;
  kind: string;
  type: 'video' | 'image' | 'audio';
  file: string;
  poster: string;
  size: number;
  width: number;
  height: number;
  duration: number;
  tags: string[];
  description: string;
  thumb: string | null;
}

interface JevQueryResult {
  mode: 'single' | 'all';
  rows: ObsidianRow[];
  total: number;
  more: number;
  via: 'jev' | 'keywords';
  intent: { plural: boolean; brand: string | null; kind: string; pillar: string; descriptive: boolean } | null;
  jev: { calls: number; latencyMs: number; inputTokens: number };
  error?: string;
}

interface ObsidianStatus {
  vaultPath: string;
  vaultExists: boolean;
  itemCount: number;
  videos: number;
  images: number;
  jev: boolean;
  // The server reads a local mirror of the iCloud vault (see scripts/obsidian-agent.js)
  mirror?: { path: string; exists: boolean; syncing: boolean; lastSyncedAt: number | null; error: string | null };
}

interface ChatMessage {
  type: 'user' | 'assistant';
  text: string;
  results?: ObsidianRow[];
  error?: string;
}

interface ObsidianPanelProps {
  ensureSession: () => Promise<string>;
  onRefreshAssets?: () => void;
}

const SERVER = 'http://localhost:3333';

// Jev speaks like an old English butler and keeps it to a sentence.
const BUTLER: VoicePersona = {
  voice: 'fable',
  instructions: 'An elderly, refined English butler in the manner of Alfred from Batman: warm, dry, unhurried, received-pronunciation British accent, slightly gravelly with age. Very brief and matter-of-fact.',
  browserVoiceNames: ['Grandpa (English (UK))', 'Grandpa', 'Daniel', 'Reed (English (UK))'],
  browserLang: 'en-GB',
  rate: 0.95,
  pitch: 0.9,
};

// In voice mode a plural ask this small is simply brought in wholesale.
const VOICE_IMPORT_ALL_MAX = 15;

export default function ObsidianPanel({ ensureSession, onRefreshAssets }: ObsidianPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [importingIds, setImportingIds] = useState<Set<string>>(new Set());
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<ObsidianStatus | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const runQueryRef = useRef<(text: string) => Promise<void>>(async () => {});
  const voice = useVoiceDirector({
    onTranscript: (text) => { setPrompt(''); void runQueryRef.current(text); },
    onInterim: (text) => setPrompt(text),
    persona: BUTLER,
  });
  const voiceModeRef = useRef(voice.voiceMode);
  voiceModeRef.current = voice.voiceMode;
  const lastSpokenRef = useRef(-1);
  const busyRef = useRef(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Speak each new reply in voice mode, then listen again.
  useEffect(() => {
    if (!voice.voiceMode) { lastSpokenRef.current = messages.length - 1; return; }
    const i = messages.length - 1;
    if (i <= lastSpokenRef.current) return;
    const last = messages[i];
    if (!last || last.type !== 'assistant') return;
    lastSpokenRef.current = i;
    void (async () => {
      await voice.speak(last.text);
      if (voiceModeRef.current && !busyRef.current) voice.startListening();
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, voice.voiceMode]);

  const toggleVoiceMode = () => {
    if (voice.voiceMode) { voice.setVoiceMode(false); return; }
    voice.setVoiceMode(true);
    setMessages((prev) => [...prev, { type: 'assistant', text: 'At your service, sir. What shall I fetch?' }]);
  };

  // Status is session-agnostic; a placeholder id avoids creating a session just to ask.
  // Poll while the vault mirror is still syncing from iCloud so the counts fill in.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = () => {
      fetch(`${SERVER}/session/_/obsidian/status`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (cancelled || !data) return;
          const st = data as ObsidianStatus;
          setStatus(st);
          if (st.mirror?.syncing) timer = setTimeout(poll, 4000);
        })
        .catch(() => { /* server may be down; search will surface the error */ });
    };
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  const formatDuration = (seconds: number): string => {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`;
  };

  const importRef = useRef<(itemId: string) => Promise<void>>(async () => {});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    void runQuery(prompt);
  };

  const runQuery = async (raw: string) => {
    const query = raw.trim();
    if (!query || isSearching) return;
    setPrompt('');
    setMessages((prev) => [...prev, { type: 'user', text: query }]);
    setIsSearching(true);
    busyRef.current = true;

    try {
      const activeSessionId = await ensureSession();
      const response = await fetch(`${SERVER}/session/${activeSessionId}/obsidian/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 8 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Search failed');

      const result = data as JevQueryResult;
      const rows = result.rows || [];
      const single = result.mode === 'single';
      const importAll = !single && voiceModeRef.current && rows.length > 0 && rows.length <= VOICE_IMPORT_ALL_MAX;
      let text: string;
      if (result.error) {
        text = `The vault isn't where I expect it, sir. Nothing is indexed. (${result.error})`;
      } else if (rows.length === 0) {
        text = result.intent?.brand
          ? `Nothing on file for ${result.intent.brand.replace(/-/g, ' ')}, sir. I shan't substitute another mark.`
          : "Nothing of the sort in the vault, sir.";
      } else if (single) {
        text = `${rows[0].name}, in your media now.${result.more > 0 ? ` ${result.more} more exist.` : ''}`;
      } else if (importAll) {
        text = `All ${rows.length} brought into your media, sir.`;
      } else {
        text = `${result.total} on file, sir. They're listed; say which you'd like.`;
      }
      setMessages((prev) => [...prev, { type: 'assistant', text, results: rows }]);
      if (single && rows[0]) void importRef.current(rows[0].id);
      else if (importAll) for (const r of rows) void importRef.current(r.id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      setMessages((prev) => [...prev, { type: 'assistant', text: `Trouble reaching the vault, sir: ${msg}`, error: msg }]);
    } finally {
      setIsSearching(false);
      busyRef.current = false;
    }
  };
  runQueryRef.current = runQuery;

  const handleImport = async (itemId: string) => {
    if (importingIds.has(itemId) || importedIds.has(itemId)) return;
    setImportingIds((prev) => new Set(prev).add(itemId));

    try {
      const activeSessionId = await ensureSession();
      const response = await fetch(`${SERVER}/session/${activeSessionId}/obsidian/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: [itemId] }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Import failed');

      if (data.imported?.length > 0) {
        setImportedIds((prev) => new Set(prev).add(itemId));
        onRefreshAssets?.();
      } else if (data.failed?.length > 0) {
        throw new Error(data.failed[0].error || 'Import failed');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      setMessages((prev) => [...prev, { type: 'assistant', text: `Couldn't bring that in, sir: ${msg}`, error: msg }]);
    } finally {
      setImportingIds((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
    }
  };

  importRef.current = handleImport;

  return (
    <div className="flex flex-col h-full bg-zinc-900/80">
      {/* Header */}
      <div className="p-4 border-b border-zinc-800/50">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 bg-gradient-to-br from-zinc-400 to-zinc-300 rounded-lg flex items-center justify-center">
            <Database className="w-4 h-4 text-zinc-900" />
          </div>
          <h2 className="font-semibold">Obsidian / JEV</h2>
          {status?.jev && (
            <span className="ml-auto flex items-center gap-1 text-[10px] text-pink-300 bg-pink-500/10 border border-pink-500/30 rounded-full px-2 py-0.5" title="Jev is the media agent">
              <Zap className="w-2.5 h-2.5" /> Jev
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-400">
          {status?.vaultExists
            ? `Marketing OS Broll vault · ${status.videos} clip${status.videos === 1 ? '' : 's'}, ${status.images} image${status.images === 1 ? '' : 's'}${status.mirror?.syncing ? ' · syncing from iCloud…' : ''}`
            : 'Search your media knowledge vault and pull logos, brand assets and b-roll into the editor.'}
        </p>
      </div>

      {status?.mirror?.error && (
        <div className="p-3 bg-amber-500/10 border-b border-amber-500/20 flex gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-200 break-all">Vault mirror sync failed: {status.mirror.error}</p>
        </div>
      )}
      {status && !status.vaultExists && (
        <div className="p-3 bg-amber-500/10 border-b border-amber-500/20 flex gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-200 break-all">
            Vault not found at <code className="text-amber-100">{status.vaultPath}</code>. Set <code className="text-amber-100">OBSIDIAN_VAULT_PATH</code> in <code className="text-amber-100">.dev.vars</code> and restart the FFmpeg server.
          </p>
        </div>
      )}

      {isSearching && (
        <div className="p-4 bg-zinc-800/40 border-b border-zinc-700/40">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-zinc-300 animate-spin" />
            <p className="text-sm text-zinc-200 font-medium">Searching the vault...</p>
          </div>
        </div>
      )}

      {/* Chat history */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4">
        {messages.length === 0 ? (
          <div className="text-center text-sm text-zinc-500 py-8 px-4">
            <Database className="w-8 h-8 mx-auto mb-3 text-zinc-600" />
            <p className="mb-1">Search your media knowledge vault.</p>
            <p className="text-xs text-zinc-600">
              Singular gets the one best file: "the claude logo", "megan profile picture". Plural gets them all: "claude logos", "hoops ai clips", "what logos do we have".
            </p>
          </div>
        ) : (
          messages.map((message, idx) => (
            <div key={idx} className="space-y-2">
              {message.type === 'user' ? (
                <div className="flex justify-end">
                  <div className="bg-gradient-to-r from-zinc-400 to-zinc-300 rounded-lg px-3 py-2 max-w-[85%]">
                    <p className="text-sm text-zinc-900 font-medium">{message.text}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className={`bg-zinc-800 rounded-lg p-3 ${message.error ? 'border border-red-500/30' : ''}`}>
                    <p className={`text-sm whitespace-pre-wrap ${message.error ? 'text-red-200' : 'text-zinc-200'}`}>
                      {message.text}
                    </p>
                  </div>

                  {message.results && message.results.length > 0 && (
                    <div className="space-y-2">
                      {message.results.map((r) => {
                        const isImporting = importingIds.has(r.id);
                        const isImported = importedIds.has(r.id);
                        const meta = [r.brand, r.kind, r.width && r.height ? `${r.width}×${r.height}` : ''].filter(Boolean);
                        return (
                          <div
                            key={r.id}
                            className="bg-zinc-800/70 border border-zinc-700/50 rounded-lg overflow-hidden flex gap-3 p-2 hover:border-zinc-500 transition-colors"
                          >
                            <div className="flex-shrink-0 w-24 h-16 bg-zinc-900 rounded overflow-hidden flex items-center justify-center relative">
                              {r.thumb ? (
                                <img src={`${SERVER}${r.thumb}`} alt={r.name} className="w-full h-full object-contain" loading="lazy" />
                              ) : r.type === 'video' ? (
                                <Film className="w-6 h-6 text-zinc-600" />
                              ) : (
                                <ImageIcon className="w-6 h-6 text-zinc-600" />
                              )}
                              <span className="absolute bottom-0.5 right-0.5 text-[9px] uppercase tracking-wide bg-black/70 text-zinc-300 rounded px-1">
                                {r.type}
                              </span>
                            </div>

                            <div className="flex-1 min-w-0 flex flex-col justify-between gap-1">
                              <div>
                                <p className="text-xs text-zinc-100 line-clamp-1 leading-snug font-medium">{r.name}</p>
                                {r.description && <p className="text-[11px] text-zinc-400 line-clamp-1">{r.description}</p>}
                                <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-500 min-w-0">
                                  {r.duration > 0 && (
                                    <span className="flex items-center gap-0.5 flex-shrink-0">
                                      <Clock className="w-2.5 h-2.5" />
                                      {formatDuration(r.duration)}
                                    </span>
                                  )}
                                  {meta.length > 0 && (
                                    <span className="flex items-center gap-0.5 truncate">
                                      <Tag className="w-2.5 h-2.5 flex-shrink-0" />
                                      <span className="truncate">{meta.join(', ')}</span>
                                    </span>
                                  )}
                                </div>
                              </div>

                              <button
                                onClick={() => handleImport(r.id)}
                                disabled={isImporting || isImported}
                                className={`self-start flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors ${
                                  isImported
                                    ? 'bg-zinc-300/20 text-zinc-200 border border-zinc-400/40 cursor-default'
                                    : isImporting
                                    ? 'bg-zinc-700 text-zinc-400 cursor-wait'
                                    : 'bg-zinc-700/60 text-zinc-200 border border-zinc-600 hover:bg-zinc-300 hover:text-zinc-900 hover:border-zinc-300'
                                }`}
                              >
                                {isImported ? (
                                  <><Check className="w-3 h-3" />Imported</>
                                ) : isImporting ? (
                                  <><Loader2 className="w-3 h-3 animate-spin" />Importing...</>
                                ) : (
                                  <><Plus className="w-3 h-3" />Import</>
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-zinc-800/50">
        <div className="flex items-center justify-between mb-2 text-[10px] text-zinc-500">
          <span>{voice.speaking ? 'Speaking…' : voice.listening ? 'Listening…' : voice.voiceMode ? 'Voice mode on' : 'Singular = one file, plural = all'}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => (voice.listening ? voice.stopListening() : voice.startListening())}
              disabled={isSearching || !voice.supported || voice.speaking}
              className={`p-1.5 rounded-md transition-all ${voice.listening ? 'bg-red-500/20 text-red-400 animate-pulse' : 'hover:bg-zinc-700 text-zinc-400 hover:text-zinc-300 disabled:opacity-50'}`}
              title={voice.supported ? (voice.listening ? 'Stop listening' : 'Ask by voice') : 'Voice needs Chrome, Edge or Safari'}
            >
              {voice.listening ? <Square className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              onClick={toggleVoiceMode}
              disabled={!voice.supported}
              className={`p-1.5 rounded-md transition-all ${voice.voiceMode ? 'bg-pink-500/20 text-pink-300' : 'hover:bg-zinc-700 text-zinc-400 hover:text-zinc-300 disabled:opacity-50'}`}
              title={voice.voiceMode ? 'Turn off voice mode' : 'Voice mode: talk to Jev, hear it answer'}
            >
              <Headphones className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={voice.listening ? 'Listening…' : 'Search logos, brand assets, b-roll...'}
            disabled={isSearching}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400/40 focus:border-zinc-400 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isSearching || !prompt.trim()}
            className="flex items-center justify-center w-10 h-10 bg-gradient-to-br from-zinc-400 to-zinc-300 rounded-lg text-zinc-900 hover:shadow-lg hover:shadow-zinc-400/40 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none transition-all"
          >
            {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </form>
    </div>
  );
}
