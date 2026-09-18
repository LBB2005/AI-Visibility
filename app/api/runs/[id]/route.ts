import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isActive, processRun } from "@/lib/pipeline";
import { buildPayload } from "@/lib/report";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const withRows = new URL(req.url).searchParams.get("rows") === "1";
  const payload = buildPayload(id, withRows);
  if (!payload) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json(payload);
}

/** { action: "resume" } — continue an interrupted run; { action: "retry-failed" } — requeue failed rows. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  if (!buildPayload(id, false)) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (isActive(id)) return NextResponse.json({ ok: true, alreadyRunning: true });
  if (action === "retry-failed") {
    db().prepare("UPDATE answers SET status = 'pending', failed_stage = NULL, error = NULL WHERE run_id = ? AND status = 'failed'").run(id);
  } else if (action !== "resume") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  void processRun(id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (isActive(id)) return NextResponse.json({ error: "Run is in progress" }, { status: 409 });
  db().prepare("DELETE FROM runs WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
