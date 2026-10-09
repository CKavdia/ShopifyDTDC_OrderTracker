import type { AbandonedCheckout, DeliveryStatus } from "./data/types";

const STORE_URL = process.env.SHOPIFY_STORE_URL!;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET!;

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 5min buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 300000) {
    return cachedToken.token;
  }

  const response = await fetch(
    `https://${STORE_URL}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify auth failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 86400) * 1000,
  };

  return data.access_token;
}

async function shopifyFetch(
  endpoint: string,
  options?: { method?: string; body?: unknown }
): Promise<unknown> {
  const token = await getAccessToken();
  const response = await fetch(`https://${STORE_URL}/admin/api/2024-01${endpoint}`, {
    method: options?.method || "GET",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify API error (${response.status}): ${text}`);
  }

  return response.json();
}

// GraphQL Admin API call, reusing the same client_credentials token as REST.
async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(
    `https://${STORE_URL}/admin/api/2024-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify GraphQL error (${response.status}): ${text}`);
  }
  const json = (await response.json()) as { data?: T; errors?: unknown };
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

// --- Invoice data ---------------------------------------------------------
// One GraphQL call that returns everything the GST invoice engine needs, in the
// shape `src/lib/invoice/calc.ts` expects (money as { shopMoney: { amount } }).

export interface InvoiceMoney {
  shopMoney: { amount: string };
}
export interface InvoiceAddress {
  name: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  provinceCode: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
}
export interface InvoiceLineItem {
  id: string;
  title: string;
  quantity: number;
  currentQuantity: number; // quantity after order edits/refunds (0 = removed)
  sku: string | null;
  variantTitle: string | null;
  vendor: string | null;
  // Variant image for the invoice's thumbnail column (null when the variant
  // has no image or was deleted after the order).
  imageUrl: string | null;
  originalUnitPriceSet: InvoiceMoney;
  originalTotalSet: InvoiceMoney;
  totalDiscountSet: InvoiceMoney;
  discountAllocations: Array<{ allocatedAmountSet: InvoiceMoney }>;
  taxLines: Array<{ title: string; ratePercentage: number; priceSet: InvoiceMoney }>;
  product: { id: string; hsn: { value: string } | null } | null;
}
export interface InvoiceOrder {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string;
  note: string | null;
  currencyCode: string;
  subtotalPriceSet: InvoiceMoney;
  totalTaxSet: InvoiceMoney;
  totalDiscountsSet: InvoiceMoney;
  totalPriceSet: InvoiceMoney;
  totalShippingPriceSet: InvoiceMoney;
  // Cash actually kept from the customer: Shopify's current (post-edit,
  // post-recorded-refund) total, NOT reduced by un-refunded returned value.
  // Exposed for bookkeeping notes — store credit owed = collected − invoice.
  collectedTotalPriceSet?: InvoiceMoney;
  shippingTitle: string | null; // e.g. "COD Fee", "Standard"
  taxesIncluded: boolean;
  // Order-level discount identities, for conditional-offer revocation on
  // returns. name = code (code-based) or title (automatic); percentage null
  // for fixed-amount discounts.
  discounts?: Array<{ name: string; percentage: number | null }>;
  // True when any CLOSED return exists on the order (goods genuinely came
  // back). Drives conditional-offer revocation in calc.ts. Absent on
  // synthetic (manual) orders, which can never revoke.
  hasClosedReturn?: boolean;
  billingAddress: InvoiceAddress | null;
  shippingAddress: InvoiceAddress | null;
  lineItems: InvoiceLineItem[];
}

