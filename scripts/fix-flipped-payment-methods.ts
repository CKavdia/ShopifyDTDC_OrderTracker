import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * One-time backfill: heal orders whose Payment Method was wrongly flipped COD -> Prepaid.
 *
 * Root cause: the Shopify sync re-derived payment method on every re-sync. COD orders use
 * Shopify's "manual" gateway (no "cod" keyword), so COD was detected only via
 * financial_status === "pending". Once a COD order left "pending" (cash collected / cancelled
 * / returned), a re-sync re-classified it as Prepaid and overwrote Notion. The sync fix makes
 * Payment Method immutable after creation; this script repairs the already-corrupted rows.
 *
 * Detection signal (zero false positives, no Shopify calls): at creation the sync sets
 * COD Collection Status = "Pending" for COD and "" for Prepaid, and that field is protected on
 * re-sync. So a genuine prepaid order (including manual-marked-paid prepaid) ALWAYS has an
 * empty COD Collection Status. Only originally-COD orders ever carry Pending/Collected.
 *
 *   Payment Method = "Prepaid" AND COD Collection Status in {Pending, Collected}
 *     => was a COD order that got flipped => reset to COD.
 *
 * Usage: npx tsx scripts/fix-flipped-payment-methods.ts
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function headers() {
  return {
    Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

/** Resolve the Shopify Orders database id the same way the app does. */
async function getDatabaseId(): Promise<string> {
  const pageId = process.env.NOTION_PAGE_ID;
  if (!pageId) throw new Error("NOTION_PAGE_ID is not set");

  const res = await fetch(
    `${NOTION_API}/blocks/${pageId}/children?page_size=100`,
    { headers: headers() }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Failed to list page children: ${JSON.stringify(data)}`);
  }

  for (const block of data.results || []) {
    if (
      block.type === "child_database" &&
      block.child_database?.title !== "Influencer Shipments"
    ) {
      return block.id;
    }
  }
  throw new Error("Shopify Orders database not found under NOTION_PAGE_ID");
}

interface NotionPage {
  id: string;
  properties: {
    "Order Number"?: { title?: Array<{ plain_text: string }> };
  };
}

async function main() {
  if (!process.env.NOTION_API_KEY) throw new Error("NOTION_API_KEY is not set");

  const databaseId = await getDatabaseId();

  // Prepaid AND COD Collection Status is Pending or Collected => flipped COD.
  const filter = {
    and: [
      { property: "Payment Method", select: { equals: "Prepaid" } },
      {
        or: [
          { property: "COD Collection Status", select: { equals: "Pending" } },
          { property: "COD Collection Status", select: { equals: "Collected" } },
        ],
      },
    ],
  };

  // Collect all matching pages (paginated).
  const matches: NotionPage[] = [];
  let startCursor: string | undefined;
  do {
    const body: Record<string, unknown> = { filter };
    if (startCursor) body.start_cursor = startCursor;

    const res = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Notion query failed (${res.status}): ${JSON.stringify(data)}`);
    }
    matches.push(...(data.results || []));
    startCursor = data.has_more ? data.next_cursor : undefined;
  } while (startCursor);

  if (matches.length === 0) {
    console.log("No flipped orders found. Nothing to fix.");
    return;
  }

  console.log(`Found ${matches.length} flipped order(s). Resetting Payment Method -> COD...\n`);

  let fixed = 0;
  for (const page of matches) {
    const orderNumber =
      page.properties["Order Number"]?.title?.[0]?.plain_text || page.id;

    const res = await fetch(`${NOTION_API}/pages/${page.id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: { "Payment Method": { select: { name: "COD" } } },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`  ✗ ${orderNumber}: failed — ${res.status} ${err}`);
      continue;
    }
    console.log(`  ✓ ${orderNumber}: Prepaid -> COD`);
    fixed++;
  }

  console.log(`\nDone. Corrected ${fixed}/${matches.length} order(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
