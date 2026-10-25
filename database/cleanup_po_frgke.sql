-- Hapus PO dari SAP yang tidak lolos aturan FRGKE (lihat isPoAccepted di src/sap/normalize.ts).
-- PO diambil bila seluruh item aktif (isDeleted=false) punya FRGKE G/2/1/B; 'L'/kosong = dihapus/cancel di SAP.
-- Pengecualian: PO plant 3219 (AMP Subang) dengan source_date (AEDAT) sebelum 2026-10-01 tidak disentuh.
-- Hanya menyentuh data_source='SAP' berstatus 'draft'; record lokal dan lifecycle lokal tidak disentuh.
-- PO yang sudah punya GR (lewat po_id maupun po_number) dikecualikan dan dievaluasi terpisah.
-- Default diakhiri ROLLBACK: cek hasil preview dulu, lalu ganti ROLLBACK menjadi COMMIT.

BEGIN;

CREATE TEMP TABLE cleanup_po ON COMMIT DROP AS
  WITH candidate AS (
    SELECT po.id, po.po_number,
      CASE
        WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(po.items, '[]'::jsonb)) i
                         WHERE NOT coalesce((i->>'isDeleted')::boolean, false)) THEN 'semua_item_terhapus'
        WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(po.items, '[]'::jsonb)) i
                     WHERE NOT coalesce((i->>'isDeleted')::boolean, false) AND i->>'releaseIndicator' = 'L') THEN 'frgke_L'
        WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(po.items, '[]'::jsonb)) i
                     WHERE NOT coalesce((i->>'isDeleted')::boolean, false) AND coalesce(i->>'releaseIndicator', '') = '') THEN 'frgke_kosong'
        WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(po.items, '[]'::jsonb)) i
                     WHERE NOT coalesce((i->>'isDeleted')::boolean, false)
                       AND i->>'releaseIndicator' NOT IN ('G', '2', '1', 'B')) THEN 'frgke_lain'
      END AS reason,
      EXISTS (SELECT 1 FROM procurement_receipts r WHERE r.po_id = po.id OR r.po_number = po.po_number)
        OR EXISTS (SELECT 1 FROM procurement_receipt_items ri WHERE ri.po_id = po.id OR ri.po_number = po.po_number) AS has_gr
    FROM purchase_orders po
    WHERE po.data_source = 'SAP' AND po.status = 'draft'
      AND NOT (po.source_date < DATE '2026-10-01'
               AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(po.items, '[]'::jsonb)) i WHERE i->>'plant' = '3219'))
  )
  SELECT id, po_number, reason, has_gr FROM candidate WHERE reason IS NOT NULL;

-- 1) Preview: jumlah PO per alasan, dipisah yang akan dihapus dan yang dikecualikan karena sudah ada GR
SELECT reason, count(*) FILTER (WHERE NOT has_gr) AS po_dihapus, count(*) FILTER (WHERE has_gr) AS po_dikecualikan_ada_gr
FROM cleanup_po GROUP BY reason ORDER BY reason;

SELECT 'link_dihapus' AS item, count(*) FROM sap_document_links
  WHERE po_id IN (SELECT id FROM cleanup_po WHERE NOT has_gr);

-- Daftar nomor PO yang akan dihapus (untuk dicocokkan dengan SAP bila perlu)
SELECT po_number, reason FROM cleanup_po WHERE NOT has_gr ORDER BY reason, po_number;

-- 2) Lepas relasi PR-PO, lalu hapus PO. Tabel lain yang masih mereferensi PO akan menggagalkan transaksi (aman).
DELETE FROM sap_document_links WHERE po_id IN (SELECT id FROM cleanup_po WHERE NOT has_gr);
DELETE FROM purchase_orders WHERE id IN (SELECT id FROM cleanup_po WHERE NOT has_gr);

-- 3) Verifikasi: sisa = hanya PO yang sengaja dikecualikan karena ada GR
SELECT count(*) AS sisa_po_ada_gr FROM purchase_orders WHERE id IN (SELECT id FROM cleanup_po);

ROLLBACK; -- ganti menjadi COMMIT setelah preview sesuai
