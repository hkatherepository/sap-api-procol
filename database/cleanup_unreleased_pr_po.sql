-- Hapus PR/PO dari SAP yang belum full release (masuk sebelum filter release diterapkan).
-- PR belum release = status 'submitted'; PO belum release = status 'draft' (lihat summarizePr/summarizePo).
-- Hanya menyentuh data_source='SAP'; record buatan lokal tidak disentuh.
-- PO draft yang sudah punya GR dikecualikan (indikasi sudah release di SAP, dievaluasi terpisah),
-- beserta PR yang terhubung ke PO tersebut. PR yang sudah dipakai tender juga dikecualikan.
-- Default diakhiri ROLLBACK: cek hasil preview dulu, lalu ganti ROLLBACK menjadi COMMIT.

BEGIN;

CREATE TEMP TABLE cleanup_po ON COMMIT DROP AS
  SELECT id, po_number FROM purchase_orders po
  WHERE data_source = 'SAP' AND status = 'draft'
    AND NOT EXISTS (SELECT 1 FROM procurement_receipts r WHERE r.po_id = po.id)
    AND NOT EXISTS (SELECT 1 FROM procurement_receipt_items ri WHERE ri.po_id = po.id);
CREATE TEMP TABLE cleanup_pr ON COMMIT DROP AS
  SELECT id, pr_number FROM purchase_requests pr
  WHERE data_source = 'SAP' AND status = 'submitted'
    AND NOT EXISTS (
      SELECT 1 FROM sap_document_links l JOIN purchase_orders po ON po.id = l.po_id
      WHERE l.pr_id = pr.id AND po.id NOT IN (SELECT id FROM cleanup_po)
    )
    AND NOT EXISTS (SELECT 1 FROM tenders t WHERE t.pr_id = pr.id);

-- 1) Preview: jumlah data yang akan dihapus / dilepas relasinya
SELECT 'pr_dihapus' AS item, count(*) FROM cleanup_pr
UNION ALL SELECT 'po_dihapus', count(*) FROM cleanup_po
UNION ALL SELECT 'link_dihapus', count(*) FROM sap_document_links
  WHERE pr_id IN (SELECT id FROM cleanup_pr) OR po_id IN (SELECT id FROM cleanup_po)
UNION ALL SELECT 'po_release_kehilangan_pr', count(*) FROM purchase_orders
  WHERE pr_id IN (SELECT id FROM cleanup_pr) AND id NOT IN (SELECT id FROM cleanup_po)
UNION ALL SELECT 'po_draft_dikecualikan_ada_gr', count(*) FROM purchase_orders
  WHERE data_source = 'SAP' AND status = 'draft' AND id NOT IN (SELECT id FROM cleanup_po)
UNION ALL SELECT 'pr_dikecualikan_ada_tender', count(*) FROM purchase_requests pr
  WHERE data_source = 'SAP' AND status = 'submitted' AND EXISTS (SELECT 1 FROM tenders t WHERE t.pr_id = pr.id);

-- 2) Lepas relasi yang menunjuk ke data yang akan dihapus
DELETE FROM sap_document_links
  WHERE pr_id IN (SELECT id FROM cleanup_pr) OR po_id IN (SELECT id FROM cleanup_po);
UPDATE purchase_orders SET pr_id = NULL, updated_at = now() WHERE pr_id IN (SELECT id FROM cleanup_pr);

-- 3) Hapus dokumen
DELETE FROM purchase_orders WHERE id IN (SELECT id FROM cleanup_po);
DELETE FROM purchase_requests WHERE id IN (SELECT id FROM cleanup_pr);

-- 4) Verifikasi: sisa = hanya data yang sengaja dikecualikan
SELECT
  (SELECT count(*) FROM purchase_requests WHERE data_source = 'SAP' AND status = 'submitted') AS sisa_pr,
  (SELECT count(*) FROM purchase_orders WHERE data_source = 'SAP' AND status = 'draft') AS sisa_po;

ROLLBACK; -- ganti menjadi COMMIT setelah preview sesuai
