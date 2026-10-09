import { config } from "dotenv";
config({ path: ".env.local" });

// Invoices whose grand total differs from what the customer actually kept
// paying: Shopify order total, minus the COD fee, minus refunded value.
async function main() {
  const m = await import("../src/lib/data");
  const { isCodFeeTitle } = await import("../src/lib/invoice/calc");
  const { data } = m;

  const tok = await fetch(`https://${process.env.SHOPIFY_STORE_URL}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID!,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET!,
    }),
  }).then((r) => r.json());

  const rows = (await data.listInvoices()).filter((r) => r.shopifyOrderId);
  const ids = [...new Set(rows.map((r) => r.shopifyOrderId!))];

  const orders = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50).join(",");
    const res = await fetch(
      `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?ids=${batch}&status=any&limit=250`,
      { headers: { "X-Shopify-Access-Token": tok.access_token } }
    );
    if (!res.ok) throw new Error(`orders fetch ${res.status}`);
    for (const o of ((await res.json()) as any).orders) orders.set(String(o.id), o);
  }

  const diffs: Array<{ inv: string; order: string; paid: number; cod: number; refunded: number; invoice: number; delta: number }> = [];
  for (const r of rows) {
    const o = orders.get(r.shopifyOrderId!);
    if (!o) continue;
    const codLines = (o.shipping_lines ?? []).filter((s: any) => isCodFeeTitle(s.title));
    const cod = codLines.reduce((s: number, x: any) => s + parseFloat(x.price || "0"), 0);
    // Refunded value: COD refunds carry no transaction (money moved outside
    // Shopify), so value the refund from its line items (subtotal + tax).
    const refunded = (o.refunds ?? []).reduce(
      (s: number, f: any) =>
        s + (f.refund_line_items ?? []).reduce((s2: number, x: any) => s2 + parseFloat(x.subtotal || "0") + parseFloat(x.total_tax || "0"), 0),
      0
    );
    const paid = parseFloat(o.total_price) - cod - refunded;
    const delta = Math.round((paid - (r.grandTotal ?? 0)) * 100) / 100;
    if (Math.abs(delta) > 0.05)
      diffs.push({ inv: r.invoiceNo, order: o.name, paid: Math.round(paid * 100) / 100, cod, refunded: Math.round(refunded * 100) / 100, invoice: r.grandTotal ?? 0, delta });
  }

  console.log(`invoices checked: ${rows.length}, true mismatches: ${diffs.length}\n`);
  for (const d of diffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)))
    console.log(`${d.inv}  ${d.order}  kept-paid ${d.paid.toFixed(2)}  cod ${d.cod.toFixed(2)}  refunded ${d.refunded.toFixed(2)}  invoice ${d.invoice.toFixed(2)}  delta ${d.delta.toFixed(2)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
