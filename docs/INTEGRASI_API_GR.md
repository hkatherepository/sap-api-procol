# Tugas: Menambahkan resource GR/SES ke middleware SAP → Si Procol

> Prompt untuk agent coding di repo **middleware SAP** (repo terpisah).
> Tugas ini hanya menambahkan resource baru di middleware; tabel tujuannya sudah
> dibuat dan tidak perlu Anda buat.

> **Status database — baca sebelum menjalankan apa pun.**
>
> | Lingkungan | Tabel penerimaan | Aman ditulis? |
> |---|---|---|
> | **dev** | ✅ sudah ada | Ya — pakai ini untuk mengembangkan dan menguji |
> | **produksi** | ❌ **belum ada** | **Belum.** Menunggu migrasi + deploy aplikasi |
>
> Migrasi produksi menghapus tabel lama `goods_receipts` dan `service_receipts`,
> sehingga harus dijalankan berbarengan dengan deploy aplikasi Si Procol. Selama
> itu belum dilakukan, `INSERT` ke `procurement_receipts` di produksi akan gagal
> karena tabelnya belum ada.
>
> Kembangkan dan uji terhadap **dev**. Untuk memulai dari keadaan bersih:
> `TRUNCATE procurement_receipts CASCADE;` — item dan verifikasinya ikut terhapus
> karena `ON DELETE CASCADE`. Bila terpaksa menyentuh produksi, jalankan mode
> `dry_run` lebih dulu.

---

## Konteks

Middleware ini sudah menarik tiga resource dari SAP (Vendor, PR, PO) dan menulis
langsung ke PostgreSQL Si Procol. Sekarang ditambahkan resource keempat: **GR/SES**
(penerimaan barang dan jasa).

Satu API SAP membawa **dua dokumen bisnis sekaligus**, dibedakan kolom `TCODE2`:

- `ML81N` → Service Entry Sheet (jasa), di Si Procol ditampilkan sebagai **BAPP**
- `MIGO_GR` → Goods Receipt (barang), ditampilkan sebagai **GR**

Polanya sama dengan resource PO yang sudah ada, yang juga membawa PO barang dan
SPK jasa dalam satu API.

Tiga tabel tujuan sudah dibuat di Si Procol dan **tidak perlu Anda buat**:

| Tabel | Isi | Siapa yang menulis |
|---|---|---|
| `procurement_receipts` | Header, satu baris per dokumen | **Middleware ini** |
| `procurement_receipt_items` | Item, satu baris per `LINE_ID` | **Middleware ini** |
| `procurement_receipt_verifications` | Foto, catatan, verifikasi lapangan | Aplikasi Si Procol — **jangan disentuh** |

---

## Bentuk data sumber

Respons API berupa array baris datar. Satu contoh baris **barang**:

```json
{
  "MBLNR": "5300105965", "MJAHR": 2026, "BKTXT": "", "BLDAT": "2026-05-20",
  "BUDAT": "2026-06-02", "TCODE2": "MIGO_GR", "LINE_ID": 1, "SGTXT": "",
  "MATNR": "10030033", "WERKS": "3103", "DMBTR": 433433, "WAERS": "IDR",
  "ERFMG": 30310, "ERFME": "KG", "LFBJA": 2026, "LFBNR": "5300105965",
  "LFPOS": 1, "EBELN": "4310011653", "EBELP": 10,
  "LIFNR": "2020003052", "KUNNR": "", "BANFN": "1310009377", "BNFPO": 10
}
```

Satu contoh baris **jasa**:

```json
{
  "MBLNR": "5300105119", "MJAHR": 2026, "BKTXT": "Jasa Asuransi All Risk",
  "BLDAT": "2026-05-13", "BUDAT": "2026-06-02", "TCODE2": "ML81N", "LINE_ID": 1,
  "SGTXT": "", "MATNR": "", "WERKS": "3909", "DMBTR": 863024.97, "WAERS": "IDR",
  "ERFMG": 1, "ERFME": "LS", "LFBJA": 2026, "LFBNR": "1000355698", "LFPOS": 1,
  "EBELN": "4350005854", "EBELP": 10,
  "LIFNR": "2020015724", "KUNNR": "", "BANFN": "1310009441", "BNFPO": 10
}
```

