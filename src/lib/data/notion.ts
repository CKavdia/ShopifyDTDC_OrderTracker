import {
  DataProvider,
  Order,
  OrderFilters,
  DeliveryStatus,
  TrackingEvent,
  InfluencerShipment,
  Product,
  CodConfirmationStatus,
  RtoConfirmationStatus,
  InvoiceLogInput,
  InvoiceRecord,
  InvoicePriceOverride,
  InvoiceLineSnapshot,
  WholesaleInvoiceInput,
  RenumberChange,
} from "./types";
import { parseInvoicePdf, parsedItemsToSnapshot } from "../invoice/parse";
import { compressPdfForUpload } from "../invoice/compress.server";
import { stampInvoiceNumber } from "../invoice/stamp.server";
import {
  financialYear,
  formatInvoiceNo,
  parseSequence,
} from "../invoice/numbering";
import { GST_STATE_CODES, GST_STATE_NAMES } from "../invoice/config";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function headers() {
  return {
    Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

let cachedDatabaseId: string | null = null;
let cachedInfluencerDbId: string | null = null;
let shippingModePropertyCreated = false;
let reviewEmailPropertyCreated = false;
let weightPropertyCreated = false;
let shippingChargePaidPropertyCreated = false;
let influencerShippingChargePaidPropertyCreated = false;
let cancelReasonPropertyCreated = false;
let whatsappPropertyCreated = false;
let dtdcFieldsPropertyCreated = false;
let dtdcFieldsInfluencerCreated = false;
let followUpPropertyCreated = false;
let rtoWhatsappPropertyCreated = false;
let rtoFollowUpPropertyCreated = false;
let ofdWhatsappPropertyCreated = false;

async function ensureDtdcFieldProperties(databaseId: string, isInfluencer: boolean) {
  const flag = isInfluencer ? dtdcFieldsInfluencerCreated : dtdcFieldsPropertyCreated;
  if (flag) return;
  try {
    await fetch(`${NOTION_API}/databases/${databaseId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "Reason Code": { rich_text: {} },
          "Reason Description": { rich_text: {} },
          "Attempt Count": { number: {} },
          "Destination Pincode": { rich_text: {} },
          "Worker Mobile": { rich_text: {} },
        },
      }),
    });
  } catch {
    // Properties may already exist
  }
  if (isInfluencer) {
    dtdcFieldsInfluencerCreated = true;
  } else {
    dtdcFieldsPropertyCreated = true;
  }
}

async function getDatabaseId(): Promise<string> {
  if (cachedDatabaseId) return cachedDatabaseId;

  const pageId = process.env.NOTION_PAGE_ID!;
  const res = await fetch(
    `${NOTION_API}/blocks/${pageId}/children?page_size=100`,
    { headers: headers() }
  );
  const data = await res.json();

  for (const block of data.results || []) {
    if (
      block.type === "child_database" &&
      block.child_database?.title !== "Influencer Shipments" &&
      block.child_database?.title !== "UrbanNaari Invoices"
    ) {
      cachedDatabaseId = block.id;
      return block.id;
    }
  }

  throw new Error(
    "Notion database not found. Run: npx tsx src/lib/notion-setup.ts"
  );
}

async function getInfluencerDatabaseId(): Promise<string> {
  if (cachedInfluencerDbId) return cachedInfluencerDbId;

  const pageId = process.env.NOTION_PAGE_ID!;
  const res = await fetch(
    `${NOTION_API}/blocks/${pageId}/children?page_size=100`,
    { headers: headers() }
  );
  const data = await res.json();

  for (const block of data.results || []) {
    if (
      block.type === "child_database" &&
      block.child_database?.title === "Influencer Shipments"
    ) {
      cachedInfluencerDbId = block.id;
      return block.id;
    }
  }

  throw new Error(
    "Influencer Shipments database not found. Run: npx tsx src/lib/notion-migrate.ts"
  );
}

async function queryDatabase(
  databaseId: string,
  filter?: Record<string, unknown>,
  sorts?: Array<Record<string, unknown>>
): Promise<Record<string, unknown>[]> {
  const allResults: Record<string, unknown>[] = [];
  let startCursor: string | undefined;

  do {
    const body: Record<string, unknown> = {};
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (startCursor) body.start_cursor = startCursor;

    const res = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) {
      const errorMsg = data.message || JSON.stringify(data);
      console.error("Notion query error:", errorMsg);
      throw new Error(`Notion query failed (${res.status}): ${errorMsg}`);
    }

    allResults.push(...(data.results || []));
    startCursor = data.has_more ? data.next_cursor : undefined;
  } while (startCursor);

  return allResults;
}

function toRichTextBlocks(str: string): Array<{ text: { content: string } }> {
  const BLOCK_LIMIT = 2000;
  const blocks: Array<{ text: { content: string } }> = [];
  for (let i = 0; i < str.length; i += BLOCK_LIMIT) {
    blocks.push({ text: { content: str.slice(i, i + BLOCK_LIMIT) } });
  }
  if (blocks.length === 0) {
    blocks.push({ text: { content: "" } });
  }
  return blocks;
}

function parseOrder(page: Record<string, unknown>): Order {
  const props = page.properties as Record<string, unknown>;

  const getText = (prop: unknown): string => {
    const p = prop as { rich_text?: Array<{ plain_text: string }> };
    return p?.rich_text?.map(b => b.plain_text).join("") || "";
  };

  const getTitle = (prop: unknown): string => {
    const p = prop as { title?: Array<{ plain_text: string }> };
    return p?.title?.[0]?.plain_text || "";
  };

  const getDate = (prop: unknown): string => {
    const p = prop as { date?: { start: string } | null };
    return p?.date?.start || "";
  };

  const getSelect = (prop: unknown): string => {
    const p = prop as { select?: { name: string } | null };
    return p?.select?.name || "";
  };

  const getNumber = (prop: unknown): string => {
    const p = prop as { number?: number | null };
    return p?.number?.toString() || "";
  };

  const getEmail = (prop: unknown): string => {
    const p = prop as { email?: string | null };
    return p?.email || "";
  };

  const getPhone = (prop: unknown): string => {
    const p = prop as { phone_number?: string | null };
    return p?.phone_number || "";
  };

  const getCheckbox = (prop: unknown): boolean => {
    const p = prop as { checkbox?: boolean };
    return p?.checkbox || false;
  };

  let timeline: TrackingEvent[] = [];
  const timelineStr = getText(props["Tracking Timeline"]);
  if (timelineStr) {
    try {
      timeline = JSON.parse(timelineStr);
    } catch {
      timeline = [];
    }
  }

  const paymentMethod = getSelect(props["Payment Method"]);
  const codStatus = getSelect(props["COD Collection Status"]);
  const shippingModeRaw = getSelect(props["Shipping Mode"]);
  const orderTotalProp = props["Order Total"] as { number?: number | null } | undefined;
  const orderTotal = orderTotalProp?.number ?? 0;
  const weightProp = props["Weight (g)"] as { number?: number | null } | undefined;
  const weightGrams = weightProp?.number ?? 0;

  return {
    id: (page as { id: string }).id,
    shopifyOrderId: getNumber(props["Shopify Order ID"]),
    orderNumber: getTitle(props["Order Number"]),
    customerName: getText(props["Customer Name"]),
    customerEmail: getEmail(props["Customer Email"]),
    customerPhone: getPhone(props["Customer Phone"]),
    shippingAddress: getText(props["Shipping Address"]),
    trackingNumber: getText(props["Tracking Number"]),
    courierPartner: getSelect(props["Courier Partner"]),
    paymentMethod: (paymentMethod === "COD" ? "COD" : "Prepaid") as "COD" | "Prepaid",
    orderTotal,
    codCollectionStatus: (codStatus === "Pending" || codStatus === "Collected" ? codStatus : "") as "Pending" | "Collected" | "",
    orderDate: getDate(props["Order Date"]),
    fulfilledDate: getDate(props["Fulfilled Date"]),
    deliveryStatus: (getSelect(props["Delivery Status"]) ||
      "Booked") as DeliveryStatus,
    originCity: getText(props["Origin City"]),
    destinationCity: getText(props["Destination City"]),
    expectedDeliveryDate: getDate(props["Expected Delivery"]),
    deliveredDate: getDate(props["Delivered Date"]),
    deliveredTimestamp: getText(props["Delivered Timestamp"]),
    receiverName: getText(props["Receiver Name"]),
    lastUpdated: getDate(props["Last Updated"]),
    trackingTimeline: timeline,
    rtoTrackingNumber: getText(props["RTO Tracking Number"]),
    reasonCode: getText(props["Reason Code"]),
    reasonDesc: getText(props["Reason Description"]),
    attemptCount: (props["Attempt Count"] as { number?: number | null } | undefined)?.number ?? 0,
    destinationPincode: getText(props["Destination Pincode"]),
    workerMobile: getText(props["Worker Mobile"]),
    deliveryEmailSent: getCheckbox(props["Delivery Email Sent"]),
    reviewEmailSent: getCheckbox(props["Review Email Sent"]),
    shippingMode: (shippingModeRaw || (paymentMethod === "COD" ? "Road" : "Air")) as "Air" | "Road",
    weightGrams,
    shippingChargePaid: getCheckbox(props["Shipping Charge Paid"]),
    cancellationReason: getText(props["Cancellation Reason"]),
    whatsappSent: getCheckbox(props["WhatsApp Sent"]),
    codConfirmationStatus: (getSelect(props["COD Confirmed"]) || "") as CodConfirmationStatus,
    whatsappFollowUpCount: (props["WhatsApp Follow-Up Count"] as { number?: number | null } | undefined)?.number ?? 0,
    whatsappLastFollowUpDate: getText(props["WhatsApp Last Follow-Up"]),
    rtoWhatsappSent: getCheckbox(props["RTO WhatsApp Sent"]),
    rtoConfirmationStatus: (getSelect(props["RTO Confirmed Status"]) || "") as RtoConfirmationStatus,
    rtoFollowUpCount: (props["RTO Follow-Up Count"] as { number?: number | null } | undefined)?.number ?? 0,
    rtoLastFollowUpDate: getText(props["RTO Last Follow-Up"]),
    ofdWhatsappSent: getCheckbox(props["OFD WhatsApp Sent"]),
  };
}

let influencerDbMigrated = false;
async function ensureInfluencerDbProperties(databaseId: string) {
  if (influencerDbMigrated) return;
  try {
    await fetch(`${NOTION_API}/databases/${databaseId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "Phone Number": { rich_text: {} },
          "Instagram Handle": { rich_text: {} },
          "Jaipur Influencer": { checkbox: {} },
          "Products": { rich_text: {} },
          "Courier Partner": {
            select: {
              options: [
                { name: "DTDC", color: "blue" },
                { name: "Hand Delivery", color: "green" },
              ],
            },
          },
        },
      }),
    });
    influencerDbMigrated = true;
  } catch {
    // Properties may already exist, that's fine
    influencerDbMigrated = true;
  }
}

