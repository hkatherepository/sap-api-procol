import { bootstrap } from "./bootstrap.js";
import { startHealthServer } from "./health.js";
import { startScheduler } from "./scheduler.js";

const app = bootstrap();
await app.repository.assertSchema();
const server = startHealthServer(app.config, app.repository, app.logger);
const schedulerActive = !app.config.sync.dryRunOnly && app.config.sync.schedulerEnabled;
const scheduledTasks = schedulerActive
  ? startScheduler(app.config, app.engine, app.repository, app.logger)
  : [];

if (app.config.sync.dryRunOnly) {
  app.logger.warn("Scheduler apply nonaktif karena DRY_RUN_ONLY=true");
} else if (!app.config.sync.schedulerEnabled) {
  app.logger.warn("Scheduler apply nonaktif karena SYNC_SCHEDULER_ENABLED=false; hanya controlled apply manual yang diizinkan");
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.logger.info({ signal }, "Graceful shutdown dimulai");
  scheduledTasks.forEach((task) => task.stop());
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await app.pool.end();
  app.logger.info("Graceful shutdown selesai");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch((error) => {
        app.logger.error({ err: error }, "Graceful shutdown gagal");
        process.exit(1);
      });
  });
}
