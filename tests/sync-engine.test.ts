import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncEngine } from "../src/sync-engine.js";

function tasksFor(checkpoint: string | null, request: object = {}) {
  const repository = { checkpoint: async () => checkpoint };
  const engine = new SyncEngine({} as never, {} as never, repository as never, {} as never, {} as never);
  return (engine as unknown as { buildTasks(request: object): Promise<Array<{ resource: string; window: { low: string; high: string } }>> })
    .buildTasks(request)
    .then((tasks) => tasks.map((task) => `${task.resource} ${task.window.low}-${task.window.high}`));
}

describe("SyncEngine window", () => {
  afterEach(() => vi.useRealTimers());

  it("scheduler menarik bulan lalu + bulan ini untuk PR, PO, GR tanpa vendor", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-29T01:00:00Z") });
    expect(await tasksFor("20260929")).toEqual([
      "pr 20260801-20260831", "po 20260801-20260831", "gr 20260801-20260831",
      "pr 20260901-20260929", "po 20260901-20260929", "gr 20260901-20260929",
    ]);
  });

  it("scheduler mundur ke checkpoint lama agar run yang terlewat tersusul", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-29T01:00:00Z") });
    expect((await tasksFor("20260615")).slice(0, 3)).toEqual(["pr 20260615-20260630", "po 20260615-20260630", "gr 20260615-20260630"]);
  });

  it("sync malam menarik PR & PO 12 bulan, melewati batas tahun", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-29T01:00:00Z") });
    const tasks = await tasksFor("20260929", { resources: ["pr", "po"], lookbackMonths: 11 });
    expect(tasks).toHaveLength(24);
    expect(tasks.slice(0, 2)).toEqual(["pr 20251001-20251031", "po 20251001-20251031"]);
    expect(tasks.at(-1)).toBe("po 20260901-20260929");
  });

  it("CLI memecah window per bulan dengan urutan PR, PO, GR", async () => {
    expect(await tasksFor(null, { window: { low: "20260820", high: "20260905" } })).toEqual([
      "pr 20260820-20260831", "po 20260820-20260831", "gr 20260820-20260831",
      "pr 20260901-20260905", "po 20260901-20260905", "gr 20260901-20260905",
    ]);
  });
});
