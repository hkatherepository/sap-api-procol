# Plan: Normalisasi `PEINH` pada PO (SAP → SiProcol)

- **Status:** Disetujui user pada 2026-09-29. **Belum diimplementasikan.**
- **Pembaca:** engineer atau model AI yang akan mengeksekusi task implementasi.
- **Cara pakai:** ikuti §5 (Perubahan per file) dan §6 (Test) secara berurutan. §4 adalah batas yang tidak boleh dilanggar. §8 **bukan** bagian task implementasi.

Aturan format angka di dokumen ini:
- Nilai SAP/tampilan ditulis dengan format Indonesia: titik `.` = pemisah ribuan, koma `,` = desimal. Contoh: `1.287,24`, `Rp 253.300.000`.
- Nilai internal program ditulis tanpa pemisah ribuan. Contoh: `1287.24`, `253300000`.

---

## 1. Context

Tim pusat SAP sudah memperbaiki kontrak API:
1. `MENGE` sekarang dikirim eksplisit dalam format Indonesia, misalnya `"1.287,24"` dan `"16.000"`. Workaround lama seperti `/100` atau skala berdasarkan `MEINS` tidak diperlukan.
2. API PO sekarang mengirim `PEINH` (price unit, "harga berlaku untuk berapa unit"). Sumbernya: `docs/LEGEND(9).xlsx` (baris PO, kolom `PEINH` = "Per") dan `docs/sample_po.json`.

**Masalah aktif:** middleware menghitung total PO sebagai `MENGE × NETPR` tanpa `PEINH`. Contoh sample solar: `MENGE 16.000 L`, `NETPR Rp 1.583.125`, `PEINH 100`. Artinya harga Rp 1.583.125 **per 100 L**.

| | Nilai internal | Tampilan |
|---|---|---|
| Hasil sekarang (salah) | `25330000000` | Rp 25.330.000.000 |
| Seharusnya | `253300000` | Rp 253.300.000 |

Selisihnya 100× (sebesar `PEINH`).

**Root cause:** `PEINH` PO belum dibaca di proses normalisasi dan kalkulasi.

---

## 2. Fakta dari source code (sudah diverifikasi)

| # | Hal | Fakta |
|---|---|---|
| 1 | Schema raw PR/PO | Tidak ada schema/zod. Baris SAP dibaca sebagai `Record<string, unknown>` di `src/sap/normalize.ts` |
| 2 | PO membaca `PEINH`? | **Belum.** `normalizePoItem` (`src/sap/normalize.ts:185-224`) hanya mem-parse `MENGE` dan `NETPR` |
| 3 | `parseSapDecimal` (`src/utils.ts:86`) cocok dengan format baru? | **Ya, sudah diuji dengan menjalankan kode:** `"1.287,24"`→`1287.24`, `"16.000"`→`16000`, `"14.860"`→`14860`, `"1.583.125"`→`1583125`, `"        1"`→`1`, `"   …100"`→`100`, `"113,4"`→`113.4`, `"141.646"`→`141646`. Tidak perlu parser baru |
| 4 | Formula PR | `quantity.mul(price).div(priceUnit)` (`normalize.ts:125`). Setara dengan `MENGE × (PREIS ÷ PEINH)`. Sample PR → `19128386.4` (Rp 19.128.386,40). **Sudah benar** |
| 5 | Formula PO | `quantity.mul(netPrice)` (`normalize.ts:220`). **Salah bila `PEINH ≠ 1`** |
| 6 | `PoItem.priceUnit` | **Belum ada** (`src/domain.ts:97-111`). `PrItem.priceUnit: string` sudah ada |
| 7 | Validasi `PEINH` di PR | Kosong, null, atau format tidak valid → `INVALID_NUMBER`, dan `priceUnit` tetap `0` sehingga ikut muncul `INVALID_PRICE_UNIT`. Nilai `≤ 0` → `INVALID_PRICE_UNIT`. Kedua kode ada di `FATAL_ISSUES` (`src/sync-engine.ts:12-20`), jadi dokumen ditandai `invalid` dan tidak ditulis ke tabel bisnis |
| 8 | Migration? | **Tidak perlu.** Kolom `items` bertipe JSONB (`database/migrations/001_sap_sync_schema.sql:116`). `total_amount` bertipe `numeric` tanpa skala (`tests/fixtures/base_schema.sql:40`, `docs/PROCOL_SCHEMA_CODEX_PROMPT.md:21`), jadi database tidak membulatkan |
| 9 | Checksum | `hashJson({ ...document, issues: undefined })` (`normalize.ts:272`), dan `items` ikut di-hash. Menambah `priceUnit` → **hash semua PO berubah** |
| 10 | Precision Decimal | Tidak ada `Decimal.set(...)` di `src/`, jadi memakai default `decimal.js` (20 digit signifikan per operasi) |

