# Laporan Sinkronisasi SAP — Januari 2025 s.d. September 2026

Tanggal eksekusi: 29 September 2026 · Mode: `apply` (CLI, scheduler tidak aktif) · Resource: PR, PO, GR (Vendor dimatikan).

## Ringkasan

| Data | Sebelum | Sesudah | Selisih |
|---|---|---|---|
| PR | 1.192 | 2.158 | +966 |
| PO | 2.639 | 4.906 | +2.267 |
| GR (dokumen) | 7.737 | 15.914 | +8.177 |
| Link PR ↔ PO | 3.050 | 6.325 | +3.275 |
| GR tanpa link PO | 1.409 | 889 | -520 |

- **63 tugas** (21 bulan × PR/PO/GR) selesai; **0 failed** (gagal teknis/tulis DB) dan **0 conflict**.
- Total baris diterima dari SAP: 114.922; dokumen valid diproses: 22.980; baris/dokumen invalid: 557.
- Nilai total GR tersimpan: Rp 2.038.203.300.141 (setelah koreksi `DMBTR` ×100).
- Checkpoint `pr`/`po`/`gr` tetap `20260929` (tidak mundur oleh backfill). Lock sync: 0 tertahan.

## Aturan yang berlaku pada sync ini

1. Filter tanggal dikirim ke SAP: PR = `ERDAT`, PO = `AEDAT`, GR = `BUDAT`, dipecah per bulan.
2. Item PR/PO **digabung per nomor item** (tidak lagi menimpa seluruh dokumen).
3. PO release bila seluruh item aktif `FRGKE` = `G` atau `2`; PR release bila `FRGKZ` = `2`.
4. PR/PO **baru** yang belum release tidak dimasukkan; yang sudah ada tetap di-update.
5. `PEINH` 0/kosong dihitung sebagai 1 (`PRICE_UNIT_DEFAULTED`).
6. `DMBTR` GR mata uang tanpa desimal (IDR) dikalikan 100.
7. Relasi PO/vendor/unit ikut checksum sehingga GR tersambung ke PO yang masuk belakangan.

## Hasil per bulan

Kolom *valid* = dokumen yang lolos validasi (PR/PO/GR). *Belum release* tidak dihitung dan tidak tercatat.

| Bulan | PR valid (baru / ubah / tetap) | PO valid (baru / ubah / tetap) | GR valid (baru / ubah / tetap) | GR invalid |
|---|---|---|---|---|
| Jan 2025 | 130 (0 / 1 / 129) | 224 (0 / 224 / 0) | 621 (0 / 0 / 621) | 212 |
| Feb 2025 | 128 (0 / 0 / 128) | 326 (0 / 326 / 0) | 876 (313 / 0 / 563) | 5 |
| Mar 2025 | 101 (101 / 0 / 0) | 241 (241 / 0 / 0) | 915 (915 / 0 / 0) | 0 |
| Apr 2025 | 67 (67 / 0 / 0) | 164 (164 / 0 / 0) | 478 (478 / 0 / 0) | 39 |
| Mei 2025 | 75 (75 / 0 / 0) | 209 (209 / 0 / 0) | 833 (833 / 0 / 0) | 7 |
| Jun 2025 | 120 (0 / 0 / 120) | 230 (0 / 0 / 230) | 902 (153 / 0 / 749) | 6 |
| Jul 2025 | 92 (92 / 0 / 0) | 248 (248 / 0 / 0) | 821 (821 / 0 / 0) | 35 |
| Agu 2025 | 104 (104 / 0 / 0) | 189 (189 / 0 / 0) | 681 (681 / 0 / 0) | 29 |
| Sep 2025 | 100 (100 / 0 / 0) | 195 (195 / 0 / 0) | 757 (757 / 0 / 0) | 43 |
| Okt 2025 | 86 (86 / 0 / 0) | 214 (214 / 0 / 0) | 535 (535 / 0 / 0) | 23 |
| Nov 2025 | 103 (103 / 0 / 0) | 283 (283 / 0 / 0) | 877 (877 / 0 / 0) | 40 |
| Des 2025 | 119 (119 / 0 / 0) | 294 (294 / 0 / 0) | 1.064 (1064 / 0 / 0) | 13 |
| Jan 2026 | 76 (0 / 0 / 76) | 261 (0 / 261 / 0) | 509 (0 / 253 / 256) | 49 |
| Feb 2026 | 129 (0 / 0 / 129) | 290 (0 / 290 / 0) | 860 (0 / 216 / 644) | 0 |
| Mar 2026 | 103 (0 / 0 / 103) | 212 (0 / 212 / 0) | 745 (0 / 112 / 633) | 12 |
| Apr 2026 | 102 (0 / 0 / 102) | 199 (0 / 199 / 0) | 590 (0 / 108 / 482) | 9 |
| Mei 2026 | 86 (0 / 0 / 86) | 180 (0 / 180 / 0) | 689 (0 / 117 / 572) | 0 |
| Jun 2026 | 110 (0 / 0 / 110) | 249 (0 / 249 / 0) | 898 (0 / 81 / 817) | 0 |
| Jul 2026 | 131 (0 / 0 / 131) | 244 (0 / 244 / 0) | 757 (0 / 31 / 726) | 21 (+1 PO) |
| Agu 2026 | 87 (0 / 0 / 87) | 220 (0 / 220 / 0) | 839 (0 / 19 / 820) | 9 |
| Sep 2026 | 111 (0 / 3 / 108) | 234 (0 / 234 / 0) | 667 (1 / 10 / 656) | 4 |

