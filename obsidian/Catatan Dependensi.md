# Catatan Dependensi

Diperbarui: 2026-10-10
Terkait: [[Logs/2026-10-02 - Implementasi Fallback LLM|Log 2026-10-02]] · [[Audit Klien LLM]] · [[Panduan Fallback LLM]]

## Kebutuhan sistem

| Kebutuhan | Status di mesin ini | Catatan |
|---|---|---|
| **Node.js ≥ 22.5** | ✅ v24.20.0 | Fitur `node:sqlite` (database pool fallback) baru tersedia sejak 22.5; proyek memakai Node 24 |
| **npm** | ⚠️ 9.8.1 | Berfungsi, tapi `camera-controls` minta npm ≥10.5.1 (hanya warning `EBADENGINE`). Bisa di-update dengan `npm i -g npm@11` |
| **Git** | ✅ 2.55 | |
| **FFmpeg + FFprobe** | ✅ v9.0.2 (winget `Gyan.FFmpeg`) | **Wajib** untuk hampir semua fitur video (upload, thumbnail, render, shorts, dead-air, ekstraksi audio Whisper). Server editor otomatis mencari ffmpeg/ffprobe di `%LOCALAPPDATA%\Microsoft\WinGet\Links`, folder paket winget, `C:\ffmpeg\bin`, Chocolatey, dan Scoop — jadi terminal yang PATH-nya belum ter-refresh tetap jalan. Override manual: `FFMPEG_PATH`/`FFPROBE_PATH` di `.dev.vars` |
| **Python + Whisper** | ❌ belum | Opsional (transkripsi lokal gratis). Butuh Python 3.11/3.12 (torch belum tentu mendukung 3.14). Lihat bawah |
| **Chrome / Edge** | ✅ ada | Untuk mode suara (Web Speech API) dan render headless Remotion |
| **RAM** | ⚠️ 12 GB (sisa ~3 GB) | Render Remotion + Whisper berat; tutup aplikasi lain saat render |

## Paket npm

**Tidak ada dependensi npm baru** untuk fitur fallback LLM — SQLite memakai `node:sqlite` bawaan Node.

Yang sudah dipakai di jalur LLM/AI:
- `@google/genai` — Gemini untuk tugas multimodal saja (transkripsi audio/video cadangan, pembuatan gambar B-roll, bab dari audio). Pembuatan teks (scene animasi, analisis transkrip, peningkatan prompt) sudah lewat pool fallback
- `@fal-ai/client` — video/image generation (DiCaprio) — belum dikonversi
- `formdata-node` — multipart untuk endpoint `/audio/transcriptions` OpenAI-compatible
- `openai` (Python) — bukan untuk proyek ini, hanya keliru terpasang global

## Setup Python Whisper (opsional)

Masalah di Windows: perintah `python3` mengarah ke stub Microsoft Store. Perbaikan:

```powershell
# 1. Buat alias python3 dari Python asli (C:\Python311)
Copy-Item C:\Python311\python.exe C:\Python311\python3.exe

# 2. Verifikasi
python3 --version

# 3. Install Whisper + PyTorch CPU (~2–3 GB)
pip install openai-whisper torch
```

- Whisper **tetap butuh FFmpeg** untuk membaca audio.
- Tanpa Whisper lokal, transkripsi jatuh ke API Whisper (pool fallback) lalu Gemini.

## Kunci API (`.dev.vars`)

Salin dari `.dev.vars.example` → `.dev.vars`:

