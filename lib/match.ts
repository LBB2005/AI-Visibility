/**
 * Brand-name matching: text folding, word-boundary term matching, the raw-text
 * fallback, and the question leak validator. Pure and unit-tested.
 */

export interface Target {
  brand: string;
  aliases?: string[];
}

/**
 * Length-preserving fold: strips diacritics, straightens quotes/dashes, maps all
 * whitespace to a single space char (without collapsing), optionally lowercases.
 * Because length is preserved, offsets in the folded string are valid offsets
 * into the raw string — which is what the UI uses for highlighting.
 */
export function fold(s: string, lower = true): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let c = ch.normalize("NFKD")[0] ?? ch;
    if (/[‘’‛′`´]/.test(c)) c = "'";
    else if (/[‐-―−]/.test(c)) c = "-";
    else if (/\s/.test(c)) c = " ";
    if (lower) {
      const l = c.toLowerCase();
      if (l.length === 1) c = l;
    }
    out += c.length === 1 ? c : ch;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Word boundary = not preceded/followed by a letter or digit (Unicode-aware).
const B_START = "(?<![\\p{L}\\p{N}])";
const B_END = "(?![\\p{L}\\p{N}])";

/** Regex source for a term; spaces/hyphens inside the term match any run of spaces/hyphens. */
function termSource(term: string, lower: boolean, sep = "[ \\-]+"): string {
  const parts = fold(term.trim(), lower)
    .split(/[ \-]+/)
    .filter(Boolean)
    .map(escapeRe);
  return B_START + parts.join(sep) + B_END;
}

export function termRegex(term: string, opts: { lower?: boolean; global?: boolean; sep?: string } = {}): RegExp {
  const lower = opts.lower ?? true;
  return new RegExp(termSource(term, lower, opts.sep), "u" + (opts.global ? "g" : ""));
}

export const alnumLen = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").length;
export const hasUpper = (s: string) => /\p{Lu}/u.test(s);
const squash = (s: string) => fold(s).replace(/[^\p{L}\p{N}]/gu, "");

/** All user-supplied names for the target (brand + aliases), deduped, empties dropped. */
export function targetTerms(target: Target): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [target.brand, ...(target.aliases ?? [])]) {
    const trimmed = t.trim();
    const key = fold(trimmed);
    if (trimmed && !seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Does `text` contain `term` as a whole word/phrase, case-insensitively?
 * "Notion AI" contains "Notion" (true); "Notion" does not contain "Notion AI" (false);
 * "Dropbox" does not contain "Box" (false).
 */
export function containsTerm(text: string, term: string): boolean {
  if (!term.trim()) return false;
  return termRegex(term).test(fold(text));
}

/**
 * Word-boundary mention of a proper name in free text, rejecting all-lowercase
 * occurrences of capitalized names ("small teams" is not "Microsoft Teams"/"Teams").
 */
export function mentionsName(text: string, name: string): boolean {
  if (!name.trim()) return false;
  const folded = fold(text);
  for (const m of folded.matchAll(termRegex(name, { global: true }))) {
    if (!hasUpper(name) || hasUpper(text.slice(m.index!, m.index! + m[0].length))) return true;
  }
  return false;
}

/** Primary matcher: does an extracted brand name refer to the target? */
export function nameMatchesTarget(name: string, target: Target): boolean {
  return targetTerms(target).some((t) => containsTerm(name, t));
}

/** Canonical key for grouping brand names across answers. */
export function brandKey(name: string): string {
  return fold(name)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Strict leak check for generated questions — deliberately over-eager, because a
 * question that names the brand invalidates the measurement. A question leaks if:
 *  - it contains the brand/alias as a word or phrase, with any (or no) space/hyphen
 *    between its words ("Google Docs", "Google-Docs", "GoogleDocs"), any case; or
 *  - for names of 4+ letters, any single token contains it ("NotionHQ", "#notion").
 */
export function leaksBrand(question: string, target: Target): string | null {
  const folded = fold(question);
  const tokens = folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const term of targetTerms(target)) {
    if (termRegex(term, { sep: "[ \\-]*" }).test(folded)) return term;
    const sq = squash(term);
    if (sq.length >= 4 && tokens.some((t) => t.includes(sq))) return term;
  }
  return null;
}

/**
 * Raw-text fallback matcher, used when extraction missed the brand.
 * Returns character offsets (into the raw answer) of each accepted occurrence.
 *
 * Rules, to avoid false positives on brands that are also common words:
 *  - word-boundary, case-insensitive match;
 *  - if the user typed the term with any uppercase letter, an occurrence written in
 *    all lowercase is rejected ("the notion that…", "bear in mind" are not brands);
 *  - terms with ≤ 2 letters/digits ("X", "Go") are too ambiguous — no fallback.
 */
export function fallbackOccurrences(answer: string, target: Target): { start: number; end: number }[] {
  const folded = fold(answer);
  const spans: { start: number; end: number }[] = [];
  for (const term of targetTerms(target)) {
    if (alnumLen(term) <= 2) continue;
    const re = termRegex(term, { global: true });
    for (const m of folded.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      const raw = answer.slice(start, end);
      if (hasUpper(term) && !hasUpper(raw)) continue;
      spans.push({ start, end });
    }
  }
  return mergeSpans(spans);
}

/**
 * Spans to highlight in the UI: every word-boundary occurrence of the brand or an alias.
 * Uses the same lowercase-rejection rule as the fallback so we don't highlight "notion" the word.
 * Short terms are included here (highlighting is cosmetic, not scored).
 */
export function highlightSpans(answer: string, target: Target): { start: number; end: number }[] {
  const folded = fold(answer);
  const spans: { start: number; end: number }[] = [];
  for (const term of targetTerms(target)) {
    for (const m of folded.matchAll(termRegex(term, { global: true }))) {
      const start = m.index!;
      const end = start + m[0].length;
      if (hasUpper(term) && !hasUpper(answer.slice(start, end))) continue;
      spans.push({ start, end });
    }
  }
  return mergeSpans(spans);
}

function mergeSpans(spans: { start: number; end: number }[]) {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: { start: number; end: number }[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}
