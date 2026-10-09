import { NextRequest, NextResponse } from "next/server";
import { notionProvider as data } from "@/lib/data/notion";

export const runtime = "nodejs";

// Re-issue the tool's own PDF for a wholesale ledger row (our UN/FY number on
// the face), moving the seller's original to "Original PDF".
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { pageId?: string };
    if (!body.pageId) {
      return NextResponse.json({ error: "pageId is required." }, { status: 400 });
    }
    const result = await data.regenerateWholesalePdf(body.pageId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("Wholesale PDF regenerate failed:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Regenerating the PDF failed",
      },
      { status: 500 }
    );
  }
}