function parseInfluencerShipment(page: Record<string, unknown>): InfluencerShipment {
  const props = page.properties as Record<string, unknown>;

  const getText = (prop: unknown): string => {
    const p = prop as { rich_text?: Array<{ plain_text: string }> };
    return p?.rich_text?.map(b => b.plain_text).join("") || "";
  };

  const getTitle = (prop: unknown): string => {
    const p = prop as { title?: Array<{ plain_text: string }> };
    return p?.title?.[0]?.plain_text || "";
  };

  const getDate = (prop: unknown): string => {
    const p = prop as { date?: { start: string } | null };
    return p?.date?.start || "";
  };

  const getSelect = (prop: unknown): string => {
    const p = prop as { select?: { name: string } | null };
    return p?.select?.name || "";
  };

  let timeline: TrackingEvent[] = [];
  const timelineStr = getText(props["Tracking Timeline"]);
  if (timelineStr) {
    try {
      timeline = JSON.parse(timelineStr);
    } catch {
      timeline = [];
    }
  }

  let products: Product[] = [];
  const productsStr = getText(props["Products"]);
  if (productsStr) {
    try {
      products = JSON.parse(productsStr);
    } catch {
      products = [];
    }
  }

  const getCheckbox = (prop: unknown): boolean => {
    const p = prop as { checkbox?: boolean };
    return p?.checkbox ?? false;
  };

  return {
    id: (page as { id: string }).id,
    label: getTitle(props["Label"]),
    trackingNumber: getText(props["Tracking Number"]),
    courierPartner: getSelect(props["Courier Partner"]),
    deliveryStatus: (getSelect(props["Delivery Status"]) || "Booked") as DeliveryStatus,
    originCity: getText(props["Origin City"]),
    destinationCity: getText(props["Destination City"]),
    expectedDeliveryDate: getDate(props["Expected Delivery"]),
    deliveredDate: getDate(props["Delivered Date"]),
    receiverName: getText(props["Receiver Name"]),
    reasonCode: getText(props["Reason Code"]),
    reasonDesc: getText(props["Reason Description"]),
    attemptCount: (props["Attempt Count"] as { number?: number | null } | undefined)?.number ?? 0,
    destinationPincode: getText(props["Destination Pincode"]),
    workerMobile: getText(props["Worker Mobile"]),
    lastUpdated: getDate(props["Last Updated"]),
    trackingTimeline: timeline,
    createdAt: getDate(props["Created At"]),
    products,
    phoneNumber: getText(props["Phone Number"]),
    instagramHandle: getText(props["Instagram Handle"]),
    isJaipurInfluencer: getCheckbox(props["Jaipur Influencer"]),
    shippingChargePaid: getCheckbox(props["Shipping Charge Paid"]),
  };
}

export async function getInfluencerShipmentById(
  pageId: string
): Promise<InfluencerShipment | null> {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    headers: headers(),
  });
  if (!res.ok) return null;
  const page = await res.json();
  return parseInfluencerShipment(page);
}

export async function updateInfluencerProducts(
  pageId: string,
  products: Product[]
): Promise<void> {
  const productsStr = JSON.stringify(products);
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({
      properties: {
        Products: {
          rich_text: toRichTextBlocks(productsStr),
        },
      },
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`Notion PATCH failed for products on ${pageId}: ${res.status}`, errorBody);
    throw new Error(`Notion update failed: ${res.status}`);
  }
}

