# Mekanisme Konversi Nilai PR & PO: SAP API → Database

Dokumen ini menjelaskan bagaimana data Purchase Request (PR) dan Purchase Order (PO) dari API SAP diubah dan disimpan ke database. Sumber kode: [src/sap/normalize.ts](../src/sap/normalize.ts), [src/utils.ts](../src/utils.ts), [src/sync-engine.ts](../src/sync-engine.ts), [src/repository.ts](../src/repository.ts).

## Gambaran alur

```
SAP API ──► unwrapSapResponse ──► normalize (per baris item) ──► grouping per dokumen
        ──► validasi (issue fatal?) ──► reconcile ke DB (1 transaksi per dokumen)
```

1. **Ambil data**: `sync-engine.ts` memanggil API SAP. `src/sap/response.ts` membuka bungkus JSON (`value`, `results`, `d.results`) sehingga hasilnya berupa array baris.
2. **Normalisasi**: setiap baris dari SAP berisi **satu item**, bukan satu dokumen. Baris-baris itu diubah ke format internal, lalu dikelompokkan per nomor dokumen (`BANFN` untuk PR, `EBELN` untuk PO).
3. **Validasi**: kalau ada issue yang termasuk **fatal** (`FATAL_ISSUES` di `sync-engine.ts`), seluruh dokumen ditandai `invalid` dan tidak ditulis ke DB.
4. **Reconcile**: dokumen yang valid di-insert atau di-update ke `purchase_requests` / `purchase_orders`. Setiap dokumen diproses dalam transaksi sendiri.

## 1. Konversi angka (bagian paling kritis)

SAP mengirim angka sebagai **string berformat Indonesia**, misalnya `"4.750.000"`. Konversinya dilakukan oleh `parseSapDecimal` (`src/utils.ts`) dengan library `decimal.js`.

> **Learning Note:** `Decimal` dipakai, bukan `Number`, supaya perhitungan uang tidak kena galat floating-point (contoh klasik: `0.1 + 0.2 = 0.30000000000000004`).

Aturannya dicek berurutan:

| Input SAP | Aturan | Hasil |
|---|---|---|
| `"  1 "`, `"-2"` | Bilangan bulat polos | `1`, `-2` |
| `"100.00000"`, `"5.000.00000"` | Ada ≥4 digit setelah titik terakhir, artinya format *fixed-scale* SAP. Bagian itu dianggap desimal dan titik sebelumnya dianggap pemisah ribuan | `100`, `5000` |
| `"187.200.000"`, `"1.234,50"` | Format id-ID: titik = ribuan, koma = desimal | `187200000`, `1234.5` |
| `"-2,5"` | Koma sebagai desimal | `-2.5` |
| `"1.25"`, `"1,234.56"` | **Ambigu**, ditolak | error `INVALID_NUMBER` |

Contoh-contoh ini diambil dari test di `tests/utils.test.ts`.

Field lain juga dibersihkan:
- **String**: `cleanString` melakukan trim, dan string kosong diubah jadi `null`.
- **Tanggal**: `parseSapDate` menerima `2026-08-11` maupun `20260811`, lalu mengubahnya ke `YYYY-MM-DD`. Tanggal yang mustahil seperti 30 Februari ditolak.
- **Nomor item**: `BNFPO: 20` diubah jadi `"00020"` (5 digit, diisi nol di depan).

## 2. Konversi PR (Purchase Request)

### Per item (`normalizePrItem`)

| Field SAP | Field internal | Catatan |
|---|---|---|
| `BANFN` | `prNumber` | wajib |
| `BNFPO` | `itemNumber` | dipad 5 digit |
| `KEY` | `sapKey` | harus sama dengan `BANFN + BNFPO(5 digit)`; kalau tidak, muncul `KEY_MISMATCH` |
| `MENGE` / `PREIS` / `PEINH` | `quantity` / `price` / `priceUnit` | `PEINH` harus > 0 |
| `LOEKZ` | `isDeleted` | terisi apa pun berarti item dihapus |
| `FRGKZ` | `releaseIndicator` | dipakai untuk menentukan status |
| `EBELN` / `EBELP` | `poNumber` / `poItemNumber` | penanda item ini sudah dibuat PO-nya |

**Nilai per baris:**

```
lineTotal = MENGE × PREIS ÷ PEINH     (null kalau item dihapus)
```

Contoh dari `docs/sample_pr_new.json`: `1.287,24 × (14.860 ÷ 1) = 19.128.386,40`.

> **Learning Note:** `PEINH` (*price unit*) artinya "harga ini berlaku untuk berapa unit". Kalau `PREIS = 100.000` dan `PEINH = 10`, harga per unitnya 10.000.

### Per dokumen (`groupPr`)

- **`total`** adalah jumlah `lineTotal` dari item yang **tidak dihapus**. Kalau PR punya lebih dari satu currency, `total = null` dan muncul issue `MULTI_CURRENCY`.
- **`status`** ditentukan dengan urutan prioritas berikut:
  1. Semua item aktif sudah punya `EBELN`, maka statusnya `CONVERTED`.
  2. Semua item aktif punya `FRGKZ = "2"`, maka statusnya `APPROVED`.
  3. Selain itu, statusnya `SUBMITTED`.