const INVOICE_ORDER_QUERY = `
  query InvoiceOrder($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      displayFinancialStatus
      note
      currencyCode
      subtotalPriceSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } }
      currentSubtotalPriceSet { shopMoney { amount } }
      currentTotalTaxSet { shopMoney { amount } }
      currentTotalDiscountsSet { shopMoney { amount } }
      currentTotalPriceSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      shippingLine { title }
      taxesIncluded
      billingAddress { name company address1 address2 city province provinceCode zip country phone }
      shippingAddress { name company address1 address2 city province provinceCode zip country phone }
      lineItems(first: 100) {
        edges {
          node {
            id
            title
            quantity
            currentQuantity
            sku
            variantTitle
            vendor
            variant { image { url } }
            originalUnitPriceSet { shopMoney { amount } }
            originalTotalSet { shopMoney { amount } }
            totalDiscountSet { shopMoney { amount } }
            discountAllocations { allocatedAmountSet { shopMoney { amount } } }
            taxLines { title ratePercentage priceSet { shopMoney { amount } } }
            product { id hsn: metafield(namespace: "custom", key: "hsn_sac") { value } }
          }
        }
      }
      returns(first: 10) {
        edges {
          node {
            status
            returnLineItems(first: 10) {
              edges {
                node {
                  quantity
                  ... on ReturnLineItem {
                    fulfillmentLineItem { lineItem { id } }
                  }
                }
              }
            }
          }
        }
      }
      refunds {
        refundLineItems(first: 10) {
          edges {
            node {
              quantity
              lineItem { id }
            }
          }
        }
      }
      discountApplications(first: 10) {
        edges {
          node {
            value {
              __typename
              ... on PricingPercentageValue { percentage }
            }
            ... on DiscountCodeApplication { code }
            ... on AutomaticDiscountApplication { title }
          }
        }
      }
    }
  }
`;

