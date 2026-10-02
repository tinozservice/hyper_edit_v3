import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  Database,
  FileDown,
  Gauge,
  Globe,
  KeyRound,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  X,
} from "lucide-react";

// Halaman pengelola daftar fallback LLM.
//
// Sumber datanya adalah SQLite milik server editor lokal
// (scripts/local-ffmpeg-server.js → scripts/llm-pool.js). Setiap provider
// selalu terdiri dari base URL + API key + model dan dicoba berurutan saat
// request chat/transkripsi/TTS gagal atau timeout.

const API = "http://localhost:3333";

type PoolKind = "chat" | "transcription" | "tts";

interface Provider {
  id: number;
  name: string;
  base_url: string;
  model: string;
  transcribe_model: string;
  tts_model: string;
  timeout_ms: number;
  max_retries: number;
  enabled: boolean;
  chat_enabled: boolean;
  transcribe_enabled: boolean;
  tts_enabled: boolean;
  priority: number;
  has_api_key: boolean;
  api_key_masked: string;
  created_at: string;
  updated_at: string;
}

const POOL_META: Record<PoolKind, { label: string; hint: string; isEnabled: (p: Provider) => boolean }> = {
  chat: {
    label: "Chat",
    hint: "Director, DiCaprio, CreatorOS, Shorts",
    // !== false: server lama (belum restart) tidak mengirim field ini.
    isEnabled: (p) => p.chat_enabled !== false,
  },
  transcription: {
    label: "Transkripsi",
    hint: "Whisper API (/audio/transcriptions)",
    isEnabled: (p) => p.transcribe_enabled !== false,
  },
  tts: {
    label: "TTS",
    hint: "Suara Direktur (/audio/speech)",
    isEnabled: (p) => p.tts_enabled !== false,
  },
};

const POOL_KINDS = Object.keys(POOL_META) as PoolKind[];

interface PoolStatus {
  db_path: string;
  provider_count: number;
  enabled_count: number;
  log_count: number;
}

interface LogEntry {
  id: number;
  ts: string;
  source: string;
  kind: string;
  provider_name: string | null;
  model: string | null;
  fallback_index: number | null;
  attempt: number | null;
  success: number;
  latency_ms: number | null;
  status_code: number | null;
  error: string | null;
}

interface TestResult {
  ok: boolean;
  capability?: PoolKind;
  provider: string;
  model: string;
  latency_ms: number;
  reply?: string;
  error?: string;
}

