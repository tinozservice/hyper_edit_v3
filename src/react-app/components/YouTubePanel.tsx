import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  LogOut,
  RefreshCw,
  Upload,
  Youtube,
} from 'lucide-react';
import type { Asset } from '@/react-app/hooks/useProject';

// Panel upload YouTube native (OAuth + YouTube Data API v3) — jalur langsung
// ke channel milik pengguna, tanpa CreatorOS. Server yang mengurus token dan
// resumable upload (scripts/youtube-client.js).

const SERVER = 'http://localhost:3333';

interface YouTubeStatus {
  configured: boolean;
  connected: boolean;
  channelId: string;
  channelTitle: string;
  redirectUri: string;
}

interface UploadResult {
  success: boolean;
  videoId: string;
  title: string;
  privacyStatus: string;
  watchUrl: string;
  shortsUrl: string;
  studioUrl: string;
  isShort: boolean;
  thumbnailError?: string | null;
}

interface UploadHistory {
  id: number;
  video_id: string;
  title: string;
  privacy: string;
  source: string;
  video_url: string;
  status: string;
  error: string | null;
  created_at: string;
}

interface YouTubePanelProps {
  sessionId: string | null;
  assets: Asset[];
}

const PRIVACY_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'unlisted', label: 'Unlisted', hint: 'Hanya lewat link — aman untuk review' },
  { value: 'public', label: 'Public', hint: 'Langsung tampil di channel' },
  { value: 'private', label: 'Private', hint: 'Hanya Anda yang bisa melihat' },
];

