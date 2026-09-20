"use client";

import { pct } from "@/lib/format";
import type { CensusReport } from "@/lib/scoring";
import { Leaderboard } from "./Leaderboard";

/**
 * The long-list view. Asking for 50 names measures recall, not recommendation: almost
 * every real brand appears somewhere in a list that long, so the signal is how deep the
 * brand sits and how often it reaches the top ten.
 */
export function Census({ census, brand }: { census: CensusReport; brand: string }) {
  const shortfall = census.avgListLength !== null && census.avgListLength < census.askedFor * 0.9;
  return (
    <div>
      <dl className="grid grid-cols-2 md:grid-cols-4 rule-top rule-bottom">
        <Stat label={`Named at all`} value={pct(census.listedRate)} sub={`in ${census.answers} long-list answers`} first />
        <Stat
          label="Average rank in the list"
          value={census.avgPosition ? `#${census.avgPosition.toFixed(1)}` : "—"}
          sub={census.avgPosition ? "position when named" : "never named"}
        />
        <Stat label="Reaches the top 10" value={pct(census.top10Rate)} sub="share of lists placing it in the first ten" />
        <Stat
          label="Names models produced"
          value={census.avgListLength ? census.avgListLength.toFixed(0) : "—"}
          sub={`on average, of ${census.askedFor} asked for${census.medianListLength ? ` · median ${census.medianListLength}` : ""}`}
        />
      </dl>

      {shortfall && (
        <p className="mt-3 text-xs text-ink-3">
          Models asked for {census.askedFor} names returned {census.avgListLength?.toFixed(0)} on average. The shortfall is reported rather than padded — it is
          itself a measure of how deep a category a model can recall.
        </p>
      )}

      <div className="mt-8">
        <h3 className="text-sm font-medium">The category as models see it</h3>
        <p className="text-xs text-ink-3 mt-1 max-w-[62ch]">
          Every brand named across the long lists. In lists this long the well-known names all reach 100%, so the ordering that matters is average rank — the table
          shows it. {brand} is highlighted.
        </p>
        <div className="mt-4">
          <Leaderboard entries={census.brands} n={census.answers} defaultTable />
        </div>
      </div>

      {census.unverified > 0 && (
        <p className="mt-4 text-xs text-ink-3 max-w-[70ch]">
          <strong className="text-ink-2">{census.unverified} brands appeared in only one of {census.answers} lists</strong> — either genuinely niche or invented by
          the model. Treat single-appearance names as unverified: {census.unverifiedNames.join(", ")}
          {census.unverified > census.unverifiedNames.length ? ", …" : ""}.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, sub, first }: { label: string; value: string; sub: string; first?: boolean }) {
  return (
    <div className={`py-5 pr-4 ${first ? "" : "md:pl-6 md:border-l border-[var(--rule)]"}`}>
      <dt className="label">{label}</dt>
      <dd className="display text-[38px] leading-none mt-2">{value}</dd>
      <dd className="text-xs mt-2 text-ink-3">{sub}</dd>
    </div>
  );
}
