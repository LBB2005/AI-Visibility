/**
 * Pure scoring module: brand matching, ranking, and every metric shown in the UI.
 * No I/O, no model calls — everything here is deterministic and unit-tested.
 */

export type Track = "parametric" | "web";
export const TRACKS: Track[] = ["parametric", "web"];

export interface Target {
  brand: string;
  aliases?: string[];
}

export interface ExtractedBrand {
  name: string;
  first_position: number;
}

/** One stored answer row, as the scorer sees it. */
export interface AnswerInput {
  questionIdx: number;
  question: string;
  model: string;
  track: Track;
  sample: number;
  /** "ok" rows count; anything else is a failure and is excluded from denominators. */
  status: "ok" | "failed";
  answer: string | null;
  brands: ExtractedBrand[] | null;
}

// ---------------------------------------------------------------------------
// Text folding & term matching
// ---------------------------------------------------------------------------

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

const alnumLen = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").length;
const hasUpper = (s: string) => /\p{Lu}/u.test(s);
const squash = (s: string) => fold(s).replace(/[^\p{L}\p{N}]/gu, "");

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

// ---------------------------------------------------------------------------
// Canonicalization & per-answer ranking
// ---------------------------------------------------------------------------

export const TARGET_KEY = "__target__";

export function brandKey(name: string): string {
  return fold(name)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface Canonical {
  key: string;
  name: string;
  isTarget: boolean;
}

/**
 * Map an extracted name onto a canonical brand: the target (via brand/aliases),
 * a user-listed competitor (if the extracted name contains it), or itself.
 */
export function canonicalize(name: string, target: Target, competitors: string[] = [], variants?: Map<string, string>): Canonical {
  if (nameMatchesTarget(name, target)) return { key: TARGET_KEY, name: target.brand, isTarget: true };
  for (const c of competitors) {
    if (c.trim() && containsTerm(name, c)) return { key: brandKey(c), name: c.trim(), isTarget: false };
  }
  const mapped = variants?.get(brandKey(name));
  if (mapped) return { key: brandKey(mapped), name: mapped, isTarget: false };
  return { key: brandKey(name), name: name.trim(), isTarget: false };
}

/**
 * Run-level name-variant map: a name that contains a shorter name extracted elsewhere in
 * the run is folded into it ("Microsoft OneNote" → "OneNote"). When several shorter
 * names qualify, the most frequently extracted wins (ties → the longer, more specific one).
 */
export function variantMap(rows: AnswerInput[], target: Target): Map<string, string> {
  const counts = new Map<string, { name: string; n: number }>();
  for (const r of rows) {
    if (r.status !== "ok" || !r.brands) continue;
    const seen = new Set<string>();
    for (const b of r.brands) {
      if (!b?.name?.trim() || nameMatchesTarget(b.name, target)) continue;
      const k = brandKey(b.name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const c = counts.get(k);
      if (c) c.n++;
      else counts.set(k, { name: b.name.trim(), n: 1 });
    }
  }
  const all = [...counts.entries()];
  const map = new Map<string, string>();
  for (const [k, { name }] of all) {
    const candidates = all
      .filter(([k2, c]) => k2 !== k && c.name.length < name.length && containsTerm(name, c.name))
      .sort((a, b) => b[1].n - a[1].n || b[1].name.length - a[1].name.length);
    if (candidates.length) map.set(k, candidates[0][1].name);
  }
  return map;
}

export interface RankedBrand extends Canonical {
  rank: number;
}

export interface ScoredAnswer {
  input: AnswerInput;
  ok: boolean;
  mentioned: boolean;
  rank: number | null;
  matchSource: "extraction" | "fallback" | null;
  ranked: RankedBrand[];
}

/**
 * Order the brands in one answer by where they first appear in the actual text.
 * - Extracted names are canonicalized and deduped (the target appears at most once).
 * - Each is located in the text by word-boundary search; names we can't locate keep
 *   the extractor's relative order, slotted right after their predecessor.
 * - If extraction missed the target but the raw-text fallback finds it, the target is
 *   inserted at its true text position.
 */
export function rankAnswer(input: AnswerInput, target: Target, competitors: string[] = [], variants?: Map<string, string>): ScoredAnswer {
  if (input.status !== "ok" || input.answer == null || input.brands == null) {
    return { input, ok: false, mentioned: false, rank: null, matchSource: null, ranked: [] };
  }
  const answer = input.answer;
  const folded = fold(answer);

  // Brands named in the question itself ("alternatives to Evernote") are the premise,
  // not a recommendation — exclude them from this answer's ranking.
  const extracted = [...input.brands]
    .filter((b) => b && typeof b.name === "string" && b.name.trim())
    .filter((b) => !mentionsName(input.question, b.name))
    .map((b, i) => ({ ...b, _i: i }))
    .sort((a, b) => (a.first_position ?? 0) - (b.first_position ?? 0) || a._i - b._i);

  // Canonicalize + dedupe, remembering every raw variant for text location.
  const byKey = new Map<string, { canon: Canonical; variants: string[]; order: number }>();
  extracted.forEach((b, order) => {
    const canon = canonicalize(b.name, target, competitors, variants);
    const hit = byKey.get(canon.key);
    if (hit) hit.variants.push(b.name);
    else byKey.set(canon.key, { canon, variants: [b.name, canon.name], order });
  });

  // Roll sub-products up into a parent brand named in the same answer
  // ("Obsidian Sync" → "Obsidian" when "Obsidian" is also named).
  for (const [key, e] of [...byKey.entries()]) {
    if (key === TARGET_KEY) continue;
    const parent = [...byKey.entries()].find(
      ([k, p]) => k !== key && k !== TARGET_KEY && p.canon.name.length < e.canon.name.length && containsTerm(e.canon.name, p.canon.name),
    );
    if (parent) {
      parent[1].variants.push(...e.variants);
      parent[1].order = Math.min(parent[1].order, e.order);
      byKey.delete(key);
    }
  }

  let matchSource: ScoredAnswer["matchSource"] = byKey.has(TARGET_KEY) ? "extraction" : null;
  if (!matchSource) {
    const occ = fallbackOccurrences(answer, target);
    if (occ.length) {
      matchSource = "fallback";
      byKey.set(TARGET_KEY, {
        canon: { key: TARGET_KEY, name: target.brand, isTarget: true },
        variants: [],
        order: Number.POSITIVE_INFINITY,
      });
    }
  }

  // First occurrence of a name; prefer a capitalized one when the name is capitalized,
  // so "bear in mind" early in the text doesn't set the position of the app "Bear".
  const firstOccurrence = (term: string): number | null => {
    let any: number | null = null;
    for (const m of folded.matchAll(termRegex(term, { global: true }))) {
      if (any === null) any = m.index!;
      if (!hasUpper(term) || hasUpper(answer.slice(m.index!, m.index! + m[0].length))) return m.index!;
    }
    return any;
  };

  const locate = (key: string, variants: string[]): number | null => {
    let best: number | null = null;
    const terms = key === TARGET_KEY ? [...variants, ...targetTerms(target)] : variants;
    for (const v of terms) {
      if (!v || !v.trim()) continue;
      const idx = firstOccurrence(v);
      if (idx !== null && (best === null || idx < best)) best = idx;
    }
    if (key === TARGET_KEY) {
      const occ = fallbackOccurrences(answer, target)[0];
      if (occ && (best === null || occ.start < best)) best = occ.start;
    }
    return best;
  };

  // Walk in extractor order; unlocated entries inherit predecessor's position + epsilon.
  const entries = [...byKey.values()].sort((a, b) => a.order - b.order);
  let prev = -1;
  const keyed = entries.map((e, i) => {
    const pos = locate(e.canon.key, e.variants);
    const sortKey = pos ?? prev + 1e-3 * (i + 1);
    if (pos !== null) prev = pos;
    else prev = sortKey;
    return { e, sortKey, i };
  });
  keyed.sort((a, b) => a.sortKey - b.sortKey || a.i - b.i);

  const ranked: RankedBrand[] = keyed.map(({ e }, idx) => ({ ...e.canon, rank: idx + 1 }));
  const t = ranked.find((r) => r.isTarget);
  return {
    input,
    ok: true,
    mentioned: !!t,
    rank: t ? t.rank : null,
    matchSource: t ? matchSource : null,
    ranked,
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Wilson score interval for a binomial proportion (default 95%). */
export function wilson(k: number, n: number, z = 1.959964): [number, number] | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [k === 0 ? 0 : Math.max(0, center - half), k === n ? 1 : Math.min(1, center + half)];
}

/** Position weight used for share of voice: 1 / log2(rank + 1). Rank 1 → 1, 2 → 0.63, 3 → 0.5. */
export function positionWeight(rank: number): number {
  return 1 / Math.log2(rank + 1);
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

/** Two-sided p-value for a difference of two proportions (pooled z-test). */
export function twoProportionP(k1: number, n1: number, k2: number, n2: number): number | null {
  if (n1 === 0 || n2 === 0) return null;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return k1 / n1 === k2 / n2 ? 1 : 0;
  const z = (k1 / n1 - k2 / n2) / se;
  return 2 * (1 - normCdf(Math.abs(z)));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface SliceMetrics {
  /** Answers counted (status ok). */
  n: number;
  /** Failed calls in this slice — excluded from n, reported separately. */
  failed: number;
  mentions: number;
  rate: number | null;
  ci: [number, number] | null;
  avgPosition: number | null;
  /** Position-weighted share of voice: target weight / total weight across all brands. */
  sov: number | null;
}

export function sliceMetrics(scored: ScoredAnswer[]): SliceMetrics {
  const ok = scored.filter((s) => s.ok);
  const failed = scored.length - ok.length;
  const hits = ok.filter((s) => s.mentioned);
  let targetW = 0;
  let totalW = 0;
  for (const s of ok) {
    for (const r of s.ranked) {
      const w = positionWeight(r.rank);
      totalW += w;
      if (r.isTarget) targetW += w;
    }
  }
  return {
    n: ok.length,
    failed,
    mentions: hits.length,
    rate: ok.length ? hits.length / ok.length : null,
    ci: wilson(hits.length, ok.length),
    avgPosition: hits.length ? hits.reduce((a, s) => a + (s.rank ?? 0), 0) / hits.length : null,
    sov: totalW > 0 ? targetW / totalW : null,
  };
}

export interface LeaderboardEntry {
  key: string;
  name: string;
  isTarget: boolean;
  isCompetitor: boolean;
  mentions: number;
  rate: number;
  ci: [number, number] | null;
  avgPosition: number | null;
  sov: number;
}

export function leaderboard(scored: ScoredAnswer[], target: Target, competitors: string[] = []): LeaderboardEntry[] {
  const ok = scored.filter((s) => s.ok);
  const n = ok.length;
  const agg = new Map<string, { name: string; isTarget: boolean; mentions: number; rankSum: number; w: number; names: Map<string, number> }>();
  let totalW = 0;
  for (const s of ok) {
    for (const r of s.ranked) {
      const w = positionWeight(r.rank);
      totalW += w;
      let a = agg.get(r.key);
      if (!a) {
        a = { name: r.name, isTarget: r.isTarget, mentions: 0, rankSum: 0, w: 0, names: new Map() };
        agg.set(r.key, a);
      }
      a.mentions++;
      a.rankSum += r.rank;
      a.w += w;
      a.names.set(r.name, (a.names.get(r.name) ?? 0) + 1);
    }
  }
  const competitorKeys = new Set(competitors.filter((c) => c.trim()).map(brandKey));
  // Always list the target and every user-named competitor, even at zero.
  if (!agg.has(TARGET_KEY)) agg.set(TARGET_KEY, { name: target.brand, isTarget: true, mentions: 0, rankSum: 0, w: 0, names: new Map() });
  for (const c of competitors) {
    const k = brandKey(c);
    if (c.trim() && !agg.has(k)) agg.set(k, { name: c.trim(), isTarget: false, mentions: 0, rankSum: 0, w: 0, names: new Map() });
  }
  const rows: LeaderboardEntry[] = [...agg.entries()].map(([key, a]) => {
    // Display the most common spelling for non-canonical brands.
    let name = a.name;
    if (!a.isTarget && !competitorKeys.has(key) && a.names.size) {
      name = [...a.names.entries()].sort((x, y) => y[1] - x[1])[0][0];
    }
    return {
      key,
      name,
      isTarget: a.isTarget,
      isCompetitor: competitorKeys.has(key),
      mentions: a.mentions,
      rate: n ? a.mentions / n : 0,
      ci: wilson(a.mentions, n),
      avgPosition: a.mentions ? a.rankSum / a.mentions : null,
      sov: totalW ? a.w / totalW : 0,
    };
  });
  rows.sort((a, b) => b.rate - a.rate || (a.avgPosition ?? 99) - (b.avgPosition ?? 99) || a.name.localeCompare(b.name));
  return rows;
}

export interface TrackGap {
  /** Models that ran both tracks — the only fair basis for comparing tracks. */
  pairedModels: string[];
  parametric: SliceMetrics;
  web: SliceMetrics;
  /** web rate − parametric rate, in proportion points. */
  delta: number | null;
  pValue: number | null;
  perModel: { model: string; parametric: SliceMetrics; web: SliceMetrics; delta: number | null }[];
}

export interface Report {
  overall: SliceMetrics;
  byModel: Record<string, SliceMetrics>;
  byTrack: Record<Track, SliceMetrics>;
  byModelTrack: Record<string, SliceMetrics>;
  byQuestion: { questionIdx: number; question: string; metrics: SliceMetrics }[];
  trackGap: TrackGap;
  leaderboard: LeaderboardEntry[];
  /** Answers where only the raw-text fallback found the brand (extraction missed it). */
  fallbackMatches: number;
  scored: ScoredAnswer[];
}

export const cellKey = (model: string, track: Track) => `${model}|${track}`;

function groupBy<T>(xs: T[], f: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = f(x);
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export function computeReport(rows: AnswerInput[], target: Target, competitors: string[] = []): Report {
  const variants = variantMap(rows, target);
  const scored = rows.map((r) => rankAnswer(r, target, competitors, variants));

  const byModel: Record<string, SliceMetrics> = {};
  for (const [m, xs] of groupBy(scored, (s) => s.input.model)) byModel[m] = sliceMetrics(xs);

  const byTrack = {
    parametric: sliceMetrics(scored.filter((s) => s.input.track === "parametric")),
    web: sliceMetrics(scored.filter((s) => s.input.track === "web")),
  };

  const byModelTrack: Record<string, SliceMetrics> = {};
  for (const [k, xs] of groupBy(scored, (s) => cellKey(s.input.model, s.input.track))) byModelTrack[k] = sliceMetrics(xs);

  const byQuestion = [...groupBy(scored, (s) => String(s.input.questionIdx)).values()]
    .map((xs) => ({ questionIdx: xs[0].input.questionIdx, question: xs[0].input.question, metrics: sliceMetrics(xs) }))
    .sort((a, b) => a.questionIdx - b.questionIdx);

  // Track gap: only over models that have *counted* answers on both tracks.
  const models = Object.keys(byModel);
  const pairedModels = models.filter(
    (m) => (byModelTrack[cellKey(m, "parametric")]?.n ?? 0) > 0 && (byModelTrack[cellKey(m, "web")]?.n ?? 0) > 0,
  );
  const paired = new Set(pairedModels);
  const pPar = sliceMetrics(scored.filter((s) => paired.has(s.input.model) && s.input.track === "parametric"));
  const pWeb = sliceMetrics(scored.filter((s) => paired.has(s.input.model) && s.input.track === "web"));
  const trackGap: TrackGap = {
    pairedModels,
    parametric: pPar,
    web: pWeb,
    delta: pPar.rate !== null && pWeb.rate !== null ? pWeb.rate - pPar.rate : null,
    pValue: twoProportionP(pWeb.mentions, pWeb.n, pPar.mentions, pPar.n),
    perModel: pairedModels.map((m) => {
      const par = byModelTrack[cellKey(m, "parametric")];
      const web = byModelTrack[cellKey(m, "web")];
      return { model: m, parametric: par, web, delta: par.rate !== null && web.rate !== null ? web.rate - par.rate : null };
    }),
  };

  return {
    overall: sliceMetrics(scored),
    byModel,
    byTrack,
    byModelTrack,
    byQuestion,
    trackGap,
    leaderboard: leaderboard(scored, target, competitors),
    fallbackMatches: scored.filter((s) => s.matchSource === "fallback").length,
    scored,
  };
}

// ---------------------------------------------------------------------------
// Plain-language summaries
// ---------------------------------------------------------------------------

export const pct = (x: number | null | undefined, digits = 0) => (x == null ? "—" : `${(x * 100).toFixed(digits)}%`);

export function verdict(report: Report, brand: string): string {
  const o = report.overall;
  if (!o.n) return `No answers were collected, so we can't say yet whether AI recommends ${brand}.`;
  const t = report.leaderboard.find((e) => e.isTarget)!;
  const rankAmong = 1 + report.leaderboard.filter((e) => e.rate > t.rate).length;
  const tied = report.leaderboard.some((e) => !e.isTarget && e.rate === t.rate && e.mentions > 0);
  const total = report.leaderboard.filter((e) => e.mentions > 0 || e.isTarget).length;
  const r = o.rate ?? 0;
  const lead =
    r >= 0.6 ? `AI reliably recommends ${brand}` : r >= 0.3 ? `AI sometimes recommends ${brand}` : r > 0 ? `AI rarely recommends ${brand}` : `AI doesn't recommend ${brand}`;
  return `${lead}: it's named in ${pct(r)} of ${o.n} answers, ${tied ? "tied for " : ""}#${rankAmong} of ${total} brands by mention rate.`;
}

export function trackInsight(report: Report, brand: string): string | null {
  const g = report.trackGap;
  if (g.delta === null || !g.pairedModels.length) return null;
  const pts = Math.round(Math.abs(g.delta) * 100);
  const sig = g.pValue !== null && g.pValue < 0.05;
  if (pts < 1) return `Web search makes no difference: ${brand} is named at the same rate from model memory and with live search.`;
  const dir = g.delta > 0 ? "rises" : "falls";
  const where = g.delta > 0 ? "live web results surface it more than training data does" : "training data favors it more than current web results do";
  return `With web search on, ${brand}'s mention rate ${dir} from ${pct(g.parametric.rate)} to ${pct(g.web.rate)} (${g.delta > 0 ? "+" : "−"}${pts} pts${sig ? "" : ", not statistically significant at this sample size"}) — ${where}.`;
}
