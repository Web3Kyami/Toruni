import { applyMigrations } from "./migrations.ts";
import { closeDatabase } from "./database.ts";
try {
  await applyMigrations();
  process.stdout.write("Toruni schema is current.\n");
} catch {
  process.stderr.write("Migration failed. Check database connectivity and migration history.\n");
  process.exitCode = 1;
} finally { await closeDatabase(); }