// Fetch a single order (by numeric REST id) with full GST detail via GraphQL.
//
// Order edits/refunds are honoured: a line removed via a Shopify order edit has
// currentQuantity 0 and is dropped; a reduced-quantity line is scaled to its
// current quantity; and the order-level totals used for reconciliation are the
// CURRENT sets (post-edit), not the original ones. So the invoice always
// reflects what the order looks like now, matching Shopify.
export async function getOrderForInvoice(
  shopifyOrderId: string
): Promise<InvoiceOrder> {
  const gid = `gid://shopify/Order/${shopifyOrderId}`;
  const data = await shopifyGraphQL<{
    order:
      | (Omit<InvoiceOrder, "lineItems" | "shippingTitle"> & {
          currentSubtotalPriceSet: InvoiceMoney;
          currentTotalTaxSet: InvoiceMoney;
          currentTotalDiscountsSet: InvoiceMoney;
          currentTotalPriceSet: InvoiceMoney;
          shippingLine: { title: string } | null;
          returns: {
            edges: Array<{
              node: {
                status: string;
                returnLineItems: {
                  edges: Array<{
                    node: {
                      quantity: number;
                      fulfillmentLineItem: { lineItem: { id: string } } | null;
                    };
                  }>;
                };
              };
            }>;
          } | null;
          refunds: Array<{
            refundLineItems: {
              edges: Array<{
                node: { quantity: number; lineItem: { id: string } | null };
              }>;
            } | null;
          }> | null;
          discountApplications: {
            edges: Array<{
              node: {
                value: { __typename: string; percentage?: number } | null;
                code?: string;
                title?: string;
              };
            }>;
          } | null;
          lineItems: { edges: Array<{ node: Omit<InvoiceLineItem, "imageUrl"> & { variant: { image: { url: string } } | null } }> };
        })
      | null;
  }>(INVOICE_ORDER_QUERY, { id: gid });

  if (!data.order) throw new Error(`Order not found: ${shopifyOrderId}`);
  const o = data.order;

  const scale = (m: InvoiceMoney, factor: number): InvoiceMoney => ({
    shopMoney: { amount: (Number(m.shopMoney.amount) * factor).toString() },
  });
  const subtractMoney = (m: InvoiceMoney, v: number): InvoiceMoney => ({
    shopMoney: { amount: (Number(m.shopMoney.amount) - v).toFixed(2) },
  });

  // --- Returned goods ---------------------------------------------------
  // Goods actually returned come OFF the invoice. A return only counts once
  // it is CLOSED (goods genuinely back); OPEN/CANCELED ones are pending. The
  // returned quantity is subtracted from the line, the line's money is
  // prorated to the remaining quantity, and a fully-returned line is dropped.
  //
  // Money: Shopify's CURRENT totals still count returned goods when no refund
  // was recorded (e.g. the customer took store credit). Only the un-refunded
  // returned portion is subtracted from the totals — a recorded refund has
  // already lowered them. Un-adjusted, round-off would silently absorb the
  // returned item's value.
  const returnedQtyById = new Map<string, number>();
  const refundedQtyById = new Map<string, number>();
  let hasClosedReturn = false;
  for (const edge of o.returns?.edges ?? []) {
    if (edge.node.status !== "CLOSED") continue;
    hasClosedReturn = true;
    for (const e of edge.node.returnLineItems.edges) {
      const id = e.node.fulfillmentLineItem?.lineItem?.id;
      if (id) returnedQtyById.set(id, (returnedQtyById.get(id) ?? 0) + e.node.quantity);
    }
  }
  for (const ref of o.refunds ?? []) {
    for (const e of ref?.refundLineItems?.edges ?? []) {
      const id = e.node.lineItem?.id;
      if (id) refundedQtyById.set(id, (refundedQtyById.get(id) ?? 0) + e.node.quantity);
    }
  }

  let returnedMoneyTotal = 0; // tax-inclusive value returned but not refunded
  let returnedTaxTotal = 0;

  const lineItems = o.lineItems.edges
    .map((e) => e.node)
    .map(({ variant, ...li }) => ({ ...li, imageUrl: variant?.image?.url ?? null }))
    .map((li) => {
      const returned = returnedQtyById.get(li.id) ?? 0;
      const baseQty = li.currentQuantity ?? li.quantity; // after order edits
      const effQty = baseQty - returned;
      // Returned but never refunded (store credit / refund paid outside
      // Shopify) — the money still sits in Shopify's current totals.
      const unrefunded = Math.max(0, returned - (refundedQtyById.get(li.id) ?? 0));

      if (unrefunded > 0) {
        const discounts = li.discountAllocations.reduce(
          (s, a) => s + Number(a.allocatedAmountSet.shopMoney.amount),
          0
        );
        const netInclTax = Number(li.originalTotalSet.shopMoney.amount) - discounts;
        const f = unrefunded / li.quantity;
        returnedMoneyTotal += netInclTax * f;
        returnedTaxTotal +=
          li.taxLines.reduce(
            (s, t) => s + Number(t.priceSet.shopMoney.amount),
            0
          ) * f;
      }

      if (returned <= 0 && baseQty === li.quantity) return li;
      if (effQty <= 0) return null; // fully returned / removed — off the invoice
      // Prorate the remaining quantity's money fields (edit + return combined).
      const f = effQty / li.quantity;
      return {
        ...li,
        quantity: effQty,
        originalTotalSet: scale(li.originalTotalSet, f),
        totalDiscountSet: scale(li.totalDiscountSet, f),
        discountAllocations: li.discountAllocations.map((a) => ({
          allocatedAmountSet: scale(a.allocatedAmountSet, f),
        })),
        taxLines: li.taxLines.map((t) => ({
          ...t,
          priceSet: scale(t.priceSet, f),
        })),
      };
    })
    .filter((li): li is NonNullable<typeof li> => li !== null);

  return {
    ...o,
    // Current (post-edit) totals are authoritative for reconciliation,
    // reduced by the un-refunded returned value.
    subtotalPriceSet: o.currentSubtotalPriceSet,
    totalTaxSet: subtractMoney(o.currentTotalTaxSet, returnedTaxTotal),
    totalDiscountsSet: o.currentTotalDiscountsSet,
    totalPriceSet: subtractMoney(o.currentTotalPriceSet, returnedMoneyTotal),
    collectedTotalPriceSet: o.currentTotalPriceSet,
    shippingTitle: o.shippingLine?.title ?? null,
    hasClosedReturn,
    discounts: (o.discountApplications?.edges ?? []).map(({ node }) => ({
      name: node.code || node.title || "",
      percentage:
        node.value?.__typename === "PricingPercentageValue" &&
        typeof node.value.percentage === "number"
          ? node.value.percentage
          : null,
    })),
    lineItems,
  };
}

