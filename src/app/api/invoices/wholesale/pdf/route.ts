import { NextRequest, NextResponse } from "next/server";
import { notionProvider as data } from "@/lib/data/notion";

export const runtime = "nodejs";

// Notion attachment URLs expire after about an hour, so the list's cached
// pdfUrl can go stale. This resolves a fresh one at click time and redirects.
// `which=original` opens the seller's original PDF instead of our re-issued one.
export async function GET(request: NextRequest) {
  const pageId = request.nextUrl.searchParams.get("pageId");
  const which = request.nextUrl.searchParams.get("which");
  if (!pageId) {
    return NextResponse.json({ error: "pageId is required." }, { status: 400 });
  }
  try {
    const invoices = await data.listInvoices();
    const inv = invoices.find((i) => i.pageId === pageId);
    const url = which === "original" ? inv?.origPdfUrl : inv?.pdfUrl;
    if (!inv || !url) {
      return NextResponse.json(
        { error: "No PDF attached to this invoice." },
        { status: 404 }
      );
    }
    return NextResponse.redirect(url);
  } catch (err) {
    console.error("Wholesale PDF resolve failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to resolve PDF" },
      { status: 500 }
    );
  }
}