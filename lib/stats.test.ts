import { describe, expect, it } from "vitest";
import { bootstrapDiff, clusterBootstrap, cohensKappa, mulberry32, percentile, positionWeight, prf1, twoProportionP, wilson } from "./stats";

describe("interval estimation", () => {
  it("wilson interval matches known values", () => {
    const [lo, hi] = wilson(5, 10)!;
    expect(lo).toBeCloseTo(0.2366, 3);
    expect(hi).toBeCloseTo(0.7634, 3);
    const [lo0, hi0] = wilson(0, 10)!;
    expect(lo0).toBe(0);
    expect(hi0).toBeCloseTo(0.2775, 3);
    expect(wilson(10, 10)![1]).toBe(1);
    expect(wilson(0, 0)).toBeNull();
  });
  it("position weights", () => {
    expect(positionWeight(1)).toBe(1);
    expect(positionWeight(3)).toBe(0.5);
    expect(positionWeight(2)).toBeCloseTo(0.6309, 4);
  });
  it("two-proportion p-value", () => {
    expect(twoProportionP(5, 10, 5, 10)).toBeCloseTo(1, 6);
    expect(twoProportionP(90, 100, 10, 100)!).toBeLessThan(0.001);
    expect(twoProportionP(1, 0, 1, 1)).toBeNull();
  });
  it("percentile interpolates", () => {
    expect(percentile([0, 1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([0, 10], 0.25)).toBe(2.5);
  });
});

describe("cluster bootstrap", () => {
  // 10 questions × 4 answers. Within a question every answer agrees, so all the
  // information is between clusters: n = 40 rows but only 10 independent units.
  const clustered = Array.from({ length: 10 }, (_, q) =>
    Array.from({ length: 4 }, () => ({ q, hit: q < 5 })),
  ).flat();
  const rate = (xs: { hit: boolean }[]) => (xs.length ? xs.filter((x) => x.hit).length / xs.length : null);

  it("is deterministic for a given seed and reproducible across calls", () => {
    const a = clusterBootstrap(clustered, (x) => x.q, rate);
    const b = clusterBootstrap(clustered, (x) => x.q, rate);
    expect(a).toEqual(b);
    expect(a!.point).toBe(0.5);
    expect(a!.clusters).toBe(10);
  });

  it("is wider than the naive interval when answers are correlated within a question", () => {
    const boot = clusterBootstrap(clustered, (x) => x.q, rate)!;
    const naive = wilson(20, 40)!;
    expect(boot.hi - boot.lo).toBeGreaterThan(naive[1] - naive[0]);
    expect(boot.lo).toBeLessThan(0.5);
    expect(boot.hi).toBeGreaterThan(0.5);
  });

  it("returns null when there is nothing to resample", () => {
    expect(clusterBootstrap([] as { q: number; hit: boolean }[], (x) => x.q, rate)).toBeNull();
    expect(clusterBootstrap([{ q: 1, hit: true }], (x) => x.q, rate)).toBeNull();
  });

  it("is stable across seeds (Monte-Carlo error stays small)", () => {
    const a = clusterBootstrap(clustered, (x) => x.q, rate, { seed: 1, iterations: 500 })!;
    const b = clusterBootstrap(clustered, (x) => x.q, rate, { seed: 2, iterations: 500 })!;
    expect(Math.abs(a.lo - b.lo)).toBeLessThan(0.15);
    expect(Math.abs(a.hi - b.hi)).toBeLessThan(0.15);
  });

  it("flags a degenerate interval when every resample is identical", () => {
    const allHit = Array.from({ length: 6 }, (_, q) => ({ q, hit: true }));
    const boot = clusterBootstrap(allHit, (x) => x.q, rate)!;
    expect(boot).toMatchObject({ point: 1, lo: 1, hi: 1, degenerate: true });
    const mixed = clusterBootstrap(clustered, (x) => x.q, rate)!;
    expect(mixed.degenerate).toBe(false);
  });

  it("mulberry32 is a stable seeded stream in [0,1)", () => {
    const r = mulberry32(42);
    const first = [r(), r(), r()];
    expect(first.every((x) => x >= 0 && x < 1)).toBe(true);
    const again = mulberry32(42);
    expect([again(), again(), again()]).toEqual(first);
  });
});

describe("bootstrapDiff", () => {
  const rows = Array.from({ length: 10 }, (_, q) => [
    { q, track: "web", hit: true },
    { q, track: "parametric", hit: q < 2 },
  ]).flat();
  const rate = (t: string) => (xs: typeof rows) => {
    const s = xs.filter((x) => x.track === t);
    return s.length ? s.filter((x) => x.hit).length / s.length : null;
  };

  it("reports the difference, an interval, and a two-sided p-value", () => {
    const d = bootstrapDiff(rows, (x) => x.q, rate("web"), rate("parametric"))!;
    expect(d.delta).toBeCloseTo(0.8);
    expect(d.lo).toBeGreaterThan(0);
    expect(d.p).toBeLessThan(0.05);
  });

  it("gives a large p-value when the tracks agree", () => {
    const same = rows.map((r) => ({ ...r, hit: true }));
    const d = bootstrapDiff(same, (x) => x.q, rate("web"), rate("parametric"))!;
    expect(d.delta).toBe(0);
    expect(d.p).toBe(1);
  });
});

describe("agreement metrics", () => {
  it("cohens kappa matches a hand-computed example", () => {
    // 20 items: 8 both true, 2 A-only, 2 B-only, 8 both false.
    const a = [...Array(8).fill(true), ...Array(2).fill(true), ...Array(2).fill(false), ...Array(8).fill(false)];
    const b = [...Array(8).fill(true), ...Array(2).fill(false), ...Array(2).fill(true), ...Array(8).fill(false)];
    const k = cohensKappa(a, b);
    expect(k.po).toBeCloseTo(0.8, 6);
    expect(k.pe).toBeCloseTo(0.5, 6);
    expect(k.kappa).toBeCloseTo(0.6, 6);
    expect(k.table).toEqual({ bothTrue: 8, aOnly: 2, bOnly: 2, bothFalse: 8 });
  });
  it("perfect agreement is 1, and a constant label leaves kappa undefined", () => {
    expect(cohensKappa([true, false, true], [true, false, true]).kappa).toBe(1);
    expect(cohensKappa([true, true], [true, true]).kappa).toBeNull();
    expect(cohensKappa([], []).kappa).toBeNull();
  });
  it("micro-averaged precision/recall/F1 over sets", () => {
    const pred = [new Set(["a", "b"]), new Set(["c"])];
    const gold = [new Set(["a"]), new Set(["c", "d"])];
    const r = prf1(pred, gold);
    expect(r).toMatchObject({ tp: 2, fp: 1, fn: 1 });
    expect(r.precision).toBeCloseTo(2 / 3, 6);
    expect(r.recall).toBeCloseTo(2 / 3, 6);
    expect(r.f1).toBeCloseTo(2 / 3, 6);
  });
});
