# Log 2026-10-03 — Rasio Video & Jev via OpenRouter

Terkait: [[../Panduan Fallback LLM|Panduan Fallback LLM]] · [[../Catatan Dependensi|Catatan Dependensi]] · [[../Audit Klien LLM|Audit Klien LLM]] · [[2026-10-02 - Implementasi Fallback LLM|Log 2026-10-02]]

## 1. Fitur rasio/piksel video di editor

Permintaan: pilihan rasio 16:9, 9:16, 4:3, 1:1, dsb., plus rasio/piksel custom untuk mengubah area editor.

**Yang dibuat:**
- `src/react-app/lib/videoFormats.ts` — preset (16:9 1920×1080, 9:16 1080×1920, 4:3 1440×1080, 3:4 1080×1440, 1:1 1080×1080, 21:9 2560×1080, 9:21 1080×2520), validasi 16–7680 px, pembulatan ke bilangan **genap** (syarat H.264 yuv420p), label `W×H` untuk dimensi custom.
- `src/react-app/components/AspectRatioPicker.tsx` — modal baru: grid preset (dengan miniatur orientasi), input custom lebar×tinggi, tombol tukar portrait/landscape, pratinjau rasio desimal, tombol terapkan.
- `Timeline.tsx` — tombol rasio kini membuka picker; ikon mengikuti orientasi; tooltip menampilkan format + dimensi aktif.
- `VideoPreview.tsx` — prop `aspectRatio` diganti `videoWidth`/`videoHeight`; kanvas memakai CSS `aspect-ratio` dari `settings.width/height`.
- `Home.tsx` — `settings.width/height` tetap menjadi satu-satunya sumber kebenaran (dipakai preview dan render FFmpeg); label rasio diturunkan otomatis lewat `useEffect`; auto-deteksi video pertama kini ikut menyetel dimensi kanvas; handler toggle lama diganti `handleOpenRatioPicker` + `handleApplyVideoFormat` (langsung `saveProject`).
- Bonus perbaikan: hook `useMemo` di `VideoPreview` dipindah ke atas early return `layers.length === 0` (pelanggaran *rules-of-hooks* yang sudah lama ada).
- Semua render overlay yang sebelumnya hardcode `1920×1080`/`fps 30` di `Home.tsx` (motion graphic, animation, transcript animation, contextual animation, edit animation) kini memakai `settings.width/height/fps` — overlay ikut format kanvas, termasuk portrait dan custom.

**Cara pakai:** buka editor → tombol rasio di toolbar timeline → pilih preset atau isi piksel custom → Terapkan. Dimensi tersimpan di `project.json` dan dipakai ekspor.

## 2. Jev via OpenRouter dengan versi model spesifik

Permintaan: Jev dari OpenRouter (tanpa API key langsung ke typesafe.ai), dengan versi model spesifik mis. `typesafe/jev-1.13`.

**Temuan:**
- OpenRouter menyediakan dua permukaan untuk Jev: **Decisions API** (`POST https://openrouter.ai/api/alpha/decisions`) dan **System One API** (`POST https://openrouter.ai/api/v1/systemone`, jalur SDK TypeSafe). Keduanya memakai protokol yang sama dengan TypeSafe: `{ state, model, questions }` → `{ answers, model, usage }`.
- Model `typesafe/jev-1.13` (nama versi: `typesafe/jev-1.13-20260917`) ada di katalog OpenRouter, modalitas `text→decisions`; **tidak bisa** lewat `/chat/completions` (error 400 yang mengarahkan ke Decisions API).

**Perubahan `scripts/jev.js`:**
- Konfigurasi otomatis: bila `OPENROUTER_API_KEY` ada → endpoint Decisions + model default `typesafe/jev-1.13`; bila hanya `TYPESAFE_API_KEY` → mode lama (`api.typesafe.ai`, `jev-latest`). `JEV_ENDPOINT` meng-override endpoint; `JEV_MODEL` mengubah model (versi spesifik atau alias `~typesafe/jev-latest`).
- `askJev()` kini juga mengulang pada 502/503/524 selain 429/529, timeout default 15 dtk, dan menyertakan `provider` di respons.
- `jevInfo()` baru — status aman-tampil (provider, model, endpoint) diekspos lewat `GET /session/:id/obsidian/status` bersama `jev: true/false`.

