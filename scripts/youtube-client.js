// YouTube Data API v3 client — OAuth (offline refresh token) + resumable
// upload + thumbnail. Ini jalur upload native, pengganti CreatorOS untuk
// YouTube: video langsung dikirim ke channel milik pengguna.
//
// Konfigurasi (.dev.vars):
//   YOUTUBE_CLIENT_ID      OAuth client ID (Google Cloud Console)
//   YOUTUBE_CLIENT_SECRET  OAuth client secret
//   YOUTUBE_REDIRECT_URI   default http://localhost:3333/youtube/oauth/callback
//
// Refresh token disimpan di SQLite (data/youtube.db, gitignored). Riwayat
// upload juga tercatat di sana.
//
// Endpoint Google bisa dioverride untuk pengujian:
//   YOUTUBE_TOKEN_URL, YOUTUBE_API_BASE, YOUTUBE_UPLOAD_BASE, YOUTUBE_AUTH_URL

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

const DATA_DIR = process.env.LLM_DATA_DIR || join(process.cwd(), 'data');
const DB_PATH = process.env.YOUTUBE_DB_PATH || join(DATA_DIR, 'youtube.db');

const AUTH_URL = process.env.YOUTUBE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.YOUTUBE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const API_BASE = process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3';
const UPLOAD_BASE = process.env.YOUTUBE_UPLOAD_BASE || 'https://www.googleapis.com/upload/youtube/v3';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const DEFAULT_REDIRECT_URI = 'http://localhost:3333/youtube/oauth/callback';
const PRIVACY_VALUES = new Set(['private', 'unlisted', 'public']);
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

let _db = null;

function db() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS youtube_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      refresh_token TEXT NOT NULL,
      access_token TEXT NOT NULL DEFAULT '',
      access_token_expires_at INTEGER NOT NULL DEFAULT 0,
      channel_id TEXT NOT NULL DEFAULT '',
      channel_title TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS youtube_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT,
      title TEXT,
      privacy TEXT,
      source TEXT,
      video_url TEXT,
      status TEXT NOT NULL DEFAULT 'uploaded',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return _db;
}

// ------------------------------------------------------------------ config

const env = (key, fallback = '') => (process.env[key] || fallback).trim();

export function youtubeConfigured() {
  return Boolean(env('YOUTUBE_CLIENT_ID') && env('YOUTUBE_CLIENT_SECRET'));
}

export function getRedirectUri() {
  return env('YOUTUBE_REDIRECT_URI', DEFAULT_REDIRECT_URI);
}

function getAuthRow() {
  return db().prepare(`SELECT * FROM youtube_auth WHERE id = 1`).get() || null;
}

export function youtubeStatus() {
  const row = getAuthRow();
  return {
    configured: youtubeConfigured(),
    connected: Boolean(row?.refresh_token),
    channelId: row?.channel_id || '',
    channelTitle: row?.channel_title || '',
    redirectUri: getRedirectUri(),
  };
}

// ------------------------------------------------------------------ oauth

// state → createdAt, agar callback hanya menerima alur yang kita mulai.
const pendingStates = new Map();
const STATE_TTL_MS = 15 * 60_000;

