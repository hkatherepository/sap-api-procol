# Kontrak Database Si Procol

Migration tidak dijalankan otomatis. File SQL merupakan proposal perubahan schema yang wajib dibandingkan dengan migration Vendor dan schema Procurement Online aktual. Hanya migration versi 1 yang diperlukan oleh service.

## Kolom existing yang diasumsikan

`vendor_registrations`:

- `id`, `vendor_code`, `circle_number`, `vendor_created_at`, `company_name`, `npwp`, `address`, `city`
- `created_at`, `updated_at`, `approved_at`, `phone`, `email`, `status`, `user_id`, `approver_name`
- `vendor_code` adalah identifier tunggal dan unique: Vendor SAP menyimpan `LIFNR` pada kolom ini.
- PO mencari `vendor_id` langsung melalui kesamaan `purchase_orders` payload `LIFNR` dengan `vendor_registrations.vendor_code`.
- `circle_number`/BPEXT, NPWP, email, dan nama perusahaan adalah atribut dan tidak digunakan sebagai identity threshold.
- Dua LIFNR berbeda tetap menjadi dua Vendor meskipun BPEXT, NPWP, atau atribut lain sama.
- NPWP dan email adalah atribut; keduanya tidak dipakai sebagai identity threshold.
- Enum `vendor_status` memakai nilai lowercase, termasuk `verified`, `suspended`, `blacklisted`, dan `rejected`.

`purchase_requests`:

- `id`, `pr_number`, `status`

`purchase_orders`:

- `id`, `po_number`, `status`, `issued_at`, `vendor_id`

Migration menambahkan metadata SAP, item JSON, checksum, audit, checkpoint, dan linkage. Bila nama atau tipe kolom existing berbeda, ubah migration dan query repository secara bersamaan sebelum approval.

## Preflight sebelum migration

```sql
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('vendor_registrations', 'purchase_requests', 'purchase_orders')
ORDER BY table_name, ordinal_position;
```

Pastikan `vendor_code` tidak duplikat dan constraint unique tetap aktif:

```sql
SELECT vendor_code, count(*)
FROM vendor_registrations
WHERE vendor_code IS NOT NULL AND btrim(vendor_code) <> ''
GROUP BY vendor_code
HAVING count(*) > 1;
```

Jika migration alias versi lama sudah pernah diterapkan, tabel `vendor_sap_circles` dan `vendor_sap_identifiers` dibiarkan utuh untuk keamanan data tetapi tidak lagi dibaca atau ditulis oleh service. Cleanup schema harus dilakukan sebagai migration terpisah setelah review pemilik database.

## Hak akses

Role runtime hanya memerlukan `SELECT`, `INSERT`, dan `UPDATE` pada tabel yang disebut di migration. Retensi audit dijalankan melalui fungsi terbatas `sap_purge_audit(integer)`, sehingga role tidak menerima hak `DELETE` langsung. Role tidak boleh mempunyai DDL, superuser, atau akses database lain.

## Schema gate

Saat startup dan sebelum command operasional, aplikasi memeriksa `sap_integration_schema_versions`. Service membutuhkan minimal versi `1`; versi lebih tinggi tetap diterima untuk kompatibilitas database yang sempat menerima migration alias lama.
