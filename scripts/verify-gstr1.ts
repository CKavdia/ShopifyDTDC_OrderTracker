import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "fs";

async function main() {
  const parseMod = await import("../src/lib/invoice/parse");
  const m = await import("../src/lib/data");
  // Spot-check: largest qty row (00097 = 50 pieces)
  const inv = (await m.data.listInvoices()).find((i) => i.invoiceNo === "UN/2026-27/00097");
  const buf = Buffer.from(await (await fetch(inv!.origPdfUrl)).arrayBuffer());
  const spot = await parseMod.parseInvoicePdf(buf);
  const totalLine = (spot as unknown as { __x?: never }) && null; // placeholder
  console.log("spot 00097 parsed qty:", spot.totalQty);

  // GSTR1 summary for Jul-Sep
  const g = await import("../src/lib/invoice/gstr1.server");
  const s = await g.buildGstr1Summary("2026-07-01T00:00:00+05:30", "2026-09-30T23:59:59+05:30");
  console.log("wholesaleCount:", s.meta.wholesaleCount);
  console.log("grand qty:", s.grand.qty, "| goods qty:", s.goodsTotal.qty);
  const wdetail = s.detail.filter((r) => r.product.startsWith("Wholesale"));
  const wsum = wdetail.reduce((a, r) => a + Number(r.qty), 0);
  console.log("wholesale detail rows:", wdetail.length, "qty sum:", wsum);
  writeFileSync("verify-gstr1.txt", wdetail.map((r) => `${r.order} | ${r.date} | hsn=${r.hsn} | qty=${r.qty}`).join("\n"), "utf8");
}
main().catch((e) => { console.error(e); process.exit(1); });
