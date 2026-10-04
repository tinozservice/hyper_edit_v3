# Panduan Upload YouTube

Upload video **langsung ke channel YouTube Anda** dari editor — OAuth resmi +
YouTube Data API v3, tanpa CreatorOS atau layanan pihak ketiga.

Terkait: [[Catatan Dependensi]] · [[Logs/2026-10-03 - Rasio Video & Jev OpenRouter|Log 2026-10-03]]

## 1. Setup sekali saja (Google Cloud)

1. Buka https://console.cloud.google.com → buat project baru (nama bebas).
2. **APIs & Services → Library** → cari **YouTube Data API v3** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** → Create.
   - Isi App name + email → Save and continue (Scopes & Test users boleh dilewati dulu).
   - **Test users**: tambahkan alamat Gmail channel YouTube Anda → Save.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized redirect URIs** → Add URI → `http://localhost:3333/youtube/oauth/callback`
   - Create → salin **Client ID** dan **Client secret**.
5. Isi `.dev.vars`:
   ```ini
   YOUTUBE_CLIENT_ID=xxxxx.apps.googleusercontent.com
   YOUTUBE_CLIENT_SECRET=xxxxx
   ```
6. Restart `npm run ffmpeg-server`.

## 2. Menghubungkan channel

1. Buka editor → panel kanan → tab **YouTube**.
2. Klik **Hubungkan ke YouTube** → tab Google terbuka → pilih akun channel → **Allow**.
3. Halaman "✅ YouTube terhubung" muncul; panel otomatis menampilkan nama channel.

Token disimpan di `data/youtube.db` (refresh token OAuth, gitignored). Klik
**Putuskan koneksi YouTube** untuk mencabut dari sisi aplikasi (cabut penuh di
https://myaccount.google.com/permissions).

## 3. Upload

1. Pilih **Sumber video**:
   - *Render ekspor terbaru* — hasil Export timeline utama (centang "Render ulang" bila ingin render dulu).
   - *Asset di library* — termasuk hasil **Shorts generator** (otomatis terisi judul & hook).
2. Isi judul, deskripsi, tag, visibilitas (**default Unlisted** — aman untuk review).
3. Klik **Upload ke YouTube**.
4. Untuk video vertikal ≤ 3 menit, `#Shorts` otomatis ditambahkan ke deskripsi.
5. Hasil: link **Buka Shorts** + **YouTube Studio**. Riwayat upload tampil di bawah panel.

## Catatan penting

- **Refresh token 7 hari**: selama OAuth consent screen berstatus *Testing*,
  Google membatasi refresh token 7 hari (harus sambung ulang mingguan). Agar
  permanen: **Publish app** di OAuth consent screen (status *In production*;
  untuk akun sendiri, peringatan "unverified" cukup diklik *Advanced → Go to app*).
- **Kuota YouTube API**: 10.000 unit/hari; satu upload ≈ 1.600 unit → ± 6 upload/hari.
- **Visibilitas**: default `unlisted`. Pilih `public` bila ingin langsung tayang.
- **Video > 15 menit** perlu verifikasi channel di YouTube (aturan YouTube).
- **Thumbnail**: memakai thumbnail asset (maks 2 MB); gagal thumbnail tidak membatalkan upload.
- **Made for kids**: default "bukan" — ubah bila kontennya untuk anak-anak.

## Endpoint (server editor, port 3333)

| Metode | Path | Fungsi |
|---|---|---|
| GET | `/youtube/status` | konfigurasi + status koneksi + channel |
| GET | `/youtube/oauth/start` | mulai alur OAuth (redirect ke Google) |
| GET | `/youtube/oauth/callback` | callback Google (isi redirect URI ini) |
| POST | `/youtube/upload` | `{ sessionId, assetId \| renderFirst, title, description, tags, privacyStatus, madeForKids }` |
| GET | `/youtube/uploads` | riwayat upload |
| POST | `/youtube/disconnect` | hapus refresh token |

Endpoint `POST /youtube/upload` juga bisa dipanggil agen/otomasi lain — jalur ini
yang menggantikan CreatorOS untuk YouTube.