---

## 3. Keputusan final

### 3.1 Formula PO: kali dulu, bagi terakhir

**Business semantic (dokumentasi):**

```text
effectiveUnitPrice = NETPR ÷ PEINH
lineTotal          = MENGE × effectiveUnitPrice
                   = MENGE × (NETPR ÷ PEINH)
```

**Implementasi (kode), pola yang sama persis dengan PR:**

```ts
quantity.mul(netPrice).div(priceUnit)
```

Kedua bentuk setara secara matematika. Kode sengaja mengalikan dahulu lalu membagi, karena:
- **Menjaga precision.** `decimal.js` membulatkan setiap operasi ke 20 digit signifikan. Kalau dibagi dulu, hasil bagi yang tak berhingga (mis. `10 ÷ 3`) terpotong sebelum dikalikan. Sudah diuji:
  - `3 × (10 ÷ 3)` = `9.9999999999999999999` ✗
  - `(3 × 10) ÷ 3` = `10` ✓
- **Menghindari premature rounding** (pembulatan terlalu dini): pembagian hanya terjadi sekali, di langkah terakhir.
- **Konsisten dengan PR** (`normalize.ts:125`).

Maknanya secara bisnis tetap: `NETPR` adalah harga untuk `PEINH` unit.

> **Learning Note:** Pada aritmetika presisi terbatas, penjumlahan dan perkalian angka desimal "bersih" biasanya eksak. Pembagian bisa menghasilkan desimal tak berhingga yang terpaksa dipotong. Karena itu pembagian ditaruh paling akhir.

### 3.2 `PEINH` PO wajib ada, tanpa fallback

- `PEINH` diparse dengan `parseSapDecimal`, di loop yang sama dengan `MENGE` dan `NETPR`.
- Kosong, tidak ada, atau format tidak valid → `INVALID_NUMBER`. Karena `priceUnit` tetap `0`, otomatis ikut `INVALID_PRICE_UNIT`.
- `≤ 0` → `INVALID_PRICE_UNIT`.
- Kedua kode sudah fatal (mekanisme existing), jadi dokumen PO tidak ditulis ke DB.
- **DILARANG** `PEINH ?? 1` atau fallback apa pun ke `1`.
- `PEINH` untuk data historis divalidasi nanti lewat dry-run setelah implementasi (§8.1), bukan di task implementasi.

### 3.3 `priceUnit` di normalized `PoItem`

- Tambahkan `priceUnit: string` ke `PoItem`.
- **Jangan** simpan `effectiveUnitPrice`, karena nilainya selalu bisa dihitung dari `netPrice ÷ priceUnit`.
- **Jangan** rename `netPrice` menjadi `price`, karena frontend mungkin sudah membaca `items[].netPrice` dari JSONB.
- Dengan `netPrice` + `priceUnit` + `unit`, frontend nanti bisa menampilkan "Rp 1.583.125 per 100 L", sama seperti ME23N.

### 3.4 Parser tidak diubah

- `parseSapDecimal` **tidak diubah**.
- Cabang `fixedScale` (`src/utils.ts:91-95`) **tidak diubah dan tidak dihapus** di task ini. Statusnya technical debt (§10).

### 3.5 Kebijakan Precision & Rounding

Middleware **TIDAK melakukan rounding** terhadap:
- nilai sumber SAP,
- `quantity`,
- `price` / `netPrice`,
- `priceUnit`,
- kalkulasi harga efektif,
- `lineTotal`,
- `total_amount`.