**Hasil uji:**
- Mock Decisions API: ✅ parsing `answers`, model terkirim `typesafe/jev-1.13`, override model per panggilan
- **Live OpenRouter** (key dari DB pool, satu request kecil): ✅ `model: typesafe/jev-1.13-20260917`, provider `TypeSafe`, jawaban choice `delete` (0,81) + noul logo 0,83, biaya **$0,000018**, 691 ms
- `npm run build` ✅

**Cara pakai:** isi `.dev.vars`:
```ini
OPENROUTER_API_KEY=sk-or-...
JEV_MODEL=typesafe/jev-1.13
```
(atau `~typesafe/jev-latest` bila ingin ikut versi terbaru). `TYPESAFE_API_KEY` boleh dikosongkan; bila keduanya terisi, OpenRouter yang dipakai. Restart `npm run ffmpeg-server`.

## 3. Perbaikan warning "Vault mirror sync failed: spawn rsync ENOENT"

Dilaporkan dari panel Obsidian/JEV di Windows: banner kuning `spawn rsync ENOENT` dan 0 clips/0 images.

**Penyebab:** agen media menyalin vault iCloud ke mirror lokal memakai `rsync` (tidak ada di Windows), dan path vault default menunjuk ke folder macOS milik developer asli (`/Users/<user>/...`). Keduanya membuat sync selalu gagal dan isi index kosong.

**Perbaikan `scripts/obsidian-agent.js`:**
- Mode **direct** otomatis saat `rsync` tidak tersedia (Windows): index, thumbnail, dan import membaca vault di tempat; `syncMirror()` menjadi no-op tanpa spawn proses.
- Vault yang tidak ada tidak lagi menghasilkan banner "mirror sync failed" — status bersih (`vaultExists: false`), panel menampilkan petunjuk `OBSIDIAN_VAULT_PATH`.
- `OBSIDIAN_VAULT_DIRECT=1/0` untuk memaksa mode. macOS tetap memakai mirror rsync (perilaku lama).
- Status kini menyertakan `mirror.mode`; panel menampilkan nama folder vault sebenarnya + penanda "dibaca langsung".

**Hasil uji (vault lokal 2 media + sidecar):** ✅ `mode: direct`, index 2 item (1 video, 1 image), `syncMirror` tanpa error, pencarian "the claude logo" menemukan item yang tepat, vault hilang → status bersih tanpa banner.

**Cara pakai di Windows:** isi `.dev.vars`:
```ini
OBSIDIAN_VAULT_PATH=D:\Media\Vault
```
Vault berisi file media + note `.md` dengan frontmatter (`name`, `type`, `file`, `brand`, …) seperti struktur Marketing OS Broll. Restart `npm run ffmpeg-server`.

## 4. Vault media contoh + upload YouTube native

**Vault contoh** di `obsidian/Media_Projek` (dibaca mode direct):
- `_Panduan Vault Media.md` — penjelasan struktur + tabel frontmatter.
- Contoh: `ai-companies/Claude/claude-logo.md`, `brand-assets/creator-os/creator-os-icon.md`, `video-broll/basketball/basketball-clip.md` (+ media contoh).
- Uji: 3 item terindeks (2 gambar, 1 video); query "the claude logo", "creator os icon", "basketball footage" menemukan item yang tepat.

**Upload YouTube native (pengganti CreatorOS untuk YouTube):**
- `scripts/youtube-client.js` — OAuth offline (refresh token di `data/youtube.db`), resumable upload `videos.insert`, thumbnail `thumbnails.set`, riwayat upload.
- Endpoint: `/youtube/status`, `/youtube/oauth/start`, `/youtube/oauth/callback`, `/youtube/upload`, `/youtube/uploads`, `/youtube/disconnect`.
- Panel baru **YouTube** di editor: hubungkan channel, pilih sumber (render terbaru / asset short), judul–deskripsi–tag–visibilitas, unggah, tautan Shorts/Studio, riwayat.
- `#Shorts` otomatis untuk video vertikal ≤ 3 menit; visibilitas default *unlisted*.
- Uji mock Google API: ✅ OAuth (state, code, channel), upload resumable (metadata + bytes + thumbnail), riwayat sukses/gagal, disconnect.
- Setup OAuth langkah demi langkah: [[../Panduan Upload YouTube|Panduan Upload YouTube]].

## Langkah berikutnya

- Restart `npm run ffmpeg-server` + `npm run dev`; muat ulang halaman.
- Ingin Jev Router (yang memilih model chat otomatis)? Itu jalur berbeda: model `typesafe/jev-router` via `/chat/completions` — bisa ditambahkan sebagai provider di [[../Panduan Fallback LLM|halaman fallback]].
