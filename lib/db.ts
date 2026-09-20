import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.AVC_DB_PATH ?? path.join(process.cwd(), "data", "avc.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,            -- running | done | interrupted
  brand        TEXT NOT NULL,
  aliases      TEXT NOT NULL,            -- JSON string[]
  category     TEXT NOT NULL,
  competitors  TEXT NOT NULL,            -- JSON string[]
  questions    TEXT NOT NULL,            -- JSON {text, intent}[]
  models       TEXT NOT NULL,            -- JSON RunModel[]
  samples      INTEGER NOT NULL,
  extractor    TEXT NOT NULL,
  est_cost     REAL,
  brand_domain TEXT                       -- the target's own website, for owned-source detection
);
CREATE TABLE IF NOT EXISTS answers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  question_idx  INTEGER NOT NULL,
  question      TEXT NOT NULL,
  model         TEXT NOT NULL,
  track         TEXT NOT NULL,           -- parametric | web
  sample        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | ok | failed
  failed_stage  TEXT,                    -- answer | extract
  error         TEXT,
  answer        TEXT,
  brands        TEXT,                    -- JSON {name, first_position}[] from extraction
  citations     TEXT,                    -- JSON {url, title}[] (web track)
  cost          REAL,
  latency_ms    INTEGER,
  cached        INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS answers_run ON answers(run_id);
CREATE TABLE IF NOT EXISTS cache (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
`;

const g = globalThis as unknown as { __avcDb?: Database.Database };

export function db(): Database.Database {
  if (!g.__avcDb) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const d = new Database(DB_PATH);
    d.pragma("journal_mode = WAL");
    d.pragma("foreign_keys = ON");
    d.exec(SCHEMA);
    migrate(d);
    g.__avcDb = d;
  }
  return g.__avcDb;
}

/** Additive migrations so databases created by earlier versions keep working. */
function migrate(d: Database.Database) {
  const columns = (table: string) => (d.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
  if (!columns("runs").includes("brand_domain")) d.exec("ALTER TABLE runs ADD COLUMN brand_domain TEXT");
}

export interface RunModel {
  id: string;
  label: string;
  provider: string;
  /** Model always searches the web (e.g. Perplexity Sonar) — has no parametric track. */
  webNative: boolean;
}

export interface Question {
  text: string;
  intent: string;
}

export interface RunRow {
  id: string;
  created_at: string;
  finished_at: string | null;
  status: "running" | "done" | "interrupted";
  brand: string;
  aliases: string[];
  category: string;
  competitors: string[];
  questions: Question[];
  models: RunModel[];
  samples: number;
  extractor: string;
  est_cost: number | null;
  brand_domain: string | null;
}

export interface AnswerRow {
  id: number;
  run_id: string;
  question_idx: number;
  question: string;
  model: string;
  track: "parametric" | "web";
  sample: number;
  status: "pending" | "ok" | "failed";
  failed_stage: string | null;
  error: string | null;
  answer: string | null;
  brands: { name: string; first_position: number }[] | null;
  citations: { url: string; title?: string }[] | null;
  cost: number | null;
  latency_ms: number | null;
  cached: number;
}

type Raw = Record<string, unknown>;
const j = <T>(v: unknown, fallback: T): T => (typeof v === "string" && v ? (JSON.parse(v) as T) : fallback);

export function parseRun(r: Raw): RunRow {
  return {
    ...(r as unknown as RunRow),
    aliases: j(r.aliases, []),
    competitors: j(r.competitors, []),
    questions: j(r.questions, []),
    models: j(r.models, []),
  };
}

export function parseAnswer(r: Raw): AnswerRow {
  return {
    ...(r as unknown as AnswerRow),
    brands: j(r.brands, null),
    citations: j(r.citations, null),
  };
}

export function getRun(id: string): RunRow | null {
  const r = db().prepare("SELECT * FROM runs WHERE id = ?").get(id) as Raw | undefined;
  return r ? parseRun(r) : null;
}

export function getAnswers(runId: string): AnswerRow[] {
  return (db().prepare("SELECT * FROM answers WHERE run_id = ? ORDER BY question_idx, model, track, sample").all(runId) as Raw[]).map(parseAnswer);
}

export function listRuns(): RunRow[] {
  return (db().prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as Raw[]).map(parseRun);
}