Middleware mempertahankan precision `Decimal` hasil parsing dan kalkulasi semaksimal implementasi existing.

**Contoh:**

| | Nilai |
|---|---|
| SAP/API | `MENGE = "1.287,24"`, `PREIS = "14.860"`, `PEINH = "1"` |
| Internal | `quantity = 1287.24`, `price = 14860`, `priceUnit = 1`, `lineTotal = 19128386.4` |

Nilai `19128386.4` **disimpan apa adanya**. Jangan diubah menjadi `19128386` hanya karena tampilan SAP/UI mungkin menampilkan IDR tanpa pecahan.

Perbedaan tampilan SAP/UI **tidak otomatis berarti nilai middleware salah**, karena layer presentation bisa melakukan formatting/rounding sendiri.

| Tanggung jawab | Middleware | Frontend |
|---|---|---|
| Normalisasi format angka SAP | ✓ | |
| Menjaga precision | ✓ | |
| Kalkulasi sesuai business rule | ✓ | |
| Format ribuan & desimal untuk tampilan | | ✓ |
| Rounding presentation (jika diperlukan) | | ✓ |

**DILARANG di kode** (kecuali ada business rule SAP yang sudah terverifikasi):
- `Math.round`, `Math.floor`, `Math.ceil`
- `toDecimalPlaces(...)`
- `toFixed(n)` dengan parameter, untuk memaksa jumlah digit tertentu

**Boleh:** `.toFixed()` **tanpa parameter**. Ini hanya serialisasi `Decimal` ke string tanpa mengurangi precision, dan sudah dipakai di seluruh `normalize.ts`.

---

## 4. Batas task implementasi (TIDAK BOLEH)

Task implementasi **tidak boleh**:
1. Mengubah frontend.
2. Mengubah formula PR (existing sudah ekuivalen).
3. Mengubah `parseSapDecimal` atau cabang `fixedScale`.
4. Melakukan currency rounding dalam bentuk apa pun (§3.5).
5. Menjalankan dry-run, apply, atau backfill.
6. Membuat atau menjalankan migration database tanpa approval.
7. Menjalankan SQL `UPDATE` manual.
8. Melakukan refactor besar yang tidak terkait.
9. Mengubah status logic atau reconcile logic (`src/repository.ts`, `src/sync-engine.ts`).
10. Membaca `.env`, secret, token, atau credential (lihat `CLAUDE.md`).

---

## 5. Perubahan per file (langkah eksekusi)

### 5.1 `src/domain.ts`: interface `PoItem` (bentuk item PO yang disimpan ke JSONB `items`)

Tambahkan satu baris tepat setelah `netPrice: string;`:

```ts
  netPrice: string;
  priceUnit: string;
```

### 5.2 `src/sap/normalize.ts`: `normalizePoItem()` (mengubah 1 baris SAP menjadi 1 item PO internal)

**a. Parse loop.** Ikuti pola PR di `normalize.ts:84-98`. Ganti blok `let quantity` … sampai akhir loop `for` menjadi:

```ts
  let quantity = new Decimal(0);
  let netPrice = new Decimal(0);
  let priceUnit = new Decimal(0);
  for (const [field, assign] of [
    ["MENGE", (value: Decimal) => (quantity = value)],
    ["NETPR", (value: Decimal) => (netPrice = value)],
    ["PEINH", (value: Decimal) => (priceUnit = value)],
  ] as const) {
    try {
      assign(parseSapDecimal(raw[field]));
    } catch (error) {
      issues.push({ code: "INVALID_NUMBER", field, message: error instanceof Error ? error.message : "angka tidak valid" });
    }
  }
  if (priceUnit.lte(0)) issues.push({ code: "INVALID_PRICE_UNIT", field: "PEINH", message: "PEINH harus lebih dari nol" });
```

**b. Objek `item`.** Tambahkan `priceUnit` setelah `netPrice`, lalu ganti `lineTotal`:

