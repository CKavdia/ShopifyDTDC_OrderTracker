import { NextRequest, NextResponse } from "next/server";
import { parseInvoicePdf } from "@/lib/invoice/parse";

export const runtime = "nodejs";

// Parse an uploaded wholesale invoice PDF and return the extracted fields for
// confirmation. Saves nothing — the confirmed values go to /api/invoices/wholesale.
export async function POST(request: NextRequest) {
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json(
        { error: "Expected a multipart form with a PDF file." },
        { status: 400 }
      );
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Attach a PDF file." }, { status: 400 });
    }
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "PDF is larger than 10 MB." },
        { status: 413 }
      );
    }
    const data = Buffer.from(await file.arrayBuffer());
    if (data.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return NextResponse.json(
        { error: "That file is not a PDF." },
        { status: 400 }
      );
    }

    const parsed = await parseInvoicePdf(data);
    return NextResponse.json({ parsed, filename: file.name });
  } catch (err) {
    console.error("Wholesale invoice parse failed:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Could not read that PDF. If it is a scanned image, type the details manually.",
      },
      { status: 500 }
    );
  }
}