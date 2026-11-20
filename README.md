# Kenal Jamsostek v2 - Quiz Sesi DIJAMIN

Aplikasi web statis untuk pretest (`index.html`, sesi `Absensi`) dan posttest (`feedback.html`, sesi `Feedback`).

## Pengamanan

- Bank soal tetap di Google Spreadsheet, tetapi spreadsheet **tidak dipublish** dan aksesnya *Restricted*.
- Soal disajikan oleh Apps Script **satu per satu**. Kunci jawaban tidak pernah dikirim ke browser.
- Batas waktu 25 detik per soal, ditegakkan di server. Tidak ada tombol kembali atau mulai ulang.
- Teks soal digambar di `<canvas>`, sehingga tidak bisa disalin atau dibaca ekstensi AI dari DOM.
- Ekstensi browser yang menyisipkan elemen ke halaman memblokir tombol mulai.
- Keluar dari halaman (pindah aplikasi, tab, side panel AI) dicatat di kolom `keluar_layar`.
- Sesi Absensi/Feedback hanya terbuka bila berstatus `AKTIF` di sheet `sesi_aktif`.
- Ekstensi yang muncul di tengah pengerjaan langsung menghentikan pengerjaan.
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

Tab `sesi_aktif` (satu-satunya pengendali buka/tutup sesi):

| sesi | status | tanggal | buka | tutup |
|---|---|---|---|---|
| Absensi | AKTIF | | | |
| Feedback | NONAKTIF | | | |

- Ubah `status` menjadi `AKTIF` untuk membuka sesi, selain itu sesi tertutup.
- `tanggal` (Plain text `yyyy-mm-dd`), `buka`, `tutup` opsional. Bila diisi, ikut membatasi.

Tab `jawaban` dibuat otomatis oleh Apps Script.

## Apps Script

1. Buka spreadsheet, lalu `Extensions > Apps Script`.
2. Tempel isi `apps-script-jawaban.gs`.
3. `Project Settings`: Time zone `Asia/Jakarta`.
4. `Deploy > Manage deployments > Edit > New version`. Execute as: Me. Who has access: Anyone.
5. Bila URL Web App berubah, ganti `RESPONSE_ENDPOINT_URL` di `app.js`, dan URL endpoint di `hasil.js`, `leaderboard.js`, `sertifikat.js`.

Pengaturan di bagian atas skrip: `SECONDS_PER_QUESTION`, `ANSWER_GRACE_SECONDS`, `MAX_FOCUS_LOST`, `ONE_ATTEMPT_SESSIONS`.

## Aturan Rilis

- Absensi dapat dibuka tanpa pembatasan jam.
- Absensi dan Feedback dibuka/ditutup dari sheet `sesi_aktif`.
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
