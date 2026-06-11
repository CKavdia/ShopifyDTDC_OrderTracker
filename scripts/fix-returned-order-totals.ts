import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * One-time backfill: correct "Order Total" in Notion for orders that were RETURNED/REFUNDED.
 *
 * The sync stores orderTotal = current_total_price, which drops when a refund is issued — so a
 * returned order (e.g. #1116) shows the refunded remainder (₹50) instead of the original
 * (₹2040). The sync fix changes the derivation to current_total_price + refunded; this script
 * repairs orders already in Notion that fell outside the 7-day re-sync window.
 *
 * Correct value = current_total_price + Σ(refund.transactions where kind="refund", success).
 * (An order edit produces a $0 restock refund, so its value is unchanged; only real returns
 * are restored to the original amount.)
 *
 * Usage: npx tsx scripts/fix-returned-order-totals.ts
 */

// ---- Shopify ----
const STORE_URL = process.env.SHOPIFY_STORE_URL!;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET!;
const SHOPIFY_API = `https://${STORE_URL}/admin/api/2024-01`;

// ---- Notion ----
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function notionHeaders() {
  return {
    Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

interface ShopifyOrder {
  id: number;
  name: string;
  current_total_price: string;
  total_price: string;
  refunds?: Array<{
    transactions?: Array<{ kind: string; status: string; amount: string }>;
  }>;
}

function getOrderValue(order: ShopifyOrder): number {
  const current = parseFloat(order.current_total_price || order.total_price || "0");
  const refunded = (order.refunds || []).reduce(
    (sum, r) =>
      sum +
      (r.transactions || [])
        .filter((t) => t.kind === "refund" && t.status === "success")
        .reduce((s, t) => s + parseFloat(t.amount || "0"), 0),
    0
  );
  return current + refunded;
}

async function getShopifyToken(): Promise<string> {
  const res = await fetch(`https://${STORE_URL}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Shopify auth failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/** Fetch all orders for a given financial_status, following Link-header pagination. */
async function fetchOrdersByStatus(
  token: string,
  financialStatus: string
): Promise<ShopifyOrder[]> {
  const headers = { "X-Shopify-Access-Token": token };
  const out: ShopifyOrder[] = [];
  let url: string | null = `${SHOPIFY_API}/orders.json?status=any&financial_status=${financialStatus}&limit=250`;

  while (url) {
    const res: Response = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Shopify orders fetch failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { orders: ShopifyOrder[] };
    out.push(...(json.orders || []));

    // Parse the rel="next" cursor link, if any.
    const link: string | null = res.headers.get("link") || res.headers.get("Link");
    const next: string | undefined = link
      ? link.split(",").find((p) => p.includes('rel="next"'))
      : undefined;
    const match: RegExpMatchArray | null = next ? next.match(/<([^>]+)>/) : null;
    url = match ? match[1] : null;
  }
  return out;
}

// ---- Notion: load all Shopify Orders pages into a map keyed by Shopify Order ID ----
async function getDatabaseId(): Promise<string> {
  const pageId = process.env.NOTION_PAGE_ID;
  if (!pageId) throw new Error("NOTION_PAGE_ID is not set");
  const res = await fetch(`${NOTION_API}/blocks/${pageId}/children?page_size=100`, {
    headers: notionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Failed to list page children: ${JSON.stringify(data)}`);
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

interface NotionRow {
  pageId: string;
  orderNumber: string;
  orderTotal: number | null;
}

async function loadNotionOrders(databaseId: string): Promise<Map<number, NotionRow>> {
  const map = new Map<number, NotionRow>();
  let startCursor: string | undefined;
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;
    const res = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
      method: "POST",
      headers: notionHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Notion query failed (${res.status}): ${JSON.stringify(data)}`);

    for (const page of data.results || []) {
      const props = page.properties || {};
      const shopifyId = props["Shopify Order ID"]?.number;
      if (typeof shopifyId !== "number") continue;
      map.set(shopifyId, {
        pageId: page.id,
        orderNumber: props["Order Number"]?.title?.[0]?.plain_text || String(shopifyId),
        orderTotal: props["Order Total"]?.number ?? null,
      });
    }
    startCursor = data.has_more ? data.next_cursor : undefined;
  } while (startCursor);
  return map;
}

async function main() {
  if (!process.env.NOTION_API_KEY) throw new Error("NOTION_API_KEY is not set");
  if (!STORE_URL || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Shopify env (SHOPIFY_STORE_URL / CLIENT_ID / CLIENT_SECRET) is not set");
  }

  const token = await getShopifyToken();

  // Orders with money refunded.
  const refundedOrders = [
    ...(await fetchOrdersByStatus(token, "refunded")),
    ...(await fetchOrdersByStatus(token, "partially_refunded")),
  ];
  console.log(`Fetched ${refundedOrders.length} refunded/partially-refunded Shopify order(s).`);

  const databaseId = await getDatabaseId();
  const notionByShopifyId = await loadNotionOrders(databaseId);

  let fixed = 0;
  for (const order of refundedOrders) {
    const row = notionByShopifyId.get(order.id);
    if (!row) continue; // not tracked in Notion

    const correct = getOrderValue(order);
    if (row.orderTotal !== null && Math.abs(row.orderTotal - correct) < 0.001) continue;

    const res = await fetch(`${NOTION_API}/pages/${row.pageId}`, {
      method: "PATCH",
      headers: notionHeaders(),
      body: JSON.stringify({ properties: { "Order Total": { number: correct } } }),
    });
    if (!res.ok) {
      console.error(`  ✗ ${row.orderNumber}: failed — ${res.status} ${await res.text()}`);
      continue;
    }
    console.log(`  ✓ ${row.orderNumber}: ${row.orderTotal ?? "—"} → ${correct}`);
    fixed++;
  }

  console.log(`\nDone. Corrected ${fixed} order total(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