| Variabel | Untuk apa | Wajib? |
|---|---|---|
| `ANTHROPIC_API_KEY` | Orkestrasi Director/DiCaprio/CreatorOS (via endpoint OpenAI-compatible Anthropic) | Untuk fitur AI |
| `OPENAI_API_KEY` | Chat cadangan, Whisper API, TTS | Opsional |
| `GEMINI_API_KEY` | Cadangan terakhir Gemini: transkripsi audio/video, pembuatan gambar B-roll, bab dari audio. Fitur teks (animasi, analisis) memakai pool fallback | Opsional |
| `FAL_API_KEY` | DiCaprio: Restyle Video, Remove Background, dan Animate Image bila tidak ada provider **Video** di pool | Opsional bila provider Video aktif |
| `GIPHY_API_KEY` | Pencarian GIF | Opsional |
| `TYPESAFE_API_KEY` | Jev (routing Direktur + agen media) langsung ke TypeSafe — **opsional, digantikan OpenRouter** | Opsional |
| `OPENROUTER_API_KEY` | Jev via OpenRouter (`JEV_MODEL`, default `typesafe/jev-1.13`); menang bila keduanya diisi | Opsional |
| `JEV_MODEL` | Versi model Jev spesifik, mis. `typesafe/jev-1.13` atau alias `~typesafe/jev-latest` | Opsional |
| `JEV_ENDPOINT` | Override endpoint Jev (default: Decisions API OpenRouter) | Opsional |
| `YOUTUBE_CLIENT_ID` | Upload YouTube native (lihat [[Panduan Upload YouTube]]) | Untuk upload |
| `YOUTUBE_CLIENT_SECRET` | Secret OAuth client Google | Untuk upload |
| `YOUTUBE_REDIRECT_URI` | Redirect URI OAuth (default `http://localhost:3333/youtube/oauth/callback`) | Opsional |
| `OBSIDIAN_VAULT_PATH` | Vault agen media. Di Windows agen berjalan mode **direct** (tanpa rsync); arahkan ke folder lokal berisi media + sidecar `.md` | Opsional |
| `OBSIDIAN_VAULT_DIRECT` | `1` paksa baca langsung, `0` paksa mirror rsync (default: otomatis — direct bila rsync tidak ada) | Opsional |

Kunci yang terisi otomatis dimasukkan ke pool fallback saat server editor pertama kali dijalankan. Setelah itu kelola lewat halaman `/settings/llm` (lihat [[Panduan Fallback LLM]]).

## Database

- Lokasi: `data/llm.db` (folder `data/` masuk `.gitignore`, **berisi API key dalam bentuk teks biasa** — jangan di-commit)
- Dibuat otomatis saat server editor pertama kali memanggil fitur LLM
- Tabel: `llm_providers` (daftar fallback), `llm_logs` (riwayat percobaan), `llm_settings` (flag seed)
- Mode WAL, aman diakses server + skrip sekaligus
- `data/youtube.db` — refresh token OAuth YouTube + riwayat upload (juga gitignored)
- `data/projects.json` + `data/projects/<id>/` — daftar **projek tersimpan** (nama, sessionId, snapshot `project.json`/`assets-meta.json`). Sesi yang disimpan di-*pin* agar tidak ikut auto-cleanup 2 jam.

## Media library (hasil generate AI)

- Lokasi default: `D:\Project\Shorts\Media-AI\<YYYY-MM-DD>\` (sortir per tanggal; ubah lewat `MEDIA_LIBRARY_DIR` di `.dev.vars`)
- Hanya **media hasil generate AI** yang dipindahkan ke sini: animasi Remotion, gambar/video hasil generate, restyle, remove-bg, dan B-roll. Upload pengguna tetap di folder sesi (`%TEMP%`).
- `assets-meta.json` menyimpan `libraryRelative`, jadi sesi bisa dipulihkan setelah restart; **menghapus session tidak menghapus media di library**.
- Saat startup, server memigrasikan asset AI lama dari folder sesi ke library secara otomatis.

## Port

| Port | Proses |
|---|---|
| 5173 | `npm run dev` — Vite + Cloudflare Worker (UI + endpoint `/api/*`) |
| 3333 | `npm run ffmpeg-server` — server editor + API manajemen `/llm/*` |

## Diketahui belum beres (di luar scope permintaan ini)

- **Bug Windows `spawn('npx')` — SUDAH DIPATCH (2026-10-10):** `scripts/local-ffmpeg-server.js` kini memakai `spawnRemotion()` yang menjalankan `node_modules/@remotion/cli/remotion-cli.js` via `process.execPath` (baris 777) — tanpa `npx`/shell sama sekali. Render motion graphic & animasi AI bisa jalan.
- **Agen Obsidian (Jev)** kini mendukung Windows lewat mode *direct* (tanpa rsync): vault dibaca di tempat, tanpa warning `spawn rsync ENOENT`. Agar berguna, isi `OBSIDIAN_VAULT_PATH` ke vault lokal berisi media + sidecar `.md` (format Marketing OS Broll). Tanpa itu panel menampilkan "Vault not found" — bukan error rsync.