export const notionProvider: DataProvider = {
  async getOrders(filters?: OrderFilters): Promise<Order[]> {
    const databaseId = await getDatabaseId();

    const filterConditions: Record<string, unknown>[] = [];

    if (filters?.status) {
      filterConditions.push({
        property: "Delivery Status",
        select: { equals: filters.status },
      });
    }

    if (filters?.hideDelivered) {
      filterConditions.push({
        property: "Delivery Status",
        select: { does_not_equal: "Delivered" },
      });
    }

    let filter: Record<string, unknown> | undefined;
    if (filterConditions.length === 1) {
      filter = filterConditions[0];
    } else if (filterConditions.length > 1) {
      filter = { and: filterConditions };
    }

    const sorts = [{ property: "Shopify Order ID", direction: "descending" }];
    const results = await queryDatabase(databaseId, filter, sorts);
    let orders = results.map((page) => parseOrder(page));

    // Hide initial test orders (#1024 and below)
    orders = orders.filter((o) => {
      const num = parseInt(o.orderNumber.replace(/\D/g, ""), 10);
      return !isNaN(num) && num > 1025;
    });

    // Always hide Cancelled from the dashboard — they're visible in Shopify admin only
    orders = orders.filter((o) => o.deliveryStatus !== "Cancelled");

    // Client-side filter: hide terminal statuses (can't filter in Notion until option exists)
    if (filters?.hideDelivered) {
      orders = orders.filter(
        (o) =>
          o.deliveryStatus !== "RTO Received" &&
          o.deliveryStatus !== "Return Complete"
      );
    }

    if (filters?.search) {
      const search = filters.search.toLowerCase();
      orders = orders.filter(
        (o) =>
          o.orderNumber.toLowerCase().includes(search) ||
          o.customerName.toLowerCase().includes(search) ||
          o.trackingNumber.toLowerCase().includes(search) ||
          o.destinationCity.toLowerCase().includes(search)
      );
    }

    // Client-side filter: Shipping Mode (can't filter in Notion until property exists)
    if (filters?.shippingMode) {
      orders = orders.filter((o) => o.shippingMode === filters.shippingMode);
    }

    return orders;
  },

  async upsertOrder(order: Omit<Order, "id">): Promise<Order> {
    const databaseId = await getDatabaseId();

    // Check if order exists
    const existing = await queryDatabase(databaseId, {
      property: "Shopify Order ID",
      number: { equals: parseInt(order.shopifyOrderId) },
    });

    const properties: Record<string, unknown> = {
      "Order Number": {
        title: [{ text: { content: order.orderNumber } }],
      },
      "Shopify Order ID": { number: parseInt(order.shopifyOrderId) },
      "Customer Name": {
        rich_text: [{ text: { content: order.customerName } }],
      },
      "Customer Email": { email: order.customerEmail || null },
      "Customer Phone": { phone_number: order.customerPhone || null },
      "Shipping Address": {
        rich_text: [{ text: { content: order.shippingAddress } }],
      },
      "Tracking Number": {
        rich_text: [{ text: { content: order.trackingNumber } }],
      },
      "Courier Partner": {
        select: { name: order.courierPartner || "DTDC" },
      },
      "Delivery Status": {
        select: { name: order.deliveryStatus || "Booked" },
      },
      "Payment Method": {
        select: { name: order.paymentMethod },
      },
      "Order Total": { number: order.orderTotal },
    };

    if (order.codCollectionStatus) {
      properties["COD Collection Status"] = {
        select: { name: order.codCollectionStatus },
      };
    }

    if (order.orderDate) {
      properties["Order Date"] = { date: { start: order.orderDate } };
    }
    if (order.fulfilledDate) {
      properties["Fulfilled Date"] = {
        date: { start: order.fulfilledDate },
      };
    }

    if (existing.length > 0) {
      const pageId = (existing[0] as { id: string }).id;
      // Don't overwrite these fields on re-sync — they are managed by other flows
      const updateProps = { ...properties };
      delete updateProps["Delivery Status"];
      delete updateProps["COD Collection Status"];
      delete updateProps["WhatsApp Sent"];
      delete updateProps["COD Confirmed"];
      delete updateProps["RTO WhatsApp Sent"];
      delete updateProps["RTO Confirmed Status"];
      delete updateProps["OFD WhatsApp Sent"];
      // Payment Method is set at order time and is only reliably knowable at creation
      // (COD = financial_status "pending", Prepaid = "paid"). Once a COD order leaves
      // "pending" (cash collected / cancelled / returned) it is indistinguishable from a
      // manual-marked prepaid, so re-deriving on sync would wrongly flip COD → Prepaid.
      // Keep it immutable after the first capture.
      delete updateProps["Payment Method"];
      const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ properties: updateProps }),
      });
      const data = await res.json();
      return parseOrder(data);
    } else {
      const res = await fetch(`${NOTION_API}/pages`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties,
        }),
      });
      const data = await res.json();
      return parseOrder(data);
    }
  },

  async updateOrderTracking(
    trackingNumber: string,
    data: {
      deliveryStatus: DeliveryStatus;
      originCity: string;
      destinationCity: string;
      expectedDeliveryDate: string;
      deliveredDate: string;
      deliveredTimestamp: string;
      receiverName: string;
      rtoNumber: string;
      reasonCode: string;
      reasonDesc: string;
      attemptCount: number;
      destinationPincode: string;
      workerMobile: string;
      lastUpdated: string;
      trackingTimeline: TrackingEvent[];
    },
    knownPageId?: string
  ): Promise<void> {
    const dbId = await getDatabaseId();
    await ensureDtdcFieldProperties(dbId, false);

    let pageId = knownPageId;

    if (!pageId) {
      const existing = await queryDatabase(dbId, {
        property: "Tracking Number",
        rich_text: { equals: trackingNumber },
      });
      if (existing.length === 0) return;
      pageId = (existing[0] as { id: string }).id;
    }
    const timelineStr = JSON.stringify(data.trackingTimeline);

    const properties: Record<string, unknown> = {
      "Delivery Status": { select: { name: data.deliveryStatus } },
      "Origin City": {
        rich_text: [{ text: { content: data.originCity } }],
      },
      "Destination City": {
        rich_text: [{ text: { content: data.destinationCity } }],
      },
      "Receiver Name": {
        rich_text: [{ text: { content: data.receiverName } }],
      },
      "Reason Code": {
        rich_text: [{ text: { content: data.reasonCode } }],
      },
      "Reason Description": {
        rich_text: [{ text: { content: data.reasonDesc } }],
      },
      "Attempt Count": { number: data.attemptCount || null },
      "Destination Pincode": {
        rich_text: [{ text: { content: data.destinationPincode } }],
      },
      "Worker Mobile": {
        rich_text: [{ text: { content: data.workerMobile } }],
      },
      "Last Updated": { date: { start: data.lastUpdated } },
      "Tracking Timeline": {
        rich_text: toRichTextBlocks(timelineStr),
      },
    };

    // Auto-populate RTO tracking number from DTDC if provided
    if (data.rtoNumber) {
      properties["RTO Tracking Number"] = {
        rich_text: [{ text: { content: data.rtoNumber } }],
      };
    }

    if (data.expectedDeliveryDate) {
      properties["Expected Delivery"] = {
        date: { start: data.expectedDeliveryDate },
      };
    }
    if (data.deliveredDate) {
      properties["Delivered Date"] = {
        date: { start: data.deliveredDate },
      };
    }
    if (data.deliveredTimestamp) {
      properties["Delivered Timestamp"] = {
        rich_text: [{ text: { content: data.deliveredTimestamp } }],
      };
    }

    const patchRes = await fetch(`${NOTION_API}/pages/${pageId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ properties }),
    });

    if (!patchRes.ok) {
      const errorBody = await patchRes.text();
      console.error(`Notion PATCH failed for tracking ${trackingNumber}: ${patchRes.status}`, errorBody);
      throw new Error(`Notion update failed: ${patchRes.status}`);
    }
  },

  async getActiveOrders(): Promise<Order[]> {
    const databaseId = await getDatabaseId();

    const results = await queryDatabase(databaseId, {
      and: [
        { property: "Delivery Status", select: { does_not_equal: "Delivered" } },
        { property: "Delivery Status", select: { does_not_equal: "RTO Received" } },
        { property: "Delivery Status", select: { does_not_equal: "Return Complete" } },
        { property: "Delivery Status", select: { does_not_equal: "Cancelled" } },
      ],
    });

    let orders = results.map((page) => parseOrder(page));

    // Exclude test orders (#1025 and below)
    orders = orders.filter((o) => {
      const num = parseInt(o.orderNumber.replace(/\D/g, ""), 10);
      return !isNaN(num) && num > 1025;
    });

    return orders;
  },

  async assignTracking(
    orderId: string,
    trackingNumber: string,
    courierPartner: string
  ): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const res = await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "Tracking Number": {
            rich_text: [{ text: { content: trackingNumber } }],
          },
          "Delivery Status": { select: { name: "Booked" } },
          "Courier Partner": { select: { name: courierPartner || "DTDC" } },
          "Fulfilled Date": { date: { start: today } },
          "Last Updated": { date: { start: today } },
        },
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Notion assignTracking failed for ${orderId}: ${res.status}`, errorBody);
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  async getOrderById(orderId: string): Promise<Order | null> {
    const res = await fetch(`${NOTION_API}/pages/${orderId}`, {
      headers: headers(),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`getOrderById failed for ${orderId}: ${res.status}`, errorBody);
      return null;
    }
    const page = await res.json();
    return parseOrder(page);
  },

  async updateDeliveryStatus(orderId: string, status: DeliveryStatus): Promise<void> {
    await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "Delivery Status": { select: { name: status } },
        },
      }),
    });
  },

  async updateCodStatus(orderId: string, status: "Pending" | "Collected"): Promise<void> {
    await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "COD Collection Status": { select: { name: status } },
        },
      }),
    });
  },

  async updateShippingMode(orderId: string, mode: "Air" | "Road"): Promise<void> {
    // Ensure the "Shipping Mode" property exists on the database
    if (!shippingModePropertyCreated) {
      const databaseId = await getDatabaseId();
      await fetch(`${NOTION_API}/databases/${databaseId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          properties: {
            "Shipping Mode": {
              select: {
                options: [
                  { name: "Air", color: "blue" },
                  { name: "Road", color: "orange" },
                ],
              },
            },
          },
        }),
      });
      shippingModePropertyCreated = true;
    }

    const res = await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "Shipping Mode": { select: { name: mode } },
        },
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Notion updateShippingMode failed for ${orderId}: ${res.status}`, errorBody);
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  async updateOrderWeight(orderId: string, weightGrams: number): Promise<void> {
    if (!weightPropertyCreated) {
      const databaseId = await getDatabaseId();
      await fetch(`${NOTION_API}/databases/${databaseId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          properties: {
            "Weight (g)": { number: {} },
          },
        }),
      });
      weightPropertyCreated = true;
    }

    const res = await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "Weight (g)": { number: weightGrams },
        },
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Notion updateOrderWeight failed for ${orderId}: ${res.status}`, errorBody);
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  async updateShippingChargePaid(orderId: string, paid: boolean): Promise<void> {
    if (!shippingChargePaidPropertyCreated) {
      const databaseId = await getDatabaseId();
      await fetch(`${NOTION_API}/databases/${databaseId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          properties: {
            "Shipping Charge Paid": { checkbox: {} },
          },
        }),
      });
      shippingChargePaidPropertyCreated = true;
    }

    const res = await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "Shipping Charge Paid": { checkbox: paid },
        },
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Notion updateShippingChargePaid failed for ${orderId}: ${res.status}`, errorBody);
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  async updateRtoTracking(orderId: string, rtoTrackingNumber: string): Promise<void> {
    await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "RTO Tracking Number": {
            rich_text: [{ text: { content: rtoTrackingNumber } }],
          },
        },
      }),
    });
  },

  async markEmailSent(orderId: string): Promise<void> {
    await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "Delivery Email Sent": { checkbox: true },
        },
      }),
    });
  },

  async markReviewEmailSent(orderId: string): Promise<void> {
    if (!reviewEmailPropertyCreated) {
      const databaseId = await getDatabaseId();
      await fetch(`${NOTION_API}/databases/${databaseId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          properties: {
            "Review Email Sent": { checkbox: {} },
          },
        }),
      });
      reviewEmailPropertyCreated = true;
    }

    await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "Review Email Sent": { checkbox: true },
        },
      }),
    });
  },

  async cancelOrder(orderId: string, reason: string): Promise<void> {
    // Ensure the "Cancellation Reason" property exists
    if (!cancelReasonPropertyCreated) {
      const databaseId = await getDatabaseId();
      await fetch(`${NOTION_API}/databases/${databaseId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          properties: {
            "Cancellation Reason": { rich_text: {} },
          },
        }),
      });
      cancelReasonPropertyCreated = true;
    }

    const now = new Date().toISOString().split("T")[0];
    const res = await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "Delivery Status": { select: { name: "Cancelled" } },
          "Cancellation Reason": {
            rich_text: [{ text: { content: reason } }],
          },
          "Last Updated": { date: { start: now } },
        },
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Notion cancelOrder failed for ${orderId}: ${res.status}`, errorBody);
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  async markWhatsAppSent(orderId: string, isCod: boolean): Promise<void> {
    void isCod;
    if (!whatsappPropertyCreated) {
      const databaseId = await getDatabaseId();
      const schemaRes = await fetch(`${NOTION_API}/databases/${databaseId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          properties: {
            "WhatsApp Sent": { checkbox: {} },
            "COD Confirmed": {
              select: {
                options: [
                  { name: "Confirmed on Call", color: "green" },
                  { name: "Confirmed on WhatsApp", color: "blue" },
                  { name: "Declined", color: "red" },
                  { name: "No Reply", color: "gray" },
                ],
              },
            },
          },
        }),
      });
      if (!schemaRes.ok) {
        const body = await schemaRes.text();
        console.error(`Failed to create WhatsApp schema properties: ${schemaRes.status}`, body);
        // Do NOT throw — the WhatsApp Sent checkbox may already exist and
        // the COD Confirmed field may just be in a non-select shape. Try the
        // write with WhatsApp Sent alone below.
      } else {
        whatsappPropertyCreated = true;
      }
    }

    // First try writing both fields. If Notion rejects (e.g. COD Confirmed has
    // the wrong property type), retry with just WhatsApp Sent so the dashboard
    // still reflects the action.
    const fullProps: Record<string, unknown> = {
      "WhatsApp Sent": { checkbox: true },
      "COD Confirmed": { select: { name: "No Reply" } },
    };

    const fullRes = await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ properties: fullProps }),
    });
    if (fullRes.ok) return;

    const fullBody = await fullRes.text();
    console.error(
      `Notion markWhatsAppSent (full) failed for ${orderId}: ${fullRes.status}`,
      fullBody
    );

    const fallbackRes = await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: { "WhatsApp Sent": { checkbox: true } },
      }),
    });
    if (!fallbackRes.ok) {
      const fbBody = await fallbackRes.text();
      console.error(
        `Notion markWhatsAppSent (fallback) failed for ${orderId}: ${fallbackRes.status}`,
        fbBody
      );
      throw new Error(
        `Notion update failed: ${fullRes.status} / fallback ${fallbackRes.status} — ${fbBody.slice(0, 200)}`
      );
    }
  },

  async updateCodConfirmation(orderId: string, status: "Confirmed on Call" | "Confirmed on WhatsApp" | "Declined" | "No Reply"): Promise<void> {
    const res = await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "COD Confirmed": { select: { name: status } },
        },
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Notion updateCodConfirmation failed for ${orderId}: ${res.status}`, errorBody);
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  async recordWhatsAppFollowUp(orderId: string): Promise<void> {
    if (!followUpPropertyCreated) {
      const databaseId = await getDatabaseId();
      const schemaRes = await fetch(`${NOTION_API}/databases/${databaseId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          properties: {
            "WhatsApp Follow-Up Count": { number: {} },
            "WhatsApp Last Follow-Up": { rich_text: {} },
          },
        }),
      });
      if (!schemaRes.ok) {
        const body = await schemaRes.text();
        console.error(`Failed to create follow-up schema properties: ${schemaRes.status}`, body);
        throw new Error(`Notion schema update failed: ${schemaRes.status} — ${body.slice(0, 200)}`);
      }
      followUpPropertyCreated = true;
    }

    // Read current count
    const page = await this.getOrderById(orderId);
    const currentCount = page?.whatsappFollowUpCount || 0;

    const res = await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "WhatsApp Follow-Up Count": { number: currentCount + 1 },
          "WhatsApp Last Follow-Up": {
            rich_text: [{ text: { content: new Date().toISOString() } }],
          },
        },
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Notion recordWhatsAppFollowUp failed for ${orderId}: ${res.status}`, errorBody);
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  async markRtoWhatsAppSent(orderId: string): Promise<void> {
    if (!rtoWhatsappPropertyCreated) {
      const databaseId = await getDatabaseId();
      const schemaRes = await fetch(`${NOTION_API}/databases/${databaseId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          properties: {
            "RTO WhatsApp Sent": { checkbox: {} },
            "RTO Confirmed Status": {
              select: {
                options: [
                  { name: "Reachable", color: "green" },
                  { name: "Cancel", color: "red" },
                  { name: "No Reply", color: "gray" },
                ],
              },
            },
          },
        }),
      });
      if (!schemaRes.ok) {
        const body = await schemaRes.text();
        console.error(`Failed to create RTO WhatsApp schema properties: ${schemaRes.status}`, body);
        throw new Error(`Notion schema update failed: ${schemaRes.status}`);
      }
      rtoWhatsappPropertyCreated = true;
    }

    const res = await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "RTO WhatsApp Sent": { checkbox: true },
          "RTO Confirmed Status": { select: { name: "No Reply" } },
        },
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Notion markRtoWhatsAppSent failed for ${orderId}: ${res.status}`, errorBody);
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  async updateRtoConfirmation(orderId: string, status: "Reachable" | "Cancel" | "No Reply"): Promise<void> {
    const res = await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "RTO Confirmed Status": { select: { name: status } },
        },
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Notion updateRtoConfirmation failed for ${orderId}: ${res.status}`, errorBody);
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  async markOfdWhatsAppSent(orderId: string): Promise<void> {
    if (!ofdWhatsappPropertyCreated) {
      const databaseId = await getDatabaseId();
      const schemaRes = await fetch(`${NOTION_API}/databases/${databaseId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          properties: {
            "OFD WhatsApp Sent": { checkbox: {} },
          },
        }),
      });
      if (!schemaRes.ok) {
        const body = await schemaRes.text();
        console.error(`Failed to create OFD WhatsApp schema property: ${schemaRes.status}`, body);
        throw new Error(`Notion schema update failed: ${schemaRes.status}`);
      }
      ofdWhatsappPropertyCreated = true;
    }

    const res = await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "OFD WhatsApp Sent": { checkbox: true },
        },
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Notion markOfdWhatsAppSent failed for ${orderId}: ${res.status}`, errorBody);
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  async recordRtoFollowUp(orderId: string): Promise<void> {
    if (!rtoFollowUpPropertyCreated) {
      const databaseId = await getDatabaseId();
      const schemaRes = await fetch(`${NOTION_API}/databases/${databaseId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          properties: {
            "RTO Follow-Up Count": { number: {} },
            "RTO Last Follow-Up": { rich_text: {} },
          },
        }),
      });
      if (!schemaRes.ok) {
        const body = await schemaRes.text();
        console.error(`Failed to create RTO follow-up schema properties: ${schemaRes.status}`, body);
        throw new Error(`Notion schema update failed: ${schemaRes.status}`);
      }
      rtoFollowUpPropertyCreated = true;
    }

    const page = await this.getOrderById(orderId);
    const currentCount = page?.rtoFollowUpCount || 0;

    const res = await fetch(`${NOTION_API}/pages/${orderId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "RTO Follow-Up Count": { number: currentCount + 1 },
          "RTO Last Follow-Up": {
            rich_text: [{ text: { content: new Date().toISOString() } }],
          },
        },
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Notion recordRtoFollowUp failed for ${orderId}: ${res.status}`, errorBody);
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  // Influencer Shipments
  async getInfluencerShipments(): Promise<InfluencerShipment[]> {
    const databaseId = await getInfluencerDatabaseId();
    const sorts = [{ property: "Created At", direction: "descending" }];
    const results = await queryDatabase(databaseId, undefined, sorts);
    return results.map((page) => parseInfluencerShipment(page));
  },

  async createInfluencerShipment(shipment: {
    label: string;
    trackingNumber: string;
    phoneNumber: string;
    instagramHandle?: string;
    isJaipurInfluencer?: boolean;
  }): Promise<InfluencerShipment> {
    const databaseId = await getInfluencerDatabaseId();
    const now = new Date().toISOString().split("T")[0];
    const isJaipur = shipment.isJaipurInfluencer ?? false;

    // Ensure new properties exist in the database schema
    await ensureInfluencerDbProperties(databaseId);

    const properties: Record<string, unknown> = {
      Label: {
        title: [{ text: { content: shipment.label || "Untitled" } }],
      },
      "Phone Number": {
        rich_text: [{ text: { content: shipment.phoneNumber || "" } }],
      },
      "Courier Partner": { select: { name: isJaipur ? "Hand Delivery" : "DTDC" } },
      "Delivery Status": { select: { name: "Booked" } },
      "Created At": { date: { start: now } },
      "Last Updated": { date: { start: now } },
      "Jaipur Influencer": { checkbox: isJaipur },
    };

    if (!isJaipur && shipment.trackingNumber) {
      properties["Tracking Number"] = {
        rich_text: [{ text: { content: shipment.trackingNumber } }],
      };
    }

    if (isJaipur) {
      properties["Destination City"] = {
        rich_text: [{ text: { content: "Jaipur" } }],
      };
    }

    if (shipment.instagramHandle) {
      properties["Instagram Handle"] = {
        rich_text: [{ text: { content: shipment.instagramHandle } }],
      };
    }

    const res = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties,
      }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Notion create influencer shipment failed: ${res.status}`, errorBody);
      throw new Error(`Notion create failed: ${res.status}`);
    }

    const data = await res.json();
    return parseInfluencerShipment(data);
  },

  async getActiveInfluencerShipments(): Promise<InfluencerShipment[]> {
    const databaseId = await getInfluencerDatabaseId();
    const results = await queryDatabase(databaseId, {
      property: "Delivery Status",
      select: { does_not_equal: "Delivered" },
    });
    return results.map((page) => parseInfluencerShipment(page));
  },

  async updateInfluencerTracking(
    trackingNumber: string,
    data: {
      deliveryStatus: DeliveryStatus;
      originCity: string;
      destinationCity: string;
      expectedDeliveryDate: string;
      deliveredDate: string;
      receiverName: string;
      reasonCode: string;
      reasonDesc: string;
      attemptCount: number;
      destinationPincode: string;
      workerMobile: string;
      lastUpdated: string;
      trackingTimeline: TrackingEvent[];
    }
  ): Promise<void> {
    const databaseId = await getInfluencerDatabaseId();
    await ensureDtdcFieldProperties(databaseId, true);

    const existing = await queryDatabase(databaseId, {
      property: "Tracking Number",
      rich_text: { equals: trackingNumber },
    });

    if (existing.length === 0) return;

    const pageId = (existing[0] as { id: string }).id;
    const timelineStr = JSON.stringify(data.trackingTimeline);

    const properties: Record<string, unknown> = {
      "Delivery Status": { select: { name: data.deliveryStatus } },
      "Origin City": {
        rich_text: [{ text: { content: data.originCity } }],
      },
      "Destination City": {
        rich_text: [{ text: { content: data.destinationCity } }],
      },
      "Receiver Name": {
        rich_text: [{ text: { content: data.receiverName } }],
      },
      "Reason Code": {
        rich_text: [{ text: { content: data.reasonCode } }],
      },
      "Reason Description": {
        rich_text: [{ text: { content: data.reasonDesc } }],
      },
      "Attempt Count": { number: data.attemptCount || null },
      "Destination Pincode": {
        rich_text: [{ text: { content: data.destinationPincode } }],
      },
      "Worker Mobile": {
        rich_text: [{ text: { content: data.workerMobile } }],
      },
      "Last Updated": { date: { start: data.lastUpdated } },
      "Tracking Timeline": {
        rich_text: toRichTextBlocks(timelineStr),
      },
    };

    if (data.expectedDeliveryDate) {
      properties["Expected Delivery"] = {
        date: { start: data.expectedDeliveryDate },
      };
    }
    if (data.deliveredDate) {
      properties["Delivered Date"] = {
        date: { start: data.deliveredDate },
      };
    }

    await fetch(`${NOTION_API}/pages/${pageId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ properties }),
    });
  },

  async updateInfluencerTrackingNumber(
    shipmentId: string,
    trackingNumber: string
  ): Promise<void> {
    const now = new Date().toISOString().split("T")[0];
    const properties: Record<string, unknown> = {
      "Tracking Number": {
        rich_text: [{ text: { content: trackingNumber } }],
      },
      "Last Updated": { date: { start: now } },
    };
    if (trackingNumber) {
      properties["Courier Partner"] = { select: { name: "DTDC" } };
    }
    const res = await fetch(`${NOTION_API}/pages/${shipmentId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Failed to update influencer tracking number: ${res.status}`, errorBody);
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  async markInfluencerDelivered(shipmentId: string): Promise<void> {
    const now = new Date().toISOString().split("T")[0];
    const res = await fetch(`${NOTION_API}/pages/${shipmentId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "Delivery Status": { select: { name: "Delivered" } },
          "Delivered Date": { date: { start: now } },
          "Last Updated": { date: { start: now } },
        },
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Failed to mark delivered: ${res.status}`, errorBody);
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  async updateInfluencerShippingChargePaid(
    shipmentId: string,
    paid: boolean
  ): Promise<void> {
    if (!influencerShippingChargePaidPropertyCreated) {
      const dbId = await getInfluencerDatabaseId();
      await fetch(`${NOTION_API}/databases/${dbId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          properties: {
            "Shipping Charge Paid": { checkbox: {} },
          },
        }),
      });
      influencerShippingChargePaidPropertyCreated = true;
    }

    const res = await fetch(`${NOTION_API}/pages/${shipmentId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          "Shipping Charge Paid": { checkbox: paid },
        },
      }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(
        `Notion updateInfluencerShippingChargePaid failed for ${shipmentId}: ${res.status}`,
        errorBody
      );
      throw new Error(`Notion update failed: ${res.status}`);
    }
  },

  async getOrCreateInvoiceNumber(input: InvoiceLogInput) {
    // Serialize so two concurrent generations can't grab the same number.
    // (Single Next.js server + single admin -> an in-process lock is enough;
    // Notion has no cross-process transactions.)
    const p = invoiceMutex.then(() => assignInvoiceNumber(input));
    invoiceMutex = p;
    return p;
  },

  getInvoiceStartNumber(fy: string) {
    return getInvoiceStartNumber(fy);
  },

  setInvoiceStartNumber(fy: string, n: number) {
    return setInvoiceStartNumber(fy, n);
  },

  getMaxInvoiceSequence(fy: string) {
    return getMaxInvoiceSequence(fy);
  },

  getInvoiceHideCodFee() {
    return getFlagRow(HIDE_COD_FEE_PROP).then(
      (v) => v ?? DEFAULT_HIDE_COD_FEE
    );
  },

  setInvoiceHideCodFee(hide: boolean) {
    return setFlagRow(HIDE_COD_FEE_PROP, hide);
  },

  async getInvoicePriceOverride(
    shopifyOrderId
  ): Promise<InvoicePriceOverride | null> {
    const dbId = await getInvoicesDatabaseId();
    const rows = await queryDatabase(dbId, {
      property: "Shopify Order ID",
      rich_text: { equals: shopifyOrderId },
    });
    if (rows.length === 0) return null;
    const props = (rows[0] as { properties: Record<string, unknown> }).properties;
    return readPriceOverride(props);
  },

  // Overwrite the frozen line-item snapshot on a ledger row (backfill / fixes).
  async setInvoiceLineItems(
    pageId: string,
    lines: InvoiceLineSnapshot[]
  ): Promise<void> {
    const dbId = await getInvoicesDatabaseId();
    await ensureInvoiceTypeProps(dbId);
    await patchLineItems(pageId, lines);
  },

  async setInvoicePriceOverride(
    shopifyOrderId: string,
    o: InvoicePriceOverride | null
  ): Promise<void> {
    const dbId = await getInvoicesDatabaseId();
    await ensurePriceOverrideProps(dbId);
    const rows = await queryDatabase(dbId, {
      property: "Shopify Order ID",
      rich_text: { equals: shopifyOrderId },
    });
    if (rows.length === 0)
      throw new Error(`No invoice ledger row for order ${shopifyOrderId}`);
    const pageId = (rows[0] as { id: string }).id;
    const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        properties: {
          [PRICE_OVERRIDE_PROP]: {
            rich_text: o ? [{ text: { content: JSON.stringify(o) } }] : [],
          },
        },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to save price override: ${err.slice(0, 200)}`);
    }
  },

  // Record a wholesale invoice issued outside the tool, then re-order the
  // unfiled part of the series so every invoice number follows date order.
  // The PDF (if supplied) is attached to the row for the record.
  async createWholesaleInvoice(
    input: WholesaleInvoiceInput,
    pdf?: { filename: string; data: Buffer }
  ): Promise<{ pageId: string; invoiceNo: string; renumbered: RenumberChange[] }> {
    // Serialize against concurrent retail numbering: the renumber walk and
    // assignInvoiceNumber both read the same FY rows.
    const p = invoiceMutex.then(async () => {
      let attachError: string | undefined;
      // Notion caps each uploaded file (free plan: 5 MiB); photo-heavy seller
      // PDFs can exceed it, so recompress before the row is created — a
      // failure here aborts cleanly before anything is recorded.
      if (pdf) {
        pdf = { ...pdf, data: await compressPdfForUpload(pdf.data) };
      }
      const dbId = await getInvoicesDatabaseId();
      await ensureInvoiceTypeProps(dbId);

      const fy = financialYear(new Date(`${input.invoiceDate}T12:00:00`));
      const placeOfSupply = `${GST_STATE_CODES[input.stateCode] || "??"}-${GST_STATE_NAMES[input.stateCode] || ""}`;
      const properties: Record<string, unknown> = {
        // Renumbering below mints the real number; the empty title marks the
        // just-added row (it sorts by date like any other).
        "Invoice No": { title: [{ text: { content: "" } }] },
        "Invoice Date": { date: { start: input.invoiceDate } },
        Customer: { rich_text: [{ text: { content: input.customerName } }] },
        "Place of Supply": { rich_text: [{ text: { content: placeOfSupply } }] },
        "Taxable Value": { number: input.taxableValue },
        CGST: { number: input.cgst },
        SGST: { number: input.sgst },
        IGST: { number: input.igst },
        "Grand Total": { number: input.grandTotal },
        FY: { rich_text: [{ text: { content: fy } }] },
        Status: { select: { name: "Issued" } },
        [TYPE_PROP]: { select: { name: TYPE_WHOLESALE } },
        [QTY_PROP]: { number: input.quantity },
      };
      if (input.gstin.trim()) {
        properties[GSTIN_PROP] = {
          rich_text: [{ text: { content: input.gstin.trim().toUpperCase() } }],
        };
      }
      if (input.hsn.trim()) {
        properties[HSN_PROP] = {
          rich_text: [{ text: { content: input.hsn.trim() } }],
        };
      }
      if (input.reference) {
        properties["Order Number"] = {
          rich_text: [{ text: { content: input.reference } }],
        };
      }
      const res = await fetch(`${NOTION_API}/pages`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ parent: { database_id: dbId }, properties }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Failed to create wholesale invoice row: ${err.slice(0, 200)}`);
      }
      const pageId = (await res.json()).id as string;

      const renumberResult = await renumberUnfiled(fy);
      const renumbered = renumberResult.changed;
      if (renumberResult.errors.length > 0) {
        const restampMsg = renumberResult.errors.join("; ");
        attachError = attachError ? `${attachError}; restamp: ${restampMsg}` : restampMsg;
      }
      // Freeze the seller PDF's item table on the row — the issued invoice's
      // lines become the source of truth for GSTR-1. Parse failure leaves the
      // snapshot empty; stamping reports the read failure below.
      let originalInvoiceNo = "";
      let lineItems: InvoiceLineSnapshot[] = [];
      if (pdf) {
        try {
          const parsed = await parseInvoicePdf(pdf.data);
          originalInvoiceNo = parsed.originalInvoiceNo;
          lineItems = parsedItemsToSnapshot(parsed.items);
        } catch (e) {
          console.error("Parsing the original PDF for the snapshot failed:", e);
        }
      }

      // Read back the number the renumber pass gave this row — the re-issued
      // PDF must print exactly that number.
      const rows = await queryDatabase(dbId, {
        property: "FY",
        rich_text: { equals: fy },
      });
      const mine = rows.find((r) => (r as { id: string }).id === pageId);
      const titleProp = ((mine as { properties?: Record<string, unknown> })
        ?.properties?.["Invoice No"] ?? {}) as {
        title?: Array<{ plain_text: string }>;
      };
      const invoiceNo = titleProp.title?.[0]?.plain_text || "";

      // Snapshot: written even when an attachment below fails — the frozen
      // lines are what GSTR-1 trusts.
      try {
        await patchLineItems(pageId, lineItems);
      } catch (e) {
        console.error("Line-item snapshot write failed:", e);
      }

      // Attachments: the seller's original goes to "Original PDF" for audit;
      // a stamped copy — our UN/FY number drawn over the original's — goes to
      // "Invoice PDF". The row stands even if either attachment fails — the
      // error is reported to the caller so the dialog can flag it.
      if (pdf) {
        try {
          await attachInvoicePdf(pageId, ORIG_PDF_PROP, pdf.filename, pdf.data);
        } catch (e) {
          attachError = `original: ${e instanceof Error ? e.message : String(e)}`;
          console.error("Original PDF attachment failed:", e);
        }
        try {
          if (!originalInvoiceNo) {
            throw new Error("could not read the original invoice number from the PDF");
          }
          const stamped = await stampInvoiceNumber(
            pdf.data,
            originalInvoiceNo,
            invoiceNo
          );
          await attachInvoicePdf(
            pageId,
            PDF_PROP,
            `invoice-${invoiceNo.replace(/\//g, "-")}.pdf`,
            stamped.bytes
          );
        } catch (e) {
          // No stamped copy — put the untouched original on "Invoice PDF" so
          // the row still opens to a document.
          const msg = e instanceof Error ? e.message : String(e);
          attachError = attachError
            ? `${attachError}; stamped copy: ${msg}`
            : `stamped copy: ${msg}`;
          console.error("Stamping the original PDF failed:", e);
          if (pdf) {
            try {
              await attachInvoicePdf(pageId, PDF_PROP, pdf.filename, pdf.data);
            } catch (e2) {
              console.error("Fallback original attachment failed:", e2);
            }
          }
        }
      }

      return {
        pageId,
        invoiceNo,
        renumbered,
        attachError,
      };
    });
    invoiceMutex = p;
    return p;
  },

  async setInvoiceFiled(pageId: string, filed: boolean): Promise<void> {
    const dbId = await getInvoicesDatabaseId();
    await ensureInvoiceTypeProps(dbId);
    const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ properties: { [FILED_PROP]: { checkbox: filed } } }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to save filed flag: ${err.slice(0, 200)}`);
    }
  },

  // Attach (or re-attach) the seller's original PDF on an existing ledger row.
  async attachWholesalePdf(
    pageId: string,
    filename: string,
    pdfData: Buffer
  ): Promise<void> {
    await attachInvoicePdf(pageId, ORIG_PDF_PROP, filename, await compressPdfForUpload(pdfData));
  },

  // Stamp the row's UN/FY number over the seller-software number in the
  // original PDF: the document stays byte-for-byte the seller's except for
  // that one line of text, so the printed number matches the filed series.
  // The untouched original moves to "Original PDF"; the stamped copy replaces
  // whatever sat in "Invoice PDF".
  async regenerateWholesalePdf(pageId: string): Promise<{ invoiceNo: string }> {
    await ensureInvoiceTypeProps(await getInvoicesDatabaseId());
    const pageRes = await fetch(`${NOTION_API}/pages/${pageId}`, { headers: headers() });
    if (!pageRes.ok) {
      throw new Error(`Failed to read ledger row (${pageRes.status}).`);
    }
    const props = ((await pageRes.json()) as { properties?: Record<string, unknown> })
      .properties ?? {};
    const title = (props["Invoice No"] as { title?: Array<{ plain_text: string }> })
      ?.title?.[0]?.plain_text || "";
    if (!title) throw new Error("Row has no invoice number yet — save it via upload first.");

    const files = (key: string) =>
      (props[key] as {
        files?: Array<{ type: string; file?: { url?: string }; external?: { url?: string } }>;
      })?.files || [];
    const fileUrl = (key: string) =>
      files(key).map((f) => f.file?.url || f.external?.url || "").find(Boolean) || "";

    // The seller's original: prefer "Original PDF", fall back to a PDF still
    // sitting in "Invoice PDF" (pre-regeneration rows).
    const origUrl = fileUrl(ORIG_PDF_PROP) || fileUrl(PDF_PROP);
    if (!origUrl) {
      throw new Error(
        "No original PDF on this row — use 'Attach PDF' to upload the seller's invoice first."
      );
    }
    const buf = await compressPdfForUpload(
      Buffer.from(await (await fetch(origUrl)).arrayBuffer())
    );
    const parsed = await parseInvoicePdf(buf);
    const originalNo =
      parsed.originalInvoiceNo ||
      (props["Order Number"] as { rich_text?: Array<{ plain_text: string }> })
        ?.rich_text?.map((b) => b.plain_text).join("").trim() ||
      "";
    if (!originalNo) {
      throw new Error(
        "Could not read the original invoice number from the PDF — nothing stamped."
      );
    }
    const stamped = await stampInvoiceNumber(buf, originalNo, title);

    // Move the untouched original to its own property first (skipped when it
    // already lives there), then replace "Invoice PDF" with the stamped copy —
    // a failure here leaves the original in place, never lost.
    if (fileUrl(ORIG_PDF_PROP) !== origUrl) {
      await attachInvoicePdf(pageId, ORIG_PDF_PROP, "original.pdf", buf);
    }
    await attachInvoicePdf(
      pageId,
      PDF_PROP,
      `invoice-${title.replace(/\//g, "-")}.pdf`,
      stamped.bytes
    );
    return { invoiceNo: title };
  },

  async listInvoices(): Promise<InvoiceRecord[]> {
    const dbId = await getInvoicesDatabaseId();
    const rows = await queryDatabase(dbId, undefined, [
      { property: "Invoice Date", direction: "descending" },
    ]);
    return rows.map((row) => {
      const props = (row as { properties: Record<string, unknown> }).properties;
      const title = (props["Invoice No"] as { title?: Array<{ plain_text: string }> })
        ?.title?.[0]?.plain_text || "";
      const text = (key: string) =>
        (props[key] as { rich_text?: Array<{ plain_text: string }> })?.rich_text
          ?.map((b) => b.plain_text)
          .join("") || "";
      const num = (key: string) =>
        (props[key] as { number?: number | null })?.number ?? 0;
      const date =
        (props["Invoice Date"] as { date?: { start: string } | null })?.date?.start || "";
      const select =
        (props["Status"] as { select?: { name: string } | null })?.select?.name || "";
      const type =
        (props[TYPE_PROP] as { select?: { name: string } | null })?.select?.name ===
        TYPE_WHOLESALE
          ? "wholesale"
          : "retail";
      const filed =
        (props[FILED_PROP] as { checkbox?: boolean | null })?.checkbox === true;
      const pdfFiles = (props[PDF_PROP] as {
        files?: Array<{ type: string; file?: { url?: string }; external?: { url?: string } }>;
      })?.files || [];
      const pdfUrl =
        pdfFiles.map((f) => f.file?.url || f.external?.url || "").find(Boolean) || "";
      const origFiles = (props[ORIG_PDF_PROP] as {
        files?: Array<{ type: string; file?: { url?: string }; external?: { url?: string } }>;
      })?.files || [];
      const origPdfUrl =
        origFiles.map((f) => f.file?.url || f.external?.url || "").find(Boolean) || "";
      return {
        pageId: (row as { id: string }).id,
        invoiceNo: title,
        shopifyOrderId: text("Shopify Order ID"),
        orderNumber: text("Order Number"),
        invoiceDate: date,
        customerName: text("Customer"),
        placeOfSupply: text("Place of Supply"),
        taxableValue: num("Taxable Value"),
        cgst: num("CGST"),
        sgst: num("SGST"),
        igst: num("IGST"),
        grandTotal: num("Grand Total"),
        fy: text("FY"),
        status: select,
        type,
        filed,
        hsn: text(HSN_PROP),
        quantity: num(QTY_PROP),
        gstin: text(GSTIN_PROP),
        pdfUrl,
        origPdfUrl,
        priceOverride: readPriceOverride(props),
        lineItems: readLineItems(props),
      };
    });
  },
};

