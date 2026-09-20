/**
 * Scoring: per-answer brand ranking and every metric shown in the UI.
 * Pure and deterministic — name matching lives in ./match, statistics in ./stats,
 * and citation analysis in ./citations.
 */

import { citationReport, type CitationReport } from "./citations";
import { pct } from "./format";
import {
  brandKey,
  containsTerm,
  fallbackOccurrences,
  fold,
  hasUpper,
  mentionsName,
  nameMatchesTarget,
  targetTerms,
  termRegex,
  type Target,
} from "./match";
import { bootstrapDiff, clusterBootstrap, positionWeight, twoProportionP, wilson, type BootstrapCI, type BootstrapDiff } from "./stats";

export type { Target } from "./match";

export type Track = "parametric" | "web";
export const TRACKS: Track[] = ["parametric", "web"];

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
  /** Sources the model cited (web track only); used by the citation report. */
  citations?: { url: string }[] | null;
  /** "buyer" (natural shortlist) or "list" (an explicit long ranked list). Defaults to buyer. */
  kind?: "buyer" | "list";
}

// ---------------------------------------------------------------------------
// Canonicalization & per-answer ranking
// ---------------------------------------------------------------------------

export const TARGET_KEY = "__target__";

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
 * Run-level name-variant map: a company-prefixed name folds into the bare product name
 * extracted elsewhere in the run ("Microsoft OneNote" → "OneNote"). Only trailing matches
 * fold — a product never folds into a bare company name ("Apple Notes" stays, not "Apple").
 * When several shorter names qualify, the most frequently extracted wins.
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
      .filter(([k2, c]) => k2 !== k && c.name.length < name.length && k.endsWith(" " + k2))
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

/** Mention rate over the counted answers of a slice — the statistic the bootstrap resamples. */
export const rateOf = (scored: ScoredAnswer[]): number | null => {
  const ok = scored.filter((s) => s.ok);
  return ok.length ? ok.filter((s) => s.mentioned).length / ok.length : null;
};

/** Position-weighted share of voice over a slice. */
export const sovOf = (scored: ScoredAnswer[]): number | null => {
  let targetW = 0;
  let totalW = 0;
  for (const s of scored) {
    if (!s.ok) continue;
    for (const r of s.ranked) {
      const w = positionWeight(r.rank);
      totalW += w;
      if (r.isTarget) targetW += w;
    }
  }
  return totalW > 0 ? targetW / totalW : null;
};

