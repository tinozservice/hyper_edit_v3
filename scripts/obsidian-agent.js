// Obsidian agent: searches the "Marketing OS Broll" Obsidian vault (a media
// knowledge graph) and imports matching files straight into a session.
//
// The vault is a plain folder. Every media file has a sidecar markdown note
// with YAML frontmatter (name, type, pillar, brand, kind, file, poster,
// aliases, tags, colors, description, width/height/duration). This module
// indexes those notes and lets Jev (TypeSafe System One) judge the whole
// vault in one call to find exactly what a request asks for. Keyword scoring
// exists only as the fallback when TYPESAFE_API_KEY is missing.
//
// Config:
//   OBSIDIAN_VAULT_PATH  vault root (defaults to the Marketing OS Broll vault)
//   TYPESAFE_API_KEY     Jev — the agent's brain

import { readFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, relative, extname, basename, dirname } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { askJev, jevConfigured, noul } from './jev.js';

const DEFAULT_VAULT_PATH =
  "/Users/<user>/Documents/Documents - My Mac (2)/Media /Marketing OS Broll/Marketing OS Broll";

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v', '.mkv']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac']);

export function getVaultPath() {
  const explicit = process.env.OBSIDIAN_VAULT_PATH?.trim();
  return explicit || DEFAULT_VAULT_PATH;
}

// ---------- local mirror ----------
//
// The vault lives in an iCloud-synced folder. macOS can evict those files to
// "dataless" placeholders at any time, and a plain read then blocks until
// iCloud re-downloads it — which froze the whole server. So we never read the
// vault directly: an rsync child process copies it to a non-synced mirror
// under ~/.clipwise, and everything (index, thumbnails, imports) reads the
// mirror. The child may block on iCloud; the server does not.

const MIRROR_ROOT = join(homedir(), '.clipwise', 'vault-mirror');
const MIRROR_REFRESH_MS = 5 * 60_000;
const mirrorState = { syncing: false, lastStartedAt: 0, lastFinishedAt: 0, lastError: '', lastExitCode: null };

export function getMirrorPath() {
  const vault = getVaultPath();
  const name = basename(vault.replace(/\/+$/, '')) || 'vault';
  return join(MIRROR_ROOT, name);
}

