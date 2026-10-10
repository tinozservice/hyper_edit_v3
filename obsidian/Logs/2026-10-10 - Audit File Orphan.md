# Log 2026-10-10 — Audit File Orphan / Tak Terpakai

Terkait: [[../Catatan Dependensi|Catatan Dependensi]] · [[../Audit Klien LLM|Audit Klien LLM]] · [[2026-10-03 - Rasio Video & Jev OpenRouter|Log 2026-10-03]]

**Status: SELESAI (2026-10-10)** — semua kandidat §1/§2/§4/§5 sudah dihapus, kecuali `lottie-web` (dipertahankan — lihat §2). Verifikasi akhir di bagian bawah.

Metode: `git status --ignored`, `git log <file>`, `npm run knip`, grep referensi (`Toolbar`, `VideoUpload`, `useFFmpeg`, `zod`, `bundler|renderer`, dll.) di seluruh repo. Working tree bersih di `9b26b9c`; tidak ada file untracked non-ignored. Semua temuan di bawah adalah file tracked yang mati, dokumen usang, atau artefak lokal gitignored.

## 1. Kode mati (tidak diimpor siapa pun)

| File | Bukti | Sejak |
|---|---|---|
| `src/react-app/components/Toolbar.tsx` | grep tanpa hasil di seluruh `src/`; knip "unused files"; UI dummy (split/duplicate/undo tanpa handler) | initial commit `9279cd4` |
| `src/react-app/components/VideoUpload.tsx` | grep tanpa hasil; knip; digantikan upload/AssetLibrary di `Home.tsx` | initial commit `9279cd4` |
| `src/react-app/hooks/useFFmpeg.ts` | grep tanpa hasil; knip; satu-satunya pemakai `@ffmpeg/ffmpeg` + `@ffmpeg/util`; server FFmpeg lokal (port 3333) sudah menggantikannya | initial commit `9279cd4` |
| `src/shared/types.ts` | hanya komentar contoh scaffold Mocha + `import z from "zod"` yang tidak dipakai; tidak direferensikan di mana pun | scaffold Mocha |

Catatan kecil: `toSpeakable` di `src/react-app/hooks/useVoiceDirector.ts:37` di-export tapi hanya dipakai internal (baris 211) — **`export` sudah dilepas (2026-10-10)**, bukan file orphan.

## 2. Dependensi npm kandidat hapus (setelah kode mati di §1 dihapus)

| Paket | Alasan |
|---|---|
| `@ffmpeg/ffmpeg`, `@ffmpeg/util` | hanya diimpor oleh `useFFmpeg.ts` (mati) |
| `@hono/zod-validator` | tidak ada impor di seluruh `src/` |
| `zod` | hanya diimpor oleh `src/shared/types.ts` (mati) |
| `@remotion/bundler`, `@remotion/renderer` | tidak diimpor kode; render memakai spawn `@remotion/cli` (server baris 775) yang membawa dep-nya sendiri; komentar server baris 4662 menyebut renderer tidak disetup |
| `lottie-web` | tidak diimpor langsung (kebutuhan internal `@remotion/lottie`) — verifikasi dulu sebelum hapus |

Hasil verifikasi: `lottie-web` adalah **peerDependency** `@remotion/lottie` (`^5`) dan `@remotion/lottie` dipakai di `src/remotion/DynamicAnimation.tsx` → **dipertahankan**.

## 3. Bukan orphan — false positive knip, JANGAN dihapus

- `@creatoros/cli` — dijalankan via bin `creatoros` (spawn), bukan impor.
- `@remotion/cli` — spawn langsung `node_modules/@remotion/cli/remotion-cli.js` (server baris 775); dipakai juga oleh `remotion.config.ts`.
- Paket yang hanya dipakai di `src/remotion/**` (entry Remotion di luar entry knip): `@remotion/preload`, `three`, `@react-three/fiber`, `@react-three/drei`, `@remotion/three`, `@types/three`, `@remotion/animated-emoji`, `@remotion/gif`, `@remotion/lottie`, `@remotion/shapes`.
- File `src/remotion/DynamicAnimation.tsx`, `Root.tsx`, `index.tsx`, `components/Scene3D.tsx` — dirender lewat `remotion render src/remotion/index.tsx`; template di `src/remotion/templates/` dipakai panel UI.
- `src/types/env.d.ts` — deklarasi tipe env global lewat tsconfig.
- `src/react-app/hooks/useVideoSession.ts` — legacy, masih dipakai `Home.tsx` (generateChapters).
- `.cursor/skills/remotion-best-practices` — symlink ke `.agents/skills/remotion-best-practices`, bukan duplikat.

## 4. Dokumen usang (kandidat hapus/arsip)

- `TODO.md` (root) — roadmap "HyperEdit" lama: judul proyek sudah berubah, banyak item "Ship Now" (API key UI, landing page) sudah kedaluwarsa/tergantikan dokumentasi lain.
- `docs/todo.md` — placeholder scaffold Mocha (#1 backend FFmpeg + R2) yang sudah lama terlampaui.

## 5. Artefak lokal (gitignored, tidak masuk repo)

- `data/heygen-test-output.mp4` (339 KB) — output uji video HeyGen; tidak direferensikan di kode mana pun. Kandidat hapus.
- Bukan orphan: `data/llm.db`, `data/youtube.db*`, `data/projects.json`, `data/projects/` (data runtime sah); `dist/` (hasil build, bisa diregenerasi); `obsidian/Media_Projek` + `obsidian/.obsidian` (vault contoh, sengaja — lihat [[2026-10-03 - Rasio Video & Jev OpenRouter|Log 2026-10-03]] §4).

## Hasil eksekusi (2026-10-10)

- [x] Konfirmasi: hapus semua — §1 kode mati, §2 dependensi (kecuali `lottie-web`), §4 dokumen, §5 artefak.
- [x] §1: `Toolbar.tsx`, `VideoUpload.tsx`, `useFFmpeg.ts`, `src/shared/types.ts` dihapus (`git rm`); `export` di `toSpeakable` dilepas.
- [x] §2: `@ffmpeg/ffmpeg`, `@ffmpeg/util`, `@hono/zod-validator`, `zod`, `@remotion/bundler`, `@remotion/renderer` dilepas dari `package.json` + lock (`npm uninstall --legacy-peer-deps`).
- [x] §4: `TODO.md` + `docs/todo.md` dihapus. §5: `data/heygen-test-output.mp4` dihapus.
- [x] Verifikasi: `npm run build` ✅ · `npm run lint` 84 error — baseline HEAD 86 error, **0 error baru** (semua pre-existing di 8 file lama) · `npm run knip` — file mati hilang dari laporan; sisa temuan persis daftar §3 "JANGAN dihapus".

Catatan: knip juga melaporkan 23 "unused exported types" (mis. `ProjectState` di `useProject.ts`, prop type template `src/remotion/templates/*`) + 2 configuration hint — sudah ada sebelum audit, di luar scope, belum disentuh.