Arti tiap field: `MBLNR` nomor dokumen material, `MJAHR` tahun, `BKTXT` header text,
`BLDAT` tanggal dokumen, `BUDAT` tanggal posting, `TCODE2` T-code/sumber,
`LINE_ID` nomor item, `SGTXT` item text, `MATNR` material, `WERKS` plant,
`DMBTR` nilai, `WAERS` mata uang, `ERFMG` kuantitas, `ERFME` satuan,
`LFBJA`/`LFBNR`/`LFPOS` tahun/nomor/item referensi (khusus SES),
`EBELN`/`EBELP` nomor dan item PO, `LIFNR` vendor, `KUNNR` kustomer,
`BANFN`/`BNFPO` nomor dan item PR.

---

## Enam aturan yang wajib diikuti

Keenamnya berasal dari analisis data asli satu bulan penuh (Juni 2026, 4.846
baris). Semuanya sudah terbukti, bukan dugaan.

### 1. Saring dulu — hanya 43% baris adalah penerimaan

API ini membawa lebih banyak jenis dokumen daripada namanya:

| `TCODE2` | Baris | Apa ini | Punya `EBELN`? |
|---|---:|---|---|
| `MIGO_GR` | 1.800 | Penerimaan barang ✅ | 1.800 dari 1.800 |
| `ML81N` | 280 | Service Entry Sheet ✅ | 280 dari 280 |
| `MIGO_GI` | 2.412 | Pengeluaran barang ke proyek ❌ | 0 |
| `VL02N` | 205 | Pengiriman keluar ❌ | 0 |
| `MIGO_GO` | 139 | Pengeluaran lain ❌ | 0 |
| `MIGO_TR` | 10 | Transfer antar lokasi ❌ | 0 |

**Hanya `MIGO_GR` dan `ML81N` yang boleh masuk tabel penerimaan.** Empat sisanya
adalah pengeluaran/transfer — kebalikan dari penerimaan — dan tidak satu pun punya
nomor PO. Kalau ikut dimasukkan, tabel akan terisi 2.766 dokumen yang salah dan
seluruh angka dashboard menjadi kacau.

T-code di luar keenam nilai itu: **jangan dimasukkan**, catat sebagai issue
`UNKNOWN_RECEIPT_TCODE` agar bisa ditinjau manusia.

### 2. Kelompokkan baris datar menjadi header + item

Kunci header adalah `MBLNR + MJAHR`; kunci item adalah `LINE_ID` di dalam header.

Nilai header diambil dari baris pertama kelompoknya (`BKTXT`, `BLDAT`, `BUDAT`,
`TCODE2`, `LFBNR`, `LFBJA`, `LIFNR`, `KUNNR`, `WAERS`), sementara `total_qty` dan
`total_value` adalah penjumlahan `ERFMG` dan `DMBTR` seluruh itemnya.

Bila dalam satu dokumen ada `LIFNR` atau `WAERS` yang berbeda-beda antar baris,
karantina dokumennya dan catat issue — jangan diam-diam mengambil yang pertama.

### 3. Nomor item wajib dipadankan menjadi lima digit

Ini kesalahan yang paling mudah terjadi dan paling sulit terdeteksi.

API PO membawa field `KEY` yang sudah tergabung (`"431001179400010"`), dan
middleware PO menyimpannya sebagai `purchase_orders.items[].sapKey`.
**API GR/SES tidak punya field `KEY`** — hanya `EBELN` dan `EBELP` terpisah,
dengan `EBELP` berupa integer (`10`).

Jadi kunci penghubungnya harus Anda susun sendiri:

```
po_item_number = lpad(String(EBELP), 5, "0")        →  "00010"
po_sap_key     = EBELN + po_item_number             →  "431001165300010"
                                                        ↑ cocok dengan items[].sapKey milik PO
```

Kalau padding terlewat, hasilnya `"431001165310"` yang **tidak akan pernah cocok
dengan satu pun item PO**. Akibatnya seluruh progres pekerjaan terbaca 0% —
tanpa error, tanpa peringatan. Aturan yang sama berlaku untuk `BNFPO` →
`pr_item_number`.

### 4. Format angka berbeda dari resource PO

| API | Field | Contoh nilai | Arti titik |
|---|---|---|---|
| PO | `NETPR` | `"5.760.000"` (string) | pemisah **ribuan** |
| GR/SES | `DMBTR` | `863024.97` (JSON number) | pemisah **desimal** |

Resource GR/SES mengirim angka sebagai JSON number biasa. **Jangan menerapkan
parser format Indonesia di sini.** Kalau `863024.97` diproses seperti `NETPR`,
nilainya menjadi `86.302.497` — seratus kali lipat.

Artinya konfigurasi format angka harus **per resource**, bukan global. Kalau saat
ini `SAP_NUMBER_FORMAT` berlaku untuk semua resource, ubah menjadi per-resource.