// --- Invoices database (numbering + log) ----------------------------------

let cachedInvoicesDbId: string | null = null;
// One-number-at-a-time lock across retail minting and wholesale renumbering —
// both walk the same FY rows. Holds whichever chained promise was queued last.
let invoiceMutex: Promise<unknown> = Promise.resolve(null);

const INVOICES_DB_TITLE = "UrbanNaari Invoices";

// Get the invoices database, creating it on first use if it doesn't exist yet.
// (Schema mirrors src/lib/notion-invoice-setup.ts, which stays as a manual fallback.)
async function getInvoicesDatabaseId(): Promise<string> {
  if (cachedInvoicesDbId) return cachedInvoicesDbId;
  const pageId = process.env.NOTION_PAGE_ID!;
  const res = await fetch(
    `${NOTION_API}/blocks/${pageId}/children?page_size=100`,
    { headers: headers() }
  );
  const data = await res.json();
  for (const block of data.results || []) {
    if (
      block.type === "child_database" &&
      block.child_database?.title === INVOICES_DB_TITLE
    ) {
      cachedInvoicesDbId = block.id;
      return block.id;
    }
  }

  const createRes = await fetch(`${NOTION_API}/databases`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      parent: { type: "page_id", page_id: pageId },
      title: [{ text: { content: INVOICES_DB_TITLE } }],
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
        "Forced Unit Price": { number: { format: "number" } },
        "Forced GST Rate": { number: { format: "number" } },
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
  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(
      `Failed to create "${INVOICES_DB_TITLE}" database: ${err.slice(0, 200)}`
    );
  }
  const created = await createRes.json();
  cachedInvoicesDbId = created.id;
  return created.id;
}

