import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const m = await import("../src/lib/data");
  const row = (await m.data.listInvoices()).find((i) => i.invoiceNo === "UN/2026-27/00129");
  if (!row?.origPdfUrl) throw new Error("no orig pdf");
  const buf = Buffer.from(await (await fetch(row.origPdfUrl)).arrayBuffer());
  // use PDFParse directly like parse.ts
  const { PDFParse } = await import("pdf-parse");
  const p = new PDFParse({ data: new Uint8Array(buf) });
  const res = await p.getText();
  await p.destroy();
  require("fs").writeFileSync("pdf-text-129.txt", res.text || "", "utf8");
  console.log((res.text || "").slice(0, 3000));
}
main().catch((e) => { console.error(e); process.exit(1); });