```ts
    netPrice: netPrice.toFixed(),
    priceUnit: priceUnit.toFixed(),
    ...
    // NETPR berlaku per PEINH unit: lineTotal = MENGE × (NETPR ÷ PEINH).
    // Dikali dulu, dibagi terakhir agar Decimal tidak membulatkan harga efektif lebih awal.
    lineTotal: !deleteIndicator && priceUnit.gt(0) ? quantity.mul(netPrice).div(priceUnit).toFixed() : null,
```

Guard `priceUnit.gt(0)` mencegah pembagian dengan nol, sama seperti PR. `.toFixed()` tanpa parameter (§3.5).

Yang **tidak** disentuh: `normalizePrItem`, `groupPr`, `normalizePoDocuments` (total dokumen tetap menjumlahkan `lineTotal` item aktif), `parseSapDecimal`, `repository.ts`, `sync-engine.ts`.

### 5.3 `tests/utils.test.ts`: tabel `it.each` di `describe("angka SAP id-ID")`

Tambahkan baris berikut ke array yang sudah ada:

```ts
    ["1.287,24", "1287.24"],
    ["16.000", "16000"],
    ["14.860", "14860"],
    ["1.583.125", "1583125"],
    ["        1", "1"],
    ["      100", "100"],
```

### 5.4 `tests/normalize.test.ts`

**a.** `poSample`: tambahkan `PEINH: "        1",`. Tanpa ini, test PO lama gagal karena `PEINH` sekarang wajib. Ekspektasi lama (`total: "187200000"`, `issues: []`) tetap berlaku.

**b.** Tambahkan test sesuai §6 (PR regression di `describe("normalisasi PR")`, sisanya di `describe("normalisasi PO")`).

### 5.5 `tests/repository.integration.test.ts` (sekitar baris 261-262): payload E2E `po`

Tambahkan `PEINH: "1"` ke objek PO. Tanpa ini, PO E2E menjadi `invalid` dan assert `{ resource: "po", inserted: 1 }` gagal. Suite ini hanya berjalan bila database test dikonfigurasi (`describeDatabase`, baris 12).

### 5.6 Dokumen

- `docs/TECHNICAL_FLOW.md:130`: ganti "Total aktif = `quantity × netPrice`" menjadi "Total aktif = `quantity × (netPrice ÷ priceUnit)`; `PEINH` wajib (kosong atau ≤ 0 → fatal)".
- `docs/KONVERSI_PR_PO.md`:
  - §2: ganti contoh `4 × 4.750.000 ÷ 1 = 19.000.000` dengan sample baru: `1.287,24 × (14.860 ÷ 1) = 19.128.386,40`.
  - §3: tambahkan `PEINH` ke daftar field, lalu ganti formula menjadi `lineTotal = MENGE × (NETPR ÷ PEINH)`. Catat bahwa kode mengalikan dahulu lalu membagi.
  - "Hal yang perlu diperhatikan": tandai #2 (rumus PO tanpa price unit) sebagai **sudah diperbaiki**, lalu tambahkan dua catatan singkat: kebijakan precision (§3.5) dan `fixedScale` sebagai technical debt (§10).

---

## 6. Test plan (wajib ada setelah implementasi)

