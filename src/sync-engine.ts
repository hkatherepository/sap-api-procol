import type { Logger } from "pino";
import type { PoolClient } from "pg";
import type { AppConfig } from "./config.js";
import { inTransaction } from "./database.js";
import { RESOURCES, emptyCounters, type DateWindow, type NormalizedRecord, type PoDocument, type PrDocument, type Resource, type ResourceCounters, type SyncMode, type Trigger, type VendorRecord } from "./domain.js";
import { Repository, type ReconcileResult } from "./repository.js";
import { SapClient } from "./sap/client.js";
import { normalizePoDocuments, normalizePrDocuments, normalizeVendors } from "./sap/normalize.js";
import { hashJson, jakartaToday, splitMonthlyWindows } from "./utils.js";
import type { Pool } from "pg";

const FATAL_ISSUES = new Set([
  "NON_OBJECT_RECORD",
  "REQUIRED_FIELD",
  "INVALID_DATE",
  "INVALID_EMAIL",
  "INVALID_ITEM_NUMBER",
  "INVALID_NUMBER",
  "INVALID_PRICE_UNIT",
  "INVALID_PO_ITEM",
  "KEY_MISMATCH",
  "DUPLICATE_KEY_CONFLICT",
  "INCONSISTENT_CURRENCY",
  "INCONSISTENT_COMPANY",
  "INCONSISTENT_VENDOR",
]);

export interface RunRequest {
  trigger: Trigger;
  mode: SyncMode;
  resources?: Resource[];
  window?: DateWindow;
  windowsByResource?: Partial<Record<Resource, DateWindow[]>>;
  triggerKey?: string;
  retryOf?: string;
  scheduledFor?: Date;
}

interface Task {
  resource: Resource;
  window: DateWindow;
  checkpointBefore: string | null;
}

export class SyncEngine {
  constructor(
    private readonly config: AppConfig,
    private readonly pool: Pool,
    private readonly repository: Repository,
    private readonly sap: SapClient,
    private readonly logger: Logger,
  ) {}

  async run(request: RunRequest): Promise<string | null> {
    if (request.mode === "apply" && this.config.sync.dryRunOnly) {
      throw new Error("Mode apply ditolak karena DRY_RUN_ONLY=true");
    }
    const runId = await this.repository.createRun({
      trigger: request.trigger,
      mode: request.mode,
      ...(request.triggerKey ? { triggerKey: request.triggerKey } : {}),
      ...(request.retryOf ? { retryOf: request.retryOf } : {}),
      ...(request.scheduledFor ? { scheduledFor: request.scheduledFor } : {}),
    });
    if (!runId) {
      this.logger.info({ triggerKey: request.triggerKey }, "Slot scheduler sudah pernah dicatat; run dilewati");
      return null;
    }

    const lockClient = await this.repository.acquireLock();
    if (!lockClient) {
      await this.repository.setRunStatus(runId, "skipped_locked");
      this.logger.warn({ runId }, "Sync dilewati karena advisory lock aktif");
      return runId;
    }

    let completedTasks = 0;
    let issueTasks = 0;
    let technicalFailures = 0;
    const resourceSuccess = new Map<Resource, { success: boolean; lastHigh: string; lastRunResourceId: string }>();
    try {
      await this.repository.setRunStatus(runId, "running");
      const tasks = await this.buildTasks(request);
      for (const task of tasks) {
        let runResourceId: string | undefined;
        const counters = emptyCounters();
        try {
          runResourceId = await this.repository.createRunResource(runId, task.resource, task.window, task.checkpointBefore);
          const raw = await this.sap.fetch(task.resource, task.window);
          counters.received = raw.length;
          const checksum = hashJson(raw);
          const records = this.normalize(task.resource, raw);
          await this.processRecords(task.resource, runResourceId, records, counters, request.mode === "apply");
          const status = counters.invalid + counters.conflict + counters.failed > 0 ? "partial" : "completed";
          await this.repository.finishRunResource(runResourceId, status, counters, checksum);
          if (counters.conflict > 0) {
            this.logger.warn({ event: "sap_sync_conflict_alert", runId, resource: task.resource, conflicts: counters.conflict }, "Konflik SAP membutuhkan review data owner");
          }
          completedTasks += 1;
          if (status === "partial") issueTasks += 1;
          const previous = resourceSuccess.get(task.resource);
          resourceSuccess.set(task.resource, {
            success: previous?.success !== false,
            lastHigh: task.window.high,
            lastRunResourceId: runResourceId,
          });
        } catch (error) {
          technicalFailures += 1;
          resourceSuccess.set(task.resource, {
            success: false,
            lastHigh: task.window.high,
            lastRunResourceId: runResourceId ?? "",
          });
          if (runResourceId) {
            await this.repository.finishRunResource(runResourceId, "failed", counters, undefined, this.errorCode(error));
          }
          this.logger.error({ runId, resource: task.resource, low: task.window.low, high: task.window.high, err: error }, "Resource window gagal");
        }
      }

      if (request.mode === "apply") {
        for (const [resource, result] of resourceSuccess) {
          if (result.success && result.lastRunResourceId) {
            await this.repository.advanceCheckpoint(resource, result.lastHigh, result.lastRunResourceId);
          }
        }
      }
      const status = technicalFailures > 0 ? (completedTasks > 0 ? "partial" : "failed") : issueTasks > 0 ? "partial" : "completed";
      await this.repository.setRunStatus(runId, status);
      if (status === "failed" && await this.repository.hasConsecutiveFailedRuns()) {
        this.logger.error({ event: "sap_sync_consecutive_failure_alert", runId }, "Dua run sinkronisasi berturut-turut gagal");
      }
      this.logger.info({ runId, status, completedTasks, technicalFailures }, "Sync selesai");
      return runId;
    } catch (error) {
      await this.repository.setRunStatus(runId, "failed", this.errorCode(error));
      throw error;
    } finally {
      await this.repository.releaseLock(lockClient);
    }
  }