// --- Invoice settings (per-FY starting number) ---------------------------

let cachedInvoiceSettingsDbId: string | null = null;
const INVOICE_SETTINGS_DB_TITLE = "UrbanNaari Invoice Settings";

// Small key/value database: one row per financial year holding its start number.
async function getOrCreateInvoiceSettingsDbId(): Promise<string> {
  if (cachedInvoiceSettingsDbId) return cachedInvoiceSettingsDbId;
  const pageId = process.env.NOTION_PAGE_ID!;
  const res = await fetch(
    `${NOTION_API}/blocks/${pageId}/children?page_size=100`,
    { headers: headers() }
  );
  const data = await res.json();
  for (const block of data.results || []) {
    if (
      block.type === "child_database" &&
      block.child_database?.title === INVOICE_SETTINGS_DB_TITLE
    ) {
      cachedInvoiceSettingsDbId = block.id;
      return block.id;
    }
  }

  const createRes = await fetch(`${NOTION_API}/databases`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      parent: { type: "page_id", page_id: pageId },
      title: [{ text: { content: INVOICE_SETTINGS_DB_TITLE } }],
      properties: {
        FY: { title: {} },
        "Start Number": { number: { format: "number" } },
      },
    }),
  });
  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(
      `Failed to create "${INVOICE_SETTINGS_DB_TITLE}" database: ${err.slice(0, 200)}`
    );
  }
  const created = await createRes.json();
  cachedInvoiceSettingsDbId = created.id;
  return created.id;
}

