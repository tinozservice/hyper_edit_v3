# Audit Klien LLM / AI

Tanggal audit: 2026-10-02
Terkait: [[Logs/2026-10-02 - Implementasi Fallback LLM|Log 2026-10-02]] · [[Catatan Dependensi]] · [[Panduan Fallback LLM]]

## 1. Titik inisialisasi/pemanggilan yang DIKONVERSI

Semua Anthropic & OpenAI kini lewat **satu jalur**: `scripts/llm-pool.js` → endpoint OpenAI-compatible `/chat/completions`, `/audio/transcriptions`, `/audio/speech`.

| Lokasi (ref baris saat audit) | Sebelum | Sekarang |
|---|---|---|
| `scripts/local-ffmpeg-server.js:65` `callLLM()` | `POST https://api.anthropic.com/v1/messages` + header `x-api-key` (SDK/SDK-less Anthropic native) | `claudeCompat()` → pool OpenAI-compatible `/chat/completions` |
| `:5572` (enhance prompt gerak — DiCaprio Animate) | `callClaude(...)` | `callLLM(...)` |
| `:5769` (enhance prompt restyle — DiCaprio Restyle) | `callClaude(...)` | `callLLM(...)` |
| `:8699` (planner CreatorOS) | `callClaude(...)` | `callLLM(...)` |
| `:8968` (ranking Shorts) | `callClaude(...)` | `callLLM(...)` |
| `:2787` `transcribeVideo()` | `POST https://api.openai.com/v1/audio/transcriptions` + `Bearer OPENAI_API_KEY` | `audioTranscription()` fallback pool |
| `:3184` `getOrTranscribeVideo()` | idem | idem |
| `:3455` `handleTranscribe` (caption) | idem | idem |
| `:3926` `handleGenerateBroll()` | idem | idem |
| `:6558` animasi dari transkrip | idem | idem |
| `:7059` generate animation | idem | idem |
| `:7416` contextual animation | idem | idem |
| `:8295` `handleDirectorTts` (`POST /director/tts`) | `POST https://api.openai.com/v1/audio/speech` | `synthesizeSpeech()` fallback pool |
| `src/worker/index.ts` `callClaude()` | `POST https://api.anthropic.com/v1/messages` | `/chat/completions` OpenAI-compatible; urutan: pool (lewat jembatan lokal) → `LLM_FALLBACKS` env → kunci legacy env |

Catatan: dua situs transkripsi lama memakai `node-fetch` + `createReadStream` (rawan gagal karena `node-fetch` hanya dependensi transitif) — sekalian dinormalkan ke `formdata-node` seperti situs lain.

## 2. Titik inisialisasi yang TIDAK dikonversi (sengaja)

| Klien | Jumlah lokasi | Alasan |
|---|---|---|
| Gemini `new GoogleGenAI` — `scripts/local-ffmpeg-server.js` (:935, :1593, :3155, :3440, :3509, :3747, :3812, :3933, :3986, :4275, :4410, :5065, :5367, :6203, :6551, :6631, :7070, :7139, :7433, :7503) | 20 | Kemampuan multimodal file video/audio Gemini yang tidak dipakai di chat. Di luar permintaan (hanya Anthropic & OpenAI). Bisa ditambahkan nanti lewat endpoint OpenAI-compatible Gemini: `https://generativelanguage.googleapis.com/v1beta/openai/` |
| fal.ai `@fal-ai/client` | 27 pemakaian | API video/image generation, bukan chat completion |
| Jev — `scripts/jev.js` | 1 modul | Protokol kustom (choice/noul/score), bukan chat. **Kini bisa lewat OpenRouter Decisions API** (`OPENROUTER_API_KEY`, `JEV_MODEL=typesafe/jev-1.13`, endpoint `/api/alpha/decisions`); mode TypeSafe langsung tetap didukung |
| Whisper lokal — `scripts/whisper-transcribe.py` | 1 skrip | Proses lokal (non-HTTP) |
| Web Speech API — `src/react-app/hooks/useVoiceDirector.ts` | 1 hook | API browser, bukan server |

## 3. Arsitektur fallback

```
Pemanggil (worker / server editor)
        │
        ▼
  chatCompletion() / audioTranscription() / synthesizeSpeech()
        │  baca llm_providers (enabled=1 + flag layanan: chat/transkripsi/tts)
        │  urut priority; tiap layanan punya daftar sendiri
        ▼
  loop provider:
    1. POST {base_url}/chat/completions  (Bearer api_key, model)
    2. timeout per-provider (timeout_ms, default 30s)
    3. gagal jaringan/timeout/429/5xx → retry max_retries → provider berikutnya
    4. 4xx auth → langsung provider berikutnya
    5. sukses → return; semua gagal → error berisi penyebab terakhir
        │
        ▼
  setiap percobaan → llm_logs (source: server | worker | settings-page)
```

- **Provider = base URL + API key + model** (selalu tiga field ini), plus opsional: `transcribe_model`, `tts_model`, `timeout_ms`, `max_retries`, `enabled`, `priority`.
- Worker memakai pool server lokal lewat `GET /llm/providers/runtime` (loopback-only, cache 10 detik) dan menulis log balik via `POST /llm/logs`.
- Halaman pengelola: `/settings/llm` → [[Panduan Fallback LLM]].

## 4. Berkas yang terlibat

- Baru: `scripts/llm-pool.js`, `src/react-app/pages/LlmSettings.tsx`, `.dev.vars.example`
- Diubah: `scripts/local-ffmpeg-server.js`, `src/worker/index.ts`, `src/types/env.d.ts`, `src/react-app/App.tsx`, `src/react-app/pages/Home.tsx`, `wrangler.json` (binding `ASSETS` + SPA fallback), `.gitignore` (`data/`)
