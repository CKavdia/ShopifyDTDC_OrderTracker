import { NextRequest, NextResponse } from "next/server";
import { buildGstr1Summary, renderGstr1Workbook } from "@/lib/invoice/gstr1.server";
import { data } from "@/lib/data";

// exceljs + Shopify fetching need the Node.js runtime (not Edge).
export const runtime = "nodejs";

// Store timezone (India). Boundaries interpreted in IST so a day covers the full
// local calendar day — matches the merged-PDF export route.
const TZ_OFFSET = "+05:30";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Download the GSTR-1 HSN-wise outward-supply summary for [start, end] as a
// formatted .xlsx (HSN Summary + Invoice Detail sheets). Read-only — does NOT
// mint invoice numbers. Iterates every paid order in the window, so a full
// quarter can take a little while.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start") || "";
    const end = searchParams.get("end") || "";

    if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
      return NextResponse.json(
        { error: "start and end must be YYYY-MM-DD dates." },
        { status: 400 }
      );
    }
    if (start > end) {
      return NextResponse.json(
        { error: "start date must be on or before end date." },
        { status: 400 }
      );
    }

    const startISO = `${start}T00:00:00${TZ_OFFSET}`;
    const endISO = `${end}T23:59:59${TZ_OFFSET}`;

    // Match the invoice PDFs' COD-fee setting so the filed summary mirrors them.
    const hideCodFee = await data.getInvoiceHideCodFee();
    const summary = await buildGstr1Summary(startISO, endISO, { hideCodFee });
    if (summary.rows.length === 0) {
      return NextResponse.json(
        { error: "No paid orders or wholesale invoices found in this range." },
        { status: 404 }
      );
    }

    const buf = await renderGstr1Workbook(summary);
    const filename = `GSTR1-HSN-Summary-${start}-to-${end}.xlsx`;

    return new NextResponse(Buffer.from(buf), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("GSTR-1 HSN summary export failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "GSTR-1 export failed" },
      { status: 500 }
    );
  }
}
