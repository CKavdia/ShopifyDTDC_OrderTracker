import { NextRequest, NextResponse } from "next/server";
import { data } from "@/lib/data";
import { financialYear } from "@/lib/invoice/numbering";

export const runtime = "nodejs";

// GET ?fy=2026-27 -> the FY's configured start number + the highest sequence
// already issued (so the UI can validate), plus the global display flags.
// Defaults to the current FY.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const fy = searchParams.get("fy") || financialYear();
    const [startNumber, currentMaxSeq, hideCodFee] = await Promise.all([
      data.getInvoiceStartNumber(fy),
      data.getMaxInvoiceSequence(fy),
      data.getInvoiceHideCodFee(),
    ]);
    return NextResponse.json({ fy, startNumber, currentMaxSeq, hideCodFee });
  } catch (err) {
    console.error("Failed to load invoice settings:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load invoice settings" },
      { status: 500 }
    );
  }
}

// POST { fy?, startNumber } -> set the FY's starting number. Rejects a floor at
// or below an already-issued sequence (would risk duplicate invoice numbers).
// POST { hideCodFee } (no startNumber) -> flip the COD-fee display flag.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Display flag update only.
    if (typeof body.hideCodFee === "boolean") {
      await data.setInvoiceHideCodFee(body.hideCodFee);
      return NextResponse.json({ hideCodFee: body.hideCodFee });
    }

    const fy: string = body.fy || financialYear();
    const startNumber = Number(body.startNumber);

    if (!Number.isInteger(startNumber) || startNumber < 1) {
      return NextResponse.json(
        { error: "Starting number must be a positive whole number." },
        { status: 400 }
      );
    }

    const currentMaxSeq = await data.getMaxInvoiceSequence(fy);
    if (startNumber <= currentMaxSeq) {
      return NextResponse.json(
        {
          error: `FY ${fy} already has invoices up to #${currentMaxSeq}. The starting number must be greater than ${currentMaxSeq}.`,
        },
        { status: 400 }
      );
    }

    await data.setInvoiceStartNumber(fy, startNumber);
    return NextResponse.json({ fy, startNumber, currentMaxSeq });
  } catch (err) {
    console.error("Failed to save invoice settings:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save invoice settings" },
      { status: 500 }
    );
  }
}
