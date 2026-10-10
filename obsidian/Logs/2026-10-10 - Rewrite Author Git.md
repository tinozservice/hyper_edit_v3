# Log 2026-10-10 — Rewrite Author Git (atribusi akun)

Terkait: [[2026-10-10 - Audit File Orphan|Log 2026-10-10 (Audit File Orphan)]] · [[../Catatan Dependensi|Catatan Dependensi]]

## Masalah

Commit di GitHub tertulis `tinozservice`, bukan identitas yang benar. Penyebab: `.git/config` **lokal** meng-override `user.name` global, sehingga commit dibuat dengan nama `tinozservice` (kemungkinan sisa proses redaksi sebelum repo dibuat publik).

## Temuan

- Akun GitHub `tinozservice` (id 317493749) = akun Tino; display name "Tino Suratno"; email `tinozservice@users.noreply.github.com` memang teratribusi ke akun itu.
- **17 commit pertama** (Initial commit … Rename agent labels, ≤ 21 Sep) ber-tree identik dengan repo asal `kevinbadi/hyperedit` → **penulis aslinya Kevin Bahrabadi**; commit sejak **3 Okt** (LLM fallback pool dst.) adalah kerja Tino.
- Config global Tino (di-set 2026-10-10): `Tino Suratno <tinozservice@users.noreply.github.com>`.
- Remote `upstream` (`github.com/kevinbadi/hyperedit`) tidak disentuh.

## Tindakan

- Backup branch lokal: `backup/pre-author-rewrite` → `3ffb2e8` (history paling awal; tidak di-push).
- Override lokal dihapus (`user.name`/`user.email`) → commit baru memakai global.
- Percobaan pertama: semua commit → `Tino Suratno` (force-push `3ffb2e8 → bc7c1dc`).
- **Direvisi sesuai penulis asli:** 17 commit basis → `Kevin Bahrabadi <129329982+kevinbadi@users.noreply.github.com>` (noreply agar teratribusi ke akun kevinbadi); 8 commit sejak 3 Okt + log ini → `Tino Suratno <tinozservice@users.noreply.github.com>`.
- Force-push final (semua SHA commit berubah).

## Hasil

- Author & committer sesuai penulis masing-masing; isi (tree) dan tanggal commit tidak berubah.
- GitHub API: 17 commit teratribusi akun `kevinbadi` (nama "Kevin Bahrabadi"); 8 sisanya akun `tinozservice` (nama "Tino Suratno").

## Bersih-bersih (opsional, nanti)

```powershell
git branch -D backup/pre-author-rewrite          # hapus backup lokal
git update-ref -d refs/original/refs/heads/main  # hapus sisa ref filter-branch
```
