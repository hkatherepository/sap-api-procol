import { request } from "node:https";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { DateWindow, Resource } from "../domain.js";
import { unwrapSapResponse } from "./response.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class SapHttpError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export class SapClient {
  constructor(
    private readonly config: AppConfig["sap"],
    private readonly logger: Logger,
  ) {
    if (!this.config.rejectUnauthorized) {
      this.logger.warn(
        { event: "sap_tls_verification_disabled" },
        "Verifikasi certificate TLS SAP dinonaktifkan sementara; jangan gunakan konfigurasi ini sebagai target production final",
      );
    }
  }

  async fetch(resource: Resource, window: DateWindow): Promise<unknown[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.requestOnce(resource, window);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof SapHttpError && error.retryable;
        if (!retryable || attempt === 3) throw error;
        const base = 250 * 2 ** (attempt - 1);
        const delay = base + Math.floor(Math.random() * Math.max(1, base / 2));
        this.logger.warn({ resource, attempt, delayMs: delay }, "SAP request gagal, akan retry");
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  private requestOnce(resource: Resource, window: DateWindow): Promise<unknown[]> {
    const url = new URL(this.config.urls[resource]);
    let body: string | undefined;
    // ponytail: filter tanggal dinonaktifkan sementara - ambil seluruh data terkini dari SAP.
    // Aktifkan lagi kalau payload SAP sudah terlalu besar untuk sekali tarik.
    // if (this.config.filterTransport === "query_parameter") {
    //   url.searchParams.set(this.config.lowParam, window.low);
    //   url.searchParams.set(this.config.highParam, window.high);
    // } else {
    //   body = JSON.stringify({ [this.config.lowParam]: window.low, [this.config.highParam]: window.high });
    // }
    void window;

    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: this.config.method,
          auth: `${this.config.username}:${this.config.password}`,
          ca: this.config.ca,
          rejectUnauthorized: this.config.rejectUnauthorized,
          headers: {
            accept: "application/json",
            ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
          },
          timeout: this.config.timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let received = 0;
          response.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > this.config.maxResponseBytes) {
              response.destroy(new SapHttpError("Respons SAP melebihi batas ukuran", undefined, false));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new SapHttpError(`SAP HTTP ${status}`, status, RETRYABLE_STATUS.has(status)));
              return;
            }
            try {
              const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              resolve(unwrapSapResponse(parsed));
            } catch {
              reject(new SapHttpError("Respons SAP bukan JSON valid", status, false));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new SapHttpError("SAP request timeout", undefined, true)));
      req.on("error", (error) => {
        reject(error instanceof SapHttpError ? error : new SapHttpError("SAP network error", undefined, true));
      });
      if (body) req.write(body);
      req.end();
    });
  }
}
