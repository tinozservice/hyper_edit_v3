# Log 2026-10-02 — Implementasi Fallback LLM

Terkait: [[Audit Klien LLM]] · [[Catatan Dependensi]] · [[Panduan Fallback LLM]]

## Permintaan

1. Gunakan folder `obsidian/` untuk mencatat log + catatan dependensi
2. Periksa semua file inisialisasi LLM/AI
3. Ubah inisiasi Anthropic & OpenAI agar memakai OpenAI SDK / OpenAI-compatible
4. Tambahkan fallback anti-error/timeout — tiap entri wajib base URL + API key + model, di-loop saat ditambahkan
5. Buat database bila perlu (mis. SQLite)
6. Buat halaman khusus pengelola daftar fallback

## Yang dikerjakan

### 1. Modul pool baru — `scripts/llm-pool.js`
- Klien OpenAI-compatible terpusat: `chatCompletion()`, `claudeCompat()`, `audioTranscription()`, `synthesizeSpeech()`, `testProvider()`, `testAllProviders()`.
- Database SQLite memakai **`node:sqlite` bawaan Node 24** → **tanpa dependensi npm baru**.
- Tabel: `llm_providers` (daftar fallback), `llm_logs` (riwayat), `llm_settings` (flag seed).
- Loop fallback: urut prioritas → coba provider → retry (jaringan/timeout/429/5xx) → lanjut provider berikut → semua gagal = error terakhir.
- Seed otomatis dari `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` saat pertama kali, dengan base URL Anthropic versi kompatibel OpenAI: `https://api.anthropic.com/v1`.

### 2. `scripts/local-ffmpeg-server.js`
- `callClaude()` (Anthropic native `/v1/messages`) → `callLLM()` via pool (4 pemanggil diperbarui).
- 7 pemanggilan langsung Whisper API → `audioTranscription()` (formData dibangun ulang per percobaan).
- TTS `/director/tts` → `synthesizeSpeech()`.
- Endpoint baru `/llm/*` (CRUD provider, reorder, test, logs, runtime loopback-only).

### 3. `src/worker/index.ts`
- `callClaude()` → `/chat/completions` dengan urutan: pool lokal lewat jembatan `GET /llm/providers/runtime` (cache 10 detik) → env `LLM_FALLBACKS` → kunci legacy.
- Log percobaan Worker dikirim best-effort ke `POST /llm/logs` (`source: worker`).
- Tambah SPA fallback `app.get("*", c => c.env.ASSETS.fetch(c.req.raw))` + binding `ASSETS` di `wrangler.json` agar deep link `/settings/llm` tidak 404 saat refresh.

### 4. Halaman pengelola — `src/react-app/pages/LlmSettings.tsx`
- Route baru `/settings/llm` + tombol **Fallback LLM** di header editor.
- Fitur: tabel provider (urutan, aktif/nonaktif, key ter-mask, timeout/retry), tambah/edit/hapus, uji satu / uji semua, tabel log, info path DB, bersihkan log.

### 5. Pendukung
- `.dev.vars.example` (template kunci + penjelasan).
- Tombol **Impor .dev.vars** di halaman — memuat entri awal dari kunci env kapan pun selama daftar masih kosong (endpoint `POST /llm/providers/seed`).
- `src/types/env.d.ts` — tipe env LLM baru.
- `.gitignore` — `data/` (DB berisi key) diabaikan.
- `wrangler.json` — binding `ASSETS`.

## Hasil pengujian (nyata, di mesin ini)

| Uji | Hasil |
|---|---|
| `npm install --legacy-peer-deps` | ✅ 627 paket (sebelumnya, sesi kompatibilitas) |
| `npm run build` (tsc + Vite + worker) | ✅ berkali-kali setelah perubahan |
| `npx eslint` file baru/ubah | ✅ 0 error di `llm-pool` terkait, `LlmSettings.tsx`, `worker/index.ts`, `App.tsx` (2 error `Home.tsx` sudah ada sebelumnya) |
| Uji modul pool (DB sementara) | ✅ CRUD, masking key, runtime key utuh, gagal→log, delete |
| Server editor: `/llm/status`, CRUD, reorder, update key-opsional | ✅ (validasi URL menolak `notaurl`; PUT tanpa key mempertahankan key) |
| Loop fallback sisi Node (provider mati → mock) | ✅ provider ke-2 dipakai, `fallback_index: 1`, kegagalan provider ke-1 tercatat |
| **End-to-end Worker → pool → fallback** | ✅ `POST /api/ai-edit` lewat Vite: provider pertama timeout (1006 ms) → fallback ke mock → jawaban terparse `"dijawab oleh mock-openai"`; log `source: worker` tercatat |
| SPA `/settings/llm` setelah fix | ✅ HTTP 200 (sebelumnya 404 di dev karena worker Hono menangani request) |
| Tombol/endpoint **Impor .dev.vars** | ✅ `added=2` saat pool kosong & kunci env diisi; otomatis nonaktif saat pool sudah terisi |
| Guard loopback `/llm/providers/runtime` | ✅ 200 dari localhost; 403 dari IP LAN (192.168.1.2) |

Server mock OpenAI-compatible kecil dipakai untuk pengujian (port 3456, hanya sementara; sudah dimatikan). Tidak ada API key asli yang dipakai.

## Tindak lanjut — error "provider returned an empty completion"

Dilaporkan dari halaman pengaturan (2026-10-02 malam): provider `or-z-ai/glm-5.3-flash` (OpenRouter) selalu **gagal** saat diuji.