// The configured starting sequence number for a financial year, or null if unset.
async function getInvoiceStartNumber(fy: string): Promise<number | null> {
  const dbId = await getOrCreateInvoiceSettingsDbId();
  const rows = await queryDatabase(dbId, {
    property: "FY",
    title: { equals: fy },
  });
  if (rows.length === 0) return null;
  const props = (rows[0] as { properties: Record<string, unknown> }).properties;
  const n = (props["Start Number"] as { number?: number | null })?.number;
  return typeof n === "number" ? n : null;
}

// Upsert the starting number for a financial year.
async function setInvoiceStartNumber(fy: string, n: number): Promise<void> {
  const dbId = await getOrCreateInvoiceSettingsDbId();
  const rows = await queryDatabase(dbId, {
    property: "FY",
    title: { equals: fy },
  });
  const properties = {
    FY: { title: [{ text: { content: fy } }] },
    "Start Number": { number: n },
  };
  if (rows.length > 0) {
    const pageId = (rows[0] as { id: string }).id;
    const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to update invoice start number: ${err.slice(0, 200)}`);
    }
  } else {
    const res = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ parent: { database_id: dbId }, properties }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to create invoice start number: ${err.slice(0, 200)}`);
    }
  }
}

// --- Invoice display flags (global) --------------------------------------

// Global flags live in the same settings DB as a special row whose title is
// FLAGS_ROW, with the boolean in a "Hide COD Fee" checkbox property. The
// property may not exist on databases created before the flag was introduced,
// so it is added lazily on first write.
const FLAGS_ROW = "_FLAGS_";
const HIDE_COD_FEE_PROP = "Hide COD Fee";
// Default: hide. The tool is requested to keep COD fees off invoices unless
// the toggle is switched on.
const DEFAULT_HIDE_COD_FEE = true;

async function ensureCheckboxProperty(dbId: string, prop: string): Promise<void> {
  const res = await fetch(`${NOTION_API}/databases/${dbId}`, { headers: headers() });
  if (res.ok) {
    const db = (await res.json()) as { properties?: Record<string, unknown> };
    if (db.properties && db.properties[prop]) return;
  }
  const patchRes = await fetch(`${NOTION_API}/databases/${dbId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ properties: { [prop]: { checkbox: {} } } }),
  });
  if (!patchRes.ok) {
    const err = await patchRes.text();
    throw new Error(`Failed to add "${prop}" to invoice settings: ${err.slice(0, 200)}`);
  }
}

// Per-order price override lives on the invoices ledger row as one rich_text
// property holding the JSON. Existing DBs predate it, so it is added lazily
// on first write (same pattern as ensureCheckboxProperty).
async function ensurePriceOverrideProps(dbId: string): Promise<void> {
  const res = await fetch(`${NOTION_API}/databases/${dbId}`, { headers: headers() });
  if (res.ok) {
    const db = (await res.json()) as { properties?: Record<string, unknown> };
    if (db.properties && db.properties[PRICE_OVERRIDE_PROP]) return;
  }
  const patchRes = await fetch(`${NOTION_API}/databases/${dbId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({
      properties: { [PRICE_OVERRIDE_PROP]: { rich_text: {} } },
    }),
  });
  if (!patchRes.ok) {
    const err = await patchRes.text();
    throw new Error(`Failed to add price override prop to invoices DB: ${err.slice(0, 200)}`);
  }
}

const PRICE_OVERRIDE_PROP = "Forced Prices";
// Frozen invoice lines (JSON snapshot) — the issued invoice is the source of
// truth; GSTR-1 reads this instead of rebuilding from Shopify.
const LINES_PROP = "Line Items";

// Rich text blocks cap at 2000 chars each — split long JSON across them.
function richTextChunks(text: string): Array<{ text: { content: string } }> {
  const out: Array<{ text: { content: string } }> = [];
  for (let i = 0; i < text.length; i += 2000)
    out.push({ text: { content: text.slice(i, i + 2000) } });
  return out;
}

function readLineItems(
  props: Record<string, unknown>
): InvoiceLineSnapshot[] | undefined {
  const raw =
    (props[LINES_PROP] as { rich_text?: Array<{ plain_text: string }> })
      ?.rich_text?.map((b) => b.plain_text)
      .join("") || "";
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as InvoiceLineSnapshot[];
  } catch {
    // Unreadable snapshot — treated as absent, callers fall back to a rebuild.
  }
  return undefined;
}