export function sliceMetrics(scored: ScoredAnswer[]): SliceMetrics {
  const ok = scored.filter((s) => s.ok);
  const failed = scored.length - ok.length;
  const hits = ok.filter((s) => s.mentioned);
  return {
    n: ok.length,
    failed,
    mentions: hits.length,
    rate: ok.length ? hits.length / ok.length : null,
    ci: wilson(hits.length, ok.length),
    avgPosition: hits.length ? hits.reduce((a, s) => a + (s.rank ?? 0), 0) / hits.length : null,
    sov: sovOf(ok),
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
  /** Unclustered pooled z-test; kept for comparison with the clustered result. */
  pValue: number | null;
  /** Question-clustered bootstrap of the same difference — the one to trust. */
  bootstrap: BootstrapDiff | null;
  perModel: { model: string; parametric: SliceMetrics; web: SliceMetrics; delta: number | null }[];
}

/**
 * What the long-list questions measure: not whether the brand is recommended (in a list of
 * 50 nearly every real brand appears) but how deep in the list it lands, and what the full
 * brand universe of the category looks like.
 */
export interface CensusReport {
  /** Counted answers to long-list questions. */
  answers: number;
  askedFor: number;
  listedRate: number | null;
  avgPosition: number | null;
  /** Share of list answers where the brand lands in the first ten names. */
  top10Rate: number | null;
  /** How many names models actually produced, against how many were asked for. */
  avgListLength: number | null;
  medianListLength: number | null;
  brands: LeaderboardEntry[];
  /** Brands named in exactly one list answer — either very niche or invented. */
  unverified: number;
  unverifiedNames: string[];
}

/** Question-clustered intervals for a slice. Computed only for finished runs. */
export interface ClusteredCI {
  rate: BootstrapCI | null;
  sov: BootstrapCI | null;
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
  /** Null when the run has no web-track citations (e.g. a parametric-only run). */
  citations: CitationReport | null;
  /** Null unless the battery included long-list questions. */
  census: CensusReport | null;
  /** Null while a run is still in progress — resampling is skipped during polling. */
  clustered: { overall: ClusteredCI; byTrack: Record<Track, ClusteredCI> } | null;
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

export interface ReportOptions {
  /** Run the question-clustered bootstrap (skip it while a run is still collecting). */
  bootstrap?: boolean;
  iterations?: number;
  /** The target's own website, for owned-source detection in the citation report. */
  brandDomain?: string | null;
  /** How many names the long-list questions asked for. */
  listTarget?: number;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Metrics for the long-list questions, kept apart from the buyer-question headline. */
export function censusReport(listRows: ScoredAnswer[], target: Target, competitors: string[], askedFor: number): CensusReport | null {
  const ok = listRows.filter((s) => s.ok);
  if (!ok.length) return null;
  const named = ok.filter((s) => s.mentioned);
  const lengths = ok.map((s) => s.ranked.length);
  const board = leaderboard(ok, target, competitors);
  const singles = board.filter((e) => e.mentions === 1 && !e.isTarget && !e.isCompetitor);
  return {
    answers: ok.length,
    askedFor,
    listedRate: named.length / ok.length,
    avgPosition: named.length ? named.reduce((a, s) => a + (s.rank ?? 0), 0) / named.length : null,
    top10Rate: ok.filter((s) => (s.rank ?? Infinity) <= 10).length / ok.length,
    avgListLength: lengths.reduce((a, b) => a + b, 0) / lengths.length,
    medianListLength: median(lengths),
    brands: board,
    unverified: singles.length,
    unverifiedNames: singles.slice(0, 12).map((e) => e.name),
  };
}

const byQuestionCluster = (s: ScoredAnswer) => s.input.questionIdx;

export function computeReport(rows: AnswerInput[], target: Target, competitors: string[] = [], opts: ReportOptions = {}): Report {
  // Variant folding sees every answer — more data makes the name map better.
  const variants = variantMap(rows, target);
  const all = rows.map((r) => rankAnswer(r, target, competitors, variants));

  // Long-list answers name ~50 brands each, so mixing them into the headline would
  // inflate the mention rate. Headline metrics use the buyer questions; the list
  // questions get their own census section.
  const listRows = all.filter((s) => s.input.kind === "list");
  const buyerRows = all.filter((s) => s.input.kind !== "list");
  // A battery of nothing but list questions still needs a headline, so fall back to them.
  const scored = buyerRows.length ? buyerRows : all;

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
  const pairedRows = scored.filter((s) => paired.has(s.input.model));
  const pPar = sliceMetrics(pairedRows.filter((s) => s.input.track === "parametric"));
  const pWeb = sliceMetrics(pairedRows.filter((s) => s.input.track === "web"));
  const iterations = opts.iterations;
  const trackGap: TrackGap = {
    pairedModels,
    parametric: pPar,
    web: pWeb,
    delta: pPar.rate !== null && pWeb.rate !== null ? pWeb.rate - pPar.rate : null,
    pValue: twoProportionP(pWeb.mentions, pWeb.n, pPar.mentions, pPar.n),
    bootstrap: opts.bootstrap
      ? bootstrapDiff(
          pairedRows,
          byQuestionCluster,
          (xs) => rateOf(xs.filter((s) => s.input.track === "web")),
          (xs) => rateOf(xs.filter((s) => s.input.track === "parametric")),
          { iterations },
        )
      : null,
    perModel: pairedModels.map((m) => {
      const par = byModelTrack[cellKey(m, "parametric")];
      const web = byModelTrack[cellKey(m, "web")];
      return { model: m, parametric: par, web, delta: par.rate !== null && web.rate !== null ? web.rate - par.rate : null };
    }),
  };

  const board = leaderboard(scored, target, competitors);

  const clusterFor = (xs: ScoredAnswer[]): ClusteredCI => ({
    rate: clusterBootstrap(xs, byQuestionCluster, rateOf, { iterations }),
    sov: clusterBootstrap(xs, byQuestionCluster, sovOf, { iterations }),
  });

  return {
    overall: sliceMetrics(scored),
    byModel,
    byTrack,
    byModelTrack,
    byQuestion,
    trackGap,
    leaderboard: board,
    fallbackMatches: scored.filter((s) => s.matchSource === "fallback").length,
    census: censusReport(listRows, target, competitors, opts.listTarget ?? 50),
    citations: citationReport(
      scored.map((s) => ({ ok: s.ok, track: s.input.track, mentioned: s.mentioned, citations: s.input.citations ?? null })),
      {
        brandDomain: opts.brandDomain,
        targetNames: targetTerms(target),
        explicitCompetitors: competitors,
        competitorNames: board.filter((e) => !e.isTarget && e.mentions > 0).map((e) => e.name),
      },
    ),
    clustered: opts.bootstrap
      ? {
          overall: clusterFor(scored),
          byTrack: {
            parametric: clusterFor(scored.filter((s) => s.input.track === "parametric")),
            web: clusterFor(scored.filter((s) => s.input.track === "web")),
          },
        }
      : null,
    // Every row, in input order, so callers can pair scores back to their source rows.
    scored: all,
  };
}

// ---------------------------------------------------------------------------
// Plain-language summaries
// ---------------------------------------------------------------------------

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
  // Prefer the question-clustered p-value; fall back to the unclustered z-test.
  const p = g.bootstrap?.p ?? g.pValue;
  const sig = p !== null && p < 0.05;
  const pa = g.parametric.avgPosition;
  const wa = g.web.avgPosition;
  const posShift = pa != null && wa != null && Math.abs(wa - pa) >= 0.5 ? ` When named, its average position moves from #${pa.toFixed(1)} from memory to #${wa.toFixed(1)} with web search.` : "";
  if (pts < 1) return `Web search doesn't change how often ${brand} is named (${pct(g.web.rate)} either way).${posShift || " Its position is stable too."}`;
  const dir = g.delta > 0 ? "rises" : "falls";
  const where = g.delta > 0 ? "live web results surface it more than training data does" : "training data favors it more than current web results do";
  return `With web search on, ${brand}'s mention rate ${dir} from ${pct(g.parametric.rate)} to ${pct(g.web.rate)} (${g.delta > 0 ? "+" : "−"}${pts} pts${sig ? "" : ", not statistically significant at this sample size"}): ${where}.${posShift}`;
}

/** One line on how the brand is cited, not just named. Null when there are no citations. */
export function citationInsight(report: Report, brand: string): string | null {
  const c = report.citations;
  if (!c || !c.withCitations) return null;
  const top = c.domains.slice(0, 3).map((d) => d.domain);
  const owned = c.citationRate ?? 0;
  const named = c.mentionRate ?? 0;
  const lead =
    owned === 0
      ? `When models search the web, they never cite ${brand}'s own site`
      : named === 0 && c.cross.citedNotNamed > 0
        ? `Models read ${brand}'s own site in ${c.cross.citedNotNamed} answer${c.cross.citedNotNamed === 1 ? "" : "s"} and still recommended someone else`
        : `${brand}'s own site is cited in ${pct(owned)} of web answers, while ${brand} is named in ${pct(named)}`;
  return `${lead}. The sources they lean on most: ${top.join(", ")}.`;
}
