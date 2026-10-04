// scripts/llm-pool.js
//
// Unified OpenAI-compatible LLM client with an ordered fallback list, backed by
// a local SQLite database (node:sqlite — built into Node 22.5+, no extra npm
// dependency).
//
// Every fallback entry is always described by the same three fields:
//   baseUrl + apiKey + model
// Chat / transcription / TTS calls loop through the enabled providers ordered
// by priority. A provider that errors, times out, returns 429 or 5xx is
// retried (max_retries) and then the loop moves to the next provider until one
// succeeds — otherwise the last error is thrown.
//
// The same DB is exposed over HTTP by scripts/local-ffmpeg-server.js
// (`/llm/providers`, `/llm/logs`, ...) and managed by the React page at
// `/settings/llm`.
//
// NOTE: older call sites used the native Anthropic Messages API
// (https://api.anthropic.com/v1/messages) and the OpenAI audio endpoints.
// Everything now goes through this pool. Anthropic is reached through its
// OpenAI SDK-compatible endpoint (base_url = https://api.anthropic.com/v1).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';

const DATA_DIR = process.env.LLM_DATA_DIR || join(process.cwd(), 'data');
export const LLM_DB_PATH = process.env.LLM_DB_PATH || join(DATA_DIR, 'llm.db');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_LOGS = 2000;

// Read lazily: .dev.vars is loaded by the server *after* module imports.
const env = (key, fallback = '') => (process.env[key] || fallback).trim();
const defaultTranscribeModel = () => env('TRANSCRIBE_MODEL', 'whisper-1');
const defaultTtsModel = () => env('TTS_MODEL', 'tts-1');
const defaultTtsInstructedModel = () => env('DIRECTOR_TTS_INSTRUCTED_MODEL', 'gpt-4o-mini-tts');

let _db = null;

function db() {
  if (_db) return _db;
  mkdirSync(dirname(LLM_DB_PATH), { recursive: true });
  _db = new DatabaseSync(LLM_DB_PATH);
  _db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS llm_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      transcribe_model TEXT NOT NULL DEFAULT '',
      tts_model TEXT NOT NULL DEFAULT '',
      timeout_ms INTEGER NOT NULL DEFAULT 30000,
      max_retries INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      chat_enabled INTEGER NOT NULL DEFAULT 1,
      transcribe_enabled INTEGER NOT NULL DEFAULT 1,
      tts_enabled INTEGER NOT NULL DEFAULT 1,
      video_enabled INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS llm_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'server',
      kind TEXT NOT NULL DEFAULT 'chat',
      provider_id INTEGER,
      provider_name TEXT,
      model TEXT,
      fallback_index INTEGER,
      attempt INTEGER,
      success INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      status_code INTEGER,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS llm_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);
  seedFromEnv(_db);
  migrateProviderCapabilities(_db);
  return _db;
}

// Databases created before per-service pools exist get the three capability
// columns added in place. Default 1 keeps the previous behavior (provider was
// used for every endpoint) until the user unchecks unsupported services.
// `video_enabled` is separate: video generation is a new capability, so it
// defaults to 0 and only providers the user marks as video are tried.
function migrateProviderCapabilities(conn) {
  const columns = conn.prepare(`PRAGMA table_info(llm_providers)`).all().map((row) => row.name);
  for (const column of ['chat_enabled', 'transcribe_enabled', 'tts_enabled']) {
    if (!columns.includes(column)) {
      conn.exec(`ALTER TABLE llm_providers ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 1`);
      console.log(`[llm-pool] Migrasi: kolom ${column} ditambahkan`);
    }
  }
  if (!columns.includes('video_enabled')) {
    conn.exec(`ALTER TABLE llm_providers ADD COLUMN video_enabled INTEGER NOT NULL DEFAULT 0`);
    console.log(`[llm-pool] Migrasi: kolom video_enabled ditambahkan`);
  }
}