function formatDuration(seconds: number): string {
  const s = Math.round(seconds || 0);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

export default function YouTubePanel({ sessionId, assets }: YouTubePanelProps) {
  const [status, setStatus] = useState<YouTubeStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [source, setSource] = useState('render');
  const [renderFirst, setRenderFirst] = useState(true);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [privacy, setPrivacy] = useState('unlisted');
  const [madeForKids, setMadeForKids] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [result, setResult] = useState<UploadResult | null>(null);
  const [history, setHistory] = useState<UploadHistory[]>([]);

  const videoAssets = useMemo(() => assets.filter((a) => a.type === 'video'), [assets]);
  const selectedAsset = useMemo(
    () => (source === 'render' ? null : videoAssets.find((a) => a.id === source) || null),
    [source, videoAssets]
  );

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER}/youtube/status`);
      const data = (await res.json()) as YouTubeStatus;
      setStatus(data);
      setStatusError('');
      return data;
    } catch (error) {
      setStatusError((error as Error).message);
      return null;
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER}/youtube/uploads?limit=10`);
      if (!res.ok) return;
      const data = (await res.json()) as { uploads: UploadHistory[] };
      setHistory(data.uploads);
    } catch {
      /* riwayat opsional */
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadHistory();
  }, [loadStatus, loadHistory]);

  // Poll saat belum terhubung supaya begitu callback OAuth selesai,
  // panel langsung berubah tanpa reload.
  useEffect(() => {
    if (!status || status.connected) return;
    const timer = window.setInterval(() => void loadStatus(), 4000);
    return () => window.clearInterval(timer);
  }, [status, loadStatus]);

  // Pilih default sumber + isi judul dari asset short bila ada
  useEffect(() => {
    if (!selectedAsset) return;
    const shortTitle = selectedAsset.shortMeta?.title;
    setTitle(shortTitle || selectedAsset.filename.replace(/\.[^.]+$/, ''));
    setDescription(selectedAsset.shortMeta?.hook || '');
  }, [selectedAsset]);

  const connect = () => {
    window.open(`${SERVER}/youtube/oauth/start`, '_blank', 'noopener');
  };

  const disconnect = async () => {
    if (!window.confirm('Putuskan koneksi YouTube? Upload berikutnya perlu menghubungkan ulang.')) return;
    await fetch(`${SERVER}/youtube/disconnect`, { method: 'POST' });
    setResult(null);
    await loadStatus();
  };

  const upload = async () => {
    if (!sessionId) return;
    setUploading(true);
    setUploadError('');
    setResult(null);
    try {
      const res = await fetch(`${SERVER}/youtube/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          ...(source === 'render' ? { renderFirst } : { assetId: source }),
          title,
          description,
          tags,
          privacyStatus: privacy,
          madeForKids,
        }),
      });
      const data = (await res.json()) as UploadResult & { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
      await loadHistory();
    } catch (error) {
      setUploadError((error as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const canUpload = Boolean(sessionId && status?.connected && title.trim() && !uploading);

  return (
    <div className="flex flex-col h-full bg-zinc-900/80 overflow-y-auto">
      {/* Header */}
      <div className="p-4 border-b border-zinc-800/50">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-red-500/20 border border-red-500/40 rounded-lg flex items-center justify-center">
            <Youtube className="w-4 h-4 text-red-400" />
          </div>
          <h2 className="font-semibold">YouTube</h2>
          {status?.connected && (
            <span className="ml-auto text-[10px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-full px-2 py-0.5 truncate max-w-[160px]">
              {status.channelTitle || status.channelId}
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-400 mt-2">
          Upload langsung ke channel YouTube Anda (OAuth resmi + Data API v3) — tanpa layanan pihak ketiga.
        </p>
      </div>

      {statusError && (
        <div className="p-3 bg-amber-500/10 border-b border-amber-500/20 flex gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-200">
            Server editor tidak terjangkau di {SERVER}. Jalankan <code>npm run ffmpeg-server</code>.
          </p>
        </div>
      )}

      {status && !status.configured && (
        <div className="p-3 bg-amber-500/10 border-b border-amber-500/20 flex gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-amber-200 space-y-1">
            <p className="font-medium">YouTube belum dikonfigurasi.</p>
            <p>
              Isi <code>YOUTUBE_CLIENT_ID</code> dan <code>YOUTUBE_CLIENT_SECRET</code> di <code>.dev.vars</code>, lalu
              daftarkan redirect URI berikut di Google Cloud Console:
            </p>
            <code className="block break-all text-amber-100">{status.redirectUri}</code>
            <p>Restart <code>npm run ffmpeg-server</code> setelah mengisi.</p>
          </div>
        </div>
      )}

      {status && status.configured && !status.connected && (
        <div className="p-4 border-b border-zinc-800/50 space-y-3">
          <button
            onClick={connect}
            className="w-full px-4 py-2.5 bg-red-600 hover:bg-red-500 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            <Youtube className="w-4 h-4" />
            Hubungkan ke YouTube
          </button>
          <p className="text-[11px] text-zinc-500">
            Tab baru akan terbuka untuk login Google. Setelah selesai, panel ini otomatis terhubung.
          </p>
        </div>
      )}

      {status?.connected && (
        <div className="p-4 space-y-4 border-b border-zinc-800/50">
          {/* Sumber video */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Sumber video</label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-zinc-500"
            >
              <option value="render">Render ekspor terbaru (timeline utama)</option>
              {videoAssets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.shortMeta?.title || asset.filename} · {formatDuration(asset.duration)}
                  {asset.shortMeta ? ' · short' : ''}
                </option>
              ))}
            </select>
            {source === 'render' && (
              <label className="flex items-center gap-2 text-xs text-zinc-400 pt-1">
                <input
                  type="checkbox"
                  checked={renderFirst}
                  onChange={(e) => setRenderFirst(e.target.checked)}
                  className="accent-zinc-400"
                />
                Render ulang timeline sebelum upload (butuh beberapa saat)
              </label>
            )}
          </div>

          {/* Judul */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Judul</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="Judul video"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-zinc-500"
            />
            <div className="text-[10px] text-zinc-600 text-right">{title.length}/100</div>
          </div>

          {/* Deskripsi */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Deskripsi</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Deskripsi / hashtag (#Shorts otomatis ditambahkan untuk video vertikal ≤ 3 menit)"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-zinc-500 resize-none"
            />
          </div>

          {/* Tag + privasi */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">Tag (pisahkan koma)</label>
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="shorts, tutorial"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs outline-none focus:border-zinc-500"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">Visibilitas</label>
              <select
                value={privacy}
                onChange={(e) => setPrivacy(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs outline-none focus:border-zinc-500"
              >
                {PRIVACY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-zinc-600">{PRIVACY_OPTIONS.find((o) => o.value === privacy)?.hint}</p>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={madeForKids}
              onChange={(e) => setMadeForKids(e.target.checked)}
              className="accent-zinc-400"
            />
            Video ini dibuat untuk anak-anak (made for kids)
          </label>

          <button
            onClick={() => void upload()}
            disabled={!canUpload}
            className="w-full px-4 py-2.5 bg-zinc-600 hover:bg-zinc-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading ? 'Mengunggah ke YouTube…' : 'Upload ke YouTube'}
          </button>
          {!sessionId && <p className="text-[11px] text-amber-300">Upload butuh session aktif — unggah video ke editor dulu.</p>}
          {uploading && <p className="text-[11px] text-zinc-500">Jangan tutup tab ini sampai upload selesai.</p>}

          {uploadError && (
            <div className="text-xs text-red-300 bg-red-950/50 border border-red-900 rounded-lg p-3 break-all">{uploadError}</div>
          )}

          {result && (
            <div className="text-xs bg-emerald-950/50 border border-emerald-900 rounded-lg p-3 space-y-2">
              <p className="flex items-center gap-1.5 text-emerald-300 font-medium">
                <CheckCircle2 className="w-4 h-4" />
                Upload berhasil {result.isShort ? '· Shorts' : ''} ({result.privacyStatus})
              </p>
              <p className="text-zinc-300 break-all">{result.title}</p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={result.shortsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" /> Buka Shorts
                </a>
                <a
                  href={result.studioUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" /> YouTube Studio
                </a>
              </div>
              {result.thumbnailError && (
                <p className="text-amber-300">Thumbnail gagal: {result.thumbnailError}</p>
              )}
            </div>
          )}

          <button
            onClick={() => void disconnect()}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1"
          >
            <LogOut className="w-3 h-3" /> Putuskan koneksi YouTube
          </button>
        </div>
      )}

      {/* Riwayat */}
      <div className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium text-zinc-400">Riwayat upload</h3>
          <button onClick={() => void loadHistory()} className="text-zinc-500 hover:text-zinc-300" title="Muat ulang">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        {history.length === 0 ? (
          <p className="text-[11px] text-zinc-600">Belum ada upload.</p>
        ) : (
          <ul className="space-y-1.5">
            {history.map((entry) => (
              <li key={entry.id} className="text-[11px] text-zinc-400 flex items-start gap-2">
                <span className={entry.status === 'uploaded' ? 'text-emerald-400' : 'text-red-400'}>
                  {entry.status === 'uploaded' ? '●' : '×'}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-zinc-300">{entry.title || entry.source || entry.video_id}</span>
                  <span className="text-zinc-600">
                    {entry.created_at} · {entry.privacy}
                    {entry.video_url ? (
                      <>
                        {' · '}
                        <a href={entry.video_url} target="_blank" rel="noreferrer" className="underline hover:text-zinc-300">
                          link
                        </a>
                      </>
                    ) : null}
                  </span>
                  {entry.error && <span className="block text-red-400/80 break-all">{entry.error}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
