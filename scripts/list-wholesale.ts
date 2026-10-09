// List wholesale ledger rows with number / date / filed / customer / row id.
import { config } from "dotenv";
config({ path: ".env.local" });

const API = "https://api.notion.com/v1";
const headers = () => ({
  Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
});

async function main() {
  const pageId = process.env.NOTION_PAGE_ID!;
  const blocks = await (
    await fetch(`${API}/blocks/${pageId}/children?page_size=100`, { headers: headers() })
  ).json();
  const db = blocks.results?.find(
    (b: { type: string; child_database?: { title: string } }) =>
      b.type === "child_database" && b.child_database?.title === "UrbanNaari Invoices"
  );
  if (!db) throw new Error("Invoices DB not found");

  const res = await fetch(`${API}/databases/${db.id}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      filter: { property: "Type", select: { equals: "Wholesale" } },
    }),
  });
  const data = await res.json();
  console.log("status", res.status, "results", data.results?.length);
  for (const row of data.results || []) {
    const props = row.properties;
    const title = props["Invoice No"]?.title?.[0]?.plain_text || "";
    const date = props["Invoice Date"]?.date?.start || "";
    const filed = props["Filed"]?.checkbox === true;
    const cust =
      props["Customer"]?.rich_text?.map((b: { plain_text: string }) => b.plain_text).join("") || "";
    console.log(title, "|", date, "| filed:", filed, "|", cust, "|", row.id);
  }
}

main().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});