export interface ShopifyOrder {
  id: number;
  name: string; // order number like "#1042"
  email: string;
  created_at: string;
  total_price: string;
  current_total_price: string; // reflects order edits/refunds; total_price is frozen at creation
  financial_status: string;
  payment_gateway_names: string[];
  customer: {
    first_name: string;
    last_name: string;
    email: string;
  } | null;
  shipping_address: {
    address1: string;
    address2: string;
    city: string;
    province: string;
    zip: string;
    country: string;
    phone: string;
  } | null;
  line_items: Array<{
    id: number;
    title: string;
    quantity: number;
  }>;
  cancelled_at: string | null;
  fulfillments: Array<{
    id: number;
    status: string;
    created_at: string;
    tracking_number: string | null;
    tracking_numbers: string[];
    tracking_company: string | null;
  }>;
  refunds?: Array<{
    id: number;
    transactions?: Array<{ kind: string; status: string; amount: string }>;
  }>;
}

interface ShopifyCheckoutLineItem {
  title: string;
  quantity: number;
  variant_title: string | null;
  price: string;
  product_id: number;
  variant_id: number;
}

interface ShopifyCheckout {
  id: number;
  email: string | null;
  phone: string | null;
  shipping_address: { name: string; phone: string | null } | null;
  billing_address: { name: string; phone: string | null } | null;
  line_items: ShopifyCheckoutLineItem[];
  total_price: string;
  abandoned_checkout_url: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export async function getAbandonedCheckouts(): Promise<AbandonedCheckout[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const data = (await shopifyFetch(
    `/checkouts.json?updated_at_min=${encodeURIComponent(sevenDaysAgo)}&limit=250`
  )) as { checkouts: ShopifyCheckout[] };

  return (data.checkouts || [])
    .filter((c) => c.completed_at === null)
    .sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    )
    .map((c) => ({
      id: String(c.id),
      customerName:
        c.shipping_address?.name ||
        c.billing_address?.name ||
        c.email ||
        "Customer",
      customerPhone:
        c.phone ||
        c.shipping_address?.phone ||
        c.billing_address?.phone ||
        "",
      customerEmail: c.email || "",
      lineItems: c.line_items.map((li) => ({
        title: li.title,
        quantity: li.quantity,
        variantTitle: li.variant_title || "",
        price: li.price,
        productId: String(li.product_id),
        variantId: String(li.variant_id),
      })),
      totalPrice: c.total_price,
      checkoutUrl: c.abandoned_checkout_url,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      waMessageSent: false,
    }));
}

// Extract the next-page cursor from a Shopify REST `Link` header, if any.
// Format: `<https://…?page_info=XXX&limit=250>; rel="next", <…>; rel="previous"`
function parseNextPageInfo(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return new URL(m[1]).searchParams.get("page_info");
  }
  return null;
}