export function buildYouTubeAuthUrl() {
  if (!youtubeConfigured()) {
    throw new Error('YouTube belum dikonfigurasi: isi YOUTUBE_CLIENT_ID dan YOUTUBE_CLIENT_SECRET di .dev.vars');
  }
  const state = randomUUID();
  pendingStates.set(state, Date.now());
  for (const [key, at] of pendingStates) {
    if (Date.now() - at > STATE_TTL_MS) pendingStates.delete(key);
  }
  const params = new URLSearchParams({
    client_id: env('YOUTUBE_CLIENT_ID'),
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(form) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error_description || data?.error || `HTTP ${res.status}`;
    throw new Error(`YouTube token error: ${message}`);
  }
  return data;
}

async function fetchChannel(accessToken) {
  const res = await fetch(`${API_BASE}/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { id: '', title: '' };
  const channel = data?.items?.[0];
  return { id: channel?.id || '', title: channel?.snippet?.title || '' };
}

/** Tukar authorization code menjadi refresh token, lalu simpan. */
export async function completeYouTubeOAuth(code, state) {
  if (!youtubeConfigured()) throw new Error('YouTube belum dikonfigurasi');
  if (!code) throw new Error('Parameter code tidak ada di callback');
  if (!state || !pendingStates.has(state)) throw new Error('State OAuth tidak dikenal atau kedaluwarsa — ulangi dari tombol Hubungkan');
  pendingStates.delete(state);

  const tokens = await tokenRequest({
    client_id: env('YOUTUBE_CLIENT_ID'),
    client_secret: env('YOUTUBE_CLIENT_SECRET'),
    code,
    grant_type: 'authorization_code',
    redirect_uri: getRedirectUri(),
  });
  if (!tokens.refresh_token) {
    throw new Error('Google tidak mengirim refresh_token. Cabut akses aplikasi di myaccount.google.com/permissions lalu hubungkan ulang.');
  }

  const channel = await fetchChannel(tokens.access_token);
  db()
    .prepare(
      `INSERT INTO youtube_auth (id, refresh_token, access_token, access_token_expires_at, channel_id, channel_title, scope, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         refresh_token = excluded.refresh_token,
         access_token = excluded.access_token,
         access_token_expires_at = excluded.access_token_expires_at,
         channel_id = excluded.channel_id,
         channel_title = excluded.channel_title,
         scope = excluded.scope,
         updated_at = datetime('now')`
    )
    .run(
      tokens.refresh_token,
      tokens.access_token || '',
      Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
      channel.id,
      channel.title,
      tokens.scope || ''
    );
  console.log(`[YouTube] Terhubung ke channel ${channel.title || channel.id}`);
  return youtubeStatus();
}

async function getAccessToken() {
  const row = getAuthRow();
  if (!row?.refresh_token) throw new Error('YouTube belum terhubung — klik Hubungkan ke YouTube dulu');
  if (row.access_token && row.access_token_expires_at > Date.now() + 60_000) {
    return row.access_token;
  }
  const tokens = await tokenRequest({
    client_id: env('YOUTUBE_CLIENT_ID'),
    client_secret: env('YOUTUBE_CLIENT_SECRET'),
    refresh_token: row.refresh_token,
    grant_type: 'refresh_token',
  });
  db()
    .prepare(`UPDATE youtube_auth SET access_token = ?, access_token_expires_at = ?, updated_at = datetime('now') WHERE id = 1`)
    .run(tokens.access_token || '', Date.now() + (Number(tokens.expires_in) || 3600) * 1000);
  return tokens.access_token;
}

export function disconnectYouTube() {
  db().prepare(`DELETE FROM youtube_auth WHERE id = 1`).run();
  return { ok: true };
}

// ------------------------------------------------------------------ upload

function recordUpload(entry) {
  db()
    .prepare(
      `INSERT INTO youtube_uploads (video_id, title, privacy, source, video_url, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.video_id || null,
      entry.title || null,
      entry.privacy || null,
      entry.source || null,
      entry.video_url || null,
      entry.status || 'uploaded',
      entry.error ? String(entry.error).slice(0, 500) : null
    );
}

export function listYouTubeUploads(limit = 20) {
  const n = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  return db().prepare(`SELECT * FROM youtube_uploads ORDER BY id DESC LIMIT ?`).all(n);
}

async function setThumbnail(accessToken, videoId, thumbnailPath) {
  const size = statSync(thumbnailPath).size;
  if (size > MAX_THUMBNAIL_BYTES) throw new Error(`thumbnail lebih dari 2 MB (${size} bytes)`);
  const ext = thumbnailPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const res = await fetch(`${UPLOAD_BASE}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': ext },
    body: readFileSync(thumbnailPath),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
}

/**
 * Upload satu file video ke YouTube (resumable upload).
 * @param {object} options
 * @param {string} options.filePath
 * @param {string} options.title
 * @param {string} [options.description]
 * @param {string[]} [options.tags]
 * @param {'private'|'unlisted'|'public'} [options.privacyStatus]
 * @param {string} [options.categoryId] default 22 (People & Blogs)
 * @param {boolean} [options.madeForKids]
 * @param {boolean} [options.notifySubscribers]
 * @param {string} [options.thumbnailPath]
 * @param {string} [options.source] label asal video (asset/render)
 */
export async function uploadToYouTube({
  filePath,
  title,
  description = '',
  tags = [],
  privacyStatus = 'unlisted',
  categoryId = '22',
  madeForKids = false,
  notifySubscribers = true,
  thumbnailPath = '',
  source = '',
}) {
  if (!youtubeConfigured()) throw new Error('YouTube belum dikonfigurasi (YOUTUBE_CLIENT_ID/SECRET)');
  if (!filePath || !existsSync(filePath)) throw new Error(`File video tidak ditemukan: ${filePath}`);
  if (!title || !String(title).trim()) throw new Error('Judul video wajib diisi');
  const privacy = PRIVACY_VALUES.has(privacyStatus) ? privacyStatus : 'unlisted';

  const accessToken = await getAccessToken();
  const size = statSync(filePath).size;
  const cleanTitle = String(title).trim().slice(0, 100);
  const cleanDescription = String(description || '').slice(0, 5000);
  const cleanTags = (Array.isArray(tags) ? tags : String(tags || '').split(','))
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, 30);

  try {
    // 1. Mulai sesi resumable upload
    const initRes = await fetch(
      `${UPLOAD_BASE}/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${notifySubscribers ? 'true' : 'false'}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(size),
          'X-Upload-Content-Type': 'video/mp4',
        },
        body: JSON.stringify({
          snippet: { title: cleanTitle, description: cleanDescription, tags: cleanTags, categoryId: String(categoryId) },
          status: { privacyStatus: privacy, selfDeclaredMadeForKids: Boolean(madeForKids) },
        }),
      }
    );
    if (!initRes.ok) {
      const data = await initRes.json().catch(() => ({}));
      throw new Error(data?.error?.message || `init upload HTTP ${initRes.status}`);
    }
    const uploadUrl = initRes.headers.get('location');
    if (!uploadUrl) throw new Error('Google tidak mengembalikan URL upload (Location header kosong)');

    // 2. Kirim bytes video
    console.log(`[YouTube] Uploading ${cleanTitle} (${(size / 1024 / 1024).toFixed(1)} MB, ${privacy})...`);
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) },
      body: readFileSync(filePath),
    });
    const video = await putRes.json().catch(() => ({}));
    if (!putRes.ok) {
      throw new Error(video?.error?.message || `upload HTTP ${putRes.status}`);
    }
    const videoId = video?.id;
    if (!videoId) throw new Error('Upload selesai tanpa video id');

    // 3. Thumbnail opsional (gagal thumbnail tidak membatalkan upload)
    let thumbnailError = '';
    if (thumbnailPath && existsSync(thumbnailPath)) {
      try {
        await setThumbnail(accessToken, videoId, thumbnailPath);
      } catch (error) {
        thumbnailError = error.message;
        console.warn(`[YouTube] Thumbnail gagal: ${error.message}`);
      }
    }

    const result = {
      videoId,
      title: video?.snippet?.title || cleanTitle,
      privacyStatus: video?.status?.privacyStatus || privacy,
      watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
      shortsUrl: `https://www.youtube.com/shorts/${videoId}`,
      studioUrl: `https://studio.youtube.com/video/${videoId}/edit`,
      thumbnailError: thumbnailError || null,
    };
    recordUpload({ video_id: videoId, title: result.title, privacy: result.privacyStatus, source, video_url: result.shortsUrl, status: 'uploaded' });
    console.log(`[YouTube] Upload selesai: ${result.shortsUrl}`);
    return result;
  } catch (error) {
    recordUpload({ title: cleanTitle, privacy, source, status: 'failed', error: error.message });
    throw error;
  }
}
