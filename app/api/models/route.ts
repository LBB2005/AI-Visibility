import { NextResponse } from "next/server";
import { fetchCatalog, isWebNative, pickDefault, pickExtractor, PROVIDERS, toRunModel } from "@/lib/models";

/** Current model catalog (text models from the four providers) + default picks. */
export async function GET() {
  try {
    const catalog = await fetchCatalog();
    const providers = PROVIDERS.map((p) => p.provider);
    const models = catalog
      .filter((m) => providers.some((p) => m.id.startsWith(p + "/")) && !/(:batch|:free)/.test(m.id))
      .sort((a, b) => b.created - a.created)
      .map((m) => ({ ...toRunModel(m), promptPrice: m.promptPrice, completionPrice: m.completionPrice, webSearchPrice: m.webSearchPrice, webNative: isWebNative(m.id) }));
    const defaults = PROVIDERS.map((p) => pickDefault(catalog, p.provider)?.id).filter(Boolean) as string[];
    const extractor = pickExtractor(catalog);
    return NextResponse.json({
      models,
      defaults,
      extractor: extractor && { id: extractor.id, promptPrice: extractor.promptPrice, completionPrice: extractor.completionPrice, webSearchPrice: 0, webNative: false },
      hasKey: !!process.env.OPENROUTER_API_KEY,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