// Fetch every order matching `params` across all pages, using Shopify's cursor
// (page_info) pagination. This is the correct approach: `since_id` is unreliable
// because /orders.json returns results newest-first, so it re-returns the same
// window and duplicates/drops orders once a result set exceeds one page.
// Filters live on the first request only; page_info carries them forward.
async function fetchOrdersPaginated(
  params: Record<string, string>
): Promise<ShopifyOrder[]> {
  const token = await getAccessToken();
  const query = new URLSearchParams({ limit: "250", ...params });
  let endpoint: string | null = `/orders.json?${query.toString()}`;
  const allOrders: ShopifyOrder[] = [];

  while (endpoint) {
    const response = await fetch(
      `https://${STORE_URL}/admin/api/2024-01${endpoint}`,
      {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      }
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Shopify API error (${response.status}): ${text}`);
    }
    const data = (await response.json()) as { orders: ShopifyOrder[] };
    allOrders.push(...data.orders);

    const next = parseNextPageInfo(response.headers.get("link"));
    endpoint = next ? `/orders.json?limit=250&page_info=${next}` : null;
  }

  // Defensive dedupe by id (preserves order); callers sort if they need to.
  const byId = new Map(allOrders.map((o) => [String(o.id), o]));
  return [...byId.values()];
}

export async function getFulfilledOrders(updatedAtMin?: string): Promise<ShopifyOrder[]> {
  return fetchOrdersPaginated({
    fulfillment_status: "shipped",
    status: "any",
    ...(updatedAtMin ? { updated_at_min: updatedAtMin } : {}),
  });
}

export async function getUnfulfilledOrders(updatedAtMin?: string): Promise<ShopifyOrder[]> {
  return fetchOrdersPaginated({
    fulfillment_status: "unfulfilled",
    status: "open",
    ...(updatedAtMin ? { updated_at_min: updatedAtMin } : {}),
  });
}

// Paid orders created within [startISO, endISO], oldest-first. Used by the
// date-range invoice export (which mints invoices for any not yet invoiced).
export async function getPaidOrdersInRange(
  startISO: string,
  endISO: string
): Promise<ShopifyOrder[]> {
  const orders = await fetchOrdersPaginated({
    status: "any",
    financial_status: "paid",
    created_at_min: startISO,
    created_at_max: endISO,
  });
  // Oldest-first so minted invoice numbers ascend by date.
  return orders.sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
}

export async function createShopifyFulfillment(
  shopifyOrderId: string,
  trackingNumber: string,
  courierPartner: string
): Promise<void> {
  const foData = (await shopifyFetch(
    `/orders/${shopifyOrderId}/fulfillment_orders.json`
  )) as {
    fulfillment_orders: Array<{
      id: number;
      status: string;
      line_items: Array<{ id: number; quantity: number; fulfillable_quantity: number }>;
    }>;
  };

  const fulfillmentOrders = foData.fulfillment_orders;
  if (!fulfillmentOrders || fulfillmentOrders.length === 0) {
    throw new Error("No fulfillment orders found for this order");
  }

  // Only include fulfillment orders that have fulfillable items
  const lineItemsByFulfillmentOrder = fulfillmentOrders
    .filter((fo) => fo.status === "open" || fo.status === "in_progress")
    .map((fo) => ({
      fulfillment_order_id: fo.id,
      fulfillment_order_line_items: fo.line_items
        .filter((li) => li.fulfillable_quantity > 0)
        .map((li) => ({
          id: li.id,
          quantity: li.fulfillable_quantity,
        })),
    }))
    .filter((fo) => fo.fulfillment_order_line_items.length > 0);

  if (lineItemsByFulfillmentOrder.length === 0) {
    await updateExistingFulfillmentTracking(
      shopifyOrderId,
      trackingNumber,
      courierPartner,
      fulfillmentOrders
    );
    return;
  }

  await shopifyFetch("/fulfillments.json", {
    method: "POST",
    body: {
      fulfillment: {
        notify_customer: true,
        line_items_by_fulfillment_order: lineItemsByFulfillmentOrder,
        tracking_info: {
          number: trackingNumber,
          company: courierPartner || "DTDC",
        },
      },
    },
  });
}

async function updateExistingFulfillmentTracking(
  shopifyOrderId: string,
  trackingNumber: string,
  courierPartner: string,
  fulfillmentOrdersForDebug: Array<{
    id: number;
    status: string;
    line_items: Array<{ id: number; quantity: number; fulfillable_quantity: number }>;
  }>
): Promise<void> {
  const fData = (await shopifyFetch(
    `/orders/${shopifyOrderId}/fulfillments.json`
  )) as {
    fulfillments: Array<{
      id: number;
      status: string;
      tracking_number: string | null;
    }>;
  };

  const fulfillments = fData.fulfillments || [];
  const target =
    fulfillments.find((f) => f.status === "success") ||
    fulfillments[fulfillments.length - 1];

  if (!target) {
    const debug = fulfillmentOrdersForDebug.map((fo) => ({
      id: fo.id,
      status: fo.status,
      items: fo.line_items.map((li) => ({
        id: li.id,
        qty: li.quantity,
        fulfillable: li.fulfillable_quantity,
      })),
    }));
    throw new Error(
      `No fulfillable items and no existing fulfillment to update. Fulfillment orders: ${JSON.stringify(debug)}`
    );
  }

  // Recovery path: Shopify already fulfilled this order (and likely already
  // emailed the customer the first time). Update tracking silently — do NOT
  // resend the shipping email.
  await shopifyFetch(`/fulfillments/${target.id}/update_tracking.json`, {
    method: "POST",
    body: {
      fulfillment: {
        notify_customer: false,
        tracking_info: {
          number: trackingNumber,
          company: courierPartner || "DTDC",
        },
      },
    },
  });
}

// --- Shipment status push -------------------------------------------------
// DTDC is the source of truth for where the parcel is, but Shopify only learns
// about it if we tell it. A FulfillmentEvent sets the fulfillment's shipment
// status, which is what drives the "Delivery status" column in the Shopify
// orders list and the customer's order status page.

export type ShipmentStatus = "OUT_FOR_DELIVERY" | "DELIVERED";

// Only these two internal statuses are mirrored to Shopify. RTO/return states
// are deliberately left alone — Shopify has no matching concept and a wrong
// event is visible to the customer.
export function toShopifyShipmentStatus(
  deliveryStatus: DeliveryStatus
): ShipmentStatus | null {
  if (deliveryStatus === "Delivered") return "DELIVERED";
  if (deliveryStatus === "Out for Delivery") return "OUT_FOR_DELIVERY";
  return null;
}

// How far along the shipment Shopify already thinks the parcel is. Only ever
// push forward — this makes repeated refreshes a no-op and stops a late DTDC
// "out for delivery" scan from walking back an already-delivered fulfillment.
const SHIPMENT_RANK: Record<string, number> = {
  IN_TRANSIT: 1,
  CARRIER_PICKED_UP: 1,
  OUT_FOR_DELIVERY: 2,
  DELIVERED: 3,
};

const FULFILLMENTS_QUERY = `
  query OrderFulfillments($id: ID!) {
    order(id: $id) {
      fulfillments(first: 20) {
        id
        status
        displayStatus
        trackingInfo(first: 5) {
          number
        }
      }
    }
  }
`;

const FULFILLMENT_EVENT_MUTATION = `
  mutation PushShipmentStatus($fulfillmentEvent: FulfillmentEventInput!) {
    fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
      fulfillmentEvent {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// DTDC hands back IST wall-clock with no offset ("2026-03-24 18:00:00[.0]"),
// so `new Date(raw)` resolves against whatever timezone the host runs in —
// correct on an IST desktop, 5h30m into the future on a UTC server. Pin the
// offset explicitly so the timestamp the customer sees is host-independent.
function toIsoFromDtdc(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  // deliveredDate can be date-only; without a time part the offset suffix
  // alone is unparseable, so give it midnight IST rather than dropping it.
  const base = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00`
    : trimmed.replace(" ", "T").replace(/\.\d+$/, "");
  const parsed = new Date(hasZone ? trimmed : `${base}+05:30`);
  return isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export async function pushShopifyShipmentStatus(
  shopifyOrderId: string,
  target: ShipmentStatus,
  opts?: { trackingNumber?: string; happenedAt?: string }
): Promise<{ pushed: boolean; reason?: string }> {
  // Not every row in the tracker is a Shopify order (manual entries exist).
  if (!shopifyOrderId) {
    return { pushed: false, reason: "no Shopify order id" };
  }

  const result = await shopifyGraphQL<{
    order: {
      fulfillments: Array<{
        id: string;
        status: string;
        displayStatus: string | null;
        trackingInfo: Array<{ number: string | null }>;
      }>;
    } | null;
  }>(FULFILLMENTS_QUERY, { id: `gid://shopify/Order/${shopifyOrderId}` });

  const fulfillments = result.order?.fulfillments || [];
  if (fulfillments.length === 0) {
    return { pushed: false, reason: "no fulfillment on Shopify order" };
  }

  // Ignore cancelled/failed fulfillments — an order re-fulfilled with the same
  // AWB carries the number on both, and posting an event to the dead one just
  // returns userErrors. Match on the AWB within the live ones so split
  // shipments update the right parcel.
  const live = fulfillments.filter((f) => f.status === "SUCCESS");
  const candidates = live.length > 0 ? live : fulfillments;
  const targetFulfillment =
    (opts?.trackingNumber
      ? candidates.find((f) =>
          f.trackingInfo.some((t) => t.number === opts.trackingNumber)
        )
      : undefined) || candidates[candidates.length - 1];

  const currentRank = SHIPMENT_RANK[targetFulfillment.displayStatus || ""] || 0;
  if (SHIPMENT_RANK[target] <= currentRank) {
    return {
      pushed: false,
      reason: `already at ${targetFulfillment.displayStatus}`,
    };
  }

  const happenedAt = toIsoFromDtdc(opts?.happenedAt);

  const mutation = await shopifyGraphQL<{
    fulfillmentEventCreate: {
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(FULFILLMENT_EVENT_MUTATION, {
    fulfillmentEvent: {
      fulfillmentId: targetFulfillment.id,
      status: target,
      ...(happenedAt ? { happenedAt } : {}),
    },
  });

  const userErrors = mutation.fulfillmentEventCreate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(
      `fulfillmentEventCreate failed: ${userErrors.map((e) => e.message).join("; ")}`
    );
  }

  return { pushed: true };
}

export async function getOrderLineItems(
  shopifyOrderId: string
): Promise<Array<{ title: string; quantity: number; variantTitle: string }>> {
  const data = (await shopifyFetch(`/orders/${shopifyOrderId}.json`)) as {
    order: {
      line_items: Array<{
        title: string;
        quantity: number;
        current_quantity?: number;
        variant_title: string | null;
      }>;
    };
  };
  return data.order.line_items
    .map((li) => ({
      title: li.title,
      // current_quantity reflects order edits (a swapped-out size has current_quantity 0)
      quantity: li.current_quantity ?? li.quantity,
      variantTitle: li.variant_title || "",
    }))
    .filter((li) => li.quantity > 0);
}

export async function markShopifyOrderPaid(shopifyOrderId: string): Promise<void> {
  // Record a capture transaction. If the order has an outstanding authorization
  // (manual-payment COD), kind=capture will mark financial_status=paid. If no
  // authorization exists, fall back to kind=sale.
  try {
    await shopifyFetch(`/orders/${shopifyOrderId}/transactions.json`, {
      method: "POST",
      body: { transaction: { kind: "capture", status: "success" } },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no.*authorization|cannot.*capture/i.test(msg)) {
      await shopifyFetch(`/orders/${shopifyOrderId}/transactions.json`, {
        method: "POST",
        body: { transaction: { kind: "sale", status: "success" } },
      });
      return;
    }
    throw err;
  }
}

export async function cancelShopifyOrder(shopifyOrderId: string, reason?: string): Promise<void> {
  // Add cancellation reason as order note before cancelling
  if (reason) {
    await shopifyFetch(`/orders/${shopifyOrderId}.json`, {
      method: "PUT",
      body: { order: { id: Number(shopifyOrderId), note: `Cancellation reason: ${reason}` } },
    });
  }
  await shopifyFetch(`/orders/${shopifyOrderId}/cancel.json`, {
    method: "POST",
    body: { reason: "other", email: true },
  });
}

export async function getShopifyOrder(shopifyOrderId: string): Promise<ShopifyOrder> {
  const data = (await shopifyFetch(`/orders/${shopifyOrderId}.json`)) as {
    order: ShopifyOrder;
  };
  return data.order;
}

export function extractProductHandle(url: string): string | null {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const match = parsed.pathname.match(/\/products\/([^/?#]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function getProductFromPublicUrl(
  url: string,
  handle: string
): Promise<{ title: string; imageUrl: string } | null> {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const jsonUrl = `${parsed.origin}/products/${handle}.json`;

    const res = await fetch(jsonUrl, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const product = data?.product;
    if (!product) return null;

    return {
      title: product.title || "",
      imageUrl: product.images?.[0]?.src || product.image?.src || "",
    };
  } catch {
    return null;
  }
}

export async function getShopifyProductImage(
  productId: string
): Promise<string | null> {
  try {
    const data = (await shopifyFetch(`/products/${productId}.json`)) as {
      product?: {
        images?: { src: string }[];
        image?: { src: string };
      };
    };
    return (
      data.product?.images?.[0]?.src ||
      data.product?.image?.src ||
      null
    );
  } catch {
    return null;
  }
}

// --- Inventory Management ---

let cachedLocationId: number | null = null;

async function getLocationId(inventoryItemId: number): Promise<number> {
  if (cachedLocationId) return cachedLocationId;

  // Get location from inventory levels (avoids needing read_locations scope)
  const data = (await shopifyFetch(
    `/inventory_levels.json?inventory_item_ids=${inventoryItemId}`
  )) as {
    inventory_levels: Array<{ location_id: number }>;
  };

  if (!data.inventory_levels.length) {
    throw new Error("No inventory levels found for this item");
  }

  cachedLocationId = data.inventory_levels[0].location_id;
  return cachedLocationId;
}

async function getProductByHandle(
  handle: string
): Promise<Array<{ id: number; title: string; inventory_item_id: number }> | null> {
  try {
    const data = (await shopifyFetch(
      `/products.json?handle=${encodeURIComponent(handle)}`
    )) as {
      products: Array<{
        variants: Array<{
          id: number;
          title: string;
          inventory_item_id: number;
        }>;
      }>;
    };

    if (!data.products.length) return null;
    return data.products[0].variants;
  } catch {
    return null;
  }
}

export async function findVariantInventoryItemId(
  handle: string,
  size: string
): Promise<number | null> {
  const variants = await getProductByHandle(handle);
  if (!variants) return null;

  const sizeLower = size.trim().toLowerCase();
  const match = variants.find((v) => v.title.trim().toLowerCase() === sizeLower);
  return match ? match.inventory_item_id : null;
}

export async function adjustInventory(
  inventoryItemId: number,
  delta: number
): Promise<{ adjusted: boolean; warning?: string }> {
  const locationId = await getLocationId(inventoryItemId);

  // Check current level before deducting
  if (delta < 0) {
    const data = (await shopifyFetch(
      `/inventory_levels.json?inventory_item_ids=${inventoryItemId}`
    )) as {
      inventory_levels: Array<{ available: number }>;
    };
    const current = data.inventory_levels[0]?.available ?? 0;
    if (current <= 0) {
      return { adjusted: false, warning: "Inventory is already at zero" };
    }
  }

  await shopifyFetch("/inventory_levels/adjust.json", {
    method: "POST",
    body: {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available_adjustment: delta,
    },
  });
  return { adjusted: true };
}

// Order value that reflects order EDITS but ignores RETURNS/REFUNDS.
// current_total_price reflects both edits and refunds; adding back the money actually
// refunded (refund transactions, kind="refund") cancels the refund portion, leaving the
// edit-adjusted total. An order edit yields a $0 restock refund, so editing keeps the edited
// value; a return yields a real refund, so it restores the original value (e.g. #1116: 50 +
// 1990 = 2040). Refund line items are NOT used — an edit can list a removed item with no money
// refunded, which would wrongly add it back.
export function getOrderValue(order: ShopifyOrder): number {
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

export function formatShippingAddress(
  addr: ShopifyOrder["shipping_address"]
): string {
  if (!addr) return "";
  const parts = [
    addr.address1,
    addr.address2,
    addr.city,
    addr.province,
    addr.zip,
    addr.country,
  ].filter(Boolean);
  return parts.join(", ");
}
