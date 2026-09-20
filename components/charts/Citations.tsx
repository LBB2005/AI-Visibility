"use client";

import { useState } from "react";
import { CATEGORY_LABELS, type CitationReport, type SourceCategory } from "@/lib/citations";
import { pct, pts } from "@/lib/format";

const TOP = 12;

/**
 * Where the models' web answers came from: which sites they lean on, whether those
 * sites are yours, a competitor's or a third party's, and whether citing a given
 * source goes with the brand being recommended.
 */
export function CitationSources({ report, brand }: { report: CitationReport; brand: string }) {
  const [all, setAll] = useState(false);
  const domains = all ? report.domains : report.domains.slice(0, TOP);
  const max = report.domains[0]?.answers ?? 1;
  const c = report.cross;
  const named = c.namedAndCited + c.namedNotCited;
  const cited = c.namedAndCited + c.citedNotNamed;

  return (
    <div className="grid gap-10 lg:grid-cols-[1.5fr_1fr] items-start">
      {/* Top sources */}
      <div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left label">
              <th className="font-normal pb-2">Source</th>
              <th className="font-normal pb-2 w-24 text-right">Answers</th>
              <th className="font-normal pb-2 w-28 text-right">Names {brand}</th>
              <th className="font-normal pb-2 w-24 text-right">Lift</th>
            </tr>
          </thead>
          <tbody>
            {domains.map((d) => (
              <tr key={d.domain} className="rule-top align-middle">
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <span className={d.category === "owned" ? "hl" : ""}>{d.domain}</span>
                    <span className="chip">{CATEGORY_LABELS[d.category]}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full" style={{ width: `${(d.answers / max) * 100}%`, background: d.category === "owned" ? "var(--hl)" : "var(--bar)" }} />
                </td>
                <td className="num text-right tabular-nums">
                  {d.answers}
                  <span className="text-ink-3"> · {pct(d.share)}</span>
                </td>
                <td className="num text-right">{pct(d.targetRate)}</td>
                <td className="num text-right" title={d.lift === null ? "Fewer than 5 answers cite this source — too few to compare." : undefined}>
                  {d.lift === null ? <span className="text-ink-3">—</span> : pts(d.lift)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex items-center gap-4 text-xs text-ink-3">
          {report.domains.length > TOP && (
            <button className="link" onClick={() => setAll((v) => !v)}>
              {all ? `Show top ${TOP}` : `Show all ${report.domains.length} sources`}
            </button>
          )}
          {report.unresolved > 0 && <span>{report.unresolved} citation(s) came through a redirect with no readable domain and are excluded.</span>}
          <span>
            Lift compares {brand}&apos;s mention rate in answers citing a source against answers that don&apos;t. It&apos;s a correlation, not proof the source caused
            the mention.
          </span>
        </div>
      </div>

      {/* Named vs cited + category mix */}
      <div>
        <h3 className="text-sm font-medium">Named or cited?</h3>
        <p className="text-xs text-ink-3 mt-1">
          Being recommended in the text is not the same as having your site used as a source. {report.withCitations} answers came with citations.
        </p>
        <table className="w-full mt-3 text-sm">
          <thead>
            <tr>
              <th />
              <th className="label font-normal text-right pb-1">Cites your site</th>
              <th className="label font-normal text-right pb-1">Doesn&apos;t</th>
            </tr>
          </thead>
          <tbody>
            <tr className="rule-top">
              <td className="py-2">Names {brand}</td>
              <td className="num text-right">{c.namedAndCited}</td>
              <td className="num text-right">{c.namedNotCited}</td>
            </tr>
            <tr className="rule-top">
              <td className="py-2 text-ink-2">Doesn&apos;t</td>
              <td className="num text-right">{c.citedNotNamed}</td>
              <td className="num text-right text-ink-3">{c.neither}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-xs text-ink-3">
          Named in {pct(named / report.withCitations)} of citing answers, cited in {pct(cited / report.withCitations)}.
        </p>

        <h3 className="text-sm font-medium mt-8">What kind of sources</h3>
        <ul className="mt-3 space-y-2">
          {report.byCategory.map((cat) => (
            <li key={cat.category}>
              <div className="flex justify-between text-sm">
                <span>{CATEGORY_LABELS[cat.category as SourceCategory]}</span>
                <span className="num text-ink-2">{pct(cat.share)}</span>
              </div>
              <div
                className="mt-1 h-2 rounded-full"
                style={{ width: `${cat.share * 100}%`, background: cat.category === "owned" ? "var(--hl)" : "var(--bar)", minWidth: "2px" }}
              />
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-3">Each answer counts once per category, so the shares can add to more than 100%.</p>
      </div>
    </div>
  );
}