// Populate the pool once from the legacy .dev.vars keys so an existing setup
// keeps working without opening the settings page first.
function seedFromEnv(conn) {
  const seeded = conn.prepare(`SELECT value FROM llm_settings WHERE key = 'seeded'`).get();
  if (seeded) return;

  let priority = 0;
  const add = (name, baseUrl, apiKey, model, caps = { chat: true, transcribe: true, tts: true }) => {
    if (!apiKey) return;
    conn
      .prepare(
        `INSERT INTO llm_providers (name, base_url, api_key, model, timeout_ms, max_retries, enabled, chat_enabled, transcribe_enabled, tts_enabled, priority)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
      )
      .run(
        name,
        baseUrl,
        apiKey,
        model,
        DEFAULT_TIMEOUT_MS,
        1,
        caps.chat ? 1 : 0,
        caps.transcribe ? 1 : 0,
        caps.tts ? 1 : 0,
        priority
      );
    priority += 1;
  };

  // Anthropic's OpenAI-compatible layer is chat-only, so it stays out of the
  // transcription/TTS fallback lists by default.
  add(
    'Anthropic (OpenAI-compatible)',
    env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1'),
    env('ANTHROPIC_API_KEY'),
    env('ANTHROPIC_MODEL', 'claude-sonnet-5'),
    { chat: true, transcribe: false, tts: false }
  );
  add(
    'OpenAI',
    env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    env('OPENAI_API_KEY'),
    env('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    { chat: true, transcribe: true, tts: true }
  );

  conn.prepare(`INSERT OR REPLACE INTO llm_settings (key, value) VALUES ('seeded', '1')`).run();
}

// Explicit re-seed from .dev.vars (used by the "Impor dari .dev.vars" button
// on /settings/llm). Only runs while the pool is empty so it never duplicates
// entries the user already manages.
export function seedFromEnvNow() {
  const conn = db();
  const count = conn.prepare(`SELECT COUNT(*) AS n FROM llm_providers`).get().n;
  if (count > 0) return { added: 0, reason: 'pool is not empty' };
  conn.prepare(`DELETE FROM llm_settings WHERE key = 'seeded'`).run();
  seedFromEnv(conn);
  const added = conn.prepare(`SELECT COUNT(*) AS n FROM llm_providers`).get().n;
  return { added };
}

// ---------------------------------------------------------------- helpers

const trimSlash = (url) => String(url || '').trim().replace(/\/+$/, '');

export function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 3)}••••••••${key.slice(-4)}`;
}

function rowToPublic(row) {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    model: row.model,
    transcribe_model: row.transcribe_model,
    tts_model: row.tts_model,
    timeout_ms: row.timeout_ms,
    max_retries: row.max_retries,
    enabled: Boolean(row.enabled),
    chat_enabled: Boolean(row.chat_enabled),
    transcribe_enabled: Boolean(row.transcribe_enabled),
    tts_enabled: Boolean(row.tts_enabled),
    video_enabled: Boolean(row.video_enabled),
    priority: row.priority,
    has_api_key: Boolean(row.api_key),
    api_key_masked: maskApiKey(row.api_key),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToRuntime(row) {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    api_key: row.api_key,
    model: row.model,
    transcribe_model: row.transcribe_model,
    tts_model: row.tts_model,
    timeout_ms: row.timeout_ms,
    max_retries: row.max_retries,
    chat_enabled: Boolean(row.chat_enabled),
    transcribe_enabled: Boolean(row.transcribe_enabled),
    tts_enabled: Boolean(row.tts_enabled),
    video_enabled: Boolean(row.video_enabled),
    priority: row.priority,
  };
}

function sanitizeProviderInput(input, { partial = false } = {}) {
  const out = {};
  const has = (key) => input[key] !== undefined && input[key] !== null;

  if (has('name')) out.name = String(input.name).trim();
  if (has('base_url')) out.base_url = trimSlash(input.base_url);
  if (has('model')) out.model = String(input.model).trim();
  if (has('transcribe_model')) out.transcribe_model = String(input.transcribe_model || '').trim();
  if (has('tts_model')) out.tts_model = String(input.tts_model || '').trim();
  if (has('api_key')) out.api_key = String(input.api_key || '').trim();
  if (has('clear_api_key')) out.clear_api_key = Boolean(input.clear_api_key);
  if (has('enabled')) out.enabled = input.enabled ? 1 : 0;
  if (has('chat_enabled')) out.chat_enabled = input.chat_enabled ? 1 : 0;
  if (has('transcribe_enabled')) out.transcribe_enabled = input.transcribe_enabled ? 1 : 0;
  if (has('tts_enabled')) out.tts_enabled = input.tts_enabled ? 1 : 0;
  if (has('video_enabled')) out.video_enabled = input.video_enabled ? 1 : 0;
  if (has('timeout_ms')) out.timeout_ms = Math.max(1000, Math.min(600000, parseInt(input.timeout_ms, 10) || DEFAULT_TIMEOUT_MS));
  if (has('max_retries')) out.max_retries = Math.max(0, Math.min(10, parseInt(input.max_retries, 10) || 0));

  if (!partial) {
    if (!out.name) throw new Error('name is required');
    if (!out.base_url || !/^https?:\/\//i.test(out.base_url)) throw new Error('base_url must be an http(s) URL');
    if (!out.model) throw new Error('model is required');
  }
  return out;
}

function logAttempt(entry) {
  try {
    const conn = db();
    conn
      .prepare(
        `INSERT INTO llm_logs (source, kind, provider_id, provider_name, model, fallback_index, attempt, success, latency_ms, status_code, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.source || 'server',
        entry.kind || 'chat',
        entry.provider_id ?? null,
        entry.provider_name ?? null,
        entry.model ?? null,
        entry.fallback_index ?? null,
        entry.attempt ?? null,
        entry.success ? 1 : 0,
        entry.latency_ms ?? null,
        entry.status_code ?? null,
        entry.error ? String(entry.error).slice(0, 500) : null
      );
    conn.prepare(`DELETE FROM llm_logs WHERE id NOT IN (SELECT id FROM llm_logs ORDER BY id DESC LIMIT ${MAX_LOGS})`).run();
  } catch (error) {
    console.error('[llm-pool] failed to write log:', error.message);
  }
}

// ---------------------------------------------------------------- CRUD

export function listProviders() {
  return db().prepare(`SELECT * FROM llm_providers ORDER BY priority ASC, id ASC`).all().map(rowToPublic);
}

const PROVIDER_CAPABILITY_COLUMNS = {
  chat: 'chat_enabled',
  transcription: 'transcribe_enabled',
  tts: 'tts_enabled',
  video: 'video_enabled',
};

export function getRuntimeProviders(capability = 'chat') {
  const column = PROVIDER_CAPABILITY_COLUMNS[capability] || 'chat_enabled';
  return db()
    .prepare(`SELECT * FROM llm_providers WHERE enabled = 1 AND ${column} = 1 ORDER BY priority ASC, id ASC`)
    .all()
    .map(rowToRuntime);
}

export function getProviderRow(id, { runtime = false } = {}) {
  const row = db().prepare(`SELECT * FROM llm_providers WHERE id = ?`).get(Number(id));
  if (!row) throw new Error(`provider ${id} not found`);
  return runtime ? rowToRuntime(row) : rowToPublic(row);
}

export function createProvider(input) {
  const data = sanitizeProviderInput(input);
  const maxPriority = db().prepare(`SELECT COALESCE(MAX(priority), -1) AS m FROM llm_providers`).get().m;
  const result = db()
    .prepare(
      `INSERT INTO llm_providers (name, base_url, api_key, model, transcribe_model, tts_model, timeout_ms, max_retries, enabled, chat_enabled, transcribe_enabled, tts_enabled, video_enabled, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.name,
      data.base_url,
      data.api_key || '',
      data.model,
      data.transcribe_model || '',
      data.tts_model || '',
      data.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      data.max_retries ?? 1,
      data.enabled ?? 1,
      data.chat_enabled ?? 1,
      data.transcribe_enabled ?? 1,
      data.tts_enabled ?? 1,
      data.video_enabled ?? 0,
      maxPriority + 1
    );
  return getProviderRow(Number(result.lastInsertRowid));
}

export function updateProvider(id, input) {
  const existing = db().prepare(`SELECT * FROM llm_providers WHERE id = ?`).get(Number(id));
  if (!existing) throw new Error(`provider ${id} not found`);
  const data = sanitizeProviderInput(input, { partial: true });

  const next = {
    name: data.name !== undefined ? data.name : existing.name,
    base_url: data.base_url !== undefined ? data.base_url : existing.base_url,
    model: data.model !== undefined ? data.model : existing.model,
    transcribe_model: data.transcribe_model !== undefined ? data.transcribe_model : existing.transcribe_model,
    tts_model: data.tts_model !== undefined ? data.tts_model : existing.tts_model,
    api_key: existing.api_key,
    timeout_ms: data.timeout_ms !== undefined ? data.timeout_ms : existing.timeout_ms,
    max_retries: data.max_retries !== undefined ? data.max_retries : existing.max_retries,
    enabled: data.enabled !== undefined ? data.enabled : existing.enabled,
    chat_enabled: data.chat_enabled !== undefined ? data.chat_enabled : existing.chat_enabled,
    transcribe_enabled: data.transcribe_enabled !== undefined ? data.transcribe_enabled : existing.transcribe_enabled,
    tts_enabled: data.tts_enabled !== undefined ? data.tts_enabled : existing.tts_enabled,
    video_enabled: data.video_enabled !== undefined ? data.video_enabled : existing.video_enabled,
  };

  if (data.clear_api_key) next.api_key = '';
  else if (data.api_key) next.api_key = data.api_key;

  if (!next.name) throw new Error('name is required');
  if (!next.base_url || !/^https?:\/\//i.test(next.base_url)) throw new Error('base_url must be an http(s) URL');
  if (!next.model) throw new Error('model is required');

  db()
    .prepare(
      `UPDATE llm_providers
       SET name = ?, base_url = ?, api_key = ?, model = ?, transcribe_model = ?, tts_model = ?,
           timeout_ms = ?, max_retries = ?, enabled = ?, chat_enabled = ?, transcribe_enabled = ?, tts_enabled = ?,
           video_enabled = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(
      next.name,
      next.base_url,
      next.api_key,
      next.model,
      next.transcribe_model,
      next.tts_model,
      next.timeout_ms,
      next.max_retries,
      next.enabled,
      next.chat_enabled,
      next.transcribe_enabled,
      next.tts_enabled,
      next.video_enabled,
      Number(id)
    );
  return getProviderRow(Number(id));
}

export function deleteProvider(id) {
  const result = db().prepare(`DELETE FROM llm_providers WHERE id = ?`).run(Number(id));
  if (!result.changes) throw new Error(`provider ${id} not found`);
  return { deleted: Number(id) };
}

export function reorderProviders(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('ids array is required');
  const conn = db();
  const update = conn.prepare(`UPDATE llm_providers SET priority = ?, updated_at = datetime('now') WHERE id = ?`);
  conn.exec('BEGIN');
  try {
    ids.forEach((id, index) => update.run(index, Number(id)));
    conn.exec('COMMIT');
  } catch (error) {
    conn.exec('ROLLBACK');
    throw error;
  }
  return listProviders();
}

export function listLogs(limit = 100) {
  const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
  return db().prepare(`SELECT * FROM llm_logs ORDER BY id DESC LIMIT ?`).all(n);
}

export function clearLogs() {
  const result = db().prepare(`DELETE FROM llm_logs`).run();
  return { deleted: result.changes };
}

export function addExternalLog(entry) {
  logAttempt({ source: entry.source || 'external', ...entry });
  return { ok: true };
}

export function poolStatus() {
  const conn = db();
  const totals = conn
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
       FROM llm_providers`
    )
    .get();
  const logs = conn.prepare(`SELECT COUNT(*) AS n FROM llm_logs`).get().n;
  return {
    db_path: LLM_DB_PATH,
    provider_count: totals.total || 0,
    enabled_count: totals.enabled || 0,
    log_count: logs || 0,
  };
}

// ---------------------------------------------------------------- transport

// Accepts either a path relative to the provider base URL or an absolute URL
// (OpenRouter returns absolute polling URLs).
function resolveProviderUrl(provider, pathOrUrl) {
  const value = String(pathOrUrl || '');
  if (/^https?:\/\//i.test(value)) return value;
  return `${trimSlash(provider.base_url)}${value.startsWith('/') ? value : `/${value}`}`;
}

function providerFetch(provider, path, { method = 'POST', headers = {}, body, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || provider.timeout_ms || DEFAULT_TIMEOUT_MS);
  const url = resolveProviderUrl(provider, path);
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${provider.api_key}`,
      ...headers,
    },
    body,
    signal: controller.signal,
  })
    .catch((error) => {
      const wrapped = new Error(
        error.name === 'AbortError'
          ? `timeout after ${timeoutMs || provider.timeout_ms || DEFAULT_TIMEOUT_MS}ms`
          : `network error: ${error.message}`
      );
      wrapped.retryable = true;
      wrapped.requestUrl = url;
      throw wrapped;
    })
    .finally(() => clearTimeout(timer))
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const wrapped = new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
        wrapped.status = res.status;
        wrapped.retryable = res.status === 429 || res.status >= 500;
        wrapped.requestUrl = url;
        throw wrapped;
      }
      return res;
    });
}

function extractChatText(data) {
  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? '';
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
  }
  return String(content || '').trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One provider, up to max_retries retries for retryable failures (429/5xx/network/timeout).
async function chatWithProviders(providers, { system, messages, maxTokens = 1024, temperature, jsonMode = false, kind = 'chat', source = 'server', timeoutMs }) {
  const chatMessages = messages || (system ? [{ role: 'system', content: system }] : []);

  let lastError = null;

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const configuredTries = Math.max(1, (provider.max_retries ?? 0) + 1);
    // One extra slot may be used by the automatic token-budget bump below.
    const maxTries = configuredTries + 1;
    let budget = maxTokens;
    let budgetBumped = false;

    for (let attempt = 0; attempt < maxTries; attempt += 1) {
      const startedAt = Date.now();
      try {
        const res = await providerFetch(provider, '/chat/completions', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: provider.model,
            messages: chatMessages,
            max_tokens: budget,
            ...(temperature !== undefined ? { temperature } : {}),
            ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          }),
          timeoutMs,
        });
        const data = await res.json();
        const text = extractChatText(data);
        if (!text) {
          // Reasoning models (GLM, o-series, deepseek-r*, ...) can spend the
          // whole budget on hidden reasoning tokens and return empty content
          // with finish_reason=length. Flag it so the retry below raises the
          // budget instead of giving up.
          const finish = data?.choices?.[0]?.finish_reason;
          const reason =
            finish === 'length'
              ? 'empty completion: token budget exhausted by reasoning before any content (finish_reason=length)'
              : 'provider returned an empty completion';
          throw Object.assign(new Error(reason), { retryable: true, budgetExhausted: finish === 'length' });
        }
        logAttempt({
          source,
          kind,
          provider_id: provider.id,
          provider_name: provider.name,
          model: provider.model,
          fallback_index: index,
          attempt,
          success: 1,
          latency_ms: Date.now() - startedAt,
          status_code: res.status,
        });
        return { text, provider: provider.name, model: provider.model, fallback_index: index, latencyMs: Date.now() - startedAt, usage: data?.usage };
      } catch (error) {
        lastError = error;
        logAttempt({
          source,
          kind,
          provider_id: provider.id,
          provider_name: provider.name,
          model: provider.model,
          fallback_index: index,
          attempt,
          success: 0,
          latency_ms: Date.now() - startedAt,
          status_code: error.status ?? null,
          error: error.message,
        });
        if (error.budgetExhausted && !budgetBumped && budget < 32768) {
          budgetBumped = true;
          budget = Math.max(budget * 4, 1024);
          await sleep(150);
          continue; // same provider, larger token budget
        }
        if (error.retryable && attempt < configuredTries - 1) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        break; // move to the next provider in the fallback list
      }
    }
  }

  throw new Error(
    `All ${providers.length} LLM provider(s) failed. Last error: ${lastError?.message || 'unknown error'}`
  );
}

/**
 * Chat completion through the ordered fallback list.
 * @param {object} options
 * @param {string} [options.system] system prompt
 * @param {string} [options.user] single user message (ignored when `messages` is set)
 * @param {Array<{role:string, content:string}>} [options.messages] full message array
 * @param {string} [options.legacyApiKey] ad-hoc Anthropic key when the pool is empty
 */
export async function chatCompletion({
  system,
  user,
  messages,
  maxTokens = 1024,
  temperature,
  jsonMode = false,
  kind = 'chat',
  source = 'server',
  legacyApiKey,
  timeoutMs,
} = {}) {
  let providers = getRuntimeProviders();
  if (!providers.length && legacyApiKey) {
    providers = [
      {
        id: null,
        name: 'Anthropic (legacy env key)',
        base_url: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1'),
        api_key: legacyApiKey,
        model: env('ANTHROPIC_MODEL', 'claude-sonnet-5'),
        timeout_ms: DEFAULT_TIMEOUT_MS,
        max_retries: 1,
      },
    ];
  }
  if (!providers.length) {
    throw new Error('No LLM providers configured. Add one at /settings/llm or set ANTHROPIC_API_KEY / OPENAI_API_KEY in .dev.vars.');
  }
  const finalMessages =
    messages ||
    [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user ?? '' }];
  return chatWithProviders(providers, { messages: finalMessages, maxTokens, temperature, jsonMode, kind, source, timeoutMs });
}

// Kept for call sites that used to talk to the Anthropic Messages API.
export async function claudeCompat(apiKey, system, userMessage, maxTokens = 1024, kind = 'anthropic-compat') {
  const result = await chatCompletion({ system, user: userMessage, maxTokens, kind, legacyApiKey: apiKey });
  return result.text;
}

// ---------------------------------------------------------------- audio

/**
 * Whisper-style transcription through the fallback list.
 * `buildFormData(model)` must return a fresh FormData per attempt.
 */
export async function audioTranscription(buildFormData, { kind = 'transcription', source = 'server' } = {}) {
  const providers = getRuntimeProviders('transcription');
  if (!providers.length) {
    throw new Error('No transcription providers enabled. Aktifkan layanan "Transkripsi" pada salah satu provider di /settings/llm.');
  }

  let lastError = null;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const model = provider.transcribe_model || defaultTranscribeModel();
    const startedAt = Date.now();
    try {
      const formData = buildFormData(model);
      const res = await providerFetch(provider, '/audio/transcriptions', {
        headers: {},
        body: formData,
      });
      const data = await res.json();
      logAttempt({
        source,
        kind,
        provider_id: provider.id,
        provider_name: provider.name,
        model,
        fallback_index: index,
        attempt: 0,
        success: 1,
        latency_ms: Date.now() - startedAt,
        status_code: res.status,
      });
      return data;
    } catch (error) {
      lastError = error;
      logAttempt({
        source,
        kind,
        provider_id: provider.id,
        provider_name: provider.name,
        model,
        fallback_index: index,
        attempt: 0,
        success: 0,
        latency_ms: Date.now() - startedAt,
        status_code: error.status ?? null,
        error: error.message,
      });
    }
  }

  throw new Error(
    `All ${providers.length} provider(s) failed for ${kind}. Last error: ${lastError?.message || 'unknown error'}`
  );
}

/**
 * OpenAI-compatible text-to-speech through the fallback list.
 * Returns { buffer, provider, model, latencyMs }.
 */
export async function synthesizeSpeech({
  input,
  voice,
  instructions,
  format = 'mp3',
  kind = 'tts',
  source = 'server',
} = {}) {
  const providers = getRuntimeProviders('tts');
  if (!providers.length) {
    const error = new Error('tts-not-configured');
    error.code = 'tts-not-configured';
    throw error;
  }

  let lastError = null;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const model = instructions
      ? defaultTtsInstructedModel()
      : provider.tts_model || defaultTtsModel();
    const startedAt = Date.now();
    try {
      const res = await providerFetch(provider, '/audio/speech', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          voice: voice || env('DIRECTOR_TTS_VOICE', 'onyx'),
          input: String(input || '').slice(0, 1200),
          ...(instructions ? { instructions: String(instructions).slice(0, 600) } : {}),
          response_format: format,
        }),
      });
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(`provider returned JSON instead of audio: ${text.slice(0, 200)}`), { retryable: false });
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      logAttempt({
        source,
        kind,
        provider_id: provider.id,
        provider_name: provider.name,
        model,
        fallback_index: index,
        attempt: 0,
        success: 1,
        latency_ms: Date.now() - startedAt,
        status_code: res.status,
      });
      return { buffer, provider: provider.name, model, latencyMs: Date.now() - startedAt };
    } catch (error) {
      lastError = error;
      logAttempt({
        source,
        kind,
        provider_id: provider.id,
        provider_name: provider.name,
        model,
        fallback_index: index,
        attempt: 0,
        success: 0,
        latency_ms: Date.now() - startedAt,
        status_code: error.status ?? null,
        error: error.message,
      });
    }
  }

  throw new Error(`All ${providers.length} provider(s) failed for TTS. Last error: ${lastError?.message || 'unknown error'}`);
}

// ---------------------------------------------------------------- video

const DEFAULT_VIDEO_POLL_INTERVAL_MS = 5000;
const DEFAULT_VIDEO_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Video generation through the fallback list. Video models use OpenRouter's
 * asynchronous API: POST {base_url}/videos returns { id, polling_url, status },
 * which is polled until `completed`, then the MP4 is downloaded from
 * `unsigned_urls[0]` (or /videos/{id}/content).
 *
 * `imageDataUrl` (a `data:image/...;base64,...` string) is sent as a
 * first-frame image for image-to-video models.
 *
 * @returns {{ buffer: Buffer, provider: string, model: string, fallback_index: number, latencyMs: number, jobId: string, cost: number|null }}
 */
export async function generateVideo({
  prompt,
  imageDataUrl,
  duration,
  resolution,
  aspectRatio,
  generateAudio,
  kind = 'video',
  source = 'server',
  pollIntervalMs = DEFAULT_VIDEO_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_VIDEO_TIMEOUT_MS,
} = {}) {
  const providers = getRuntimeProviders('video');
  if (!providers.length) {
    const error = new Error('No video provider enabled. Aktifkan layanan "Video" pada salah satu provider di /settings/llm.');
    error.code = 'video-not-configured';
    throw error;
  }

  let lastError = null;

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const startedAt = Date.now();

    try {
      const submitBody = {
        model: provider.model,
        ...(prompt ? { prompt } : {}),
        ...(duration ? { duration: Number(duration) } : {}),
        ...(resolution ? { resolution } : {}),
        ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        ...(generateAudio !== undefined ? { generate_audio: Boolean(generateAudio) } : {}),
        ...(imageDataUrl
          ? {
              frame_images: [
                { type: 'image_url', image_url: { url: imageDataUrl }, frame_type: 'first_frame' },
              ],
            }
          : {}),
      };

      const submitRes = await providerFetch(provider, '/videos', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitBody),
      });
      let job = await submitRes.json();
      const jobId = job?.id || '';
      const pollingUrl = job?.polling_url || (jobId ? `/videos/${jobId}` : null);
      if (!pollingUrl) throw new Error('video provider did not return a polling_url');

      const deadline = Date.now() + timeoutMs;
      while (job.status !== 'completed') {
        if (['failed', 'cancelled', 'expired'].includes(job.status)) {
          throw new Error(`video job ${job.status}: ${job.error || 'no error detail'}`);
        }
        if (Date.now() > deadline) {
          throw new Error(`video job timed out after ${Math.round(timeoutMs / 1000)}s (last status: ${job.status || 'unknown'})`);
        }
        await sleep(pollIntervalMs);
        const pollRes = await providerFetch(provider, pollingUrl, { method: 'GET' });
        job = await pollRes.json();
      }

      const downloadPath = job.unsigned_urls?.[0] || `/videos/${jobId}/content?index=0`;
      const videoRes = await providerFetch(provider, downloadPath, { method: 'GET', timeoutMs: 180000 });
      const buffer = Buffer.from(await videoRes.arrayBuffer());
      const latencyMs = Date.now() - startedAt;

      logAttempt({
        source,
        kind,
        provider_id: provider.id,
        provider_name: provider.name,
        model: provider.model,
        fallback_index: index,
        attempt: 0,
        success: 1,
        latency_ms: latencyMs,
        status_code: 200,
      });

      return {
        buffer,
        provider: provider.name,
        model: provider.model,
        fallback_index: index,
        latencyMs,
        jobId,
        cost: job.usage?.cost ?? null,
      };
    } catch (error) {
      lastError = error;
      logAttempt({
        source,
        kind,
        provider_id: provider.id,
        provider_name: provider.name,
        model: provider.model,
        fallback_index: index,
        attempt: 0,
        success: 0,
        latency_ms: Date.now() - startedAt,
        status_code: error.status ?? null,
        error: error.message,
      });
    }
  }

  throw new Error(
    `All ${providers.length} video provider(s) failed. Last error: ${lastError?.message || 'unknown error'}`
  );
}

// ---------------------------------------------------------------- testing

export async function testProvider(id, capability = 'chat') {
  const provider = getProviderRow(id, { runtime: true });
  const startedAt = Date.now();

  if (capability === 'tts') {
    const model = provider.tts_model || defaultTtsModel();
    try {
      const res = await providerFetch(provider, '/audio/speech', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          voice: env('DIRECTOR_TTS_VOICE', 'onyx'),
          input: 'pong',
          response_format: 'mp3',
        }),
      });
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const text = await res.text().catch(() => '');
        throw new Error(`provider returned JSON instead of audio: ${text.slice(0, 200)}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      logAttempt({
        source: 'settings-page',
        kind: 'test-tts',
        provider_id: provider.id,
        provider_name: provider.name,
        model,
        fallback_index: 0,
        attempt: 0,
        success: 1,
        latency_ms: Date.now() - startedAt,
        status_code: res.status,
      });
      return { ok: true, capability: 'tts', provider: provider.name, model, latency_ms: Date.now() - startedAt, reply: `audio ${buffer.length} bytes` };
    } catch (error) {
      logAttempt({
        source: 'settings-page',
        kind: 'test-tts',
        provider_id: provider.id,
        provider_name: provider.name,
        model,
        fallback_index: 0,
        attempt: 0,
        success: 0,
        latency_ms: Date.now() - startedAt,
        status_code: error.status ?? null,
        error: error.message,
      });
      return { ok: false, capability: 'tts', provider: provider.name, model, latency_ms: Date.now() - startedAt, error: error.message };
    }
  }

  if (capability === 'video') {
    // A real test would generate a paid video; direct users to DiCaprio.
    return {
      ok: false,
      capability: 'video',
      provider: provider.name,
      model: provider.model,
      latency_ms: 0,
      error: 'Uji video tidak tersedia dari halaman (berbiaya per detik). Uji lewat DiCaprio → Animate Image.',
    };
  }

  if (capability === 'transcription') {
    // Not testable from the settings page: the endpoint needs a multipart
    // audio file. Real transcription runs record to llm_logs instead.
    return {
      ok: false,
      capability: 'transcription',
      provider: provider.name,
      model: provider.transcribe_model || defaultTranscribeModel(),
      latency_ms: 0,
      error: 'Transkripsi tidak bisa diuji dari halaman (butuh file audio). Uji lewat fitur caption/transkrip.',
    };
  }

  try {
    const result = await chatWithProviders([provider], {
      messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
      maxTokens: 512, // cukup untuk model reasoning sebelum menghasilkan konten
      kind: 'test',
      source: 'settings-page',
    });
    return { ok: true, capability: 'chat', provider: provider.name, model: provider.model, latency_ms: result.latencyMs, reply: result.text.slice(0, 200) };
  } catch (error) {
    return { ok: false, capability: 'chat', provider: provider.name, model: provider.model, latency_ms: Date.now() - startedAt, error: error.message };
  }
}

export async function testAllProviders(capability = 'chat') {
  const column = PROVIDER_CAPABILITY_COLUMNS[capability] || 'chat_enabled';
  const rows = db()
    .prepare(`SELECT id FROM llm_providers WHERE enabled = 1 AND ${column} = 1 ORDER BY priority ASC, id ASC`)
    .all();
  const results = [];
  for (const row of rows) {
    results.push(await testProvider(row.id, capability));
  }
  return results;
}
