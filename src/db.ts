import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export const MAX_OBJECTS = 100000;
export const MAX_FIELDS = 64;
export const MAX_CAPACITY = 1_000_000;
export const MAX_EXPLAIN = 1000;

export interface Limits {
  maxObjects: number;
  maxFields: number;
  maxCapacity: number;
  maxExplain: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxObjects: MAX_OBJECTS,
  maxFields: MAX_FIELDS,
  maxCapacity: MAX_CAPACITY,
  maxExplain: MAX_EXPLAIN,
};

export function dataDir(): string {
  return process.env.GC_DATA_DIR || path.join(process.cwd(), "data");
}

export function openDb(file?: string): DatabaseSync {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = file || process.env.GC_DB_FILE || path.join(dir, "gc.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS objects (
      id INTEGER PRIMARY KEY,
      payload INTEGER NOT NULL,
      space INTEGER NOT NULL,
      offset INTEGER NOT NULL,
      field_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fields (
      object_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      target_id INTEGER,
      PRIMARY KEY (object_id, idx)
    );
    CREATE TABLE IF NOT EXISTS roots (
      name TEXT PRIMARY KEY,
      target_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
  `);
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
