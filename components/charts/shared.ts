import type { RunModel } from "@/lib/db";
import { pct } from "@/lib/format";
import type { LeaderboardEntry, SliceMetrics } from "@/lib/scoring";

/** "31%–58%" for any metric carrying a 95% interval. */
export const ci = (m: SliceMetrics | LeaderboardEntry) => (m.ci ? `${pct(m.ci[0])}\u2013${pct(m.ci[1])}` : "\u2014");

/** Model label without the provider prefix ("Claude \u00b7 Sonnet 5" \u2192 "Sonnet 5"). */
export const shortName = (m: RunModel) => m.label.split(" \u00b7 ").slice(1).join(" \u00b7 ") || m.id;