**Akar masalah (tereproduksi dengan respons mentah):** model itu **model reasoning**. Tombol Uji waktu itu memakai `max_tokens: 16`, dan seluruh budget habis untuk token `reasoning` tersembunyi (`reasoning_tokens: 17`) sehingga `content` kosong dengan `finish_reason: "length"` — padahal HTTP 200. Dengan `max_tokens: 512`, jawabannya normal (`"pong"`, `finish_reason: "stop"`).

**Perbaikan:**
1. `scripts/llm-pool.js` — bila content kosong dan `finish_reason=length` (budget habis oleh reasoning), provider yang sama langsung dicoba ulang sekali dengan budget dinaikkan (`max(4×, 1024)`); tidak bergantung pada setelan retry dan tidak menghabiskan jatah fallback. Pesan error kini menjelaskan penyebabnya.
2. Tombol Uji memakai `max_tokens: 512` (dari 16).
3. `src/worker/index.ts` — logika bump yang sama untuk jalur Director di Worker.

**Hasil uji:**
- Mock khusus (kosong `length` → lalu `pong`): ✅ budget `512 -> 2048`, sukses, log tercatat gagal-1 lalu sukses-1
- Provider OpenRouter asli (id 5) via `testProvider(5)`: ✅ `ok: true`, `reply: "pong"`, 1527 ms
- `npm run build` ✅ · sintaks ✅
- Catatan: `npm run ffmpeg-server` perlu **di-restart** agar memuat kode baru (proses lama masih memegang modul versi lama).

## Tindak lanjut kedua — daftar fallback per layanan

Permintaan: TTS dan transkripsi perlu daftar sendiri karena sebagian provider tidak melayani layanan tersebut.

**Perubahan:**
1. `llm_providers` mendapat tiga kolom flag: `chat_enabled`, `transcribe_enabled`, `tts_enabled` (default 1). Database yang sudah ada dimigrasi otomatis saat server dijalankan (`ALTER TABLE ADD COLUMN`, aman untuk data lama).
2. `getRuntimeProviders(capability)` menyaring daftar; `audioTranscription()` memakai daftar **transkripsi**, `synthesizeSpeech()` memakai daftar **TTS**, `chatCompletion()`/Worker memakai daftar **chat**. Bila daftar layanan kosong, pesan errornya menjelaskan layanan mana yang perlu diaktifkan.
3. Seed `.dev.vars`: Anthropic masuk sebagai **chat-only** (lapisan kompatibel OpenAInya tidak melayani audio); OpenAI masuk untuk chat+transkripsi+TTS.
4. Halaman `/settings/llm` kini bertiga tab — **Chat / Transkripsi / TTS** — dengan jumlah provider aktif masing-masing; formulir punya checkbox **Layanan**; baris provider menampilkan chip `chat`/`stt`/`tts`.
5. Tombol **Uji** mengikuti tab aktif: chat mengirim "pong", TTS mengirim satu kata dan memeriksa byte audio; transkripsi tidak bisa diuji dari halaman (butuh file audio) dan mengembalikan keterangan. Endpoint uji menerima `{ capability }`.
6. Reorder dalam tab menukar posisi dua provider tetangga di urutan prioritas bersama; provider lain tidak bergeser.

**Hasil uji:**
- Migrasi pada **salinan DB asli** (VACUUM INTO): ✅ tiga kolom ditambahkan, data lama utuh
- Filter: chat=2, transkripsi=1, tts=1 pada 2 provider (A chat-only, B semua) ✅
- TTS & transkripsi: request ke provider A **0**, langsung ke B ✅
- `testAllProviders('tts')` hanya menguji provider berlayanan TTS; `testAllProviders('transcription')` mengembalikan keterangan "tidak bisa diuji" ✅
- `npm run build` ✅ · eslint ✅
- Catatan: **restart `npm run ffmpeg-server`** agar migrasi + kode baru aktif.

## Keputusan desain

- **`node:sqlite` daripada better-sqlite3** — nol dependensi native, tidak perlu build tools di Windows.
- **SQLite di server lokal sebagai sumber kebenaran** — Worker dev menariknya lewat jembatan HTTP; saat deploy jatuh ke env. Membuat halaman pengelola bekerja penuh di mode pengembangan lokal (yang memang jadi cara proyek ini dipakai).
- **Anthropic lewat endpoint OpenAI-compatible** (`https://api.anthropic.com/v1`) — memenuhi permintaan "semua pakai OpenAI-compatible", tanpa SDK native.
- **Gemini/fal/Jev tidak diubah** — di luar permintaan; dicatat di [[Audit Klien LLM]] beserta alasan.
- Endpoint runtime (berisi key mentah) dibatasi **loopback-only**.

## Catatan / langkah berikutnya

- Halaman menampilkan key ter-mask; database tetap menyimpan teks biasa — perlakukan `data/` seperti `.dev.vars`.
- Bug Windows `spawn('npx')` (3 lokasi render Remotion) **belum dipatch** — lihat [[Catatan Dependensi]]. Render motion graphic & animasi masih gagal sampai diperbaiki.
- Gemini masih memakai SDK native (@google/genai). Bila ingin ikut jalur fallback, bisa ditambahkan via endpoint OpenAI-compatible Gemini.
- Pertimbangkan enkripsi DB atau kunci OS (nanti) bila repo dipakai multi-mesin.
- Perubahan belum di-commit; jalankan `git status` untuk melihat daftar berkas.