Catatan: GR Feb 2025 dan Jun 2025 sebagian sudah masuk pada run yang terputus, sehingga tercatat *tetap* pada run lanjutan. PO yang sudah ada tercatat *ubah* karena rumus checksum PO berubah (item gabungan + relasi vendor), bukan karena datanya di SAP berubah; ini terjadi sekali saja. GR 2026 yang *ubah* umumnya karena kini tersambung ke PO 2025 yang baru masuk.

## Kondisi data sesudah sync

| Tahun | PR | PO | GR |
|---|---|---|---|
| 2025 | 1.223 | 2.817 | 9.360 |
| 2026 | 935 | 2.089 | 6.554 |

Status: PR `approved` 105, `converted` 1.850, `submitted` 203; PO `draft` 289, `issued` 4.617.

Kode `FRGKE` pada item PO aktif: `G` 13.290, `2` 8.246, `B` 598, `kosong` 127, `1` 100.

`PR submitted` dan `PO draft` berasal dari sync sebelum aturan 4 dikembalikan (dokumen lama tetap di-update, tidak dihapus) — sesuai keputusan untuk dicek dulu.

### Pemulihan item yang sempat terpotong

Contoh PR `1310007023` (item dibuat lintas bulan): sekarang **4 item** (`00010,00020,00030,00040`), status `converted`, `source_date` 2025-01-30. Sebelumnya hanya 2 item (`00030,00040`).

### GR tanpa link PO

Turun dari 1.409 menjadi **889 dokumen** (1.424 item). Seluruhnya punya nomor PO, tetapi PO-nya belum ada di database. **Dugaan (belum diverifikasi):** PO dibuat sebelum 2025 (di luar rentang sync) atau PO belum release. Bila PO 2024 diperlukan, sync rentang 2024 akan menyambungkannya otomatis.

## Data invalid

| Resource | Penyebab | Jumlah |
|---|---|---|
| GR | T-code `MI07` belum dikenali | 416 |
| GR | T-code `VL09` belum dikenali | 139 |
| GR | T-code `MI08` belum dikenali | 1 |
| PO | `REQUIRED_FIELD,PRICE_UNIT_DEFAULTED` | 1 |

Rincian T-code dan PO invalid ada di [DATA_INVALID_SYNC_2026-09-29.md](DATA_INVALID_SYNC_2026-09-29.md) (periode 2026). Seluruh baris GR invalid adalah transaksi stok (`MI07`/`MI08`/`VL09`) tanpa nomor PO; menunggu konfirmasi tim SAP untuk dimasukkan ke daftar non-penerimaan.

PO/PR invalid: `4310011948` (Jul 2026) — `REQUIRED_FIELD, PRICE_UNIT_DEFAULTED`.

`PEINH` 0/kosong yang dihitung sebagai 1: 4 PO, 0 PR.

## Eksekusi dan gangguan

| Run | Rentang | Mulai (UTC) | Selesai (UTC) | Status | Log |
|---|---|---|---|---|---|
| `42730911` | Jan 2025 – Sep 2026 | 10:52:21 | terputus ±11:18 | crash (tunnel) | `logs/sync_20250101-20260929.log` |
| `fc437b1e` | Jun 2025 – Sep 2026 | 11:19:34 | 12:23:57 | `partial` (hanya karena data invalid) | `logs/sync_20250601-20260929_lanjutan-1.log` |

- Run pertama berhenti di GR Juni 2025 karena server `38.47.91.26` memutus SSH tunnel (`Connection to 38.47.91.26 closed by remote host`). Container tunnel tercatat restart 14 kali hari itu.
- Sesi database yatim dari run yang crash masih memegang lock sync; sesi itu (idle, dimulai bersamaan dengan run) dihentikan dengan `pg_terminate_backend` sebelum run lanjutan.
- Run pertama tetap berstatus `running` di `sap_sync_runs` (hanya catatan riwayat).

## Rekomendasi

1. **Ketahanan koneksi (prioritas):** tambahkan error handler dan TCP keepalive pada koneksi PostgreSQL agar putusnya tunnel tidak membuat proses crash dan lock tertahan. Tanpa ini, scheduler production berisiko macet (`skipped_locked`).
2. **SSH tunnel:** periksa kebijakan timeout server `38.47.91.26` dan tambahkan `ServerAliveInterval` pada tunnel.
3. **T-code `MI07`/`MI08`/`VL09`:** setelah dikonfirmasi tim SAP, masukkan ke daftar non-penerimaan.
4. **PR `submitted` / PO `draft` lama:** putuskan dihapus atau dipertahankan (saat ini dipertahankan).
5. **PO sebelum 2025:** sync rentang 2024 bila GR tanpa link PO perlu disambungkan.
