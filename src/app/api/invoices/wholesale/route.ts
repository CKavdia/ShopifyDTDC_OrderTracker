import { NextRequest, NextResponse } from "next/server";
import { notionProvider as data } from "@/lib/data/notion";
import { GST_STATE_CODES } from "@/lib/invoice/config";

export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 15 chars: 2-digit state code, 10-char PAN, entity digit, 'Z', checksum.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

// Body as sent by the confirm dialog. Every field re-validated here — the
// parsed values are untrusted suggestions the user may have edited.
interface WholesaleBody {
  invoiceDate: string;
  customerName: string;
  gstin: string;
  stateCode: string;
  hsn: string;
  quantity: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  grandTotal: number;
  reference: string;
  filename: string;
  pdfBase64: string;
}

function parseBody(body: unknown): WholesaleBody | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const num = (v: unknown) => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  };

  const parsed: WholesaleBody = {
    invoiceDate: str(b.invoiceDate),
    customerName: str(b.customerName),
    gstin: str(b.gstin).toUpperCase(),
    stateCode: str(b.stateCode).toUpperCase(),
    hsn: str(b.hsn),
    quantity: num(b.quantity),
    taxableValue: num(b.taxableValue),
    cgst: num(b.cgst),
    sgst: num(b.sgst),
    igst: num(b.igst),
    grandTotal: num(b.grandTotal),
    reference: str(b.reference).slice(0, 100),
    filename: str(b.filename).replace(/[\\/:*?"<>|]/g, "-").slice(0, 120),
    pdfBase64: typeof b.pdfBase64 === "string" ? b.pdfBase64 : "",
  };

  if (!DATE_RE.test(parsed.invoiceDate)) return "Invoice date must be a valid date.";
  if (!parsed.customerName) return "Customer name is required.";
  if (parsed.gstin && !GSTIN_RE.test(parsed.gstin))
    return "GSTIN must be 15 characters in the standard format.";
  if (!GST_STATE_CODES[parsed.stateCode]) return "Select a valid state.";
  if (parsed.hsn && !/^\d{4,8}$/.test(parsed.hsn))
    return "HSN/SAC must be 4–8 digits (or leave it blank).";
  if (
    [parsed.taxableValue, parsed.cgst, parsed.sgst, parsed.igst, parsed.grandTotal].some(
      (n) => !Number.isFinite(n) || n < 0
    )
  )
    return "Amounts cannot be negative.";
  if (Number.isFinite(parsed.quantity) && parsed.quantity < 0)
    return "Quantity cannot be negative.";
  if (!Number.isFinite(parsed.quantity)) parsed.quantity = 0;
  if (parsed.taxableValue <= 0) return "Taxable value must be greater than zero.";
  if (parsed.grandTotal <= 0) return "Grand total must be greater than zero.";
  if (
    Math.abs(parsed.cgst + parsed.sgst + parsed.igst - (parsed.grandTotal - parsed.taxableValue)) >
    2
  )
    return "GST heads must add up to (Grand total − Taxable value). Fix the amounts.";
  return parsed;
}

// Record a confirmed wholesale invoice. Assigns nothing itself — the row is
// created and the unfiled series is renumbered into date order inside the
// same lock, so the returned number is final.
export async function POST(request: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const input = parseBody(body);
    if (typeof input === "string") {
      return NextResponse.json({ error: input }, { status: 400 });
    }

    let pdf: { filename: string; data: Buffer } | undefined;
    if (input.pdfBase64) {
      const buf = Buffer.from(input.pdfBase64, "base64");
      if (buf.length === 0 || buf.length > 10 * 1024 * 1024) {
        return NextResponse.json({ error: "Attached PDF is too large." }, { status: 413 });
      }
      pdf = { filename: input.filename || "wholesale-invoice.pdf", data: buf };
    }

    const result = await data.createWholesaleInvoice(
      {
        invoiceDate: input.invoiceDate,
        customerName: input.customerName,
        gstin: input.gstin,
        stateCode: input.stateCode,
        hsn: input.hsn,
        quantity: input.quantity,
        taxableValue: input.taxableValue,
        cgst: input.cgst,
        sgst: input.sgst,
        igst: input.igst,
        grandTotal: input.grandTotal,
        reference: input.reference,
      },
      pdf
    );

    return NextResponse.json(result);
  } catch (err) {
    console.error("Wholesale invoice save failed:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Wholesale invoice save failed",
      },
      { status: 500 }
    );
  }
}

// Mark an invoice's GST return filed (or un-file it).
export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      pageId?: string;
      filed?: boolean;
    };
    if (!body.pageId) {
      return NextResponse.json({ error: "pageId is required." }, { status: 400 });
    }
    await data.setInvoiceFiled(body.pageId, body.filed !== false);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Filed flag update failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Update failed" },
      { status: 500 }
    );
  }
}