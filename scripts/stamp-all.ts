// Stamp every wholesale row's invoice number onto its original PDF via the
// provider (same path as the Regenerate button).
import { config } from "dotenv";
config({ path: ".env.local" });
import { notionProvider } from "../src/lib/data/notion";

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
    try {
      const r = await notionProvider.regenerateWholesalePdf(row.id);
      console.log(`${title}: stamped (replaced on "${r.invoiceNo}")`);
    } catch (e) {
      console.log(`${title}: FAILED — ${(e as Error).message.slice(0, 160)}`);
    }
  }
}

main().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});