interface FormState {
  id: number | null;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  transcribe_model: string;
  tts_model: string;
  timeout_ms: number;
  max_retries: number;
  enabled: boolean;
  chat_enabled: boolean;
  transcribe_enabled: boolean;
  tts_enabled: boolean;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: "",
  base_url: "",
  api_key: "",
  model: "",
  transcribe_model: "",
  tts_model: "",
  timeout_ms: 30000,
  max_retries: 1,
  enabled: true,
  chat_enabled: true,
  transcribe_enabled: true,
  tts_enabled: true,
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function formatTs(ts: string): string {
  try {
    const iso = ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`;
    return new Date(iso).toLocaleString();
  } catch {
    return ts;
  }
}

function formFromProvider(provider: Provider): FormState {
  return {
    id: provider.id,
    name: provider.name,
    base_url: provider.base_url,
    api_key: "",
    model: provider.model,
    transcribe_model: provider.transcribe_model,
    tts_model: provider.tts_model,
    timeout_ms: provider.timeout_ms,
    max_retries: provider.max_retries,
    enabled: provider.enabled,
    chat_enabled: provider.chat_enabled !== false,
    transcribe_enabled: provider.transcribe_enabled !== false,
    tts_enabled: provider.tts_enabled !== false,
  };
}

export default function LlmSettingsPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [testResults, setTestResults] = useState<Record<number, TestResult>>({});
  const [activePool, setActivePool] = useState<PoolKind>("chat");

  const visibleProviders = providers.filter(POOL_META[activePool].isEnabled);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [providerRes, statusRes, logRes] = await Promise.all([
        api<{ providers: Provider[] }>("/llm/providers"),
        api<PoolStatus>("/llm/status"),
        api<{ logs: LogEntry[] }>("/llm/logs?limit=100"),
      ]);
      setProviders(providerRes.providers);
      setStatus(statusRes);
      setLogs(logRes.logs);
    } catch (err) {
      setError(
        `Tidak bisa terhubung ke server editor di ${API}. Jalankan "npm run ffmpeg-server" lalu muat ulang. (${(err as Error).message})`
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setTestResults({});
  }, [activePool]);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 4000);
  };

  const saveForm = async () => {
    if (!form) return;
    setBusy("save");
    setError("");
    try {
      const payload = {
        name: form.name,
        base_url: form.base_url,
        model: form.model,
        transcribe_model: form.transcribe_model,
        tts_model: form.tts_model,
        timeout_ms: form.timeout_ms,
        max_retries: form.max_retries,
        enabled: form.enabled,
        chat_enabled: form.chat_enabled,
        transcribe_enabled: form.transcribe_enabled,
        tts_enabled: form.tts_enabled,
        ...(form.api_key ? { api_key: form.api_key } : {}),
      };
      if (form.id === null) {
        await api("/llm/providers", { method: "POST", body: JSON.stringify(payload) });
        flash("Provider ditambahkan.");
      } else {
        await api(`/llm/providers/${form.id}`, { method: "PUT", body: JSON.stringify(payload) });
        flash("Provider diperbarui.");
      }
      setForm(null);
      setShowKey(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const removeProvider = async (provider: Provider) => {
    if (!window.confirm(`Hapus provider "${provider.name}"?`)) return;
    setBusy(`delete-${provider.id}`);
    try {
      await api(`/llm/providers/${provider.id}`, { method: "DELETE" });
      await load();
      flash("Provider dihapus.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleProvider = async (provider: Provider) => {
    setBusy(`toggle-${provider.id}`);
    try {
      await api(`/llm/providers/${provider.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !provider.enabled }),
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= visibleProviders.length) return;
    // Swap the two adjacent providers of the active pool in the shared
    // priority order. Other providers keep their position.
    const a = visibleProviders[index];
    const b = visibleProviders[target];
    const next = [...providers];
    const ia = next.findIndex((p) => p.id === a.id);
    const ib = next.findIndex((p) => p.id === b.id);
    [next[ia], next[ib]] = [next[ib], next[ia]];
    setProviders(next);
    setBusy("reorder");
    try {
      await api("/llm/providers/reorder", { method: "POST", body: JSON.stringify({ ids: next.map((p) => p.id) }) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const testOne = async (provider: Provider) => {
    setBusy(`test-${provider.id}`);
    try {
      const result = await api<TestResult>(`/llm/providers/${provider.id}/test`, {
        method: "POST",
        body: JSON.stringify({ capability: activePool }),
      });
      setTestResults((prev) => ({ ...prev, [provider.id]: result }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [provider.id]: { ok: false, provider: provider.name, model: provider.model, latency_ms: 0, error: (err as Error).message },
      }));
    } finally {
      setBusy(null);
    }
  };

  const testAll = async () => {
    setBusy("test-all");
    try {
      const res = await api<{ results: TestResult[] }>("/llm/test", {
        method: "POST",
        body: JSON.stringify({ capability: activePool }),
      });
      const byName = new Map(res.results.map((r) => [r.provider, r]));
      setTestResults((prev) => {
        const next = { ...prev };
        visibleProviders.forEach((p) => {
          const found = byName.get(p.name);
          if (found) next[p.id] = found;
        });
        return next;
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const clearLogs = async () => {
    setBusy("clear-logs");
    try {
      await api("/llm/logs", { method: "DELETE" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const importFromEnv = async () => {
    setBusy("seed");
    try {
      const res = await api<{ added: number; reason?: string }>("/llm/providers/seed", { method: "POST" });
      await load();
      flash(
        res.added > 0
          ? `${res.added} provider diimpor dari .dev.vars.`
          : `Tidak ada yang diimpor${res.reason ? ` (${res.reason})` : ""}. Pastikan ANTHROPIC_API_KEY/OPENAI_API_KEY terisi lalu jalankan ulang npm run ffmpeg-server.`
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <header className="flex items-center justify-between px-6 py-4 bg-zinc-900/50 border-b border-zinc-800/50 sticky top-0 backdrop-blur-sm z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-br from-zinc-500 to-zinc-500 rounded-lg flex items-center justify-center">
            <Settings className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold">Fallback LLM</h1>
            <p className="text-xs text-zinc-500">
              Daftar provider OpenAI-compatible per layanan — chat, transkripsi, dan TTS punya urutan fallback sendiri
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void load()}
            className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm transition-colors flex items-center gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Muat ulang
          </button>
          <button
            onClick={() => {
              setForm({ ...EMPTY_FORM });
              setShowKey(false);
            }}
            className="px-3 py-2 bg-zinc-600 hover:bg-zinc-500 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Tambah provider
          </button>
          <Link to="/" className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm transition-colors">
            ← Editor
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-6">
        {error && (
          <div className="flex items-start gap-2 bg-red-950/60 border border-red-800 text-red-200 rounded-lg p-4 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="flex items-center gap-2 bg-emerald-950/60 border border-emerald-800 text-emerald-200 rounded-lg p-4 text-sm">
            <Check className="w-4 h-4" />
            {notice}
          </div>
        )}

        {status && (
          <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
            <span className="flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5" />
              SQLite: <code className="text-zinc-300">{status.db_path}</code>
            </span>
            <span>
              {status.provider_count} provider · {status.log_count} log
            </span>
            <span className="flex items-center gap-2">
              {POOL_KINDS.map((kind) => (
                <span key={kind} className="px-1.5 py-0.5 rounded bg-zinc-800">
                  {POOL_META[kind].label}: {providers.filter(POOL_META[kind].isEnabled).length} aktif
                </span>
              ))}
            </span>
          </div>
        )}

        {form && (
          <section className="bg-zinc-900 border border-zinc-700 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{form.id === null ? "Provider baru" : `Edit provider #${form.id}`}</h2>
              <button onClick={() => setForm(null)} className="p-1 hover:bg-zinc-800 rounded transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="space-y-1 text-sm">
                <span className="text-zinc-400">Nama</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Contoh: OpenAI"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 outline-none focus:border-zinc-500"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5" /> Base URL
                </span>
                <input
                  value={form.base_url}
                  onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 outline-none focus:border-zinc-500 font-mono text-xs"
                />
              </label>
              <label className="space-y-1 text-sm md:col-span-2">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  <KeyRound className="w-3.5 h-3.5" /> API key {form.id !== null && <em className="text-zinc-600">(kosongkan untuk mempertahankan key tersimpan)</em>}
                </span>
                <div className="flex gap-2">
                  <input
                    type={showKey ? "text" : "password"}
                    value={form.api_key}
                    onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                    placeholder={form.id !== null ? "•••••••• (tidak diubah)" : "sk-..."}
                    className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 outline-none focus:border-zinc-500 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="px-3 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs"
                  >
                    {showKey ? "Sembunyikan" : "Tampilkan"}
                  </button>
                </div>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-zinc-400">Model (chat)</span>
                <input
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  placeholder="gpt-4o-mini / claude-sonnet-5"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 outline-none focus:border-zinc-500 font-mono text-xs"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-zinc-400">Model transkripsi (opsional, default whisper-1)</span>
                <input
                  value={form.transcribe_model}
                  onChange={(e) => setForm({ ...form, transcribe_model: e.target.value })}
                  placeholder="whisper-1"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 outline-none focus:border-zinc-500 font-mono text-xs"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-zinc-400">Model TTS (opsional, default tts-1)</span>
                <input
                  value={form.tts_model}
                  onChange={(e) => setForm({ ...form, tts_model: e.target.value })}
                  placeholder="tts-1"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 outline-none focus:border-zinc-500 font-mono text-xs"
                />
              </label>
              <div className="grid grid-cols-2 gap-4">
                <label className="space-y-1 text-sm">
                  <span className="text-zinc-400">Timeout (ms)</span>
                  <input
                    type="number"
                    value={form.timeout_ms}
                    onChange={(e) => setForm({ ...form, timeout_ms: Number(e.target.value) })}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 outline-none focus:border-zinc-500"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-zinc-400">Retry per provider</span>
                  <input
                    type="number"
                    value={form.max_retries}
                    onChange={(e) => setForm({ ...form, max_retries: Number(e.target.value) })}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 outline-none focus:border-zinc-500"
                  />
                </label>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-300">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                    className="accent-zinc-400"
                  />
                  Aktif
                </label>
                <span className="text-zinc-700">|</span>
                <span className="text-zinc-400">Layanan:</span>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.chat_enabled}
                    onChange={(e) => setForm({ ...form, chat_enabled: e.target.checked })}
                    className="accent-zinc-400"
                  />
                  Chat
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.transcribe_enabled}
                    onChange={(e) => setForm({ ...form, transcribe_enabled: e.target.checked })}
                    className="accent-zinc-400"
                  />
                  Transkripsi
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.tts_enabled}
                    onChange={(e) => setForm({ ...form, tts_enabled: e.target.checked })}
                    className="accent-zinc-400"
                  />
                  TTS
                </label>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setForm(null)} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm">
                  Batal
                </button>
                <button
                  onClick={() => void saveForm()}
                  disabled={busy === "save" || !form.name || !form.base_url || !form.model}
                  className="px-4 py-2 bg-zinc-600 hover:bg-zinc-500 disabled:opacity-50 rounded-lg text-sm font-medium flex items-center gap-2"
                >
                  {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Simpan
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 bg-zinc-950/70 border border-zinc-800 rounded-lg p-1">
                {POOL_KINDS.map((kind) => {
                  const count = providers.filter(POOL_META[kind].isEnabled).length;
                  const active = activePool === kind;
                  return (
                    <button
                      key={kind}
                      onClick={() => setActivePool(kind)}
                      title={POOL_META[kind].hint}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
                        active ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                      }`}
                    >
                      {POOL_META[kind].label}
                      <span className={`px-1 rounded ${active ? "bg-zinc-900/80" : "bg-zinc-800"}`}>{count}</span>
                    </button>
                  );
                })}
              </div>
              <span className="text-xs text-zinc-500 hidden md:inline">{POOL_META[activePool].hint}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void importFromEnv()}
                disabled={busy === "seed" || providers.length > 0}
                title="Tambahkan entri awal dari ANTHROPIC_API_KEY / OPENAI_API_KEY di .dev.vars"
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg text-xs flex items-center gap-1.5"
              >
                {busy === "seed" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
                Impor .dev.vars
              </button>
              <button
                onClick={() => void testAll()}
                disabled={busy === "test-all" || visibleProviders.length === 0}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg text-xs flex items-center gap-1.5"
              >
                {busy === "test-all" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Gauge className="w-3.5 h-3.5" />}
                Uji semua
              </button>
            </div>
          </div>

          {visibleProviders.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-500">
              Belum ada provider untuk layanan <span className="text-zinc-300">{POOL_META[activePool].label}</span>. Klik{" "}
              <span className="text-zinc-300">Tambah provider</span>, atau aktifkan layanan ini pada provider yang ada lewat{" "}
              <span className="text-zinc-300">Edit</span>.
            </div>
          ) : (
            <div className="divide-y divide-zinc-800">
              {visibleProviders.map((provider, index) => {
                const result = testResults[provider.id];
                return (
                  <div key={provider.id} className={`px-4 py-3 ${provider.enabled ? "" : "opacity-50"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="flex flex-col items-center gap-0.5 pt-0.5">
                          <span className="text-xs text-zinc-500">#{index + 1}</span>
                          <button
                            onClick={() => void move(index, -1)}
                            disabled={index === 0}
                            className="p-0.5 hover:bg-zinc-800 rounded disabled:opacity-30"
                            title="Naikkan prioritas"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => void move(index, 1)}
                            disabled={index === visibleProviders.length - 1}
                            className="p-0.5 hover:bg-zinc-800 rounded disabled:opacity-30"
                            title="Turunkan prioritas"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{provider.name}</span>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded ${
                                provider.enabled ? "bg-emerald-900/60 text-emerald-300" : "bg-zinc-800 text-zinc-400"
                              }`}
                            >
                              {provider.enabled ? "aktif" : "nonaktif"}
                            </span>
                            {result && (
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 ${
                                  result.ok ? "bg-emerald-900/60 text-emerald-300" : "bg-red-900/60 text-red-300"
                                }`}
                                title={result.error || result.reply}
                              >
                                {result.ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                                {result.ok ? `${result.latency_ms}ms` : "gagal"}
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              {provider.chat_enabled !== false && (
                                <span className="text-[10px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-500">chat</span>
                              )}
                              {provider.transcribe_enabled !== false && (
                                <span className="text-[10px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-500">stt</span>
                              )}
                              {provider.tts_enabled !== false && (
                                <span className="text-[10px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-500">tts</span>
                              )}
                            </span>
                          </div>
                          <div className="text-xs text-zinc-500 font-mono truncate">{provider.base_url}</div>
                          <div className="text-xs text-zinc-400 font-mono">
                            {provider.model}
                            {provider.transcribe_model ? ` · stt:${provider.transcribe_model}` : ""}
                            {provider.tts_model ? ` · tts:${provider.tts_model}` : ""}
                            {" · "}
                            {provider.timeout_ms}ms · retry {provider.max_retries} · key {provider.has_api_key ? provider.api_key_masked : "(kosong)"}
                          </div>
                          {result && !result.ok && (
                            <div className="text-xs text-red-400 mt-1 break-all">{result.error}</div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => void toggleProvider(provider)}
                          disabled={busy === `toggle-${provider.id}`}
                          className="px-2 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs disabled:opacity-50"
                          title={provider.enabled ? "Nonaktifkan" : "Aktifkan"}
                        >
                          {provider.enabled ? "⏸" : "▶"}
                        </button>
                        <button
                          onClick={() => void testOne(provider)}
                          disabled={busy === `test-${provider.id}`}
                          className="px-2 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs flex items-center gap-1 disabled:opacity-50"
                        >
                          {busy === `test-${provider.id}` ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Play className="w-3.5 h-3.5" />
                          )}
                          Uji
                        </button>
                        <button
                          onClick={() => {
                            setForm(formFromProvider(provider));
                            setShowKey(false);
                          }}
                          className="p-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs"
                          title="Edit"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => void removeProvider(provider)}
                          disabled={busy === `delete-${provider.id}`}
                          className="p-1.5 bg-zinc-800 hover:bg-red-900/60 rounded text-xs disabled:opacity-50"
                          title="Hapus"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
            <h2 className="font-semibold text-sm">Log percobaan terakhir</h2>
            <button
              onClick={() => void clearLogs()}
              disabled={busy === "clear-logs" || logs.length === 0}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg text-xs"
            >
              Bersihkan log
            </button>
          </div>
          {logs.length === 0 ? (
            <div className="p-6 text-center text-sm text-zinc-500">Belum ada percobaan tercatat.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-zinc-500 bg-zinc-900/80">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Waktu</th>
                    <th className="text-left px-3 py-2 font-medium">Jenis</th>
                    <th className="text-left px-3 py-2 font-medium">Provider</th>
                    <th className="text-left px-3 py-2 font-medium">Model</th>
                    <th className="text-left px-3 py-2 font-medium">Hasil</th>
                    <th className="text-left px-3 py-2 font-medium">Latensi</th>
                    <th className="text-left px-3 py-2 font-medium">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70">
                  {logs.map((entry) => (
                    <tr key={entry.id} className="text-zinc-300">
                      <td className="px-3 py-2 whitespace-nowrap">{formatTs(entry.ts)}</td>
                      <td className="px-3 py-2">
                        {entry.kind}
                        <span className="text-zinc-600"> · {entry.source}</span>
                      </td>
                      <td className="px-3 py-2">{entry.provider_name || "-"}</td>
                      <td className="px-3 py-2 font-mono">{entry.model || "-"}</td>
                      <td className="px-3 py-2">
                        {entry.success ? (
                          <span className="text-emerald-400">ok</span>
                        ) : (
                          <span className="text-red-400">gagal {entry.status_code ? `(${entry.status_code})` : ""}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">{entry.latency_ms != null ? `${entry.latency_ms}ms` : "-"}</td>
                      <td className="px-3 py-2 text-red-300/80 max-w-[320px] truncate" title={entry.error || ""}>
                        {entry.error || ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="text-xs text-zinc-500 leading-relaxed">
          Cara kerja: tiap layanan punya daftar fallback sendiri — tab <em>Chat</em>, <em>Transkripsi</em>, dan <em>TTS</em>{" "}
          di atas. Hanya provider dengan layanan tersebut aktif yang dicoba, berurutan dari atas. Error jaringan, timeout,
          HTTP 429/5xx, atau model reasoning yang kehabisan token di-retry otomatis lalu lanjut ke provider berikutnya.
          Semua percobaan dicatat di tabel log (kolom <em>Jenis</em> menunjukkan layanannya).
        </p>
      </main>
    </div>
  );
}
