import type { Pool, PoolClient } from "pg";
import { summarizePo, summarizePr } from "./sap/normalize.js";
import { hashJson } from "./utils.js";
import type { DateWindow, Issue, PoDocument, PoItem, PrDocument, PrItem, ReceiptDocument, RecordAction, Resource, ResourceCounters, RunStatus, SyncMode, Trigger, VendorRecord } from "./domain.js";

const LOCK_KEY = 1_864_031_005;

// Filter tanggal SAP bekerja per item, jadi satu window bisa membawa sebagian item dokumen.
// Item digabung per nomor item: yang datang menimpa, yang tidak ikut terkirim tetap disimpan.
export function mergeItems<T extends { itemNumber: string }>(stored: T[] | null | undefined, incoming: T[]): T[] {
  const merged = new Map((stored ?? []).map((item) => [item.itemNumber, item]));
  for (const item of incoming) merged.set(item.itemNumber, item);
  return [...merged.values()].sort((a, b) => a.itemNumber.localeCompare(b.itemNumber));
}

function earliestDate(stored: string | null | undefined, incoming: string): string {
  return stored && stored < incoming ? stored : incoming;
}

export interface ReconcileResult {
  action: RecordAction;
  issues: Issue[];
}

export class Repository {
  constructor(private readonly pool: Pool) {}

  async assertSchema(): Promise<void> {
    const result = await this.pool.query<{ version: number }>("SELECT max(version)::int AS version FROM sap_integration_schema_versions");
    if ((result.rows[0]?.version ?? 0) < 1) throw new Error("Schema Si Procol belum memakai migration SAP versi 1");
  }

