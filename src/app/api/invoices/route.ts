import { NextResponse } from "next/server";
import { data } from "@/lib/data";

export const runtime = "nodejs";

// List issued invoices (newest first) for the Invoices page.
export async function GET() {
  try {
    const invoices = await data.listInvoices();
    return NextResponse.json({ invoices });
  } catch (err) {
    console.error("Failed to list invoices:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list invoices" },
      { status: 500 }
    );
  }
}
