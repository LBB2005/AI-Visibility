import { Fragment } from "react";
import { highlightSpans, type Target } from "@/lib/scoring";

/** Renders text with every occurrence of the target brand/aliases marked in highlighter yellow. */
export function HighlightedText({ text, target }: { text: string; target: Target }) {
  const spans = highlightSpans(text, target);
  if (!spans.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  spans.forEach((s, i) => {
    if (s.start > at) out.push(<Fragment key={`t${i}`}>{text.slice(at, s.start)}</Fragment>);
    out.push(
      <mark key={`m${i}`} className="hl">
        {text.slice(s.start, s.end)}
      </mark>,
    );
    at = s.end;
  });
  if (at < text.length) out.push(<Fragment key="end">{text.slice(at)}</Fragment>);
  return <>{out}</>;
}

export function BrandMark({ children, swipe = false }: { children: React.ReactNode; swipe?: boolean }) {
  return <mark className={`hl ${swipe ? "hl-swipe" : ""}`}>{children}</mark>;
}
