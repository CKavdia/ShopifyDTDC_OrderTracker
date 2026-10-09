import { NextRequest, NextResponse } from "next/server";
import { notionProvider as data } from "@/lib/data/notion";

export const runtime = "nodejs";

// Attach (or replace) the original PDF on an existing wholesale ledger row —
// for rows whose upload-time attachment failed. Nothing else changes: numbers,
// dates and totals stay as they are.
export async function POST(request: NextRequest) {
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json(
        { error: "Expected a multipart form (pageId + file)." },
        { status: 400 }
      );
    }

    const pageId = form.get("pageId");
    const file = form.get("file");
    if (typeof pageId !== "string" || !pageId) {
      return NextResponse.json({ error: "pageId is required." }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Attach a PDF file." }, { status: 400 });
    }
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "PDF is larger than 10 MB." },
        { status: 413 }
      );
    }

    await data.attachWholesalePdf(
      pageId,
      file.name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120) || "wholesale-invoice.pdf",
      Buffer.from(await file.arrayBuffer())
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Wholesale PDF attach failed:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Attaching the PDF failed",
      },
      { status: 500 }
    );
  }
}