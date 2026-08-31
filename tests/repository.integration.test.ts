import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Repository } from "../src/repository.js";
import type { PoDocument, PrDocument, VendorRecord } from "../src/domain.js";
import type { AppConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { SyncEngine } from "../src/sync-engine.js";
import type { SapClient } from "../src/sap/client.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Repository PostgreSQL", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const repository = new Repository(pool);

  beforeAll(async () => {
    await repository.assertSchema();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("mengunci sync secara eksklusif", async () => {
    const first = await repository.acquireLock();
    expect(first).not.toBeNull();
    expect(await repository.acquireLock()).toBeNull();
    await repository.releaseLock(first!);
    const afterRelease = await repository.acquireLock();
    expect(afterRelease).not.toBeNull();
    await repository.releaseLock(afterRelease!);
  });

  it("membuat run idempotent berdasarkan trigger key", async () => {
    const triggerKey = `test:${randomUUID()}`;
    expect(await repository.createRun({ trigger: "scheduler", triggerKey, mode: "dry_run" })).toMatch(/[0-9a-f-]{36}/);
    expect(await repository.createRun({ trigger: "scheduler", triggerKey, mode: "dry_run" })).toBeNull();
  });

  it("insert Vendor menjadi idempotent", async () => {
    const client = await pool.connect();
    const vendor: VendorRecord = {
      vendorCode: `V-${randomUUID()}`,
      circleNumber: "01",
      companyName: "Vendor Test",
      npwp: null,
      address: null,
      city: "Jakarta",
      sourceDate: "2026-08-05",
      phone: null,
      email: null,
    };
    try {
      await client.query("BEGIN");
      expect((await repository.reconcileVendor(client, vendor, "a".repeat(64), true)).action).toBe("inserted");
      await client.query("COMMIT");
      await client.query("BEGIN");
      expect((await repository.reconcileVendor(client, vendor, "a".repeat(64), true)).action).toBe("unchanged");
      expect((await repository.reconcileVendor(client, { ...vendor, companyName: "Nama SAP Berubah" }, "b".repeat(64), true)).action).toBe("updated");
      expect((await client.query("SELECT count(*)::int AS count FROM vendor_registrations WHERE vendor_code=$1", [vendor.vendorCode])).rows[0].count).toBe(1);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("memetakan dua LIFNR dengan BPEXT sama sebagai dua Vendor berbeda", async () => {
    const client = await pool.connect();
    const suffix = randomUUID();
    const circleNumber = `C-${suffix}`;
    const first: VendorRecord = {
      vendorCode: `V1-${suffix}`,
      circleNumber,
      companyName: "Vendor Pertama",
      npwp: "010000000000000",
      address: "Alamat Utama",
      city: "Jakarta",
      sourceDate: "2026-08-05",
      phone: "021123456",
      email: "utama@example.test",
    };
    const second: VendorRecord = {
      ...first,
      vendorCode: `V2-${suffix}`,
      companyName: "Vendor Kedua",
      address: "Alamat Kedua",
      phone: "021-123456",
      email: "kedua@example.test",
    };
    try {
      await client.query("BEGIN");
      expect((await repository.reconcileVendor(client, first, "c".repeat(64), true)).action).toBe("inserted");
      expect((await repository.reconcileVendor(client, second, "d".repeat(64), true)).action).toBe("inserted");
      const vendors = await client.query<{ id: string; vendor_code: string }>(
        "SELECT id,vendor_code FROM vendor_registrations WHERE vendor_code=ANY($1::text[]) ORDER BY vendor_code",
        [[first.vendorCode, second.vendorCode]],
      );
      expect(vendors.rows).toHaveLength(2);
      expect(new Set(vendors.rows.map((row) => row.id)).size).toBe(2);
      expect((await client.query("SELECT count(*)::int AS count FROM vendor_registrations WHERE circle_number=$1", [circleNumber])).rows[0].count).toBe(2);

      const po: PoDocument = {
        poNumber: `PO-${suffix}`,
        sourceDate: "2026-08-05",
        sourceCreatedBy: "SAPUSER",
        vendorCode: second.vendorCode,
        vendorNameSnapshot: second.companyName,
        currency: "IDR",
        total: "100",
        status: "ISSUED",
        items: [],
        issues: [],
      };
      const poResult = await repository.reconcilePo(client, po, "e".repeat(64), true);
      expect(poResult.issues.some((issue) => issue.code === "VENDOR_NOT_FOUND")).toBe(false);
      const storedPo = await client.query<{ vendor_id: string }>("SELECT vendor_id FROM purchase_orders WHERE po_number=$1", [po.poNumber]);
      expect(storedPo.rows[0]?.vendor_id).toBe(vendors.rows.find((row) => row.vendor_code === second.vendorCode)?.id);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("dry-run PR tidak mengubah tabel bisnis dan konflik lokal tidak ditimpa", async () => {
    const prNumber = `PR-${randomUUID()}`;
    const document: PrDocument = {
      prNumber,
      sourceDate: "2026-08-05",
      sourceCreatedBy: "SAPUSER",
      currency: "IDR",
      total: "10",
      status: "SUBMITTED",
      items: [],
      issues: [],
    };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect((await repository.reconcilePr(client, document, "b".repeat(64), false)).action).toBe("inserted");
      await client.query("COMMIT");
      expect((await pool.query("SELECT count(*)::int AS count FROM purchase_requests WHERE pr_number=$1", [prNumber])).rows[0].count).toBe(0);

      await pool.query(
        "INSERT INTO purchase_requests(id,pr_number,status,updated_at) VALUES(gen_random_uuid(),$1,'draft',now())",
        [prNumber],
      );
      await client.query("BEGIN");
      const result = await repository.reconcilePr(client, document, "b".repeat(64), true);
      await client.query("ROLLBACK");
      expect(result.action).toBe("conflict");
      expect(result.issues[0]?.code).toBe("LOCAL_RECORD_CONFLICT");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("mengikuti status release SAP tanpa menimpa lifecycle lokal", async () => {
    const client = await pool.connect();
    const prNumber = `PR-STATUS-${randomUUID()}`;
    const poNumber = `PO-STATUS-${randomUUID()}`;
    const pr: PrDocument = {
      prNumber,
      sourceDate: "2026-08-05",
      sourceCreatedBy: "SAPUSER",
      currency: "IDR",
      total: "10",
      status: "SUBMITTED",
      items: [],
      issues: [],
    };
    const po: PoDocument = {
      poNumber,
      sourceDate: "2026-08-05",
      sourceCreatedBy: "SAPUSER",
      vendorCode: `MISSING-${randomUUID()}`,
      vendorNameSnapshot: "Vendor SAP",
      currency: "IDR",
      total: "10",
      status: "DRAFT",
      items: [],
      issues: [],
    };
    try {
      await client.query("BEGIN");
      await repository.reconcilePr(client, pr, "1".repeat(64), true);
      await repository.reconcilePr(client, { ...pr, status: "APPROVED" }, "2".repeat(64), true);
      expect((await client.query("SELECT status FROM purchase_requests WHERE pr_number=$1", [prNumber])).rows[0]?.status).toBe("approved");
      await repository.reconcilePr(client, { ...pr, status: "CONVERTED" }, "3".repeat(64), true);
      await repository.reconcilePr(client, pr, "4".repeat(64), true);
      expect((await client.query("SELECT status FROM purchase_requests WHERE pr_number=$1", [prNumber])).rows[0]?.status).toBe("submitted");
      await client.query("UPDATE purchase_requests SET status='rejected' WHERE pr_number=$1", [prNumber]);
      await repository.reconcilePr(client, { ...pr, status: "APPROVED" }, "5".repeat(64), true);
      expect((await client.query("SELECT status FROM purchase_requests WHERE pr_number=$1", [prNumber])).rows[0]?.status).toBe("rejected");

      await repository.reconcilePo(client, po, "6".repeat(64), true);
      let storedPo = (await client.query<{ status: string; issued_at: Date | null }>("SELECT status,issued_at FROM purchase_orders WHERE po_number=$1", [poNumber])).rows[0]!;
      expect(storedPo).toMatchObject({ status: "draft", issued_at: null });
      await repository.reconcilePo(client, { ...po, status: "ISSUED" }, "7".repeat(64), true);
      storedPo = (await client.query("SELECT status,issued_at FROM purchase_orders WHERE po_number=$1", [poNumber])).rows[0]!;
      expect(storedPo.status).toBe("issued");
      expect(storedPo.issued_at).not.toBeNull();
      await repository.reconcilePo(client, po, "8".repeat(64), true);
      storedPo = (await client.query("SELECT status,issued_at FROM purchase_orders WHERE po_number=$1", [poNumber])).rows[0]!;
      expect(storedPo).toMatchObject({ status: "draft", issued_at: null });

      for (const protectedStatus of ["acknowledged", "partial", "delivered", "closed", "cancelled"] as const) {
        await client.query("UPDATE purchase_orders SET status=$2,issued_at='2026-08-05' WHERE po_number=$1", [poNumber, protectedStatus]);
        await repository.reconcilePo(client, po, protectedStatus.padEnd(64, "0"), true);
        storedPo = (await client.query("SELECT status,issued_at FROM purchase_orders WHERE po_number=$1", [poNumber])).rows[0]!;
        expect(storedPo.status).toBe(protectedStatus);
        expect(storedPo.issued_at).not.toBeNull();
      }
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("menjalankan alur Vendor ke PR ke PO secara idempotent dan membuat linkage", async () => {
    const nonce = String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));
    const vendorCode = `2${nonce.slice(1)}`;
    const prNumber = `1${nonce.slice(1)}`;
    const poNumber = `4${nonce.slice(1)}`;
    const config = {
      env: "test",
      databaseUrl: databaseUrl!,
      sap: {
        urls: { vendor: "https://sap.test/vendor", pr: "https://sap.test/pr", po: "https://sap.test/po" },
        username: "test",
        password: "test",
        method: "POST",
        filterTransport: "json_body",
        lowParam: "low",
        highParam: "high",
        timeoutMs: 1_000,
        maxResponseBytes: 1_000_000,
      },
      sync: {
        schedules: ["0 8,16 * * *"],
        timezone: "Asia/Jakarta",
        batchSize: 200,
        dryRunOnly: false,
        auditRetentionDays: 90,
        housekeepingSchedule: "30 2 * * *",
      },
      service: { host: "127.0.0.1", port: 3000 },
      logLevel: "silent",
    } as AppConfig;
    const payloads = {
      vendor: [{ LIFNR: vendorCode, NAME1: "E2E VENDOR", AEDAT: "2026-08-05" }],
      pr: [{
        KEY: `${prNumber}00010`, BANFN: prNumber, BNFPO: 10, LOEKZ: "", ERDAT: "2026-08-05",
        MENGE: "2", PREIS: "100.000", PEINH: "1", WAERS: "IDR", FRGKZ: "2", EBELN: poNumber, EBELP: 10,
      }],
      po: [{
        KEY: `${poNumber}00010`, EBELN: poNumber, EBELP: 10, LOEKZ: "", AEDAT: "2026-08-05",
        LIFNR: vendorCode, NAME_VEND: "E2E VENDOR", BUKRS: "HK03", MENGE: "2", NETPR: "100.000", WAERS: "IDR", FRGKE: "G",
      }],
    };
    const sap = { fetch: async (resource: keyof typeof payloads) => payloads[resource] } as unknown as SapClient;
    const engine = new SyncEngine(config, pool, repository, sap, createLogger(config));

    const firstRun = await engine.run({ trigger: "cli", mode: "apply", window: { low: "20260805", high: "20260805" } });
    const firstCounts = await pool.query<{ resource: string; inserted: number }>(
      "SELECT resource,inserted FROM sap_sync_run_resources WHERE run_id=$1 ORDER BY resource",
      [firstRun],
    );
    expect(firstCounts.rows).toEqual([
      { resource: "po", inserted: 1 },
      { resource: "pr", inserted: 1 },
      { resource: "vendor", inserted: 1 },
    ]);
    expect((await pool.query("SELECT count(*)::int AS count FROM sap_document_links WHERE po_number=$1", [poNumber])).rows[0].count).toBe(1);

    const secondRun = await engine.run({ trigger: "cli", mode: "apply", window: { low: "20260805", high: "20260805" } });
    const secondCounts = await pool.query<{ unchanged: number; inserted: number; updated: number }>(
      "SELECT unchanged,inserted,updated FROM sap_sync_run_resources WHERE run_id=$1 ORDER BY resource",
      [secondRun],
    );
    expect(secondCounts.rows.every((row) => row.unchanged === 1 && row.inserted === 0 && row.updated === 0)).toBe(true);
  });
});