  async healthcheck(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async createRun(input: { trigger: Trigger; triggerKey?: string; mode: SyncMode; retryOf?: string; scheduledFor?: Date }): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO sap_sync_runs(trigger_type, trigger_key, retry_of, mode, status, scheduled_for)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       ON CONFLICT (trigger_key) WHERE trigger_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [input.trigger, input.triggerKey ?? null, input.retryOf ?? null, input.mode, input.scheduledFor ?? null],
    );
    return result.rows[0]?.id ?? null;
  }

  async setRunStatus(runId: string, status: RunStatus, errorCode?: string): Promise<void> {
    await this.pool.query(
      `UPDATE sap_sync_runs SET status=$2,
       started_at=CASE WHEN $2='running' THEN COALESCE(started_at, now()) ELSE started_at END,
       finished_at=CASE WHEN $2 IN ('completed','partial','failed','skipped_locked') THEN now() ELSE finished_at END,
       error_code=$3 WHERE id=$1`,
      [runId, status, errorCode ?? null],
    );
  }

  async acquireLock(): Promise<PoolClient | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [LOCK_KEY]);
      if (!result.rows[0]?.locked) {
        client.release();
        return null;
      }
      return client;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async releaseLock(client: PoolClient): Promise<void> {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    } finally {
      client.release();
    }
  }

  async createRunResource(runId: string, resource: Resource, window: DateWindow, checkpointBefore: string | null): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO sap_sync_run_resources(run_id, resource, filter_low, filter_high, status, checkpoint_before, started_at)
       VALUES ($1,$2,$3,$4,'running',$5,now()) RETURNING id`,
      [runId, resource, window.low, window.high, checkpointBefore],
    );
    return result.rows[0]!.id;
  }

  async finishRunResource(id: string, status: "completed" | "partial" | "failed", counters: ResourceCounters, checksum?: string, errorCode?: string): Promise<void> {
    await this.pool.query(
      `UPDATE sap_sync_run_resources SET status=$2, payload_checksum=$3, received=$4, valid=$5, invalid=$6,
       inserted=$7, updated=$8, unchanged=$9, conflict=$10, failed=$11, error_code=$12, finished_at=now() WHERE id=$1`,
      [id, status, checksum ?? null, counters.received, counters.valid, counters.invalid, counters.inserted, counters.updated, counters.unchanged, counters.conflict, counters.failed, errorCode ?? null],
    );
  }

  async recordResult(runResourceId: string, key: string, action: RecordAction, hash: string | null, issues: Issue[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO sap_sync_record_results(run_resource_id,business_key,action,source_hash,issue_codes)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (run_resource_id,business_key) DO UPDATE SET action=EXCLUDED.action,source_hash=EXCLUDED.source_hash,issue_codes=EXCLUDED.issue_codes`,
      [runResourceId, key, action, hash, [...new Set(issues.map((issue) => issue.code))]],
    );
  }

  async checkpoint(resource: Resource): Promise<string | null> {
    const result = await this.pool.query<{ checkpoint_high: string }>("SELECT checkpoint_high FROM sap_sync_checkpoints WHERE resource=$1", [resource]);
    return result.rows[0]?.checkpoint_high ?? null;
  }

  async advanceCheckpoint(resource: Resource, high: string, runResourceId: string): Promise<void> {
    // Hanya maju: backfill rentang lama lewat CLI tidak boleh memundurkan checkpoint scheduler.
    await this.pool.query(
      `INSERT INTO sap_sync_checkpoints(resource,checkpoint_high,successful_run_resource_id)
       VALUES ($1,$2,$3) ON CONFLICT(resource) DO UPDATE SET checkpoint_high=EXCLUDED.checkpoint_high,
       successful_run_resource_id=EXCLUDED.successful_run_resource_id,updated_at=now()
       WHERE sap_sync_checkpoints.checkpoint_high <= EXCLUDED.checkpoint_high`,
      [resource, high, runResourceId],
    );
  }

  async reconcileVendor(client: PoolClient, vendor: VendorRecord, hash: string, apply: boolean): Promise<ReconcileResult> {
    type VendorMatch = {
      id: string;
      source_checksum: string | null;
    };
    const result = await client.query<VendorMatch>(
      `SELECT id,source_checksum
       FROM vendor_registrations
       WHERE vendor_code=$1
       FOR UPDATE`,
      [vendor.vendorCode],
    );
    const existing = result.rows[0];

    if (!existing) {
      if (apply) {
        await client.query(
          `INSERT INTO vendor_registrations(id,vendor_code,circle_number,company_name,npwp,address,city,
           vendor_created_at,approved_at,phone,email,status,user_id,data_source,source_checksum,last_synced_at,approver_name,updated_at)
           VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7::date,$7::date::timestamptz,$8,$9,'verified',NULL,'SAP',$10,
           now(),'SAP Integration',now())`,
          [vendor.vendorCode, vendor.circleNumber, vendor.companyName, vendor.npwp, vendor.address, vendor.city, vendor.sourceDate, vendor.phone, vendor.email, hash],
        );
      }
      return { action: "inserted", issues: [] };
    }
    if (existing.source_checksum === hash) return { action: "unchanged", issues: [] };
    if (apply) {
      await client.query(
        `UPDATE vendor_registrations SET circle_number=COALESCE(NULLIF(circle_number,''),$2),
         company_name=COALESCE(NULLIF(company_name,''),$3),npwp=COALESCE(NULLIF(npwp,''),$4),address=COALESCE(NULLIF(address,''),$5),
         city=COALESCE(NULLIF(city,''),$6),phone=COALESCE(NULLIF(phone,''),$7),email=COALESCE(NULLIF(email,''),$8),
         data_source=COALESCE(data_source,'SAP'),source_checksum=$9,
         vendor_created_at=COALESCE(vendor_created_at,$10::date),
         last_synced_at=now(),updated_at=now()
         WHERE id=$1`,
        [existing.id, vendor.circleNumber, vendor.companyName, vendor.npwp, vendor.address, vendor.city, vendor.phone, vendor.email, hash, vendor.sourceDate],
      );
    }
    return { action: "updated", issues: [] };
  }

  async reconcilePr(client: PoolClient, incoming: PrDocument, hash: string, apply: boolean): Promise<ReconcileResult> {
    const result = await client.query<{ id: string; data_source: string | null; source_checksum: string | null; items: PrItem[] | null; source_date: string | null }>(
      "SELECT id,data_source,source_checksum,items,source_date::text AS source_date FROM purchase_requests WHERE pr_number=$1 FOR UPDATE",
      [incoming.prNumber],
    );
    const existing = result.rows[0];
    if (existing && existing.data_source !== "SAP") return { action: "conflict", issues: [{ code: "LOCAL_RECORD_CONFLICT", message: "Nomor PR sudah dimiliki record lokal" }] };
    const items = mergeItems(existing?.items, incoming.items);
    const document: PrDocument = { ...incoming, items, sourceDate: earliestDate(existing?.source_date, incoming.sourceDate), ...summarizePr(items) };
    // PR baru yang belum full release (FRGKZ != '2') tidak disimpan; PR yang sudah ada tetap di-update.
    if (!existing && document.status === "SUBMITTED") return { action: "skipped", issues: [] };
    hash = hashJson({ ...document, issues: undefined });
    if (existing?.source_checksum === hash) return { action: "unchanged", issues: document.issues };
    if (!existing) {
      if (apply) {
        await client.query(
          `INSERT INTO purchase_requests(id,pr_number,status,data_source,source_key,source_checksum,source_date,source_created_by,
           currency,total_amount,items,last_synced_at,updated_at)
           VALUES(gen_random_uuid(),$1,lower($2)::pr_status,'SAP',$1,$3,$4,$5,$6,$7,$8::jsonb,now(),now())`,
          [document.prNumber, document.status, hash, document.sourceDate, document.sourceCreatedBy, document.currency, document.total, JSON.stringify(document.items)],
        );
      }
      return { action: "inserted", issues: document.issues };
    }
    if (apply) {
      await client.query(
        `UPDATE purchase_requests SET source_checksum=$2,source_date=$3,source_created_by=$4,currency=$5,total_amount=$6,items=$7::jsonb,
         status=CASE WHEN status IN ('submitted','approved','converted') THEN lower($8)::pr_status ELSE status END,
         last_synced_at=now(),updated_at=now() WHERE id=$1`,
        [existing.id, hash, document.sourceDate, document.sourceCreatedBy, document.currency, document.total, JSON.stringify(document.items), document.status],
      );
    }
    return { action: "updated", issues: document.issues };
  }

  async reconcilePo(client: PoolClient, incoming: PoDocument, hash: string, apply: boolean): Promise<ReconcileResult> {
    const result = await client.query<{ id: string; data_source: string | null; source_checksum: string | null; items: PoItem[] | null; source_date: string | null }>(
      "SELECT id,data_source,source_checksum,items,source_date::text AS source_date FROM purchase_orders WHERE po_number=$1 FOR UPDATE",
      [incoming.poNumber],
    );
    const existing = result.rows[0];
    if (existing && existing.data_source !== "SAP") return { action: "conflict", issues: [{ code: "LOCAL_RECORD_CONFLICT", message: "Nomor PO sudah dimiliki record lokal" }] };
    const items = mergeItems(existing?.items, incoming.items);
    const document: PoDocument = { ...incoming, items, sourceDate: earliestDate(existing?.source_date, incoming.sourceDate), ...summarizePo(items) };
    // Sementara dinonaktifkan: bug di SAP masih membolehkan PO belum release punya GR, sehingga GR di Procol
    // kehilangan PO induknya. Aktifkan lagi setelah bug SAP diperbaiki. PO belum release tersimpan sebagai DRAFT.
    // PO baru yang belum full release (FRGKE bukan 'G'/'2') tidak disimpan; PO yang sudah ada tetap di-update.
    // if (!existing && document.status !== "ISSUED") return { action: "skipped", issues: [] };
    const vendor = await client.query<{ id: string }>(
      "SELECT id FROM vendor_registrations WHERE vendor_code=$1",
      [document.vendorCode],
    );
    const vendorId = vendor.rows[0]?.id ?? null;
    const issues = [...document.issues];
    if (!vendorId) issues.push({ code: "VENDOR_NOT_FOUND", message: `Vendor ${document.vendorCode} belum ditemukan` });
    // Relasi ikut checksum agar vendor yang baru ditambahkan belakangan tetap tersambung di run berikutnya.
    hash = hashJson({ document: { ...document, issues: undefined }, vendorId });
    if (existing?.source_checksum === hash) return { action: "unchanged", issues };
    let poId = existing?.id;
    if (!existing) {
      if (apply) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO purchase_orders(id,po_number,status,data_source,source_key,source_checksum,source_date,source_created_by,issued_at,
           vendor_id,vendor_name_snapshot,currency,total_amount,items,last_synced_at,updated_at)
           VALUES(gen_random_uuid(),$1,lower($2)::po_status,'SAP',$1,$3,$4::date,$5,
           CASE WHEN $2='ISSUED' THEN $4::date::timestamptz ELSE NULL END,$6,$7,$8,$9,$10::jsonb,
           now(),now()) RETURNING id`,
          [document.poNumber, document.status, hash, document.sourceDate, document.sourceCreatedBy, vendorId, document.vendorNameSnapshot, document.currency, document.total, JSON.stringify(document.items)],
        );
        poId = inserted.rows[0]!.id;
      }
    } else if (apply) {
      await client.query(
        `UPDATE purchase_orders SET source_checksum=$2,source_date=$3,source_created_by=$4,vendor_id=$5,vendor_name_snapshot=$6,
         currency=$7,total_amount=$8,items=$9::jsonb,
         issued_at=CASE WHEN status IN ('draft','issued') THEN CASE WHEN $10='ISSUED' THEN $3::date::timestamptz ELSE NULL END ELSE issued_at END,
         status=CASE WHEN status IN ('draft','issued') THEN lower($10)::po_status ELSE status END,
         last_synced_at=now(),updated_at=now() WHERE id=$1`,
        [existing.id, hash, document.sourceDate, document.sourceCreatedBy, vendorId, document.vendorNameSnapshot, document.currency, document.total, JSON.stringify(document.items), document.status],
      );
    }
    if (apply && poId) await this.reconcileLinks(client, poId, document.poNumber);
    return { action: existing ? "updated" : "inserted", issues };
  }

  async reconcileReceipt(client: PoolClient, document: ReceiptDocument, hash: string, apply: boolean): Promise<ReconcileResult> {
    const found = await client.query<{ id: string; data_source: string | null; source_checksum: string | null }>(
      "SELECT id,data_source,source_checksum FROM procurement_receipts WHERE sap_doc_number=$1 AND sap_doc_year=$2 FOR UPDATE",
      [document.sapDocNumber, document.sapDocYear],
    );
    const existing = found.rows[0];
    if (existing && existing.data_source !== "SAP") {
      return { action: "conflict", issues: [{ code: "LOCAL_RECORD_CONFLICT", message: "Dokumen penerimaan sudah dimiliki record lokal" }] };
    }

    const issues = [...document.issues];
    let vendorId: string | null = null;
    if (document.vendorCode) {
      const vendor = await client.query<{ id: string }>("SELECT id FROM vendor_registrations WHERE vendor_code=$1", [document.vendorCode]);
      vendorId = vendor.rows[0]?.id ?? null;
      if (!vendorId) issues.push({ code: "VENDOR_NOT_FOUND", message: `Vendor ${document.vendorCode} belum ditemukan` });
    }

    const poNumbers = [...new Set(document.items.map((item) => item.poNumber).filter((value): value is string => Boolean(value)))];
    const poRows = poNumbers.length
      ? (await client.query<{ id: string; po_number: string; project_id: string | null }>(
          "SELECT id,po_number,project_id FROM purchase_orders WHERE po_number = ANY($1::text[])",
          [poNumbers],
        )).rows
      : [];
    const purchaseOrders = new Map(poRows.map((row) => [row.po_number, row]));
    // Relasi belum ketemu tidak membatalkan baris; checksum di bawah membuat run berikutnya menyambungkannya.
    for (const poNumber of poNumbers) {
      if (!purchaseOrders.has(poNumber)) issues.push({ code: "PO_NOT_FOUND", message: `PO ${poNumber} belum ditemukan` });
    }
    const headerPo = document.poNumber ? purchaseOrders.get(document.poNumber) : undefined;

    let unitId: string | null = null;
    if (document.plant) {
      const unit = await client.query<{ id: string }>("SELECT id FROM units WHERE plant=$1", [document.plant]);
      unitId = unit.rows[0]?.id ?? null;
    }

    // Relasi ikut checksum agar PO/vendor/unit yang baru masuk belakangan tetap tersambung di run berikutnya.
    hash = hashJson({ source: hash, vendorId, unitId, poIds: poRows.map((row) => row.id).sort() });
    if (existing?.source_checksum === hash) return { action: "unchanged", issues };
    const action: RecordAction = existing ? "updated" : "inserted";
    if (!apply) return { action, issues };

    const upserted = await client.query<{ id: string }>(
      `INSERT INTO procurement_receipts(sap_doc_number,sap_doc_year,sap_tcode,header_text,doc_date,posting_date,
       sap_ref_doc_number,sap_ref_doc_year,vendor_code,vendor_id,customer_code,po_number,po_id,project_id,unit_id,
       currency,total_qty,total_value,is_reversal,receipt_type,receipt_type_source,receipt_number,
       data_source,source_key,source_checksum,last_synced_at,updated_at)
       VALUES($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'sap',$21,'SAP',$22,$23,now(),now())
       ON CONFLICT (sap_doc_number,sap_doc_year) DO UPDATE SET
       sap_tcode=EXCLUDED.sap_tcode,header_text=EXCLUDED.header_text,doc_date=EXCLUDED.doc_date,posting_date=EXCLUDED.posting_date,
       sap_ref_doc_number=EXCLUDED.sap_ref_doc_number,sap_ref_doc_year=EXCLUDED.sap_ref_doc_year,
       vendor_code=EXCLUDED.vendor_code,vendor_id=EXCLUDED.vendor_id,customer_code=EXCLUDED.customer_code,
       po_number=EXCLUDED.po_number,po_id=EXCLUDED.po_id,project_id=EXCLUDED.project_id,unit_id=EXCLUDED.unit_id,
       currency=EXCLUDED.currency,total_qty=EXCLUDED.total_qty,total_value=EXCLUDED.total_value,
       is_reversal=EXCLUDED.is_reversal,receipt_type=EXCLUDED.receipt_type,receipt_type_source=EXCLUDED.receipt_type_source,
       receipt_number=EXCLUDED.receipt_number,source_checksum=EXCLUDED.source_checksum,
       last_synced_at=now(),updated_at=now()
       RETURNING id`,
      [
        document.sapDocNumber, document.sapDocYear, document.sapTcode, document.headerText, document.docDate, document.postingDate,
        document.sapRefDocNumber, document.sapRefDocYear, document.vendorCode, vendorId, document.customerCode,
        document.poNumber, headerPo?.id ?? null, headerPo?.project_id ?? null, unitId,
        document.currency, document.totalQty, document.totalValue, document.isReversal, document.receiptType,
        document.receiptNumber, `${document.sapDocNumber}/${document.sapDocYear}`, hash,
      ],
    );
    const receiptId = upserted.rows[0]!.id;
    await client.query("DELETE FROM procurement_receipt_items WHERE receipt_id=$1", [receiptId]);
    for (const item of document.items) {
      await client.query(
        `INSERT INTO procurement_receipt_items(receipt_id,line_id,item_text,material_code,plant,quantity,unit,amount,currency,
         po_number,po_item_number,po_sap_key,po_id,pr_number,pr_item_number,sap_ref_item,is_reversal,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())`,
        [
          receiptId, item.lineId, item.itemText, item.materialCode, item.plant, item.quantity, item.unit, item.amount, item.currency,
          item.poNumber, item.poItemNumber, item.poSapKey, item.poNumber ? purchaseOrders.get(item.poNumber)?.id ?? null : null,
          item.prNumber, item.prItemNumber, item.sapRefItem, item.isReversal,
        ],
      );
    }
    return { action, issues };
  }

  private async reconcileLinks(client: PoolClient, poId: string, poNumber: string): Promise<void> {
    await client.query(
      `INSERT INTO sap_document_links(pr_id,pr_number,pr_item_number,po_id,po_number,po_item_number)
       SELECT pr.id,pr.pr_number,item->>'itemNumber',$1,$2,item->>'poItemNumber'
       FROM purchase_requests pr CROSS JOIN LATERAL jsonb_array_elements(pr.items) item
       WHERE pr.data_source='SAP' AND item->>'poNumber'=$2 AND COALESCE(item->>'poItemNumber','')<>''
       ON CONFLICT(pr_number,pr_item_number,po_number,po_item_number)
       DO UPDATE SET pr_id=EXCLUDED.pr_id,po_id=EXCLUDED.po_id,updated_at=now()`,
      [poId, poNumber],
    );
    const prIds = await client.query<{ pr_id: string }>("SELECT DISTINCT pr_id FROM sap_document_links WHERE po_id=$1", [poId]);
    await client.query("UPDATE purchase_orders SET pr_id=$2 WHERE id=$1", [poId, prIds.rowCount === 1 ? prIds.rows[0]!.pr_id : null]);
  }

  async getRun(runId: string): Promise<unknown> {
    const run = await this.pool.query("SELECT * FROM sap_sync_runs WHERE id=$1", [runId]);
    if (!run.rows[0]) throw new Error("Run tidak ditemukan");
    const resources = await this.pool.query("SELECT * FROM sap_sync_run_resources WHERE run_id=$1 ORDER BY started_at", [runId]);
    return { ...run.rows[0], resources: resources.rows };
  }

  async getRetryDefinition(runId: string): Promise<{ mode: SyncMode; resources: Array<{ resource: Resource; low: string; high: string }> }> {
    const run = await this.pool.query<{ mode: SyncMode }>("SELECT mode FROM sap_sync_runs WHERE id=$1", [runId]);
    if (!run.rows[0]) throw new Error("Run tidak ditemukan");
    const resources = await this.pool.query<{ resource: Resource; filter_low: string; filter_high: string }>(
      "SELECT resource,filter_low,filter_high FROM sap_sync_run_resources WHERE run_id=$1 AND status IN ('failed','partial') ORDER BY started_at",
      [runId],
    );
    return { mode: run.rows[0].mode, resources: resources.rows.map((row) => ({ resource: row.resource, low: row.filter_low, high: row.filter_high })) };
  }

  async deleteExpiredAudit(retentionDays: number): Promise<number> {
    const result = await this.pool.query<{ deleted: number }>("SELECT sap_purge_audit($1)::int AS deleted", [retentionDays]);
    return result.rows[0]?.deleted ?? 0;
  }

  async hasConsecutiveFailedRuns(count = 2): Promise<boolean> {
    const result = await this.pool.query<{ status: string }>(
      "SELECT status FROM sap_sync_runs WHERE status <> 'skipped_locked' ORDER BY created_at DESC LIMIT $1",
      [count],
    );
    return result.rows.length === count && result.rows.every((row) => row.status === "failed");
  }

  async wasTriggerSuccessful(triggerKey: string): Promise<boolean> {
    const result = await this.pool.query<{ successful: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM sap_sync_runs WHERE trigger_key=$1 AND status IN ('completed','partial')) AS successful",
      [triggerKey],
    );
    return result.rows[0]?.successful ?? false;
  }
}
