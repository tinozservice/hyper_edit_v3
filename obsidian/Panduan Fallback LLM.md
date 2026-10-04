# Panduan Fallback LLM

Terkait: [[Audit Klien LLM]] · [[Catatan Dependensi]] · [[Logs/2026-10-02 - Implementasi Fallback LLM|Log 2026-10-02]]

## Membuka halaman

1. Jalankan **dua** proses (terminal terpisah):
   - `npm run ffmpeg-server` → server editor + API pool (port 3333)
   - `npm run dev` → UI + Cloudflare Worker (port 5173)
2. Buka `http://localhost:5173/settings/llm` (atau klik **Fallback LLM** di header editor).

## Daftar per layanan (chat / transkripsi / TTS / video / image / video edit)

Tiap provider punya **flag layanan**: `Chat`, `Transkripsi`, `TTS`, `Video`, `Image`, dan `Video Edit`. Halaman pengaturan punya enam tab — masing-masing adalah daftar fallback tersendiri:

- **Chat** — Director, DiCaprio, CreatorOS, Shorts (`/chat/completions`).
- **Transkripsi** — Whisper API (`/audio/transcriptions`, model `transcribe_model` atau default `whisper-1`).
- **TTS** — suara Direktur (`/audio/speech`, model `tts_model` atau default `tts-1`).
- **Video** — DiCaprio **Animate Image** (image-to-video) dan **text-to-video**; API async OpenRouter `POST /videos` → polling → unduh MP4. Model contoh: `heygen/heygen-video-1`.
- **Image** — text-to-image & image-to-image lewat OpenRouter `POST /images` (respons base64). Model contoh: `openai/gpt-image-1-mini` (mendukung `input_references` dan `background: transparent`).
- **Video Edit** — video-to-video (restyle) lewat `POST /videos` + `input_references` video. Model contoh: `black-forest-labs/flux-video-edit` (~$0,03/detik), `runway/aleph-2`, `bytedance/seedance-2.5`.

Provider yang tidak melayani suatu layanan (mis. OpenRouter untuk audio, atau Anthropic untuk TTS) cukup dinonaktifkan flag-nya lewat **Edit → Layanan**; provider itu otomatis tidak ikut dicoba di tab tersebut. Urutan fallback tiap tab mengikuti prioritas yang sama, tetapi keanggotaannya disaring oleh flag ini. Tombol **Uji** dan **Uji semua** menguji sesuai tab aktif (uji TTS mengirim satu kata; transkripsi tidak bisa diuji dari halaman karena butuh file audio; **video, image, dan video edit tidak diuji dari halaman karena berbiaya** — uji lewat DiCaprio).

## Cara kerja

- Setiap request (chat, transkripsi, TTS, video, image, atau video edit) mencoba provider **dari urutan teratas pada tab layanannya**; hanya provider yang flag layanannya aktif ikut dicoba.
- Setiap provider = **Base URL + API key + Model** (wajib) dan opsional model transkripsi (`/audio/transcriptions`, default `whisper-1`), model TTS (`/audio/speech`, default `tts-1`), timeout, dan jumlah retry.
- Gagal jaringan/timeout/HTTP 429/5xx → di-retry sesuai nilai retry, lalu lanjut ke provider berikutnya. HTTP 4xx (mis. key salah) → langsung lanjut.
- Jika semua provider gagal, error terakhir ditampilkan ke pemanggil (mis. chat Director).
- Setiap percobaan dicatat di tabel **Log percobaan terakhir** (waktu, jenis, provider, model, status, latensi, error).
- **Model reasoning** (GLM, o-series, deepseek-r*, dsb.): jika budget token habis dipakai untuk reasoning tersembunyi (`finish_reason=length`, content kosong), pool otomatis mencoba ulang provider yang sama dengan budget 4× lebih besar (minimal 1024) sebelum pindah ke provider berikutnya. Tidak perlu setelan khusus.
- **Video** memakai API async: provider mengirim job ke `{base_url}/videos`, lalu pool melakukan polling sampai `completed` dan mengunduh MP4-nya (`unsigned_urls[0]`). Gambar sumber dikirim sebagai data URL (`data:image/...;base64,...`) pada `frame_images` first-frame, jadi tidak butuh URL publik. Tanpa gambar = text-to-video. Timeout job default 10 menit; polling tiap 5 detik.
- **Video Edit** juga lewat `/videos`, tetapi sumber video harus berupa **URL HTTPS publik** (OpenRouter menolak data URL untuk video, dan Files API-nya tidak menerima video). Server mengompres klip ke proxy 480p/8 dtk lalu mengunggahnya sementara ke **litterbox** (fallback: **uguu.se**, keduanya kedaluwarsa otomatis ~1–3 jam) hanya selama job berjalan. Ada juga fallback fal.ai LTX-2 bila `FAL_API_KEY` terisi.
- **Image** memakai `POST {base_url}/images`; respons berisi gambar base64 (`data[].b64_json`). `input_references` (data URL) dipakai untuk image-to-image; `background: transparent` tersedia pada model yang mendukung.

