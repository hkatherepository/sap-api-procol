import cron, { type ScheduledTask } from "node-cron";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import { SyncEngine } from "./sync-engine.js";
import { Repository } from "./repository.js";

function jakartaParts(now: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${value("year")}${value("month")}${value("day")}`, hour: Number(value("hour")) };
}

function previousDate(compact: string): string {
  const date = new Date(`${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

export function latestScheduleSlot(now = new Date()): string {
  const local = jakartaParts(now);
  if (local.hour >= 16) return `${local.date}-16`;
  if (local.hour >= 8) return `${local.date}-08`;
  return `${previousDate(local.date)}-16`;
}

export function previousScheduleSlot(slot: string): string {
  const match = /^(\d{8})-(08|16)$/.exec(slot);
  if (!match) throw new Error("Schedule slot tidak valid");
  return match[2] === "16" ? `${match[1]}-08` : `${previousDate(match[1]!)}-16`;
}

async function alertMissingPreviousSlot(repository: Repository, logger: Logger, currentSlot: string): Promise<void> {
  const previousSlot = previousScheduleSlot(currentSlot);
  if (!await repository.wasTriggerSuccessful(`scheduler:${previousSlot}`)) {
    logger.error({ event: "sap_sync_missing_success_alert", previousSlot }, "Tidak ada run sukses pada slot scheduler sebelumnya");
  }
}

export function startScheduler(config: AppConfig, engine: SyncEngine, repository: Repository, logger: Logger): ScheduledTask[] {
  const tasks = config.sync.schedules.map((expression) =>
    cron.schedule(
      expression,
      async () => {
        const slot = latestScheduleSlot();
        const triggerKey = `scheduler:${slot}`;
        try {
          await alertMissingPreviousSlot(repository, logger, slot);
          await engine.run({ trigger: "scheduler", mode: "apply", triggerKey, scheduledFor: new Date() });
        } catch (error) {
          logger.error({ err: error, triggerKey }, "Scheduled sync gagal");
        }
      },
      { timezone: config.sync.timezone, noOverlap: true },
    ),
  );
  tasks.push(
    cron.schedule(
      config.sync.housekeepingSchedule,
      async () => {
        try {
          const deleted = await repository.deleteExpiredAudit(config.sync.auditRetentionDays);
          logger.info({ deleted }, "Housekeeping audit selesai");
        } catch (error) {
          logger.error({ err: error }, "Housekeeping audit gagal");
        }
      },
      { timezone: config.sync.timezone, noOverlap: true },
    ),
  );

  setImmediate(() => {
    const slot = latestScheduleSlot();
    const triggerKey = `scheduler:${slot}`;
    alertMissingPreviousSlot(repository, logger, slot)
      .then(() => engine.run({ trigger: "scheduler", mode: "apply", triggerKey, scheduledFor: new Date() }))
      .catch((error) => {
      logger.error({ err: error, triggerKey }, "Catch-up sync gagal");
    });
  });
  return tasks;
}
