import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { transaction } from "./database.ts";
export async function applyMigrations(): Promise<string[]> {
  const directory = resolve(process.cwd(), "sql");
  const filenames = (await readdir(directory)).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort();
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('toruni-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations
      (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied: string[] = [];
    for (const filename of filenames) {
      const sql = await readFile(resolve(directory, filename), "utf8");
      const digest = createHash("sha256").update(sql).digest("hex");
      const previous = await client.query<{ sha256: string }>("SELECT sha256 FROM schema_migrations WHERE filename = $1", [filename]);
      if (previous.rows[0]) {
        if (previous.rows[0].sha256 !== digest) throw new Error(`Applied migration checksum mismatch: ${filename}`);
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename, sha256) VALUES ($1,$2)", [filename, digest]);
      applied.push(filename);
    }
    return applied;
  });
}
