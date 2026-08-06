#!/usr/bin/env node
import { Command, Option } from "commander";
import { bootstrap } from "./bootstrap.js";
import { RESOURCES, type Resource } from "./domain.js";
import { jakartaToday, validateWindow } from "./utils.js";

function selectedResources(value: string): Resource[] {
  if (value === "all") return [...RESOURCES];
  if (RESOURCES.includes(value as Resource)) return [value as Resource];
  throw new Error("resource harus all, vendor, pr, atau po");
}

async function withApp<T>(callback: (app: ReturnType<typeof bootstrap>) => Promise<T>): Promise<T> {
  const app = bootstrap();
  try {
    return await callback(app);
  } finally {
    await app.pool.end();
  }
}

const program = new Command()
  .name("sap-sync")
  .description("Command operasional sinkronisasi SAP ke Si Procol")
  .showHelpAfterError();

program
  .command("test")
  .description("Uji schema database dan koneksi read-only ke tiga endpoint SAP")
  .action(async () => {
    await withApp(async ({ repository, sap }) => {
      await repository.assertSchema();
      const today = jakartaToday();
      const counts: Partial<Record<Resource, number>> = {};
      for (const resource of RESOURCES) counts[resource] = (await sap.fetch(resource, { low: today, high: today })).length;
      process.stdout.write(`${JSON.stringify({ database: "ok", sap: "ok", filter: { low: today, high: today }, received: counts }, null, 2)}\n`);
    });
  });

function addWindowOptions(command: Command): Command {
  return command
    .addOption(new Option("--resource <resource>").choices(["all", ...RESOURCES]).default("all"))
    .requiredOption("--low <YYYYMMDD>")
    .requiredOption("--high <YYYYMMDD>");
}

addWindowOptions(program.command("dry-run").description("Ambil, validasi, dan rekonsiliasi tanpa mengubah tabel bisnis"))
  .action(async (options: { resource: string; low: string; high: string }) => {
    await withApp(async ({ repository, engine }) => {
      await repository.assertSchema();
      const runId = await engine.run({ trigger: "cli", mode: "dry_run", resources: selectedResources(options.resource), window: validateWindow(options.low, options.high) });
      process.stdout.write(`${JSON.stringify({ runId, mode: "dry_run" })}\n`);
    });
  });

addWindowOptions(program.command("run").description("Jalankan apply terkontrol ke tabel bisnis"))
  .requiredOption("--confirm-write", "Konfirmasi eksplisit bahwa mode write telah disetujui")
  .action(async (options: { resource: string; low: string; high: string; confirmWrite: boolean }) => {
    if (!options.confirmWrite) throw new Error("--confirm-write wajib untuk apply");
    await withApp(async ({ repository, engine }) => {
      await repository.assertSchema();
      const runId = await engine.run({ trigger: "cli", mode: "apply", resources: selectedResources(options.resource), window: validateWindow(options.low, options.high) });
      process.stdout.write(`${JSON.stringify({ runId, mode: "apply" })}\n`);
    });
  });

program
  .command("status")
  .argument("<run-id>")
  .description("Tampilkan status dan counter sebuah run")
  .action(async (runId: string) => {
    await withApp(async ({ repository }) => {
      await repository.assertSchema();
      process.stdout.write(`${JSON.stringify(await repository.getRun(runId), null, 2)}\n`);
    });
  });

program
  .command("retry")
  .argument("<run-id>")
  .option("--confirm-write", "Wajib bila run asal menggunakan mode apply")
  .description("Ulangi window failed/partial dari run sebelumnya")
  .action(async (runId: string, options: { confirmWrite?: boolean }) => {
    await withApp(async ({ repository, engine }) => {
      await repository.assertSchema();
      const definition = await repository.getRetryDefinition(runId);
      if (definition.mode === "apply" && !options.confirmWrite) throw new Error("Retry apply membutuhkan --confirm-write");
      const windowsByResource: Partial<Record<Resource, Array<{ low: string; high: string }>>> = {};
      for (const item of definition.resources) {
        const windows = windowsByResource[item.resource] ?? [];
        windows.push({ low: item.low, high: item.high });
        windowsByResource[item.resource] = windows;
      }
      const resources = RESOURCES.filter((resource) => windowsByResource[resource]?.length);
      if (resources.length === 0) throw new Error("Run tidak mempunyai resource failed/partial untuk di-retry");
      const retryRunId = await engine.run({ trigger: "retry", mode: definition.mode, retryOf: runId, resources, windowsByResource });
      process.stdout.write(`${JSON.stringify({ runId: retryRunId, retryOf: runId, mode: definition.mode })}\n`);
    });
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`sap-sync: ${message}\n`);
  process.exitCode = 1;
});
