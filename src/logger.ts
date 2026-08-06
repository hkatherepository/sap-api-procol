import pino from "pino";
import type { AppConfig } from "./config.js";

export function createLogger(config: Pick<AppConfig, "logLevel">) {
  return pino({
    level: config.logLevel,
    redact: {
      censor: "[REDACTED]",
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "headers.authorization",
        "headers.cookie",
        "authorization",
        "password",
        "token",
        "sap.password",
        "payload",
        "rawPayload",
        "*.email",
        "*.phone",
        "*.npwp",
      ],
    },
    base: { service: "sap-procol-integration" },
  });
}
