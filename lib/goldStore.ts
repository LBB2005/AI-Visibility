/** File access for the gold set. Server-only; the pure math lives in ./gold. */

import fs from "node:fs";
import path from "node:path";
import { GoldItemSchema, type GoldItem } from "./gold";

export const GOLD_DIR = process.env.AVC_GOLD_DIR ?? path.join(process.cwd(), "gold");
export const GOLD_PATH = path.join(GOLD_DIR, "extractor-gold.jsonl");
export const REPORT_PATH = path.join(GOLD_DIR, "validation.md");

/** Every labeled item. Returns [] when nothing has been labeled yet. */
export function loadGold(): GoldItem[] {
  if (!fs.existsSync(GOLD_PATH)) return [];
  return fs
    .readFileSync(GOLD_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      const parsed = GoldItemSchema.safeParse(JSON.parse(l));
      if (!parsed.success) throw new Error(`${GOLD_PATH}:${i + 1} does not match the gold schema: ${parsed.error.issues[0]?.message}`);
      return parsed.data;
    });
}

export function goldIds(): Set<string> {
  return new Set(loadGold().map((i) => i.id));
}

export function appendGold(item: GoldItem): void {
  fs.mkdirSync(GOLD_DIR, { recursive: true });
  fs.appendFileSync(GOLD_PATH, JSON.stringify(item) + "\n", "utf8");
}

export function writeReport(markdown: string): string {
  fs.mkdirSync(GOLD_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, markdown, "utf8");
  return REPORT_PATH;
}
