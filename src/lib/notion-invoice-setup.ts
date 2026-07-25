import * as dotenv from "dotenv";
import * as path from "path";

// Load .env.local
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const pageId = process.env.NOTION_PAGE_ID!;
const TITLE = "UrbanNaari Invoices";

async function setup() {
  console.log(`Checking Notion "${TITLE}" database...`);

  // Skip if it already exists.
  const listRes = await fetch(
    `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
    {
      headers: {
        Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
      },
    }
  );
  const list = await listRes.json();
  for (const block of list.results || []) {
    if (
      block.type === "child_database" &&
      block.child_database?.title === TITLE
    ) {
      console.log("Database already exists:", block.id);
      return;
    }
  }

  const response = await fetch("https://api.notion.com/v1/databases", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { type: "page_id", page_id: pageId },
      title: [{ text: { content: TITLE } }],
      properties: {
        "Invoice No": { title: {} },
        "Shopify Order ID": { rich_text: {} },
        "Order Number": { rich_text: {} },
        "Invoice Date": { date: {} },
        Customer: { rich_text: {} },
        "Place of Supply": { rich_text: {} },
        "Taxable Value": { number: { format: "number" } },
        CGST: { number: { format: "number" } },
        SGST: { number: { format: "number" } },
        IGST: { number: { format: "number" } },
        "Grand Total": { number: { format: "number" } },
        FY: { rich_text: {} },
        Status: {
          select: {
            options: [
              { name: "Issued", color: "green" },
              { name: "Cancelled", color: "red" },
            ],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.message || "Failed to create database");
  }

  const data = await response.json();
  console.log("Database created:", data.id);
  console.log("Setup complete!");
}

setup().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