| Kelompok | Input | Expected |
|---|---|---|
| **Numeric parsing** (`utils.test.ts`) | `"1.287,24"`, `"16.000"`, `"14.860"`, `"1.583.125"`, `"        1"`, `"      100"` | `1287.24`, `16000`, `14860`, `1583125`, `1`, `100` |
| **PR regression** | `{ ...prSample, MENGE: "1.287,24", PREIS: "14.860", PEINH: "        1" }` | item: `quantity "1287.24"`, `price "14860"`, `priceUnit "1"`, `lineTotal "19128386.4"`. Dokumen `total "19128386.4"` (Rp 19.128.386,40) |
| **PO `PEINH = 100`** | `{ ...poSample, MENGE: "16.000", MEINS: "L", NETPR: "1.583.125", PEINH: "                          100" }` | `issues []`. Item: `quantity "16000"`, `netPrice "1583125"`, `priceUnit "100"`, `lineTotal "253300000"`. Dokumen `total "253300000"` (Rp 253.300.000). Bukan `253296000` (harga dibulatkan 15831) dan bukan `253312000` (15832) |
| **PO `PEINH = 1`** | `{ ...poSample, MENGE: "113,4", NETPR: "141.646", PEINH: "1" }` | `quantity "113.4"`, `netPrice "141646"`, `priceUnit "1"`, `lineTotal "16062656.4"`, sama dengan formula lama `113.4 × 141646` |
| **Invalid `PEINH`: 0** | `{ ...poSample, PEINH: "0" }` | issue codes berisi `INVALID_PRICE_UNIT` |
| **Invalid `PEINH`: missing** | `{ ...poSample, PEINH: undefined }` | issue codes berisi `INVALID_NUMBER` dan `INVALID_PRICE_UNIT` |
| **Invalid `PEINH`: format salah** | `{ ...poSample, PEINH: "abc" }` | issue codes berisi `INVALID_NUMBER` dan `INVALID_PRICE_UNIT` |
| **No premature rounding** | `{ ...poSample, MENGE: "3", NETPR: "10", PEINH: "3" }` | `lineTotal "10"`. Kalau implementasi membagi dulu, hasilnya `"9.9999999999999999999"` dan test harus gagal |

Catatan untuk test invalid: issue item digabung ke issue dokumen, jadi assert memakai `records[0]?.issues.map((issue) => issue.code)`.

---

## 7. Verifikasi (dijalankan di task implementasi)

1. `npm run typecheck`: tidak ada literal `PoItem` yang rusak.
2. `npm test`: semua unit test hijau. Laporkan apakah suite integrasi DB berjalan atau di-skip.
3. Konfirmasi dari output test: sample PR `19128386.4`, sample PO `253300000`, kasus `3/10/3` → `10`.
4. `grep` diff untuk memastikan tidak ada `Math.round|Math.floor|Math.ceil|toDecimalPlaces|toFixed\(\d` baru.
5. **Jangan** menjalankan dry-run, apply, atau backfill.

---

## 8. Setelah implementasi: dry-run historis & re-sync

**Bukan bagian task implementasi. Butuh approval terpisah.** Jalankan di staging dulu sesuai `infra/STAGING_RUNBOOK.md`, dan jangan menjalankan SQL `UPDATE` manual.

### 8.1 Validasi `PEINH` historis (wajib sebelum backfill)

- Dry-run historis **wajib**. **Jangan hanya memvalidasi PO terbaru.** Bisa saja API baru hanya mengirim `PEINH` untuk data baru.
- Jalankan dry-run untuk **seluruh rentang tanggal PO lama** yang akan di-backfill (CLI memecah otomatis per bulan):
  `npm run sap-sync -- dry-run --resource po --low <YYYYMMDD> --high <YYYYMMDD>` (lalu `--resource pr`).
- Dry-run hanya menulis audit ke tabel `sap_sync_*`, tidak ke `purchase_orders`/`purchase_requests`.
- Periksa `sap_sync_record_results.issue_codes` per window:
  - `INVALID_PRICE_UNIT` hanya bisa berasal dari `PEINH`, dan selalu muncul bila `PEINH` kosong, invalid, atau ≤ 0. Ini **penanda utama**.
  - `INVALID_NUMBER` bisa berasal dari `MENGE`, `NETPR`, atau `PEINH`. Cek detail di log jika perlu.
- **Jika PO historis di suatu window menghasilkan `INVALID_NUMBER`/`INVALID_PRICE_UNIT` karena `PEINH`, backfill window tersebut DITUNDA** sampai tim pusat memastikan data historis ikut mengirim `PEINH`.

### 8.2 Checksum & arti angka `updated`

Menambah `priceUnit` ke item PO mengubah checksum **seluruh** PO. Karena itu:

> **Jumlah `updated` ≠ jumlah PO yang sebelumnya salah.**

Sumber perubahan yang harus dibedakan:

