import { db, pool } from "../config/drizzle.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_FOLDER = path.join(__dirname, "migrations");
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

const MIGRATIONS_TABLE = "_applied_migrations";

const objectExists = async (type: "table" | "type", name: string): Promise<boolean> => {
  try {
    if (type === "type") {
      const r = await pool.query(`SELECT 1 FROM pg_type WHERE typname = $1`, [name.replace(/"/g, "")]);
      return r.rows.length > 0;
    }
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
      [name.replace(/"/g, "").toLowerCase()]
    );
    return r.rows.length > 0;
  } catch { return false; }
};

export const runMigrations = async (): Promise<boolean> => {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await pool.query("SELECT 1");

      await pool.query(`
        CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL UNIQUE,
          applied_at TIMESTAMP DEFAULT NOW()
        )
      `);

      const files = fs.readdirSync(MIGRATIONS_FOLDER)
        .filter(f => f.endsWith(".sql") && !f.includes("snapshot"))
        .sort();

      const applied = await pool.query(`SELECT name FROM "${MIGRATIONS_TABLE}"`);
      const appliedNames = new Set(applied.rows.map((r: any) => r.name));

      // Legacy migrations that reference old schema (users table, removed columns)
      // Mark as applied so they're skipped without warnings on every startup
      const legacyFiles = ["0000_far_tombstone.sql", "0002_swift_penance.sql"];
      for (const f of legacyFiles) {
        if (files.includes(f) && !appliedNames.has(f)) {
          await pool.query(`INSERT INTO "${MIGRATIONS_TABLE}" (name) VALUES ($1) ON CONFLICT DO NOTHING`, [f]);
          appliedNames.add(f);
        }
      }

      let pending = 0;

      for (const file of files) {
        if (appliedNames.has(file)) continue;

        const sql = fs.readFileSync(path.join(MIGRATIONS_FOLDER, file), "utf-8");
        const statements = sql
          .split(/-->\s*statement-breakpoint/)
          .map(s => s.replace(/;\s*$/, "").trim())
          .filter(s => s.length > 0);

        let fileOk = true;

        for (const raw of statements) {
          const stmt = raw.endsWith(";") ? raw : raw + ";";
          const upper = stmt.trim().toUpperCase();

          // Skip CREATE TYPE if type already exists
          if (upper.startsWith("CREATE TYPE")) {
            const match = stmt.match(/CREATE\s+TYPE\s+(?:"[^"]+")?\.?"?(\w+)"?\s*AS/i);
            if (match && await objectExists("type", match[1])) {
              continue;
            }
          }

          // Skip CREATE TABLE IF table already exists
          if (upper.startsWith("CREATE TABLE")) {
            const match = stmt.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+")?\.?"?(\w+)"?/i);
            if (match && await objectExists("table", match[1])) {
              continue;
            }
          }

          // Skip ADD COLUMN IF NOT EXISTS — handled by inline SQL
          if (upper.includes("ADD COLUMN IF NOT EXISTS")) continue;

          try {
            await pool.query(stmt);
          } catch (e: any) {
            const msg = e.message?.toLowerCase() || "";
            if (
              msg.includes("already exists") ||
              msg.includes("duplicate key") ||
              msg.includes("duplicate column") ||
              msg.includes("duplicate object")
            ) {
              continue;
            }
            console.error(`     ⚠️  ${file}: ${e.message.slice(0, 120)}`);
            fileOk = false;
          }
        }

        if (fileOk) {
          await pool.query(
            `INSERT INTO "${MIGRATIONS_TABLE}" (name) VALUES ($1) ON CONFLICT DO NOTHING`,
            [file]
          );
          console.log(`  ✅ ${file}`);
          pending++;
        }
      }

      if (pending === 0) console.log("  ✅ All migrations already applied");
      return true;
    } catch (e: any) {
      const isConnError =
        e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT" ||
        e.code === "ENOTFOUND" || e.message?.includes("connection") ||
        e.message?.includes("timeout") || e.message?.includes("Pool");

      if (isConnError && attempt < MAX_RETRIES) {
        console.log(`  ⚠️  DB not ready (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }

      if (attempt < MAX_RETRIES) {
        console.log(`  ⚠️  Migration failed (attempt ${attempt}/${MAX_RETRIES}), retrying...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }

      console.error(`  ❌ Migration failed after ${MAX_RETRIES} attempts: ${e.message}`);
      return false;
    }
  }
  return false;
};

export const waitForDatabase = async (): Promise<boolean> => {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await pool.query("SELECT NOW()");
      console.log("  ✅ Database connected successfully");
      console.log("     Server time:", r.rows[0].now);
      return true;
    } catch (e: any) {
      if (attempt < MAX_RETRIES) {
        console.log(`  ⚠️  DB connection attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      console.error(`  ❌ Database connection failed after ${MAX_RETRIES} attempts`);
      return false;
    }
  }
  return false;
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const ok = await runMigrations();
  process.exit(ok ? 0 : 1);
}