## Cakupan pemakaian & matriks modalitas

| Modalitas | Jalur | Catatan |
|---|---|---|
| text → text | **Pool Chat** | Director, animasi, analisis, peningkatan prompt |
| text → image | **Pool Image** | `generateImage()` → `/images`; fallback fal bila ada |
| text → audio | **Pool TTS** | Suara Director (`/audio/speech`) |
| text → video | **Pool Video** | DiCaprio tanpa gambar → `generateVideo()` tanpa `imageDataUrl` |
| image → image | **Pool Image** | `input_references` (restyle gambar) |
| image → video | **Pool Video** | first-frame `frame_images` (HeyGen, dll.) |
| video → video | **Pool Video Edit** | `input_references` video via host sementara (flux-video-edit, dll.) |
| remove background | **FFmpeg lokal** | Chroma key (`colorkey` + `despill`) → WebM VP9 alpha; tanpa AI/fal |

- **Chat/orkestrasi** — Director (routing Jev tetap lewat OpenRouter/TypeSafe), DiCaprio, CreatorOS, Shorts.
- **Animasi AI** — pembuatan animasi kustom, edit animasi, batch animasi, analisis konsep animasi, animasi dari transkrip, dan animasi kontekstual (pembuatan scene JSON).
- **Analisis transkrip** — perencanaan B-roll dan peningkatan prompt.
- **Transkripsi** — lewat tab **Transkripsi**; bila tidak ada provider transkripsi, jatuh ke Whisper lokal, lalu Gemini.
- **Video** — DiCaprio **Animate Image** / **text-to-video**, dan workflow `animate-image` Director JEV. Hasilnya masuk media library.
- **Image** — `handleGenerateImage` (text-to-image & image-to-image) lewat tab **Image**; fallback fal.ai bila `FAL_API_KEY` terisi.
- **Video Edit** — DiCaprio **Restyle** lewat tab **Video Edit**; fallback fal.ai LTX-2 bila `FAL_API_KEY` terisi.
- **Remove BG** — chroma key lokal (hijau/biru, `similarity`/`blend`/`despill`) tanpa provider eksternal.

Masih khusus Gemini (butuh input audio/gambar): pembuatan bab dari audio/video, transkripsi cadangan tanpa provider, dan pembuatan gambar B-roll. Untuk fitur gambar B-roll, `GEMINI_API_KEY` tetap wajib.

## Mengelola provider

- **Tambah provider** — isi nama, base URL (harus berakhiran versi, mis. `https://api.openai.com/v1`), API key, dan model.
- **Naikkan/turunkan prioritas** — tombol ▲/▼ di kolom kiri; urutan tersimpan otomatis.
- **⏸ / ▶** — aktif/nonaktifkan tanpa menghapus.
- **Uji** — kirim satu prompt kecil ke provider itu saja (muncul latensi + pratinjau balasan, atau pesan error).
- **Uji semua** — uji seluruh provider berurutan.
- **Edit** — saat mengedit, biarkan API key kosong untuk mempertahankan key tersimpan.
- **Hapus** — menghapus provider dari daftar.

