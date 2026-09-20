import { z } from "zod";
import type { Question } from "./db";
import { chat, parseJsonObject } from "./openrouter";
import { leaksBrand, targetTerms, type Target } from "./match";

/**
 * Question slots in priority order — a battery of N uses the first N slots, so even
 * small batteries cover the core intents.
 */
export const SLOTS: { intent: string; guide: string }[] = [
  { intent: "Best overall", guide: "asks which option is best overall" },
  { intent: "Small team", guide: "is from a small team (2–10 people) choosing one" },
  { intent: "Alternatives", guide: "asks for alternatives to the single best-known market leader in the category, naming that leader" },
  { intent: "Enterprise", guide: "is at a large company with security, compliance, SSO or admin requirements" },
  { intent: "Budget", guide: "wants the best value — free or low-cost options" },
  { intent: "Shortlist", guide: "asks for a shortlist or side-by-side comparison of the top options (without naming any)" },
  { intent: "Beginner", guide: "is a beginner who wants something easy to learn" },
  { intent: "Use case", guide: "has one specific, realistic use case (pick a concrete job-to-be-done)" },
  { intent: "Best overall", guide: "asks what most people use or what the assistant would personally recommend" },
  { intent: "Use case", guide: "has a different specific use case or persona than any other question" },
];

const Out = z.object({ questions: z.array(z.object({ slot: z.number().int(), text: z.string().min(8) })) });

function prompt(category: string, slots: { n: number; intent: string; guide: string }[], avoid: string[]) {
  const lines = slots.map((s) => `${s.n}. [${s.intent}] — the asker ${s.guide}.`).join("\n");
  const avoidLine = avoid.length
    ? `\nNever mention any of these names, in any spelling: ${avoid.map((a) => `"${a}"`).join(", ")}. If one of them is the market leader, name a different well-known product for the Alternatives slot.`
    : "";
  return `Write realistic questions a person would type into an AI assistant while shopping for ${category}.

Write exactly one question per slot:
${lines}

Rules:
- Natural first-person buyer voice, one or two short sentences, varied phrasing. No numbering or quotes inside the text.
- Do not name any company, product, or brand — except the Alternatives slot, which names the market leader it wants alternatives to.
- Keep every question vendor-neutral so the assistant chooses what to recommend.${avoidLine}

Return only JSON: {"questions":[{"slot":<number>,"text":"<question>"}]}`;
}

async function ask(model: string, category: string, slots: { n: number; intent: string; guide: string }[], avoid: string[]) {
  const res = await chat({ model, messages: [{ role: "user", content: prompt(category, slots, avoid) }] }, { noCache: true });
  return Out.parse(parseJsonObject(res.text)).questions;
}

/**
 * Generate the battery. The first pass never sees the target brand — so the question
 * set can't be tilted toward or away from it. Any question that leaks the brand/alias
 * (checked in code) is regenerated once with an explicit exclusion list, then dropped.
 */
export async function generateQuestions(opts: { category: string; target: Target; count: number; model: string }) {
  const count = Math.max(1, Math.min(opts.count, SLOTS.length));
  const slots = SLOTS.slice(0, count).map((s, i) => ({ ...s, n: i + 1 }));
  const dropped: { text: string; reason: string }[] = [];
  const accepted = new Map<number, Question>();

  const take = (qs: { slot: number; text: string }[], pending: typeof slots) => {
    for (const q of qs) {
      const slot = pending.find((s) => s.n === q.slot);
      if (!slot || accepted.has(slot.n)) continue;
      const text = q.text.trim().replace(/^["“]|["”]$/g, "");
      const leak = leaksBrand(text, opts.target);
      if (leak) dropped.push({ text, reason: `names "${leak}"` });
      else if ([...accepted.values()].some((a) => a.text.toLowerCase() === text.toLowerCase())) dropped.push({ text, reason: "duplicate" });
      else accepted.set(slot.n, { text, intent: slot.intent });
    }
  };

  let first: { slot: number; text: string }[] = [];
  try {
    first = await ask(opts.model, opts.category, slots, []);
  } catch {
    first = await ask(opts.model, opts.category, slots, []); // one retry on bad JSON
  }
  take(first, slots);

  const missing = slots.filter((s) => !accepted.has(s.n));
  if (missing.length) {
    try {
      take(await ask(opts.model, opts.category, missing, targetTerms(opts.target)), missing);
    } catch {
      // leave missing slots dropped
    }
  }

  const questions = slots.filter((s) => accepted.has(s.n)).map((s) => accepted.get(s.n)!);
  return { questions, dropped };
}
