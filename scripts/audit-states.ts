// Buyer-state audit: pull the buyer's "State Name ... Code : NN" (last one on
// the page = buyer block) from each wholesale row's original PDF and check the
// ledger tax heads against it (08 = intra → CGST+SGST; else → IGST).
import { config } from "dotenv";
config({ path: ".env.local" });
import path from "path";
import { pathToFileURL } from "url";
import { PDFParse } from "pdf-parse";

const API = "https://api.notion.com/v1";
const H = () => ({
  Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
});

let workerReady = false;
function ensurePdfWorker() {
  if (workerReady) return;
  PDFParse.setWorker(
    pathToFileURL(
      path.join(process.cwd(), "node_modules/pdf-parse/dist/pdf-parse/cjs/pdf.worker.mjs")
    ).href
  );
  workerReady = true;
}

const STATE_OF_CODE: Record<string, string> = {
  "01": "J&K", "02": "HP", "03": "PB", "04": "CH", "05": "UK", "06": "HR",
  "07": "DL", "08": "RJ", "09": "UP", "10": "BR", "19": "WB", "21": "OD",
  "22": "CG", "23": "MP", "24": "GJ", "27": "MH", "29": "KA", "30": "GO",
  "32": "KL", "33": "TN", "36": "TG", "37": "AP", "11": "SK",
};

async function main() {
  ensurePdfWorker();
  const pageId = process.env.NOTION_PAGE_ID!;
  const blocks = await (
    await fetch(`${API}/blocks/${pageId}/children?page_size=100`, { headers: H() })
  ).json();
  const db = blocks.results?.find(
    (b: { type: string; child_database?: { title: string } }) =>
      b.type === "child_database" && b.child_database?.title === "UrbanNaari Invoices"
  );
  if (!db) throw new Error("Invoices DB not found");
  const res = await fetch(`${API}/databases/${db.id}/query`, {
    method: "POST",
    headers: H(),
    body: JSON.stringify({ filter: { property: "Type", select: { equals: "Wholesale" } } }),
  });
  const rows = (await res.json()).results || [];
  for (const row of rows) {
    const props = row.properties;
    const title = props["Invoice No"]?.title?.[0]?.plain_text || "";
    const num = (k: string) => (props[k] as { number?: number | null })?.number ?? 0;
    const url =
      (props["Original PDF"]?.files || []).map((f: { file?: { url?: string } }) => f.file?.url || "").find(Boolean) ||
      (props["Invoice PDF"]?.files || []).map((f: { file?: { url?: string } }) => f.file?.url || "").find(Boolean) || "";
    if (!url) {
      console.log(`${title} | no PDF`);
      continue;
    }
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const { text } = await new PDFParse({ data: new Uint8Array(buf) }).getText();
    const matches = [...text.matchAll(/State Name\s*:?\s*([A-Za-z .&-]+?),?\s*Code\s*:?\s*(\d{2})/g)];
    const last = matches[matches.length - 1];
    const buyerCode = last ? last[2] : "??";
    const buyerState = last ? last[1].trim() : "??";
    const c = num("CGST"), s = num("SGST"), i = num("IGST");
    const expectIntra = buyerCode === "08";
    const headsOk = expectIntra ? c + s > 0 && i === 0 : i > 0 && c === 0 && s === 0;
    console.log(
      `${title} | buyer: ${buyerState} (${buyerCode}) ${expectIntra ? "intra" : "INTER"} | ledger c=${c} s=${s} i=${i} ${headsOk ? "OK" : "** MISMATCH **"}`
    );
  }
}

main().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});