async function patchLineItems(
  pageId: string,
  lines: InvoiceLineSnapshot[]
): Promise<void> {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({
      properties: {
        [LINES_PROP]: {
          rich_text: lines.length ? richTextChunks(JSON.stringify(lines)) : [],
        },
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to save line items: ${err.slice(0, 200)}`);
  }
}

// Wholesale-upload props (added lazily — the DB predates the feature).
const TYPE_PROP = "Type";
const TYPE_RETAIL = "Retail";
const TYPE_WHOLESALE = "Wholesale";
const FILED_PROP = "Filed";
const PDF_PROP = "Invoice PDF";
const ORIG_PDF_PROP = "Original PDF";
const HSN_PROP = "HSN";
const GSTIN_PROP = "Buyer GSTIN";
const QTY_PROP = "Total Qty";

async function ensureInvoiceTypeProps(dbId: string): Promise<void> {
  const res = await fetch(`${NOTION_API}/databases/${dbId}`, { headers: headers() });
  if (res.ok) {
    const db = (await res.json()) as { properties?: Record<string, unknown> };
    if (
      db.properties &&
      db.properties[TYPE_PROP] &&
      db.properties[FILED_PROP] &&
      db.properties[PDF_PROP] &&
      db.properties[ORIG_PDF_PROP] &&
      db.properties[HSN_PROP] &&
      db.properties[GSTIN_PROP] &&
      db.properties[QTY_PROP] &&
      db.properties[LINES_PROP]
    )
      return;
  }
  const patchRes = await fetch(`${NOTION_API}/databases/${dbId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({
      properties: {
        [TYPE_PROP]: {
          select: {
            options: [
              { name: TYPE_RETAIL, color: "blue" },
              { name: TYPE_WHOLESALE, color: "purple" },
            ],
          },
        },
        [FILED_PROP]: { checkbox: {} },
        [PDF_PROP]: { files: {} },
        [ORIG_PDF_PROP]: { files: {} },
        [HSN_PROP]: { rich_text: {} },
        [GSTIN_PROP]: { rich_text: {} },
        [QTY_PROP]: { number: {} },
        [LINES_PROP]: { rich_text: {} },
      },
    }),
  });
  if (!patchRes.ok) {
    const err = await patchRes.text();
    throw new Error(`Failed to add wholesale props to invoices DB: ${err.slice(0, 200)}`);
  }
}

// Re-issue numbers for every unfiled invoice in a financial year so the whole
// series reads in date order (GST requirement). Filed rows are anchors — their
// numbers can never move, so the walk aborts if they would break the order.
// Wholesale rows whose number moves also need their stamped PDF re-drawn over
// the original — failures there are reported, never fatal to the walk.
async function renumberUnfiled(fy: string): Promise<{
  changed: RenumberChange[];
  errors: string[];
}> {
  const dbId = await getInvoicesDatabaseId();
  const rows = await queryDatabase(dbId, {
    property: "FY",
    rich_text: { equals: fy },
  });

  interface Row {
    pageId: string;
    invoiceNo: string;
    seq: number;
    date: string; // YYYY-MM-DD prefix of the Notion date
    filed: boolean;
    customerName: string;
    isWholesale: boolean;
    hasOrigPdf: boolean;
  }
  const list: Row[] = rows.map((row) => {
    const props = (row as { properties: Record<string, unknown> }).properties;
    const invoiceNo =
      (props["Invoice No"] as { title?: Array<{ plain_text: string }> })
        ?.title?.[0]?.plain_text || "";
    return {
      pageId: (row as { id: string }).id,
      invoiceNo,
      seq: parseSequence(invoiceNo),
      date: ((props["Invoice Date"] as { date?: { start: string | null } })?.date?.start || "").slice(0, 10),
      filed:
        (props[FILED_PROP] as { checkbox?: boolean | null })?.checkbox === true,
      customerName:
        (props["Customer"] as { rich_text?: Array<{ plain_text: string }> })
          ?.rich_text?.map((b) => b.plain_text).join("") || "",
      isWholesale:
        (props[TYPE_PROP] as { select?: { name: string } | null })?.select
          ?.name === TYPE_WHOLESALE,
      hasOrigPdf:
        ((props[ORIG_PDF_PROP] as { files?: unknown[] })?.files?.length ?? 0) > 0,
    };
  });

  list.sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date < b.date ? -1 : 1));

  const claimed = new Set(list.filter((r) => r.filed).map((r) => r.seq));
  // Numbers never go below the per-FY floor (the configured start number, or
  // the series' own lowest existing number) — renumbering shifts rows within
  // the series, it never drags the whole series back to 1.
  const minExisting = Math.min(
    ...list.filter((r) => r.seq > 0).map((r) => r.seq)
  );
  const floor =
    (await getInvoiceStartNumber(fy)) ??
    (Number.isFinite(minExisting) && minExisting > 0 ? minExisting : 1);
  const changed: RenumberChange[] = [];
  const errors: string[] = [];
  let prevAnchor = 0; // last filed number seen — anchors rise with date
  let prevAssigned = floor - 1; // highest number handed out so far

  for (const [i, r] of list.entries()) {
    if (r.filed) {
      if (r.seq <= prevAnchor) {
        throw new Error(
          `Filed invoices ${r.invoiceNo} and an earlier one are out of date ` +
            `order, so the series cannot be re-sorted. Numbers on filed ` +
            `invoices cannot change.`
        );
      }
      prevAnchor = r.seq;
      prevAssigned = Math.max(prevAssigned, r.seq);
      continue;
    }
    // The next filed anchor (if any) caps what this row can take.
    let nextAnchorCap = Infinity;
    for (let j = i + 1; j < list.length; j++) {
      if (list[j].filed) {
        nextAnchorCap = list[j].seq;
        break;
      }
    }
    let next = Math.max(prevAssigned, prevAnchor) + 1;
    while (next < nextAnchorCap && claimed.has(next)) next++;
    if (next >= nextAnchorCap) {
      throw new Error(
        `No free invoice number between #${prevAnchor} and #${nextAnchorCap} ` +
          `for ${r.invoiceNo || "the new invoice"} (dated ${r.date}) — ` +
          `that gap belongs to already-filed invoices. Date the upload after ` +
          `the last filed invoice, or un-file that month first.`
      );
    }
    const newNo = formatInvoiceNo(fy, next);
    if (newNo !== r.invoiceNo) {
      const res = await fetch(`${NOTION_API}/pages/${r.pageId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          properties: {
            "Invoice No": { title: [{ text: { content: newNo } }] },
          },
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Failed to renumber ${r.invoiceNo || "(new)"}: ${err.slice(0, 200)}`);
      }
      changed.push({
        oldNo: r.invoiceNo,
        invoiceNo: newNo,
        invoiceDate: r.date,
        customerName: r.customerName,
      });
      // The stamp must print the number the ledger now carries, or the merged
      // export shows the same printed number twice (this stale stamp + whoever
      // holds that number now). Report — never abort the walk.
      if (r.isWholesale) {
        if (!r.hasOrigPdf) {
          errors.push(`${newNo}: no Original PDF on the row — restamp skipped`);
        } else {
          try {
            await restampWholesalePdf(r.pageId, newNo);
          } catch (e) {
            errors.push(
              `${newNo}: restamp failed — ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
      }
    }
    prevAssigned = next;
  }
  return { changed, errors };
}

// Re-stamp a wholesale row's "Invoice PDF" after renumbering moved its number.
// Stamps only from "Original PDF": a fallback "Invoice PDF" copy may already
// carry an old stamp, which would survive as a ghost second number.
async function restampWholesalePdf(pageId: string, newNo: string): Promise<void> {
  const pageRes = await fetch(`${NOTION_API}/pages/${pageId}`, {
    headers: headers(),
  });
  if (!pageRes.ok) throw new Error(`row read failed (${pageRes.status})`);
  const props =
    ((await pageRes.json()) as { properties?: Record<string, unknown> })
      .properties ?? {};
  const origUrl = (
    props[ORIG_PDF_PROP] as {
      files?: Array<{ file?: { url?: string }; external?: { url?: string } }>;
    }
  )?.files
    ?.map((f) => f.file?.url || f.external?.url || "")
    .find(Boolean);
  if (!origUrl) throw new Error("no Original PDF attached");
  const buf = await compressPdfForUpload(
    Buffer.from(await (await fetch(origUrl)).arrayBuffer())
  );
  const parsed = await parseInvoicePdf(buf);
  if (!parsed.originalInvoiceNo) {
    throw new Error("could not read the original invoice number from the PDF");
  }
  const stamped = await stampInvoiceNumber(
    buf,
    parsed.originalInvoiceNo,
    newNo
  );
  await attachInvoicePdf(
    pageId,
    PDF_PROP,
    `invoice-${newNo.replace(/\//g, "-")}.pdf`,
    stamped.bytes
  );
}

// Attach a PDF to a ledger row's files property via Notion's file upload API
// (single part — the tool rejects anything larger well before this).
// `prop` picks the property: "Invoice PDF" (our re-issued PDF) or
// "Original PDF" (the seller's).
async function attachInvoicePdf(
  pageId: string,
  prop: string,
  filename: string,
  data: Buffer
): Promise<void> {
  const createRes = await fetch(`${NOTION_API}/file_uploads`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      mode: "single_part",
      filename,
      content_type: "application/pdf",
    }),
  });
  if (!createRes.ok) {
    throw new Error(
      `File upload init failed (${createRes.status}): ${(await createRes.text()).slice(0, 200)}`
    );
  }
  const uploadId = ((await createRes.json()) as { id?: string }).id;

  // Send takes multipart/form-data with a `file` field (JSON or raw-binary
  // bodies are rejected). Content-Type must be dropped so fetch sets the
  // multipart boundary itself.
  const { "Content-Type": _drop, ...sendHeaders } = headers();
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([new Uint8Array(data)], { type: "application/pdf" }),
    filename
  );
  const sendRes = await fetch(`${NOTION_API}/file_uploads/${uploadId}/send`, {
    method: "POST",
    headers: sendHeaders,
    body: fd,
  });
  if (!sendRes.ok) {
    throw new Error(
      `File upload send failed (${sendRes.status}): ${(await sendRes.text()).slice(0, 200)}`
    );
  }

  const attachRes = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({
      properties: {
        [prop]: {
          files: [{ type: "file_upload", file_upload: { id: uploadId } }],
        },
      },
    }),
  });
  if (!attachRes.ok) {
    throw new Error(
      `File attach failed (${attachRes.status}): ${(await attachRes.text()).slice(0, 200)}`
    );
  }
}

// Parse the JSON override; fall back to the legacy single-price number props
// ("Forced Unit Price"/"Forced GST Rate", written before per-line pricing)
// rendered as a "*" wildcard line matching every goods line.
function readPriceOverride(
  props: Record<string, unknown>
): InvoicePriceOverride | null {
  const raw =
    (props[PRICE_OVERRIDE_PROP] as { rich_text?: Array<{ plain_text: string }> })
      ?.rich_text?.map((b) => b.plain_text)
      .join("") || "";
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as InvoicePriceOverride;
      if (
        typeof parsed.gstRate === "number" &&
        Array.isArray(parsed.lines) &&
        parsed.lines.length > 0
      )
        return parsed;
    } catch {
      // fall through to legacy props
    }
  }
  const unitPrice = (
    props["Forced Unit Price"] as { number?: number | null } | undefined
  )?.number;
  const gstRate = (
    props["Forced GST Rate"] as { number?: number | null } | undefined
  )?.number;
  if (typeof unitPrice === "number" && typeof gstRate === "number")
    return { gstRate, lines: [{ key: "*", title: "", qty: 0, unitPrice }] };
  return null;
}

