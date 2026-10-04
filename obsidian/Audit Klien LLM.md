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
| Gemini `new GoogleGenAI` — `scripts/local-ffmpeg-server.js` | 20 → 12 (lihat §5) | Kemampuan multimodal file video/audio yang tidak dipakai di chat. Di luar permintaan (hanya Anthropic & OpenAI). Bisa ditambahkan nanti lewat endpoint OpenAI-compatible Gemini: `https://generativelanguage.googleapis.com/v1beta/openai/` |
| fal.ai `@fal-ai/client` | 27 pemakaian | API video/image generation, bukan chat completion |
| Jev — `scripts/jev.js` | 1 modul | Protokol kustom (choice/noul/score), bukan chat. **Kini bisa lewat OpenRouter Decisions API** (`OPENROUTER_API_KEY`, `JEV_MODEL=typesafe/jev-1.13`, endpoint `/api/alpha/decisions`); mode TypeSafe langsung tetap didukung |
| Whisper lokal — `scripts/whisper-transcribe.py` | 1 skrip | Proses lokal (non-HTTP) |
| Web Speech API — `src/react-app/hooks/useVoiceDirector.ts` | 1 hook | API browser, bukan server |

## 3. Arsitektur fallback

```
Pemanggil (worker / server editor)
        │
        ▼
  chatCompletion() / audioTranscription() / synthesizeSpeech() / generateVideo()
        │  baca llm_providers (enabled=1 + flag layanan: chat/transkripsi/tts/video)
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

- **Provider = base URL + API key + model** (selalu tiga field ini), plus opsional: `transcribe_model`, `tts_model`, `timeout_ms`, `max_retries`, `enabled`, `priority`, dan flag layanan `chat_enabled`/`transcribe_enabled`/`tts_enabled`/`video_enabled`.
- **Video** memakai API async OpenRouter: `POST /videos` → polling `polling_url` → unduh `unsigned_urls[0]` (atau `/videos/{id}/content`). Gambar first-frame dikirim sebagai data URL. Provider video default `video_enabled=0`; hanya provider yang ditandai Video ikut dicoba.
- Worker memakai pool server lokal lewat `GET /llm/providers/runtime` (loopback-only, cache 10 detik) dan menulis log balik via `POST /llm/logs`.
- Halaman pengelola: `/settings/llm` → [[Panduan Fallback LLM]].

## 4. Berkas yang terlibat

- Baru: `scripts/llm-pool.js`, `src/react-app/pages/LlmSettings.tsx`, `.dev.vars.example`
- Diubah: `scripts/local-ffmpeg-server.js`, `src/worker/index.ts`, `src/types/env.d.ts`, `src/react-app/App.tsx`, `src/react-app/pages/Home.tsx`, `wrangler.json` (binding `ASSETS` + SPA fallback), `.gitignore` (`data/`)

## 5. Pembaruan 2026-10-04 — panggilan teks pindah ke pool

Panggilan Gemini yang murni **teks** kini lewat `generateText()` → pool chat (`data/llm.db`) lebih dulu, dan hanya jatuh ke `GEMINI_API_KEY` bila pool tidak punya provider Chat aktif:

- Pembuatan/penyuntingan scene animasi: `handleGenerateAnimation`, `handleEditAnimation`, `handleGenerateBatchAnimations`, `handleAnalyzeForAnimation`, `handleGenerateTranscriptAnimation`, `handleGenerateContextualAnimation`.
- Perencanaan B-roll (`analyzeBrollOpportunities`) dan peningkatan prompt Picasso (`handleGenerateImage`).
- Cabang transkripsi memakai flag **Transkripsi** per provider (`poolHasCapability('transcription')`), bukan sekadar ada provider; `getOrTranscribeVideo()` kini mengenali pool sehingga tidak lagi menolak lebih dulu saat `GEMINI_API_KEY` kosong.
- `chatCompletion()` menerima `timeoutMs` per permintaan (generasi JSON panjang memakai 120 dtk).

Sisa Gemini (multimodal, tidak bisa lewat chat): transkripsi audio cadangan (`getOrTranscribeVideo`, `handleTranscribe`, B-roll), pembuatan gambar B-roll (`generateImageWithGemini`), dan bab dari audio (`handleGenerateChapters`, `handleSessionChapters`).

**Video (2026-10-04):** kapabilitas `video` ditambahkan ke pool (`video_enabled`, tab **Video** di `/settings/llm`). `generateVideo()` memakai API async OpenRouter (`POST /videos` → polling → unduh MP4). DiCaprio Animate Image memakai pool video bila ada provider Video aktif; jika tidak, fallback ke fal.ai (butuh `FAL_API_KEY`). Gambar lokal dikirim sebagai data URL first-frame — terverifikasi pada `heygen/heygen-video-1` (5 dtk 480p ≈ $0,05 saat promo). Provider video default `video_enabled=0` agar tidak mengotori daftar chat/transkripsi/TTS.