### 5. Pembatalan: periksa T-code **dan** header text

Pembatalan penerimaan tidak selalu memakai T-code `MIGO_CANCEL`. Pada data Juni
ada 29 baris ber-`TCODE2` = `MIGO_GR` biasa yang ditandai lewat `BKTXT` = `"CANCEL"`,
dengan **kuantitas positif**.

Contoh nyata: PO `4310011479` item 10 punya dua dokumen masing-masing 400 unit —
satu penerimaan (`5300106496`, BKTXT kosong) dan satu pembatalan (`5300105994`,
BKTXT `"CANCEL"`). Tanpa penanganan, item itu terbaca 200% diterima.

Isi `is_reversal = true` bila salah satu terpenuhi:

- `TCODE2` mengandung `CANCEL`
- `BKTXT` mengandung `CANCEL`, `BATAL`, atau `REVERS` (bandingkan huruf besar)
- `ERFMG` atau `DMBTR` bernilai negatif

Ini masih heuristik. Lihat bagian "Permintaan ke tim SAP" di bawah.

### 6. `po_id` hanya diisi bila satu dokumen menunjuk satu PO

Di SAP, satu dokumen MIGO boleh berisi baris untuk beberapa PO berbeda. Jadi PO
adalah atribut **baris**, bukan atribut dokumen.

- `procurement_receipt_items.po_number` / `po_id` → selalu diisi per item
- `procurement_receipts.po_number` / `po_id` → **hanya** diisi bila seluruh item
  dalam dokumen itu menunjuk PO yang sama; kalau campur, biarkan `NULL`

Aturan ini persis sama dengan yang sudah dipakai untuk `purchase_orders.pr_id`.

---

## Pemetaan field lengkap

### `procurement_receipts` (header)

