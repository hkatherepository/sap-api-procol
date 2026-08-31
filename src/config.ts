import { readFileSync } from "node:fs";
import { z } from "zod";

const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1),
    SAP_VENDOR_API_URL: z.string().url(),
    SAP_PR_API_URL: z.string().url(),
    SAP_PO_API_URL: z.string().url(),
    SAP_API_USERNAME: z.string().min(1),
    SAP_API_PASSWORD: z.string().min(1),
    SAP_HTTP_METHOD: z.enum(["GET", "POST"]).default("POST"),
    SAP_FILTER_TRANSPORT: z.enum(["json_body", "query_parameter"]),
    SAP_FILTER_LOW_PARAM: z.string().min(1).default("low"),
    SAP_FILTER_HIGH_PARAM: z.string().min(1).default("high"),
    SAP_CA_CERT_PATH: z.string().optional(),
    SAP_TLS_REJECT_UNAUTHORIZED: booleanString.default(false),
    SAP_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    SAP_MAX_RESPONSE_MB: z.coerce.number().positive().max(500).default(50),
    SAP_NUMBER_FORMAT: z.literal("id-ID").default("id-ID"),
    SYNC_SCHEDULES: z.string().default("0 7 * * *,0 12 * * *,0 19 * * *"),
    SYNC_TIMEZONE: z.literal("Asia/Jakarta").default("Asia/Jakarta"),
    SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(2_000).default(200),
    DRY_RUN_ONLY: booleanString.default(true),
    SYNC_SCHEDULER_ENABLED: booleanString.default(false),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(7).default(90),
    HOUSEKEEPING_SCHEDULE: z.string().default("30 2 * * *"),
    SERVICE_HOST: z.string().default("0.0.0.0"),
    SERVICE_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  })
  .superRefine((env, ctx) => {
    if (env.SAP_HTTP_METHOD === "GET" && env.SAP_FILTER_TRANSPORT === "json_body") {
      ctx.addIssue({ code: "custom", path: ["SAP_FILTER_TRANSPORT"], message: "HTTP GET tidak boleh memakai json_body" });
    }
    if (env.NODE_ENV === "production" && !env.SAP_CA_CERT_PATH) {
      ctx.addIssue({ code: "custom", path: ["SAP_CA_CERT_PATH"], message: "CA internal wajib di production" });
    }
  });

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const env = schema.parse(source);
  const rawSchedules = env.SYNC_SCHEDULES.trim().replace(/\s+/g, " ");
  const schedules = rawSchedules === "0 7,12,19 * * *"
    ? [rawSchedules]
    : rawSchedules.split(",").map((value) => value.trim()).filter(Boolean);
  const expected = ["0 7 * * *", "0 12 * * *", "0 19 * * *"];
  const validSchedules =
    (schedules.length === 1 && schedules[0] === "0 7,12,19 * * *") ||
    (schedules.length === 3 && expected.every((value) => schedules.includes(value)));
  if (!validSchedules) throw new Error("SYNC_SCHEDULES hanya boleh 0 7 * * *,0 12 * * *,0 19 * * * atau 0 7,12,19 * * *");
  return {
    env: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    sap: {
      urls: { vendor: env.SAP_VENDOR_API_URL, pr: env.SAP_PR_API_URL, po: env.SAP_PO_API_URL },
      username: env.SAP_API_USERNAME,
      password: env.SAP_API_PASSWORD,
      method: env.SAP_HTTP_METHOD,
      filterTransport: env.SAP_FILTER_TRANSPORT,
      lowParam: env.SAP_FILTER_LOW_PARAM,
      highParam: env.SAP_FILTER_HIGH_PARAM,
      ca: env.SAP_CA_CERT_PATH ? readFileSync(env.SAP_CA_CERT_PATH) : undefined,
      rejectUnauthorized: env.SAP_TLS_REJECT_UNAUTHORIZED,
      timeoutMs: env.SAP_API_TIMEOUT_MS,
      maxResponseBytes: Math.floor(env.SAP_MAX_RESPONSE_MB * 1024 * 1024),
    },
    sync: {
      schedules,
      timezone: env.SYNC_TIMEZONE,
      batchSize: env.SYNC_BATCH_SIZE,
      dryRunOnly: env.DRY_RUN_ONLY,
      schedulerEnabled: env.SYNC_SCHEDULER_ENABLED,
      auditRetentionDays: env.AUDIT_RETENTION_DAYS,
      housekeepingSchedule: env.HOUSEKEEPING_SCHEDULE,
    },
    service: { host: env.SERVICE_HOST, port: env.SERVICE_PORT },
    logLevel: env.LOG_LEVEL,
  };
}
