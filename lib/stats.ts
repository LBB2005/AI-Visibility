/**
 * Statistics: interval estimation, clustered resampling, and agreement metrics.
 * Pure, deterministic (all randomness is seeded), and unit-tested.
 */

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

/**
 * Two-sided p-value for a difference of two proportions (pooled z-test).
 * Assumes independent draws — see `bootstrapDiff` for the clustered version.
 */
export function twoProportionP(k1: number, n1: number, k2: number, n2: number): number | null {
  if (n1 === 0 || n2 === 0) return null;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return k1 / n1 === k2 / n2 ? 1 : 0;
  const z = (k1 / n1 - k2 / n2) / se;
  return 2 * (1 - normCdf(Math.abs(z)));
}

// ---------------------------------------------------------------------------
// Cluster bootstrap
// ---------------------------------------------------------------------------

/** Small, fast, seeded PRNG so every bootstrap is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile of an already-sorted array, by linear interpolation. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export interface BootstrapCI {
  point: number;
  lo: number;
  hi: number;
  iterations: number;
  /** Number of clusters resampled — the effective sample size for this interval. */
  clusters: number;
  /**
   * Every resample produced the same value, so the interval has zero width. This happens
   * at 0% and 100%: it is arithmetically correct but says nothing about uncertainty, so
   * callers should report the cluster count instead of a fake ±0 bracket.
   */
  degenerate: boolean;
}

export interface BootstrapOpts {
  iterations?: number;
  seed?: number;
  alpha?: number;
}

function clusterize<T>(items: T[], clusterOf: (x: T) => string | number): T[][] {
  const groups = new Map<string, T[]>();
  for (const x of items) {
    const k = String(clusterOf(x));
    const arr = groups.get(k);
    if (arr) arr.push(x);
    else groups.set(k, [x]);
  }
  return [...groups.values()];
}

/**
 * Percentile cluster bootstrap: resample whole clusters (for us, questions) with
 * replacement, recompute the statistic, and take percentiles of the resampled
 * distribution. Answers to the same question are correlated, so resampling rows
 * independently would understate the uncertainty.
 *
 * See Miller 2024 (arXiv:2411.00640) on clustered standard errors in LLM evals.
 */
export function clusterBootstrap<T>(
  items: T[],
  clusterOf: (x: T) => string | number,
  statistic: (xs: T[]) => number | null,
  opts: BootstrapOpts = {},
): BootstrapCI | null {
  const { iterations = 2000, seed = 42, alpha = 0.05 } = opts;
  const point = statistic(items);
  if (point === null || !items.length) return null;
  const clusters = clusterize(items, clusterOf);
  if (clusters.length < 2) return null; // one cluster carries no between-cluster information

  const rand = mulberry32(seed);
  const draws: number[] = [];
  const buf: T[] = [];
  for (let i = 0; i < iterations; i++) {
    buf.length = 0;
    for (let c = 0; c < clusters.length; c++) {
      const picked = clusters[Math.floor(rand() * clusters.length)];
      for (const item of picked) buf.push(item);
    }
    const s = statistic(buf);
    if (s !== null && Number.isFinite(s)) draws.push(s);
  }
  if (draws.length < iterations / 2) return null;
  draws.sort((a, b) => a - b);
  const lo = percentile(draws, alpha / 2);
  const hi = percentile(draws, 1 - alpha / 2);
  return { point, lo, hi, iterations: draws.length, clusters: clusters.length, degenerate: draws[0] === draws[draws.length - 1] };
}

export interface BootstrapDiff {
  delta: number;
  lo: number;
  hi: number;
  /** Two-sided bootstrap p-value for H0: delta = 0. */
  p: number;
  iterations: number;
  clusters: number;
}

/**
 * Cluster bootstrap for a difference of two statistics computed on the same
 * resampled clusters (e.g. web mention rate − parametric mention rate, where both
 * tracks answer the same questions). The p-value is the standard two-sided
 * percentile-bootstrap value: twice the smaller tail mass on either side of zero.
 */
export function bootstrapDiff<T>(
  items: T[],
  clusterOf: (x: T) => string | number,
  statA: (xs: T[]) => number | null,
  statB: (xs: T[]) => number | null,
  opts: BootstrapOpts = {},
): BootstrapDiff | null {
  const { iterations = 2000, seed = 42, alpha = 0.05 } = opts;
  const a0 = statA(items);
  const b0 = statB(items);
  if (a0 === null || b0 === null) return null;
  const clusters = clusterize(items, clusterOf);
  if (clusters.length < 2) return null;

  const rand = mulberry32(seed);
  const draws: number[] = [];
  const buf: T[] = [];
  for (let i = 0; i < iterations; i++) {
    buf.length = 0;
    for (let c = 0; c < clusters.length; c++) {
      const picked = clusters[Math.floor(rand() * clusters.length)];
      for (const item of picked) buf.push(item);
    }
    const a = statA(buf);
    const b = statB(buf);
    if (a !== null && b !== null && Number.isFinite(a - b)) draws.push(a - b);
  }
  if (draws.length < iterations / 2) return null;
  draws.sort((x, y) => x - y);
  const below = draws.filter((d) => d <= 0).length / draws.length;
  const above = draws.filter((d) => d >= 0).length / draws.length;
  return {
    delta: a0 - b0,
    lo: percentile(draws, alpha / 2),
    hi: percentile(draws, 1 - alpha / 2),
    p: Math.min(1, 2 * Math.min(below, above)),
    iterations: draws.length,
    clusters: clusters.length,
  };
}

// ---------------------------------------------------------------------------
// Agreement metrics (extractor validation)
// ---------------------------------------------------------------------------

export interface Kappa {
  kappa: number | null;
  /** Observed agreement. */
  po: number;
  /** Agreement expected by chance. */
  pe: number;
  n: number;
  /** Confusion counts: both true, rater A only, rater B only, both false. */
  table: { bothTrue: number; aOnly: number; bOnly: number; bothFalse: number };
}

/**
 * Cohen's kappa for two raters on a binary decision (Cohen 1960).
 * kappa is null when both raters give a single constant label, where kappa is undefined.
 */
export function cohensKappa(a: boolean[], b: boolean[]): Kappa {
  const n = Math.min(a.length, b.length);
  const t = { bothTrue: 0, aOnly: 0, bOnly: 0, bothFalse: 0 };
  for (let i = 0; i < n; i++) {
    if (a[i] && b[i]) t.bothTrue++;
    else if (a[i]) t.aOnly++;
    else if (b[i]) t.bOnly++;
    else t.bothFalse++;
  }
  if (!n) return { kappa: null, po: 0, pe: 0, n: 0, table: t };
  const po = (t.bothTrue + t.bothFalse) / n;
  const aTrue = (t.bothTrue + t.aOnly) / n;
  const bTrue = (t.bothTrue + t.bOnly) / n;
  const pe = aTrue * bTrue + (1 - aTrue) * (1 - bTrue);
  return { kappa: pe === 1 ? null : (po - pe) / (1 - pe), po, pe, n, table: t };
}

export interface PRF1 {
  precision: number | null;
  recall: number | null;
  f1: number | null;
  tp: number;
  fp: number;
  fn: number;
}

/** Micro-averaged precision/recall/F1 over paired sets (predicted vs. gold). */
export function prf1(predicted: Set<string>[], gold: Set<string>[]): PRF1 {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < Math.min(predicted.length, gold.length); i++) {
    for (const p of predicted[i]) {
      if (gold[i].has(p)) tp++;
      else fp++;
    }
    for (const g of gold[i]) if (!predicted[i].has(g)) fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { precision, recall, f1, tp, fp, fn };
}