| Sumber perubahan | Resource | Dampak `items` | Dampak `total_amount` | Ciri |
|---|---|---|---|---|
| **Struktur checksum berubah** (key baru masuk hash) | Semua PO | – | – | Penyebab mekanis semua PO menjadi `updated`. Bukan indikasi data salah |
| **Field baru `priceUnit`** | Semua PO | setiap item mendapat `priceUnit` | tetap (bila `PEINH = 1`) | total sebelum = sesudah |
| **`PEINH ≠ 1`** | PO | `lineTotal` turun sebesar faktor `PEINH` | turun | ada item `priceUnit <> '1'` dan total berubah |
| **`MENGE` historis** (format lama ambigu) | PR & PO | `quantity` & `lineTotal` berubah | berubah | total berubah walaupun semua `priceUnit = '1'` |
| Perubahan data sah di SAP | PR & PO | bervariasi | bervariasi | tidak bisa dibedakan otomatis dari `MENGE` historis; cek sampel manual |

- **PR:** strukturnya tidak berubah, jadi `updated` PR ≈ PR terdampak `MENGE` historis + perubahan sah di SAP.
- **Agar kategori bisa dibedakan:** sebelum apply, ambil snapshot read-only (`SELECT po_number, total_amount, items …`) untuk window yang sama. Setelah apply, bandingkan. Tanpa snapshot, nilai lama tertimpa dan kategorinya tidak bisa direkonstruksi.
- Status lokal yang sudah maju tetap dilindungi reconcile existing: PO `CASE WHEN status IN ('draft','issued')`, PR `IN ('submitted','approved','converted')`. `items` dan `total_amount` tetap diperbarui.
- Re-sync hanya menyentuh dokumen dalam window `--low/--high` yang dijalankan.

**Urutan:** dry-run historis PR & PO → laporkan jumlah PR/PO `updated`, `invalid`, dan issue → snapshot read-only → minta approval → apply per window.

---

## 9. Risiko & edge case

1. **`PEINH` tidak dikirim** oleh endpoint PO production atau untuk data historis → PO `invalid` dan tidak ter-update. Data lama aman, tetapi sync PO berhenti. Terdeteksi lewat dry-run (§8.1).
2. **Pecahan currency.** Middleware sengaja mempertahankan precision hasil kalkulasi (mis. `19128386.4`). SAP/UI mungkin menampilkan nilai yang sudah diformat atau dibulatkan, sehingga tampilan bisa berbeda beberapa pecahan currency. Perbedaan ini **tidak otomatis dianggap error kalkulasi**. Currency rounding **bukan scope task ini** dan tidak boleh ditambahkan sebelum aturan SAP-nya terverifikasi.
3. **Desimal panjang.** `NETPR ÷ PEINH` bisa tak berhingga (mis. ÷ 3). Karena pembagian dilakukan terakhir, hasilnya dibatasi 20 digit signifikan `decimal.js` hanya sekali.
4. **Angka `updated` menyesatkan** bila dibaca sebagai "jumlah PO yang salah" (§8.2).
5. **Asumsi `NETPR`:** di LEGEND labelnya "AMOUNT PO", tetapi nilainya diperlakukan sebagai harga per `PEINH` unit, bukan total baris. Sample solar (≈ Rp 15.831,25/L) hanya masuk akal dengan tafsiran ini.

---

## 10. Technical debt / task lanjutan

- **Audit parser `fixedScale`** (`src/utils.ts:91-95`). Cabang ini menerima format fixed-scale lama (`"100.00000"` → `100`). Ia juga membaca nilai ambigu `"1.28724"` sebagai `1.28724` tanpa error. Untuk format baru, cabang ini tidak terpakai. Tidak ada keputusan untuk menghapusnya. Audit dilakukan sebagai task terpisah: verifikasi seluruh pemanggil `parseSapDecimal` (PR: `MENGE`/`PREIS`/`PEINH`; PO: `MENGE`/`NETPR`/`PEINH`) dan kontrak API aktif. Cabang ini dihapus **hanya jika** semuanya sudah terbukti tidak memakai format fixed-scale.
- **Currency rounding** menunggu aturan SAP yang terverifikasi (desimal per currency, mode pembulatan, dan level baris atau total).
- **Tampilan harga di frontend** ("Rp 1.583.125 per 100 L") memakai `netPrice` + `priceUnit` + `unit`. Task frontend terpisah.