/** Kick off (or skip, if fresh/running) an rsync of the vault into the mirror. Never blocks. */
export function syncMirror({ force = false } = {}) {
  const vault = getVaultPath();
  const mirror = getMirrorPath();
  if (mirrorState.syncing) return false;
  if (!force && Date.now() - mirrorState.lastFinishedAt < MIRROR_REFRESH_MS) return false;
  if (!existsSync(vault)) { mirrorState.lastError = `vault not found at ${vault}`; return false; }
  mkdirSync(mirror, { recursive: true });
  mirrorState.syncing = true;
  mirrorState.lastStartedAt = Date.now();
  mirrorState.lastError = '';
  const child = spawn('rsync', ['-a', '--delete', '--exclude', '.obsidian', '--exclude', '.DS_Store', `${vault}/`, `${mirror}/`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 10 * 60_000);
  child.on('exit', (code) => {
    clearTimeout(killer);
    mirrorState.syncing = false;
    mirrorState.lastFinishedAt = Date.now();
    mirrorState.lastExitCode = code;
    if (code !== 0) mirrorState.lastError = `rsync exited ${code}: ${stderr.slice(0, 200)}`;
    cache.builtAt = 0; // re-index on next query
    console.log(`[Obsidian] Mirror sync ${code === 0 ? 'complete' : 'FAILED'} (${Math.round((Date.now() - mirrorState.lastStartedAt) / 1000)}s)`);
  });
  child.on('error', (err) => {
    clearTimeout(killer);
    mirrorState.syncing = false;
    mirrorState.lastFinishedAt = Date.now();
    mirrorState.lastError = err.message;
  });
  return true;
}

export function getMirrorState() {
  return { ...mirrorState, mirrorPath: getMirrorPath(), mirrorExists: existsSync(getMirrorPath()) };
}

// ---------- frontmatter ----------

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = text.slice(3, end).trim();
  const out = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    const raw = rawValue.trim();
    let value = raw;
    try {
      value = JSON.parse(raw); // notes store strings/arrays/numbers as JSON literals
    } catch {
      value = raw.replace(/^["']|["']$/g, '');
    }
    out[key] = value;
  }
  return out;
}

function mediaTypeFor(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return null;
}

// ---------- index ----------

let cache = { builtAt: 0, vault: '', items: [] };
const CACHE_TTL_MS = 10_000;

function walk(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

export function loadIndex({ force = false } = {}) {
  syncMirror(); // background refresh when stale; no-op if running or fresh
  const vault = getMirrorPath();
  const fresh = cache.vault === vault && Date.now() - cache.builtAt < CACHE_TTL_MS;
  if (fresh && !force) return cache.items;

  const items = [];
  if (existsSync(vault)) {
    for (const notePath of walk(vault)) {
      let fm;
      try { fm = parseFrontmatter(readFileSync(notePath, 'utf-8')); } catch { continue; }
      if (!fm || !fm.file) continue; // hub/index notes have no `file`

      const filePath = join(vault, String(fm.file));
      if (!existsSync(filePath)) continue;
      const type = (typeof fm.type === 'string' && ['video', 'image', 'audio'].includes(fm.type))
        ? fm.type
        : mediaTypeFor(filePath);
      if (!type) continue;

      const posterPath = fm.poster ? join(vault, String(fm.poster)) : '';
      const id = relative(vault, notePath).replace(/\.md$/, '');
      items.push({
        id,
        name: String(fm.name || basename(notePath, '.md')),
        type,
        pillar: fm.pillar ? String(fm.pillar) : '',
        brand: fm.brand ? String(fm.brand) : '',
        kind: fm.kind ? String(fm.kind) : '',
        hub: basename(dirname(notePath)),
        file: String(fm.file),
        filePath,
        posterPath: posterPath && existsSync(posterPath) ? posterPath : '',
        width: Number(fm.width) || 0,
        height: Number(fm.height) || 0,
        duration: Number(fm.duration) || 0,
        aliases: Array.isArray(fm.aliases) ? fm.aliases.map(String) : [],
        tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
        colors: Array.isArray(fm.colors) ? fm.colors.map(String) : [],
        description: fm.description ? String(fm.description) : '',
        sizeBytes: (() => { try { return statSync(filePath).size; } catch { return 0; } })(),
      });
    }
  }

  cache = { builtAt: Date.now(), vault, items };
  return items;
}

export function getItemById(id) {
  return loadIndex().find((it) => it.id === id) || null;
}

/** Thumbnail to show for an item: its poster, or the image itself. */
export function thumbnailPathFor(item) {
  if (!item) return '';
  if (item.posterPath) return item.posterPath;
  if (item.type === 'image') return item.filePath;
  return '';
}

export function getObsidianStatus() {
  const vault = getVaultPath();
  const exists = existsSync(vault);
  const items = exists ? loadIndex() : [];
  const mirror = getMirrorState();
  return {
    vaultPath: vault,
    vaultExists: exists,
    mirror: { path: mirror.mirrorPath, exists: mirror.mirrorExists, syncing: mirror.syncing, lastSyncedAt: mirror.lastFinishedAt || null, error: mirror.lastError || null },
    itemCount: items.length,
    videos: items.filter((i) => i.type === 'video').length,
    images: items.filter((i) => i.type === 'image').length,
    jev: jevConfigured(),
  };
}

// ---------- search ----------

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he', 'in', 'is', 'it', 'its',
  'of', 'on', 'that', 'the', 'to', 'was', 'were', 'will', 'with', 'i', 'me', 'my', 'we', 'you', 'your',
  'this', 'these', 'those', 'some', 'any', 'all', 'find', 'show', 'get', 'give', 'want', 'need', 'can',
  'could', 'would', 'should', 'please', 'video', 'videos', 'clip', 'clips', 'footage', 'image', 'images',
  'logo', 'logos', 'broll', 'roll', 'add', 'insert', 'put', 'use',
]);

