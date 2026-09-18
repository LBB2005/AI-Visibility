// Milestone B smoke test: pick models from /models, generate 2 questions, ask one
// question on one model in both tracks, extract brands, score.
import { fetchCatalog, pickDefault, pickExtractor, PROVIDERS } from "../lib/models";
import { generateQuestions } from "../lib/questions";
import { chat } from "../lib/openrouter";
import { extractBrands } from "../lib/extract";
import { rankAnswer } from "../lib/scoring";

async function main() {
  const cat = await fetchCatalog();
  for (const p of PROVIDERS) console.log("default", p.label.padEnd(10), pickDefault(cat, p.provider)?.id);
  const extractor = pickExtractor(cat)!;
  console.log("extractor ", extractor.id);
  const target = { brand: "Notion" };
  const gen = await generateQuestions({ category: "note-taking apps", target, count: 3, model: pickDefault(cat, "anthropic")!.id });
  console.log("questions", gen);
  const q = gen.questions[0].text;
  const model = pickDefault(cat, "openai")!.id;
  for (const track of ["parametric", "web"] as const) {
    const res = await chat({ model, messages: [{ role: "user", content: q }], ...(track === "web" ? { plugins: [{ id: "web", max_results: 5 }] } : {}) }, { cacheSalt: "smoke" });
    const ex = await extractBrands(res.text, extractor.id);
    const s = rankAnswer({ questionIdx: 0, question: q, model, track, sample: 1, status: "ok", answer: res.text, brands: ex.brands }, target);
    console.log(`\n== ${track} | ${res.model} | cost ${res.cost} | cached ${res.cached} | ${res.latencyMs}ms | citations ${res.citations.length}`);
    console.log(res.text.slice(0, 400).replace(/\n+/g, " "), "…");
    console.log("ranked:", s.ranked.map((r) => `${r.rank}.${r.name}${r.isTarget ? "*" : ""}`).join(", "), "| mentioned:", s.mentioned, s.matchSource);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
