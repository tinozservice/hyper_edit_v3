# Catatan Dependensi

Diperbarui: 2026-10-02
Terkait: [[Logs/2026-10-02 - Implementasi Fallback LLM|Log 2026-10-02]] · [[Audit Klien LLM]] · [[Panduan Fallback LLM]]

## Kebutuhan sistem

| Kebutuhan | Status di mesin ini | Catatan |
|---|---|---|
| **Node.js ≥ 22.5** | ✅ v24.20.0 | Fitur `node:sqlite` (database pool fallback) baru tersedia sejak 22.5; proyek memakai Node 24 |
| **npm** | ⚠️ 9.8.1 | Berfungsi, tapi `camera-controls` minta npm ≥10.5.1 (hanya warning `EBADENGINE`). Bisa di-update dengan `npm i -g npm@11` |
| **Git** | ✅ 2.55 | |
| **FFmpeg + FFprobe** | ❌ belum ada | **Wajib** untuk hampir semua fitur video (upload, thumbnail, render, shorts, dead-air, ekstraksi audio Whisper). Install: `winget install Gyan.FFmpeg`, lalu buka terminal baru dan cek `ffmpeg -version` |
| **Python + Whisper** | ❌ belum | Opsional (transkripsi lokal gratis). Butuh Python 3.11/3.12 (torch belum tentu mendukung 3.14). Lihat bawah |
| **Chrome / Edge** | ✅ ada | Untuk mode suara (Web Speech API) dan render headless Remotion |
| **RAM** | ⚠️ 12 GB (sisa ~3 GB) | Render Remotion + Whisper berat; tutup aplikasi lain saat render |

## Paket npm

**Tidak ada dependensi npm baru** untuk fitur fallback LLM — SQLite memakai `node:sqlite` bawaan Node.

Yang sudah dipakai di jalur LLM/AI:
- `@google/genai` — Gemini (multimodal video/transkrip, generator animasi) — belum dikonversi
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
| `GEMINI_API_KEY` | Analisis video/transkrip, generator animasi | Untuk fitur animasi |
| `FAL_API_KEY` | DiCaprio (video/image generation) | Untuk fitur DiCaprio |
| `GIPHY_API_KEY` | Pencarian GIF | Opsional |
| `TYPESAFE_API_KEY` | Jev (routing Direktur + agen media) langsung ke TypeSafe — **opsional, digantikan OpenRouter** | Opsional |
| `OPENROUTER_API_KEY` | Jev via OpenRouter (`JEV_MODEL`, default `typesafe/jev-1.13`); menang bila keduanya diisi | Opsional |
| `JEV_MODEL` | Versi model Jev spesifik, mis. `typesafe/jev-1.13` atau alias `~typesafe/jev-latest` | Opsional |
| `JEV_ENDPOINT` | Override endpoint Jev (default: Decisions API OpenRouter) | Opsional |
| `OBSIDIAN_VAULT_PATH` | Vault agen media | Opsional (default macOS — tidak jalan di Windows) |

Kunci yang terisi otomatis dimasukkan ke pool fallback saat server editor pertama kali dijalankan. Setelah itu kelola lewat halaman `/settings/llm` (lihat [[Panduan Fallback LLM]]).

## Database

- Lokasi: `data/llm.db` (folder `data/` masuk `.gitignore`, **berisi API key dalam bentuk teks biasa** — jangan di-commit)
- Dibuat otomatis saat server editor pertama kali memanggil fitur LLM
- Tabel: `llm_providers` (daftar fallback), `llm_logs` (riwayat percobaan), `llm_settings` (flag seed)
- Mode WAL, aman diakses server + skrip sekaligus

## Port

| Port | Proses |
|---|---|
| 5173 | `npm run dev` — Vite + Cloudflare Worker (UI + endpoint `/api/*`) |
| 3333 | `npm run ffmpeg-server` — server editor + API manajemen `/llm/*` |

## Diketahui belum beres (di luar scope permintaan ini)

- **Bug Windows `spawn('npx')`** di `scripts/local-ffmpeg-server.js` (3 lokasi render Remotion) — gagal `ENOENT` di Windows; perlu `npx.cmd`/`shell: true`. Render motion graphic & animasi AI belum bisa sampai ini dipatch.
- **Agen Obsidian (Jev)** hardcoded ke vault macOS iCloud + `rsync` — tidak berfungsi di Windows.
