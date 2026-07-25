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
} from "./types";
import {
  financialYear,
  formatInvoiceNo,
  parseSequence,
} from "../invoice/numbering";

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
    invoiceMutex = invoiceMutex.then(() => assignInvoiceNumber(input));
    return invoiceMutex;
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
      return {
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
      };
    });
  },
};

// --- Invoices database (numbering + log) ----------------------------------

let cachedInvoicesDbId: string | null = null;
let invoiceMutex: Promise<{ invoiceNo: string; reused: boolean }> =
  Promise.resolve({ invoiceNo: "", reused: false });

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

// Highest invoice sequence already issued in a financial year (0 if none).
async function getMaxInvoiceSequence(fy: string): Promise<number> {
  const dbId = await getInvoicesDatabaseId();
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
    const props = (existing[0] as { properties: Record<string, unknown> })
      .properties;
    const titleProp = props["Invoice No"] as {
      title?: Array<{ plain_text: string }>;
    };
    const invoiceNo = titleProp?.title?.[0]?.plain_text || "";
    if (invoiceNo) return { invoiceNo, reused: true };
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

  await fetch(`${NOTION_API}/pages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties: {
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
      },
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