Contoh entri Anthropic (lewat endpoint kompatibel OpenAI): base URL `https://api.anthropic.com/v1`, model `claude-sonnet-5`.
Contoh OpenAI: base URL `https://api.openai.com/v1`, model `gpt-4o-mini`.
Contoh video (OpenRouter): base URL `https://openrouter.ai/api/v1`, model `heygen/heygen-video-1`, centang layanan **Video** (jangan centang Chat/Transkripsi/TTS — model video bukan model chat).
Contoh image (OpenRouter): base URL `https://openrouter.ai/api/v1`, model `openai/gpt-image-1-mini`, centang layanan **Image**.
Contoh video edit (OpenRouter): base URL `https://openrouter.ai/api/v1`, model `black-forest-labs/flux-video-edit`, centang layanan **Video Edit**.
Provider OpenAI-compatible lain (Ollama, OpenRouter, Groq, LM Studio, dsb.) bisa langsung ditambahkan dengan base URL masing-masing.

## Seeding otomatis

- Saat server editor pertama kali memanggil fitur LLM, isi `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` dari `.dev.vars` otomatis masuk sebagai entri awal.
- Jika daftar masih kosong tapi `.dev.vars` baru diisi (atau server dijalankan sebelum `.dev.vars` lengkap), gunakan tombol **Impor .dev.vars** di halaman: isi kunci → jalankan ulang `npm run ffmpeg-server` → klik tombol.
- Setelah daftar terisi, impor tidak dijalankan lagi (tombol nonaktif) dan daftar sepenuhnya dikelola lewat halaman.

## Worker (Cloudflare)

- Saat dev, Worker mengambil daftar dari server editor lokal (`http://localhost:3333/llm/providers/runtime`, hanya loopback).
- Saat di-deploy (server lokal tidak ada), Worker memakai env `LLM_FALLBACKS` (JSON array) atau kunci legacy `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`.
- Format `LLM_FALLBACKS`:
  ```json
  [{"name":"OpenAI","base_url":"https://api.openai.com/v1","api_key":"sk-...","model":"gpt-4o-mini"}]
  ```

## API (server 3333)

| Metode | Path | Fungsi |
|---|---|---|
| GET | `/llm/status` | path DB, jumlah provider/log |
| GET | `/llm/providers` | daftar (API key ter-mask) |
| POST | `/llm/providers` | tambah provider |
| PUT | `/llm/providers/:id` | ubah (key kosong = dipertahankan) |
| DELETE | `/llm/providers/:id` | hapus |
| POST | `/llm/providers/reorder` | urutkan ulang `{ "ids": [...] }` |
| POST | `/llm/providers/seed` | impor entri awal dari `.dev.vars` (hanya bila daftar kosong) |
| POST | `/llm/providers/:id/test` | uji satu provider (body opsional `{ capability: 'chat'\|'tts'\|'video' }`) |
| POST | `/llm/test` | uji semua provider pada layanan (body opsional `{ capability }`) |
| GET/DELETE | `/llm/logs` | lihat / bersihkan log |
| POST | `/llm/logs` | tulis log dari Worker |
| GET | `/llm/providers/runtime` | konfigurasi penuh (loopback-only, untuk Worker) |

## Keamanan

- Database `data/llm.db` menyimpan API key **teks biasa** (seperti `.dev.vars`) — folder `data/` sudah masuk `.gitignore`.
- Daftar di halaman menampilkan key ter-mask; key hanya dikirim ke Worker lokal lewat endpoint khusus yang menolak akses non-loopback.
- Endpoint lama server (port 3333) tetap tanpa autentikasi — jangan ekspos port ini ke jaringan publik.
