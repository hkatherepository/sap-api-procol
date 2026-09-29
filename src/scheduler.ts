import cron, { type ScheduledTask } from "node-cron";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import { SyncEngine } from "./sync-engine.js";
import { Repository } from "./repository.js";
import { jakartaToday } from "./utils.js";

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

// Sync malam (SYNC_DEEP_SCHEDULE) menarik PR & PO 12 bulan (bulan ini + 11 bulan sebelumnya)
// untuk menangkap release dan tambahan item yang terlambat.
export const DEEP_SYNC_LOOKBACK_MONTHS = 11;

export function latestScheduleSlot(slotHours: string[], now = new Date()): string {
  const local = jakartaParts(now);
  const passed = slotHours.filter((hour) => local.hour >= Number(hour));
  const last = passed.at(-1);
  return last ? `${local.date}-${last}` : `${previousDate(local.date)}-${slotHours.at(-1)}`;
}

export function previousScheduleSlot(slot: string, slotHours: string[]): string {
  const match = /^(\d{8})-(\d{2})$/.exec(slot);
  const index = match ? slotHours.indexOf(match[2]!) : -1;
  if (index < 0) throw new Error("Schedule slot tidak valid");
  return index === 0 ? `${previousDate(match![1]!)}-${slotHours.at(-1)}` : `${match![1]}-${slotHours[index - 1]}`;
}

async function alertMissingPreviousSlot(repository: Repository, logger: Logger, currentSlot: string, slotHours: string[]): Promise<void> {
  const previousSlot = previousScheduleSlot(currentSlot, slotHours);
  if (!await repository.wasTriggerSuccessful(`scheduler:${previousSlot}`)) {
    logger.error({ event: "sap_sync_missing_success_alert", previousSlot }, "Tidak ada run sukses pada slot scheduler sebelumnya");
  }
}

export function startScheduler(config: AppConfig, engine: SyncEngine, repository: Repository, logger: Logger): ScheduledTask[] {
  const tasks = config.sync.schedules.map((expression) =>
    cron.schedule(
      expression,
      async () => {
        const slot = latestScheduleSlot(config.sync.slotHours);
        const triggerKey = `scheduler:${slot}`;
        try {
          await alertMissingPreviousSlot(repository, logger, slot, config.sync.slotHours);
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
      config.sync.deepSchedule,
      async () => {
        const triggerKey = `scheduler-deep:${jakartaToday()}`;
        try {
          await engine.run({ trigger: "scheduler", mode: "apply", triggerKey, scheduledFor: new Date(), resources: ["pr", "po"], lookbackMonths: DEEP_SYNC_LOOKBACK_MONTHS });
        } catch (error) {
          logger.error({ err: error, triggerKey }, "Deep sync malam gagal");
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
    const slot = latestScheduleSlot(config.sync.slotHours);
    const triggerKey = `scheduler:${slot}`;
    alertMissingPreviousSlot(repository, logger, slot, config.sync.slotHours)
      .then(() => engine.run({ trigger: "scheduler", mode: "apply", triggerKey, scheduledFor: new Date() }))
      .catch((error) => {
      logger.error({ err: error, triggerKey }, "Catch-up sync gagal");
    });
  });
  return tasks;
}
