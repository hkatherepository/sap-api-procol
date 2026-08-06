import { loadConfig } from "./config.js";
import { createPool } from "./database.js";
import { createLogger } from "./logger.js";
import { Repository } from "./repository.js";
import { SapClient } from "./sap/client.js";
import { SyncEngine } from "./sync-engine.js";

export function bootstrap() {
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = createPool(config);
  const repository = new Repository(pool);
  const sap = new SapClient(config.sap, logger);
  const engine = new SyncEngine(config, pool, repository, sap, logger);
  return { config, logger, pool, repository, sap, engine };
}
