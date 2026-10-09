import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const m = await import("../src/lib/data");
  const { PDFParse } = await import("pdf-parse");
  const nos = process.argv.slice(2);
  for (const no of nos) {
    const inv = (await m.data.listInvoices()).find((i) => i.invoiceNo.endsWith(no));
    if (!inv?.origPdfUrl) { console.log(no, "no pdf"); continue; }
    const buf = Buffer.from(await (await fetch(inv.origPdfUrl)).arrayBuffer());
    const p = new PDFParse({ data: new Uint8Array(buf) });
    const res = await p.getText();
    await p.destroy();
    require("fs").writeFileSync(`pdf-text-${no}.txt`, res.text || "", "utf8");
    console.log(no, "pages~", (res.text || "").match(/Page \d+ of \d+/g)?.slice(-1) || "1", "chars", (res.text || "").length);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