- **`sourceDate` / `sourceCreatedBy`** diambil dari **baris pertama** (`ERDAT`, `ERNAM`).

## 3. Konversi PO (Purchase Order)

### Per item (`normalizePoItem`)

Field yang dipakai: `EBELN`, `EBELP`, `LIFNR` (vendor), `MENGE`, `NETPR`, `PEINH` (wajib, harus > 0), `FRGKE`, `WAERS`, `BUKRS`, dan `AEDAT` sebagai tanggal.

**Nilai per baris:**

```
lineTotal = MENGE × (NETPR ÷ PEINH)     (null kalau item dihapus)
```

Kode mengalikan dahulu lalu membagi (`MENGE × NETPR ÷ PEINH`) agar `Decimal` tidak memotong harga efektif lebih awal. Contoh solar: `16.000 × (1.583.125 ÷ 100) = 253.300.000`. `PEINH` kosong/invalid → `INVALID_NUMBER` + `INVALID_PRICE_UNIT` (fatal).

### Per dokumen (`normalizePoDocuments`)

- `total` adalah jumlah `lineTotal` item aktif, dengan aturan currency yang sama seperti PR.
- `status`: kalau semua item aktif punya `FRGKE = "G"`, statusnya `ISSUED`. Selain itu `DRAFT`.
- Ada validasi konsistensi **yang bersifat fatal**: currency (`INCONSISTENT_CURRENCY`), company/`BUKRS` (`INCONSISTENT_COMPANY`), dan vendor/`LIFNR` (`INCONSISTENT_VENDOR`) harus sama di semua item.

## 4. Penulisan ke database

Semua baris item disimpan sebagai **JSONB** di kolom `items`. Header disimpan di kolom biasa (`total_amount`, `currency`, `status`, dan seterusnya).

`reconcilePr` dan `reconcilePo` (`src/repository.ts`) memakai pola yang sama:

1. Baris dikunci dengan `SELECT ... FOR UPDATE` berdasarkan `pr_number` / `po_number`. Tujuannya mencegah dua proses mengubah baris yang sama bersamaan.
2. Kalau record sudah ada tapi `data_source ≠ 'SAP'` (dibuat manual di aplikasi), hasilnya **`conflict`**. Data lokal tidak ditimpa.
3. Kalau `source_checksum` sama dengan hash dokumen baru, hasilnya **`unchanged`** dan tidak ada query tulis.
   > **Learning Note:** hash SHA-256 dihitung dari dokumen hasil normalisasi dengan urutan key yang sudah diseragamkan. Dengan begitu, perubahan sekecil apa pun di SAP terdeteksi tanpa harus membandingkan kolom satu per satu.
4. Kalau record belum ada, dilakukan INSERT. Kalau sudah ada, dilakukan UPDATE.
5. **Status hanya ditimpa kalau status lokal masih "status milik SAP"**:
   - PR: `submitted`, `approved`, atau `converted`
   - PO: `draft` atau `issued`

   Jadi kalau di Procol status sudah maju ke tahap lain, sync tidak akan mengembalikannya.
6. **Khusus PO**:
   - `vendor_id` dicari lewat `vendor_code`. Kalau vendor tidak ketemu, PO **tetap disimpan** dengan issue `VENDOR_NOT_FOUND`.
   - `issued_at` diisi dari `AEDAT` kalau statusnya `ISSUED`.
   - `reconcileLinks` membuat relasi PR↔PO di tabel `sap_document_links`. Caranya dengan mencari item PR (di dalam JSONB) yang `poNumber`-nya sama dengan PO ini. Kalau PO itu berasal dari tepat **satu** PR, maka `purchase_orders.pr_id` diisi.

Hasil setiap dokumen (`inserted`, `updated`, `unchanged`, `conflict`, `invalid`, atau `failed`) dicatat di `sap_sync_record_results` sebagai jejak audit.

## Hal yang perlu diperhatikan

Berikut beberapa temuan dari pembacaan kode. Ini observasi, belum diuji dengan data nyata.

1. **Satu item rusak menggagalkan seluruh dokumen.** Issue per item digabung ke issue dokumen. Kalau satu item punya `PREIS` ambigu, seluruh PR ditandai `invalid` dan tidak disimpan sama sekali.
2. ~~**Rumus PO tidak memakai price unit.**~~ **Sudah diperbaiki:** PO kini memakai `MENGE × (NETPR ÷ PEINH)` dan `PEINH` wajib.
3. **`"1.430"` dibaca sebagai 1430**, bukan 1,43. Ini konsisten dengan format id-ID, tapi berbahaya kalau suatu saat SAP mengirim desimal dengan 3 digit memakai titik.
4. **`MULTI_CURRENCY` dan `ALL_ITEMS_DELETED` tidak fatal** untuk PR. Dokumennya tetap tersimpan, dengan `total_amount = null` atau `0`.
5. **Precision:** middleware tidak melakukan rounding pada quantity, harga, `lineTotal`, maupun `total_amount` (mis. `19128386.4` disimpan apa adanya). Format/rounding tampilan adalah tanggung jawab frontend.
6. **Technical debt `fixedScale`:** cabang fixed-scale di `parseSapDecimal` masih ada dan bisa membaca `"1.28724"` sebagai `1.28724` tanpa error. Audit dan penghapusan dilakukan sebagai task terpisah.
