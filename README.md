# Kenal Jamsostek v2 - Quiz Sesi DIJAMIN

Aplikasi web statis untuk pretest (`index.html`, sesi `Absensi`) dan posttest (`feedback.html`, sesi `Feedback`).

## Pengamanan

- Bank soal tetap di Google Spreadsheet, tetapi spreadsheet **tidak dipublish** dan aksesnya *Restricted*.
- Soal disajikan oleh Apps Script **satu per satu**. Kunci jawaban tidak pernah dikirim ke browser.
- Batas waktu 25 detik per soal, ditegakkan di server. Tidak ada tombol kembali atau mulai ulang.
- Teks soal digambar di `<canvas>`, sehingga tidak bisa disalin atau dibaca ekstensi AI dari DOM.
- Ekstensi browser yang menyisipkan elemen ke halaman memblokir tombol mulai.
- Keluar dari halaman (pindah aplikasi, tab, side panel AI) dicatat di kolom `keluar_layar`.
- Feedback wajib kode sesi dari sheet `kode_sesi`.
- Pretest dan Feedback hanya bisa 1 kali per nomor WA per hari per tema.
- Skor dan durasi dihitung di server. Hasil hanya menampilkan skor, tanpa kunci dan pembahasan.
- Baris dengan `catatan` (`KELUAR_LAYAR`, `EKSTENSI`, `TERLALU_CEPAT`) tidak masuk leaderboard.

## Spreadsheet

Tab `bank_soal` (nama bisa diubah di `BANK_SHEET_NAME`):

```csv
id_soal,nama_modul,program,sesi,pertanyaan,opsi_a,opsi_b,opsi_c,opsi_d,kunci,status
```

- `sesi`: `PRE`, `POST`, atau `SEMUA`.
- `status`: hanya baris `AKTIF` yang dipakai.
- `opsi_e` dan `pembahasan` opsional.

Tab `kode_sesi`:

| tanggal | kode | buka | tutup |
|---|---|---|---|
| 2026-11-20 | 482913 | 10:00 | 10:20 |

Format kolom `tanggal` sebagai Plain text `yyyy-mm-dd`.

Tab `jawaban` dibuat otomatis oleh Apps Script.

## Apps Script

1. Buka spreadsheet, lalu `Extensions > Apps Script`.
2. Tempel isi `apps-script-jawaban.gs`.
3. `Project Settings`: Time zone `Asia/Jakarta`.
4. `Deploy > Manage deployments > Edit > New version`. Execute as: Me. Who has access: Anyone.
5. Bila URL Web App berubah, ganti `RESPONSE_ENDPOINT_URL` di `app.js`, dan URL endpoint di `hasil.js`, `leaderboard.js`, `sertifikat.js`.

Pengaturan di bagian atas skrip: `SECONDS_PER_QUESTION`, `ANSWER_GRACE_SECONDS`, `MAX_FOCUS_LOST`, `CODE_REQUIRED_SESSIONS`, `ONE_ATTEMPT_SESSIONS`.

## Aturan Rilis

- Absensi dapat dibuka tanpa pembatasan jam.
- Feedback mulai dapat dibuka pukul 10.00 WIB dan wajib kode sesi yang aktif.
- Halaman sertifikat dapat dibuka mulai pukul 10.30 sampai sebelum pukul 24.00 WIB.
- Sertifikat hanya untuk peserta yang mengisi Feedback sebelum pukul 12.00 WIB pada hari kegiatan yang sama.

## Menjalankan Lokal

```bash
python -m http.server 5173
```

Lalu buka `http://localhost:5173`.

## Batasan

Halaman web tidak bisa mencegah peserta memotret soal dengan HP kedua. Penangkal utama: batas waktu per soal dan soal kontekstual dari isi sesi.
Penjagaan jam dan login dashboard berjalan di browser dan bukan pengganti autentikasi server.
