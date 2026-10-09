// Compare each wholesale row's ledger tax heads with the tax heads parsed
// from its attached original PDF.
import { config } from "dotenv";
config({ path: ".env.local" });
import { parseInvoicePdf } from "../src/lib/invoice/parse";

const API = "https://api.notion.com/v1";
const H = () => ({
  Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
});

async function main() {
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
    const text = (k: string) =>
      (props[k] as { rich_text?: Array<{ plain_text: string }> })?.rich_text
        ?.map((b) => b.plain_text).join("") || "";
    const num = (k: string) => (props[k] as { number?: number | null })?.number ?? 0;
    const url =
      (props["Original PDF"]?.files || []).map((f: { file?: { url?: string } }) => f.file?.url || "").find(Boolean) ||
      (props["Invoice PDF"]?.files || []).map((f: { file?: { url?: string } }) => f.file?.url || "").find(Boolean) || "";
    let parsed = "no PDF";
    if (url) {
      try {
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
        const p = await parseInvoicePdf(buf);
        parsed = `pdf: t=${p.taxableValue} c=${p.cgst} s=${p.sgst} i=${p.igst} g=${p.grandTotal} state=${p.stateCode} origNo=${p.originalInvoiceNo}`;
      } catch (e) {
        parsed = "parse ERR " + (e as Error).message;
      }
    }
    console.log(
      `${title} | ledger: t=${num("Taxable Value")} c=${num("CGST")} s=${num("SGST")} i=${num("IGST")} g=${num("Grand Total")} | ${parsed}`
    );
  }
}

main().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});