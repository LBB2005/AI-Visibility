import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchCatalog, pickDefault, pickExtractor } from "@/lib/models";
import { generateQuestions } from "@/lib/questions";

const Body = z.object({
  brand: z.string().trim().min(1),
  aliases: z.array(z.string()).default([]),
  category: z.string().trim().min(2),
  count: z.number().int().min(1).max(10).default(10),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Brand and category are required." }, { status: 400 });
  const { brand, aliases, category, count } = parsed.data;
  try {
    const catalog = await fetchCatalog();
    const model = (pickDefault(catalog, "anthropic") ?? pickExtractor(catalog))!.id;
    const out = await generateQuestions({ category, target: { brand, aliases }, count, model });
    return NextResponse.json({ ...out, generator: model });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