function keywords(query) {
  return query.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

function keywordScore(item, words, wholeQuery) {
  const name = item.name.toLowerCase();
  const aliases = item.aliases.map((a) => a.toLowerCase());
  const tags = item.tags.map((t) => t.toLowerCase());
  const desc = item.description.toLowerCase();
  const brand = item.brand.toLowerCase();
  const hub = item.hub.toLowerCase();
  let score = 0;
  if (wholeQuery && (name.includes(wholeQuery) || aliases.some((a) => a === wholeQuery))) score += 6;
  for (const w of words) {
    if (name.includes(w)) score += 4;
    if (aliases.some((a) => a.includes(w))) score += 4;
    if (brand && (brand.includes(w) || w.includes(brand))) score += 3;
    if (hub.includes(w)) score += 2;
    if (tags.some((t) => t.includes(w))) score += 2;
    if (item.kind && item.kind.toLowerCase().includes(w)) score += 2;
    if (desc.includes(w)) score += 1;
  }
  return score;
}

// ---------- Jev media agent ----------
//
// queryVault(message) is the agent. Plain-English ask in, vault rows out.
//
//  1. One small Jev call reads the intent: singular vs plural, media kind
//     (logo/profile/clip/any), pillar, the brand explicitly named (or none),
//     and whether the ask describes content beyond brand + kind.
//  2. Code applies the vault rules: family expansion for AI-company hubs,
//     exact-brand only for our own brand assets, logo == icon, clips separate,
//     brand narrowing only when a brand is actually named.
//  3. Deterministic ranking: exact brand > plain "Brand logo" > logo > icon >
//     profile > clip > biggest resolution.
//  4. Only for descriptive asks ("the pink jev mark", "basketball footage") or
//     an unnamed-brand singular pick does Jev judge the candidates one by one.
//  Singular → exactly one row plus `more`; plural → every row.

const KIND_RANK = { logo: 3, icon: 2, profile: 1, clip: 0 };
const PLURAL_CAP = 200;
const JUDGE_CAP = 150;

function titleFromBrand(brand) {
  return brand.replace(/[-_]+/g, ' ').trim();
}

/** "Claude logo" beats "Claude icon (invader, solid)" and "Claude Code banner". */
function isPlainMark(item) {
  const n = item.name.toLowerCase();
  if (/[()]/.test(n)) return false;
  const words = n.split(/\s+/);
  return (words[words.length - 1] === 'logo' || words[words.length - 1] === 'icon') && words.length <= 3;
}

function norm(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The canonical "<Brand> logo" / "<Brand> icon" for the named brand. */
function isBrandMark(item, brand) {
  if (!brand) return false;
  const n = norm(item.name);
  const b = norm(titleFromBrand(brand));
  return n === `${b} logo` || n === `${b} icon` || n === b;
}

function rankKey(item, brand) {
  return [
    brand && item.brand === brand ? 1 : 0,
    isBrandMark(item, brand) ? 1 : 0,
    isPlainMark(item) ? 1 : 0,
    KIND_RANK[item.kind] ?? 0,
    (item.width || 0) * (item.height || 0),
    item.duration || 0,
  ];
}

function compareRank(a, b, brand) {
  const ka = rankKey(a, brand); const kb = rankKey(b, brand);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
  return a.name.localeCompare(b.name);
}

function brandCatalog(items) {
  const byBrand = new Map();
  for (const it of items) {
    if (!it.brand) continue;
    const entry = byBrand.get(it.brand) || { brand: it.brand, hubs: new Set(), pillars: new Set(), aliases: new Set(), names: new Set() };
    entry.hubs.add(it.hub); entry.pillars.add(it.pillar);
    it.aliases.slice(0, 4).forEach((a) => entry.aliases.add(a));
    entry.names.add(it.name);
    byBrand.set(it.brand, entry);
  }
  return [...byBrand.values()].map((e) => ({
    brand: e.brand,
    hubs: [...e.hubs],
    pillars: [...e.pillars],
    aliases: [...e.aliases].slice(0, 5),
  }));
}

function familyFor(items, brand) {
  const own = items.filter((it) => it.brand === brand);
  if (own.length === 0) return [];
  const companyHubs = new Set(own.filter((it) => it.pillar === 'ai-companies').map((it) => it.hub));
  if (companyHubs.size === 0) return own; // our own brand assets stay narrow
  const family = items.filter((it) => (it.pillar === 'ai-companies' && companyHubs.has(it.hub)) || it.brand === brand);
  return family;
}

function toRow(item) {
  const poster = item.posterPath ? relative(getMirrorPath(), item.posterPath) : '';
  return {
    id: item.id,
    name: item.name,
    brand: item.brand,
    kind: item.kind,
    type: item.type,
    file: item.file,
    poster,
    size: item.sizeBytes,
    width: item.width,
    height: item.height,
    duration: item.duration,
    tags: item.tags,
    description: item.description,
    thumb: thumbnailPathFor(item) ? `/obsidian/thumbnail/${encodeURIComponent(item.id)}` : null,
  };
}

async function readIntent(message, items) {
  const catalog = brandCatalog(items);
  const state = {
    message,
    brands: catalog.map((b) => ({ brand: b.brand, hubs: b.hubs, aliases: b.aliases })),
  };
  const brandCriteria = Object.fromEntries(catalog.map((b) => [b.brand, `${titleFromBrand(b.brand)} (${b.hubs.join(', ')}${b.aliases.length ? `; aka ${b.aliases.join(', ')}` : ''})`]));
  brandCriteria.none = 'No brand, company, product or persona is named in the message';

  const questions = {
    plural: noul(
      { question: 'Does `message` ask for several files rather than exactly one? Plural nouns or words like logos, icons, clips, videos, pictures, avatars, assets, marks, files, all, every, each, multiple, footage, b-roll mean several. "a", "an", "the", "one", "single", "best", "top", "main", "official" followed by a singular noun means exactly one.' },
      { true: 'Several files: a list, a set, everything of a kind, choosing between versions', false: 'Exactly one file: the single best match' },
    ),
    kind: {
      type: 'choice',
      instructions: { question: 'What kind of media does `message` ask for?' },
      criteria: {
        logo: 'Logos, icons, marks, wordmarks, banners, tiles, app icons (logo and icon are the same thing)',
        profile: 'Profile pictures, avatars, social profile photos, pfps',
        clip: 'Video clips, footage, b-roll, screen recordings, demos',
        any: 'Not specified, or asks for all assets / media / files in general',
      },
    },
    pillar: {
      type: 'choice',
      instructions: { question: 'Which part of the vault does `message` point at, when no specific brand is named?' },
      criteria: {
        'ai-companies': 'AI company / tech company / startup logos and marks (third-party companies, not our own brands)',
        'brand-assets': 'Our own brand assets: the phrase "brand assets" means this. Creator OS, Hoops AI, No Code Academy marks and our people\'s social profile pictures (kevbuildsapps, kev ai, megan, danny, creator os)',
        'video-broll': 'Real video footage and b-roll clips',
        any: 'Not specified',
      },
    },
    brand: {
      type: 'choice',
      instructions: { question: 'Which entry in `brands` does `message` explicitly name, by its name or one of its aliases? Only pick a brand that is actually said in the message; otherwise pick none.' },
      criteria: brandCriteria,
    },
    descriptive: noul(
      { question: 'Beyond naming a brand and a kind of media, does `message` describe what the file should look like or contain (a color, a variant, a scene, an action, a platform, a subject)?' },
      { true: 'Yes: e.g. "the pink one", "the invader", "basketball court footage", "the instagram avatar"', false: 'No: just a brand and/or kind, e.g. "the openai logo", "hoops ai clips", "what logos do we have"' },
    ),
  };
  const resp = await askJev(state, questions);
  const a = resp.answers;
  return {
    plural: Number(a.plural?.noul ?? 0) >= 0.5,
    kind: a.kind?.choice || 'any',
    pillar: a.pillar?.choice || 'any',
    brand: a.brand?.choice && a.brand.choice !== 'none' ? a.brand.choice : null,
    brandConfidence: Number(a.brand?.confidence ?? 0),
    descriptive: Number(a.descriptive?.noul ?? 0) >= 0.5,
    latencyMs: resp.latencyMs,
    inputTokens: resp.usage?.input_tokens ?? 0,
  };
}

async function judgeItems(message, candidates, { wantBest }) {
  const judged = candidates.slice(0, JUDGE_CAP);
  const state = {
    request: message,
    items: judged.map((it, i) => ({
      i, name: it.name, type: it.type, brand: it.brand, kind: it.kind, collection: it.hub,
      aliases: it.aliases.slice(0, 5), tags: it.tags.slice(0, 5), description: it.description.slice(0, 160),
    })),
  };
  const questions = {};
  judged.forEach((_, i) => {
    questions[`m${i}`] = noul(
      { question: `Is \`items[${i}]\` what the editor is asking for in \`request\`?` },
      { true: 'Right subject, variant and kind of media, or a strong fit', false: 'Wrong variant, wrong kind of media, or unrelated' },
    );
  });
  if (wantBest) {
    questions.best = {
      type: 'choice',
      instructions: { question: 'Which single entry in `items` is the one the editor is asking for in `request`? Pick none if nothing fits.' },
      criteria: Object.fromEntries([...judged.map((it, i) => [`i${i}`, `${it.name} — ${it.type}${it.brand ? `, ${it.brand}` : ''}${it.kind ? `, ${it.kind}` : ''}`]), ['none', 'Nothing fits']]),
    };
  }
  const resp = await askJev(state, questions, { timeoutMs: 12000 });
  const a = resp.answers;
  const bestKey = a.best?.choice;
  const bestIndex = bestKey && /^i\d+$/.test(bestKey) ? Number(bestKey.slice(1)) : -1;
  return {
    probs: judged.map((_, i) => Number(a[`m${i}`]?.noul ?? 0)),
    bestIndex,
    bestConfidence: Number(a.best?.confidence ?? 0),
    latencyMs: resp.latencyMs,
    inputTokens: resp.usage?.input_tokens ?? 0,
  };
}

/**
 * The Jev media agent. Plain-English ask → vault rows.
 * @param {string} message
 * @returns {Promise<{media: true, mode: 'single'|'all', rows: object[], total: number, more: number, intent: object, jev: object, via: 'jev'|'keywords'}>}
 */
export async function queryVault(message) {
  const items = loadIndex();
  const jev = { calls: 0, latencyMs: 0, inputTokens: 0 };
  if (items.length === 0) {
    const m = getMirrorState();
    const error = m.syncing ? 'Vault is still syncing from iCloud, try again in a moment' : m.lastError ? `Vault sync failed: ${m.lastError}` : 'Vault is empty or not found';
    return { media: true, mode: 'all', rows: [], total: 0, more: 0, intent: null, jev, via: 'jev', vaultPath: getVaultPath(), error };
  }

  // Keyword-only fallback when Jev is unconfigured (never the normal path).
  if (!jevConfigured()) {
    const words = keywords(message);
    const q = message.toLowerCase().trim();
    const plural = /\b(logos|icons|clips|videos|pictures|avatars|assets|marks|files|all|every|each|multiple|footage|b-roll)\b/.test(q);
    const ranked = items.map((it) => ({ it, kw: keywordScore(it, words, q) })).filter((s) => s.kw > 0).sort((a, b) => b.kw - a.kw).map((s) => s.it);
    const rows = (plural ? ranked.slice(0, PLURAL_CAP) : ranked.slice(0, 1)).map(toRow);
    return { media: true, mode: plural ? 'all' : 'single', rows, total: ranked.length, more: Math.max(0, ranked.length - rows.length), intent: { plural, brand: null, kind: 'any', pillar: 'any', descriptive: false }, jev, via: 'keywords' };
  }

  // 1. Intent.
  const intent = await readIntent(message, items);
  jev.calls++; jev.latencyMs += intent.latencyMs; jev.inputTokens += intent.inputTokens;

  // 2. Deterministic narrowing.
  let candidates = intent.brand ? familyFor(items, intent.brand) : items.slice();
  if (!intent.brand && intent.pillar !== 'any') candidates = candidates.filter((it) => it.pillar === intent.pillar);
  if (intent.kind === 'logo') candidates = candidates.filter((it) => it.kind === 'logo' || it.kind === 'icon');
  else if (intent.kind === 'profile') candidates = candidates.filter((it) => it.kind === 'profile');
  else if (intent.kind === 'clip') candidates = candidates.filter((it) => it.kind === 'clip');
  // Asking for a company's "logos" must not drag in its clips, and vice versa.
  if (intent.brand && intent.kind === 'any') {
    const hasMarks = candidates.some((it) => it.kind !== 'clip');
    if (hasMarks && !/\b(clip|clips|footage|b-roll|broll|video|videos|recording)\b/i.test(message)) candidates = candidates.filter((it) => it.kind !== 'clip');
  }

  // 3. Rank.
  candidates.sort((a, b) => compareRank(a, b, intent.brand));

  // 4. Judge individually only when needed.
  const needJudge = candidates.length > 1 && (intent.descriptive || (!intent.brand && !intent.plural));
  let best = null;
  if (needJudge) {
    const verdict = await judgeItems(message, candidates, { wantBest: !intent.plural });
    jev.calls++; jev.latencyMs += verdict.latencyMs; jev.inputTokens += verdict.inputTokens;
    const scored = candidates.slice(0, JUDGE_CAP).map((it, i) => ({ it, p: verdict.probs[i], isBest: i === verdict.bestIndex }));
    let kept = scored.filter((s) => s.p >= 0.5 || s.isBest);
    if (kept.length === 0) kept = scored.filter((s) => s.p >= 0.3);
    kept.sort((a, b) => (b.isBest - a.isBest) || (b.p - a.p) || compareRank(a.it, b.it, intent.brand));
    candidates = kept.map((s) => s.it);
    if (verdict.bestIndex >= 0) best = { id: scored[verdict.bestIndex].it.id, confidence: verdict.bestConfidence };
  }

  const total = candidates.length;
  const rows = (intent.plural ? candidates.slice(0, PLURAL_CAP) : candidates.slice(0, 1)).map(toRow);
  return {
    media: true,
    mode: intent.plural ? 'all' : 'single',
    rows,
    total,
    more: Math.max(0, total - rows.length),
    best,
    intent: { plural: intent.plural, brand: intent.brand, brandConfidence: intent.brandConfidence, kind: intent.kind, pillar: intent.pillar, descriptive: intent.descriptive },
    jev,
    via: 'jev',
  };
}