async function getFlagRow(prop: string): Promise<boolean | null> {
  const dbId = await getOrCreateInvoiceSettingsDbId();
  const rows = await queryDatabase(dbId, {
    property: "FY",
    title: { equals: FLAGS_ROW },
  });
  if (rows.length === 0) return null;
  const props = (rows[0] as { properties: Record<string, unknown> }).properties;
  const v = (props[prop] as { checkbox?: boolean | null })?.checkbox;
  return typeof v === "boolean" ? v : null;
}

async function setFlagRow(prop: string, value: boolean): Promise<void> {
  const dbId = await getOrCreateInvoiceSettingsDbId();
  await ensureCheckboxProperty(dbId, prop);
  const rows = await queryDatabase(dbId, {
    property: "FY",
    title: { equals: FLAGS_ROW },
  });
  const properties = {
    FY: { title: [{ text: { content: FLAGS_ROW } }] },
    [prop]: { checkbox: value },
  };
  if (rows.length > 0) {
    const pageId = (rows[0] as { id: string }).id;
    const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to save invoice flag: ${err.slice(0, 200)}`);
    }
  } else {
    const res = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ parent: { database_id: dbId }, properties }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to save invoice flag: ${err.slice(0, 200)}`);
    }
  }
}

// Highest invoice sequence already issued in a financial year (0 if none).
async function getMaxInvoiceSequence(fy: string): Promise<number> {  const dbId = await getInvoicesDatabaseId();
  const rows = await queryDatabase(dbId, {
    property: "FY",
    rich_text: { equals: fy },
  });
  let maxSeq = 0;
  for (const row of rows) {
    const props = (row as { properties: Record<string, unknown> }).properties;
    const titleProp = props["Invoice No"] as {
      title?: Array<{ plain_text: string }>;
    };
    maxSeq = Math.max(maxSeq, parseSequence(titleProp?.title?.[0]?.plain_text || ""));
  }
  return maxSeq;
}

async function assignInvoiceNumber(
  input: InvoiceLogInput
): Promise<{ invoiceNo: string; reused: boolean }> {
  const dbId = await getInvoicesDatabaseId();

  // Reuse if this order already has an invoice.
  const existing = await queryDatabase(dbId, {
    property: "Shopify Order ID",
    rich_text: { equals: input.shopifyOrderId },
  });
  if (existing.length > 0) {
    const pageId = (existing[0] as { id: string }).id;
    const props = (existing[0] as { properties: Record<string, unknown> })
      .properties;
    const titleProp = props["Invoice No"] as {
      title?: Array<{ plain_text: string }>;
    };
    const invoiceNo = titleProp?.title?.[0]?.plain_text || "";
    if (invoiceNo) {
      // Regenerating after an order edit/return changes the figures — keep the
      // ledger row in step with what the PDF now shows. Number and date stay.
      const num = (k: string) =>
        (props[k] as { number?: number | null })?.number ?? 0;
      const patch: Record<string, unknown> = {};
      if (num("Taxable Value") !== input.taxableValue)
        patch["Taxable Value"] = { number: input.taxableValue };
      if (num("CGST") !== input.cgst) patch["CGST"] = { number: input.cgst };
      if (num("SGST") !== input.sgst) patch["SGST"] = { number: input.sgst };
      if (num("IGST") !== input.igst) patch["IGST"] = { number: input.igst };
      if (num("Grand Total") !== input.grandTotal)
        patch["Grand Total"] = { number: input.grandTotal };
      // Keep any price override (or its clearing) in step too.
      const existingOverride = readPriceOverride(props);
      if (JSON.stringify(existingOverride) !== JSON.stringify(input.priceOverride ?? null)) {
        await ensurePriceOverrideProps(dbId);
        patch[PRICE_OVERRIDE_PROP] = {
          rich_text: input.priceOverride
            ? [{ text: { content: JSON.stringify(input.priceOverride) } }]
            : [],
        };
      }
      // Refresh the frozen line snapshot so the row matches the PDF just built.
      const existingLines = readLineItems(props);
      if (
        JSON.stringify(existingLines ?? null) !==
        JSON.stringify(input.lineItems ?? null)
      ) {
        await ensureInvoiceTypeProps(dbId);
        patch[LINES_PROP] = {
          rich_text: input.lineItems?.length
            ? richTextChunks(JSON.stringify(input.lineItems))
            : [],
        };
      }
      if (Object.keys(patch).length > 0) {
        const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ properties: patch }),
        });
        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Failed to update invoice ledger totals: ${err.slice(0, 200)}`);
        }
      }
      return { invoiceNo, reused: true };
    }
  }

  // Next sequence within the current financial year.
  const fy = financialYear(new Date(input.invoiceDate));
  const fyRows = await queryDatabase(dbId, {
    property: "FY",
    rich_text: { equals: fy },
  });
  let maxSeq = 0;
  for (const row of fyRows) {
    const props = (row as { properties: Record<string, unknown> }).properties;
    const titleProp = props["Invoice No"] as {
      title?: Array<{ plain_text: string }>;
    };
    const no = titleProp?.title?.[0]?.plain_text || "";
    maxSeq = Math.max(maxSeq, parseSequence(no));
  }
  // Apply the configured per-FY starting number as a floor (e.g. continue an
  // existing sequence at 51). Never goes below what's already been issued.
  const start = await getInvoiceStartNumber(fy);
  const nextSeq = Math.max(maxSeq, (start ?? 1) - 1) + 1;
  const invoiceNo = formatInvoiceNo(fy, nextSeq);

  const newProps: Record<string, unknown> = {
    "Invoice No": { title: [{ text: { content: invoiceNo } }] },
    "Shopify Order ID": {
      rich_text: [{ text: { content: input.shopifyOrderId } }],
    },
    "Order Number": {
      rich_text: [{ text: { content: input.orderNumber } }],
    },
    "Invoice Date": { date: { start: input.invoiceDate } },
    Customer: { rich_text: [{ text: { content: input.customerName } }] },
    "Place of Supply": {
      rich_text: [{ text: { content: input.placeOfSupply } }],
    },
    "Taxable Value": { number: input.taxableValue },
    CGST: { number: input.cgst },
    SGST: { number: input.sgst },
    IGST: { number: input.igst },
    "Grand Total": { number: input.grandTotal },
    FY: { rich_text: [{ text: { content: fy } }] },
    Status: { select: { name: "Issued" } },
  };
  if (input.priceOverride) {
    // Databases created before overrides existed lack this prop — add first.
    await ensurePriceOverrideProps(dbId);
    newProps[PRICE_OVERRIDE_PROP] = {
      rich_text: [{ text: { content: JSON.stringify(input.priceOverride) } }],
    };
  }

  await fetch(`${NOTION_API}/pages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties: newProps,
    }),
  });

  return { invoiceNo, reused: false };
}

// --- Abandoned Checkouts WA Tracking ---

let cachedAbandonedCheckoutsDbId: string | null = null;

async function getOrCreateAbandonedCheckoutsDbId(): Promise<string> {
  if (cachedAbandonedCheckoutsDbId) return cachedAbandonedCheckoutsDbId;

  const pageId = process.env.NOTION_PAGE_ID!;
  const res = await fetch(`${NOTION_API}/blocks/${pageId}/children?page_size=100`, {
    headers: headers(),
  });
  const data = await res.json();

  for (const block of data.results || []) {
    if (
      block.type === "child_database" &&
      block.child_database?.title === "Abandoned Checkouts"
    ) {
      cachedAbandonedCheckoutsDbId = block.id;
      return block.id;
    }
  }

  const createRes = await fetch(`${NOTION_API}/databases`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      parent: { type: "page_id", page_id: pageId },
      title: [{ text: { content: "Abandoned Checkouts" } }],
      properties: {
        "Checkout ID": { title: {} },
        "Customer Name": { rich_text: {} },
        "Customer Phone": { rich_text: {} },
        "Total Price": { rich_text: {} },
        "Checkout URL": { url: {} },
        "WA Sent": { checkbox: {} },
        "WA Sent At": { date: {} },
      },
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.json();
    throw new Error(`Failed to create Abandoned Checkouts DB: ${err.message || JSON.stringify(err)}`);
  }

  const created = await createRes.json();
  cachedAbandonedCheckoutsDbId = created.id;
  return created.id;
}

export async function getAbandonedCheckoutWaSentIds(): Promise<Set<string>> {
  const dbId = await getOrCreateAbandonedCheckoutsDbId();
  const results = await queryDatabase(dbId, {
    property: "WA Sent",
    checkbox: { equals: true },
  });

  const ids = new Set<string>();
  for (const page of results) {
    const props = (page as { properties: Record<string, unknown> }).properties;
    const titleProp = props["Checkout ID"] as { title?: Array<{ plain_text: string }> } | undefined;
    const checkoutId = titleProp?.title?.[0]?.plain_text || "";
    if (checkoutId) ids.add(checkoutId);
  }
  return ids;
}

export async function upsertAbandonedCheckoutWaSent(
  checkoutId: string,
  customerName: string,
  customerPhone: string,
  totalPrice: string,
  checkoutUrl: string
): Promise<void> {
  const dbId = await getOrCreateAbandonedCheckoutsDbId();
  const dateOnly = new Date().toISOString().split("T")[0];

  const existing = await queryDatabase(dbId, {
    property: "Checkout ID",
    title: { equals: checkoutId },
  });

  const properties: Record<string, unknown> = {
    "Checkout ID": { title: [{ text: { content: checkoutId } }] },
    "Customer Name": { rich_text: [{ text: { content: customerName } }] },
    "Customer Phone": { rich_text: [{ text: { content: customerPhone } }] },
    "Total Price": { rich_text: [{ text: { content: totalPrice } }] },
    "Checkout URL": { url: checkoutUrl || null },
    "WA Sent": { checkbox: true },
    "WA Sent At": { date: { start: dateOnly } },
  };

  if (existing.length > 0) {
    const notionPageId = (existing[0] as { id: string }).id;
    const patchRes = await fetch(`${NOTION_API}/pages/${notionPageId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ properties }),
    });
    if (!patchRes.ok) {
      const errorBody = await patchRes.text();
      throw new Error(`Notion update failed: ${patchRes.status} — ${errorBody.slice(0, 200)}`);
    }
  } else {
    const postRes = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ parent: { database_id: dbId }, properties }),
    });
    if (!postRes.ok) {
      const errorBody = await postRes.text();
      throw new Error(`Notion create failed: ${postRes.status} — ${errorBody.slice(0, 200)}`);
    }
  }
}

export async function updateInfluencerStatus(
  shipmentId: string,
  status: string
): Promise<void> {
  const now = new Date().toISOString().split("T")[0];
  const res = await fetch(`${NOTION_API}/pages/${shipmentId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({
      properties: {
        "Delivery Status": { select: { name: status } },
        "Last Updated": { date: { start: now } },
      },
    }),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`Failed to update influencer status: ${res.status}`, errorBody);
    throw new Error(`Notion update failed: ${res.status}`);
  }
}