| Kolom | Sumber | Wajib | Catatan |
|---|---|:---:|---|
| `id` | — | | Ada `DEFAULT gen_random_uuid()`, jangan diisi |
| `sap_doc_number` | `MBLNR` | ✅ | |
| `sap_doc_year` | `MJAHR` | ✅ | `smallint`, harus 1990–2999 |
| `sap_tcode` | `TCODE2` | | Simpan mentah |
| `header_text` | `BKTXT` | | Untuk jasa inilah deskripsi pekerjaan |
| `doc_date` | `BLDAT` | | |
| `posting_date` | `BUDAT` | ✅ | |
| `sap_ref_doc_number` | `LFBNR` | | Nomor SES untuk jasa |
| `sap_ref_doc_year` | `LFBJA` | | `smallint` |
| `vendor_code` | `LIFNR` | | Simpan apa adanya |
| `vendor_id` | dicari dari `LIFNR` | | Lihat "Pencarian relasi" |
| `customer_code` | `KUNNR` | | |
| `po_number` / `po_id` | `EBELN` | | Hanya bila satu PO (aturan #6) |
| `project_id` | dari PO | | `purchase_orders.project_id` |
| `unit_id` | dari `WERKS` | | Lihat "Pencarian relasi" |
| `currency` | `WAERS` | | |
| `total_qty` | `SUM(ERFMG)` | | `numeric(18,3)` |
| `total_value` | `SUM(DMBTR)` | | `numeric(18,2)` |
| `is_reversal` | turunan | | Aturan #5. Default `false` |
| `data_source` | konstanta `'SAP'` | | |
| `source_key` | `MBLNR + '/' + MJAHR` | | |
| `source_checksum` | hash isi dokumen | | `char(64)`, untuk melewati record tak berubah |
| `last_synced_at` | waktu run | | |
| `updated_at` | waktu run | ✅ | Tidak ada default untuk UPDATE |

**Tiga kolom yang JANGAN Anda tulis:**

- `receipt_date` — **generated column** (`COALESCE(doc_date, posting_date)`).
  Postgres akan **menolak** insert yang menyebut kolom ini.
- `receipt_type` dan `receipt_type_source` — boleh dikirim, boleh tidak; ada
  trigger yang mengisinya. Lihat "Perilaku trigger".
- `receipt_number` — sama, trigger yang mengisi.

### `procurement_receipt_items` (item)

| Kolom | Sumber | Wajib | Catatan |
|---|---|:---:|---|
| `receipt_id` | FK ke header | ✅ | `ON DELETE CASCADE` |
| `line_id` | `LINE_ID` | ✅ | `integer`, harus > 0 |
| `item_text` | `SGTXT` | | Sering kosong |
| `material_code` | `MATNR` | | Kosong untuk jasa |
| `plant` | `WERKS` | | |
| `quantity` | `ERFMG` | ✅ | `numeric(18,3)` |
| `unit` | `ERFME` | | |
| `amount` | `DMBTR` | ✅ | `numeric(18,2)` |
| `currency` | `WAERS` | | |
| `po_number` | `EBELN` | | |
| `po_item_number` | `lpad(EBELP, 5, '0')` | | Aturan #3 |
| `po_sap_key` | `EBELN + po_item_number` | | Aturan #3 |
| `po_id` | dicari dari `EBELN` | | |
| `pr_number` | `BANFN` | | |
| `pr_item_number` | `lpad(BNFPO, 5, '0')` | | |
| `sap_ref_item` | `LFPOS` | | |
| `is_reversal` | turunan | | |
| `updated_at` | waktu run | ✅ | |

---

## Pencarian relasi

```sql
-- vendor_id
SELECT id FROM vendor_registrations WHERE vendor_code = :LIFNR;
-- tidak ketemu → vendor_id NULL + issue VENDOR_NOT_FOUND, rekonsiliasi run berikutnya

-- po_id
SELECT id, project_id FROM purchase_orders WHERE po_number = :EBELN;
-- tidak ketemu → po_id NULL + issue PO_NOT_FOUND, JANGAN melewati barisnya

-- unit_id (dari plant item pertama)
SELECT id FROM units WHERE plant = :WERKS;
```

Semuanya nullable. **Baris tetap dimasukkan meski relasinya belum ketemu** —
inilah kenapa urutan sync penting (lihat di bawah).

---

## Perilaku trigger yang perlu Anda ketahui

Ada dua `BEFORE INSERT OR UPDATE` trigger di sisi database. Keduanya jaring
pengaman supaya middleware versi lama tetap menghasilkan data yang benar.

**Pada header** — kalau `receipt_type` dikirim `NULL`:

- `TCODE2` diawali `ML81` → `jasa`, source `derived`
- `TCODE2` terisi selain itu → `barang`, source `derived`
- `TCODE2` kosong → `barang`, source `fallback` (perlu ditinjau manusia)
- Kalau `receipt_type` dikirim tapi `receipt_type_source` tidak → source `sap`

Kalau `receipt_number` `NULL`: diisi `LFBNR` untuk jasa (bila ada), selain itu
`MBLNR`. Dan `is_reversal` dinaikkan menjadi `true` bila T-code atau header text
mengandung penanda pembatalan.

**Pada item** — `po_sap_key` disusun otomatis dari `po_number` + `po_item_number`
bila `NULL`, dan `is_reversal` menjadi `true` bila `quantity` atau `amount` negatif.

> Meski trigger ada, **tetap kirim nilainya secara eksplisit** dari middleware.
> Trigger adalah cadangan, bukan pengganti. Bila Anda mengirim `receipt_type`
> sendiri, sertakan `receipt_type_source = 'sap'`.

---

## Idempotensi

Menjalankan window yang sama dua kali tidak boleh menghasilkan dokumen ganda.

```sql
INSERT INTO procurement_receipts (...) VALUES (...)
ON CONFLICT (sap_doc_number, sap_doc_year) DO UPDATE SET ...;
```

Untuk item, cara paling bersih adalah `DELETE` seluruh item dokumen lalu
`INSERT` ulang, **dalam satu transaksi per dokumen**. Constraint uniknya
`(receipt_id, line_id)`.

Karena header sudah unik per `(MBLNR, MJAHR)`, kombinasi `receipt_id + line_id`
setara dengan natural key SAP `(MBLNR, MJAHR, LINE_ID)`.

---

## Urutan sync dan audit

Resource baru bernama **`gr`**, dan **wajib diproses paling akhir**:

```
Vendor → PR → PO → GR
```

Alasannya: `po_id` dan `vendor_id` dicari dari data yang baru saja dimasukkan
resource sebelumnya. Kalau GR jalan duluan, hampir semua relasinya `NULL`.

Nilai `'gr'` sudah ditambahkan ke CHECK constraint pada `sap_sync_run_resources`
dan `sap_sync_checkpoints`, jadi audit run tinggal dipakai seperti resource lain.

Field tanggal filter yang dipakai: **`BUDAT`** (tanggal posting).

---

## Kriteria selesai

1. Menjalankan window yang sama dua kali menghasilkan nol insert dan nol update
   pada run kedua.
2. Dari sample Juni 2026 (4.846 baris): tepat **898 dokumen** dan **2.080 item**
   yang masuk. Kalau lebih, penyaringan T-code (aturan #1) belum benar.
3. Pembagian jenis: **619 barang** (609 normal + 10 pembatalan) dan **279 jasa**.
4. Query berikut harus mengembalikan **1.242** pada database dev:
   ```sql
   SELECT count(*) FROM procurement_receipt_items i
   JOIN purchase_order_item_lines l ON l.po_sap_key = i.po_sap_key;
   ```
   Kalau hasilnya 0, padding lima digit (aturan #3) belum diterapkan.
5. Tidak ada baris ber-`receipt_type_source = 'fallback'`.
6. Dokumen jasa memakai nomor SES pada `receipt_number` (contoh: `1000355698`),
   bukan nomor material document (`5300105119`).
7. Uji unit minimal: penyaringan T-code, padding nomor item, pengelompokan
   multi-item, dokumen multi-PO (header `po_id` harus `NULL`), deteksi pembatalan
   lewat header text, dan angka desimal `DMBTR` tidak berubah nilainya.

---

## Permintaan ke tim SAP (di luar coding, tapi tolong diajukan)

1. **Tambahkan `BWART` (movement type) dan `SHKZG` (indikator debit/kredit) ke
   query.** Tanpa keduanya, pembatalan hanya bisa ditebak dari T-code dan header
   text, sehingga angka progres pekerjaan berpotensi lebih tinggi dari kenyataan.
   Kolom `sap_movement_type` sudah disiapkan dan menunggu diisi.
2. **Konfirmasi arti `BLDAT` pada ML81N** — tanggal akhir periode pekerjaan, atau
   tanggal entry sheet dibuat? Si Procol memakai `COALESCE(BLDAT, BUDAT)` sebagai
   tanggal bisnis untuk evaluasi vendor dan perhitungan keterlambatan.
3. **Konfirmasi `LFBNR` pada MIGO.** Dokumentasi menyebut biasanya kosong, tetapi
   pada data nyata nilainya sama dengan `MBLNR`.
4. Pada data Juni ada **4 dokumen ber-`BLDAT` di masa depan** (sampai 2026-12-17)
   dan **12 dokumen** dengan `BLDAT` lebih dari 90 hari sebelum `BUDAT`. Mohon
   dikonfirmasi apakah wajar.

---

## Catatan: ada bug di resource PO yang sudah ada

Ini di luar tugas GR/SES, tapi ditemukan saat memverifikasi data dan **menghalangi
progres jasa terbaca benar**, jadi sebaiknya diperbaiki bersamaan.

Harga item PO tersimpan salah, kemungkinan besar 1000× terlalu besar. Buktinya:

- Dari **1.315 item PO, nol yang mempunyai angka desimal.** Bandingkan dengan
  sisi penerimaan: 418 dari 2.080 punya desimal.
- PO `4310011733`: solar 48.000 liter dengan harga satuan tercatat
  **Rp 2.365.275 per liter**, sehingga nilai PO menjadi Rp 113 miliar. Harga
  solar sebenarnya sekitar Rp 2.365,275 per liter.
- Harga satuan tertinggi di seluruh PO: **Rp 14,9 miliar per unit**.

Dugaannya: `NETPR` dikirim sebagai string berformat Indonesia (`"2.365,275"`),
dan parser membuang titik **dan** koma sekaligus, sehingga desimalnya ikut menjadi
bagian bilangan bulat. Yang benar: titik dibuang (pemisah ribuan), koma menjadi
titik desimal.

Dampaknya: progres barang tetap benar karena dihitung dari kuantitas, tetapi
progres jasa — yang berbasis nilai — terbaca hampir nol. Contoh: SPK `4350005949`
tercatat Rp 10,2 miliar sementara BAPP yang masuk Rp 25 juta, sehingga progres
0,25%.

Setelah `netPrice` diperbaiki, angka jasa langsung benar tanpa perubahan kode di
sisi Si Procol.

---

## Referensi

- Kontrak lengkap: `docs/plan/sap-procol-data-integration-prd.md` §7.6 (di repo Si Procol)
- Catatan desain tabel: `docs/plan/procurement-receipts-gr-bapp.md`
- Aturan versi TypeScript yang dipakai Si Procol (boleh disalin):
  `server/src/lib/procurement-document.ts` — `isReceiptDocument`,
  `resolveReceiptType`, `isReceiptReversal`, `sapItemNumber`, `purchaseOrderItemKey`