  private async buildTasks(request: RunRequest): Promise<Task[]> {
    const selected = request.resources ?? [...RESOURCES];
    const tasks: Task[] = [];
    if (request.window) {
      const windows = splitMonthlyWindows(request.window.low, request.window.high);
      for (const window of windows) {
        for (const resource of RESOURCES) {
          if (selected.includes(resource)) tasks.push({ resource, window, checkpointBefore: await this.repository.checkpoint(resource) });
        }
      }
      return tasks;
    }
    if (request.windowsByResource) {
      for (const resource of selected) {
        const checkpointBefore = await this.repository.checkpoint(resource);
        for (const window of request.windowsByResource[resource] ?? []) tasks.push({ resource, window, checkpointBefore });
      }
      return this.sortTasks(tasks);
    }
    const today = jakartaToday();
    for (const resource of selected) {
      const checkpointBefore = await this.repository.checkpoint(resource);
      const low = checkpointBefore ?? today;
      for (const window of splitMonthlyWindows(low, today)) tasks.push({ resource, window, checkpointBefore });
    }
    return this.sortTasks(tasks);
  }

  private sortTasks(tasks: Task[]): Task[] {
    return tasks.sort((a, b) => a.window.low.localeCompare(b.window.low) || a.window.high.localeCompare(b.window.high) || RESOURCES.indexOf(a.resource) - RESOURCES.indexOf(b.resource));
  }

  private normalize(resource: Resource, raw: unknown[]): NormalizedRecord<VendorRecord | PrDocument | PoDocument>[] {
    if (resource === "vendor") return normalizeVendors(raw);
    if (resource === "pr") return normalizePrDocuments(raw);
    return normalizePoDocuments(raw);
  }

  private async processRecords(
    resource: Resource,
    runResourceId: string,
    records: NormalizedRecord<VendorRecord | PrDocument | PoDocument>[],
    counters: ResourceCounters,
    apply: boolean,
  ): Promise<void> {
    for (let offset = 0; offset < records.length; offset += this.config.sync.batchSize) {
      const batch = records.slice(offset, offset + this.config.sync.batchSize);
      for (const record of batch) {
        if (!record.value || record.issues.some((issue) => FATAL_ISSUES.has(issue.code))) {
          counters.invalid += 1;
          await this.repository.recordResult(runResourceId, record.key, "invalid", record.hash, record.issues);
          continue;
        }
        counters.valid += 1;
        try {
          const result = await inTransaction(this.pool, (client) => this.reconcile(resource, client, record, apply));
          counters[result.action] += 1;
          await this.repository.recordResult(runResourceId, record.key, result.action, record.hash, [...record.issues, ...result.issues]);
        } catch (error) {
          counters.failed += 1;
          await this.repository.recordResult(runResourceId, record.key, "failed", record.hash, [{ code: this.errorCode(error), message: "Database operation gagal" }]);
          this.logger.error({ resource, businessKey: record.key, err: error }, "Record gagal diproses");
        }
      }
    }
  }

  private reconcile(resource: Resource, client: PoolClient, record: NormalizedRecord<VendorRecord | PrDocument | PoDocument>, apply: boolean): Promise<ReconcileResult> {
    if (resource === "vendor") return this.repository.reconcileVendor(client, record.value as VendorRecord, record.hash, apply);
    if (resource === "pr") return this.repository.reconcilePr(client, record.value as PrDocument, record.hash, apply);
    return this.repository.reconcilePo(client, record.value as PoDocument, record.hash, apply);
  }

  private errorCode(error: unknown): string {
    if (!(error instanceof Error)) return "UNKNOWN_ERROR";
    return error.name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase().slice(0, 80) || "ERROR";
  }
}
