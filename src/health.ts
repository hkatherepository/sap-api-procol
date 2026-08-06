import { createServer, type Server } from "node:http";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import { Repository } from "./repository.js";

export function startHealthServer(config: AppConfig, repository: Repository, logger: Logger): Server {
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health/live") {
      response.statusCode = 200;
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.url === "/health/ready") {
      try {
        await repository.healthcheck();
        response.statusCode = 200;
        response.end(JSON.stringify({ status: "ready" }));
      } catch {
        response.statusCode = 503;
        response.end(JSON.stringify({ status: "not_ready" }));
      }
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(config.service.port, config.service.host, () => {
    logger.info({ host: config.service.host, port: config.service.port }, "Health server aktif");
  });
  return server;
}
