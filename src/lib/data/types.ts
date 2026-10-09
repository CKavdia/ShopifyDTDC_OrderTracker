export type DeliveryStatus =
  | "Unfulfilled"
  | "Booked"
  | "Picked Up"
  | "In Transit"
  | "At Destination"
  | "Out for Delivery"
  | "Delivered"
  | "Undelivered"
  | "RTO"
  | "RTO Confirmed"
  | "RTO Received"
  | "Return Initiated"
  | "Return Complete"
  | "Video Received"
  | "Product Received Back"
  | "Completed"
  | "Cancelled";

export type EmailType = "delivery_confirmation" | "review_request";

export type CodConfirmationStatus = "Confirmed on Call" | "Confirmed on WhatsApp" | "Declined" | "No Reply" | "";

export type RtoConfirmationStatus = "Reachable" | "Cancel" | "No Reply" | "";

export interface TrackingEvent {
  timestamp: string;
  status: string;
  description: string;
  location: string;
  branch: string;
}

export interface Order {
  id: string; // Notion page ID
  shopifyOrderId: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingAddress: string;
  trackingNumber: string;
  courierPartner: string;
  paymentMethod: "COD" | "Prepaid";
  orderTotal: number;
  codCollectionStatus: "Pending" | "Collected" | "";
  orderDate: string;
  fulfilledDate: string;
  deliveryStatus: DeliveryStatus;
  originCity: string;
  destinationCity: string;
  expectedDeliveryDate: string;
  deliveredDate: string;
  deliveredTimestamp: string;
  receiverName: string;
  lastUpdated: string;
  trackingTimeline: TrackingEvent[];
  rtoTrackingNumber: string;
  reasonCode: string;
  reasonDesc: string;
  attemptCount: number;
  destinationPincode: string;
  workerMobile: string;
  deliveryEmailSent: boolean;
  reviewEmailSent: boolean;
  shippingMode: "Air" | "Road" | "";
  weightGrams: number;
  shippingChargePaid: boolean;
  cancellationReason: string;
  whatsappSent: boolean;
  codConfirmationStatus: CodConfirmationStatus;
  whatsappFollowUpCount: number;
  whatsappLastFollowUpDate: string;
  rtoWhatsappSent: boolean;
  rtoConfirmationStatus: RtoConfirmationStatus;
  rtoFollowUpCount: number;
  rtoLastFollowUpDate: string;
  ofdWhatsappSent: boolean;
}

export interface Product {
  id: string;
  name: string;
  imageUrl: string;
  size: string;
  productUrl: string;
  received?: boolean;
}

export interface InfluencerShipment {
  id: string;
  label: string;
  trackingNumber: string;
  courierPartner: string;
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
  createdAt: string;
  products?: Product[];
  phoneNumber: string;
  instagramHandle: string;
  isJaipurInfluencer: boolean;
  shippingChargePaid: boolean;
}

export interface ShippingRateSlab {
  minGrams: number;
  maxGrams: number; // use Infinity for the last slab
  rate: number;
}

export interface ShippingRateTable {
  codAir: ShippingRateSlab[];
  codRoad: ShippingRateSlab[];
  prepaidAir: ShippingRateSlab[];
  prepaidRoad: ShippingRateSlab[];
}

export interface AbandonedCheckoutLineItem {
  title: string;
  quantity: number;
  variantTitle: string;
  price: string;
  productId: string;
  variantId: string;
}

export interface AbandonedCheckout {
  id: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  lineItems: AbandonedCheckoutLineItem[];
  totalPrice: string;
  checkoutUrl: string;
  createdAt: string;
  updatedAt: string;
  waMessageSent: boolean;
  waMessageSentAt?: string;
}

export interface OrderFilters {
  status?: DeliveryStatus;
  search?: string;
  hideDelivered?: boolean;
  shippingMode?: "Air" | "Road";
}

export interface DataProvider {
  getOrders(filters?: OrderFilters): Promise<Order[]>;
  upsertOrder(order: Omit<Order, "id">): Promise<Order>;
  updateOrderTracking(
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
    pageId?: string
  ): Promise<void>;
  getActiveOrders(): Promise<Order[]>;
  updateDeliveryStatus(orderId: string, status: DeliveryStatus): Promise<void>;
  updateCodStatus(
    orderId: string,
    status: "Pending" | "Collected"
  ): Promise<void>;
  updateShippingMode(
    orderId: string,
    mode: "Air" | "Road"
  ): Promise<void>;
  updateOrderWeight(orderId: string, weightGrams: number): Promise<void>;
  updateShippingChargePaid(orderId: string, paid: boolean): Promise<void>;
  updateRtoTracking(
    orderId: string,
    rtoTrackingNumber: string
  ): Promise<void>;
  assignTracking(
    orderId: string,
    trackingNumber: string,
    courierPartner: string
  ): Promise<void>;
  markEmailSent(orderId: string): Promise<void>;
  markReviewEmailSent(orderId: string): Promise<void>;
  cancelOrder(orderId: string, reason: string): Promise<void>;
  markWhatsAppSent(orderId: string, isCod: boolean): Promise<void>;
  updateCodConfirmation(orderId: string, status: "Confirmed on Call" | "Confirmed on WhatsApp" | "Declined" | "No Reply"): Promise<void>;
  recordWhatsAppFollowUp(orderId: string): Promise<void>;
  markRtoWhatsAppSent(orderId: string): Promise<void>;
  updateRtoConfirmation(orderId: string, status: "Reachable" | "Cancel" | "No Reply"): Promise<void>;
  recordRtoFollowUp(orderId: string): Promise<void>;
  markOfdWhatsAppSent(orderId: string): Promise<void>;
  getOrderById(orderId: string): Promise<Order | null>;
  // Influencer shipments
  getInfluencerShipments(): Promise<InfluencerShipment[]>;
  createInfluencerShipment(shipment: {
    label: string;
    trackingNumber: string;
    phoneNumber: string;
    instagramHandle?: string;
    isJaipurInfluencer?: boolean;
  }): Promise<InfluencerShipment>;
  getActiveInfluencerShipments(): Promise<InfluencerShipment[]>;
  updateInfluencerTracking(
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
  ): Promise<void>;
  markInfluencerDelivered(shipmentId: string): Promise<void>;
  updateInfluencerShippingChargePaid(shipmentId: string, paid: boolean): Promise<void>;
  updateInfluencerTrackingNumber(
    shipmentId: string,
    trackingNumber: string
  ): Promise<void>;
  // Invoicing: assign (or reuse) a sequential invoice number and log it.
  getOrCreateInvoiceNumber(
    input: InvoiceLogInput
  ): Promise<{ invoiceNo: string; reused: boolean }>;
  // List issued invoices (newest first) for the Invoices page.
  listInvoices(): Promise<InvoiceRecord[]>;
  // Per-FY starting invoice number (floor). null if unset.
  getInvoiceStartNumber(fy: string): Promise<number | null>;
  setInvoiceStartNumber(fy: string, n: number): Promise<void>;
  // Highest invoice sequence already issued in a financial year (0 if none).
  getMaxInvoiceSequence(fy: string): Promise<number>;
  // Invoice display flags (global). hideCodFee drops the COD fee line from
  // every generated invoice PDF.
  getInvoiceHideCodFee(): Promise<boolean>;
  setInvoiceHideCodFee(hide: boolean): Promise<void>;
  // Per-order fixed-price override. Null clears it.
  getInvoicePriceOverride(shopifyOrderId: string): Promise<InvoicePriceOverride | null>;
  setInvoicePriceOverride(shopifyOrderId: string, o: InvoicePriceOverride | null): Promise<void>;
  // Wholesale invoices issued outside the tool: log one, renumber the unfiled
  // part of the series into date order, and (optionally) attach the PDF.
  createWholesaleInvoice(
    input: WholesaleInvoiceInput,
    pdf?: { filename: string; data: Buffer }
  ): Promise<{
    pageId: string;
    invoiceNo: string;
    renumbered: RenumberChange[];
    attachError?: string;
  }>;
  // Mark an invoice's GST return as filed (locks its number in place).
  setInvoiceFiled(pageId: string, filed: boolean): Promise<void>;
  // Attach the seller's original PDF to an existing row (files property
  // "Original PDF").
  attachWholesalePdf(pageId: string, filename: string, pdfData: Buffer): Promise<void>;
  // Overwrite the frozen line-item snapshot on a ledger row (backfill and fixes;
  // new invoices write it automatically at issue time).
  setInvoiceLineItems(pageId: string, lines: InvoiceLineSnapshot[]): Promise<void>;
  // Re-issue the tool's own PDF for a wholesale row (our UN/FY number on the
  // face): backfills GSTIN/HSN from the seller's original when missing, moves
  // the original to "Original PDF", and attaches ours to "Invoice PDF".
  regenerateWholesalePdf(pageId: string): Promise<{ invoiceNo: string }>;
}

// One invoice line, frozen when the invoice is issued. GSTR-1, exports and
// bookkeeping read this snapshot instead of rebuilding from Shopify, so later
// order edits can never change what an issued invoice said. Wholesale uploads
// freeze the item table parsed from the seller's original PDF.
export interface InvoiceLineSnapshot {
  hsn: string; // "" on the synthetic shipping/COD line
  title: string;
  variantTitle?: string;
  qty: number;
  rate: number; // GST rate %
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  lineTotal: number; // tax-inclusive
  service: boolean; // shipping/COD fee line (SAC 9968), vs goods
}

// Data needed to log an issued invoice in the Invoices database.
export interface InvoiceLogInput {
  shopifyOrderId: string;
  orderNumber: string;
  customerName: string;
  invoiceDate: string; // ISO date
  placeOfSupply: string;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  grandTotal: number;
  // Fixed-price reissue (e.g. "unit price ₹2,499 + 5% GST"): persisted on the
  // ledger row so every later regeneration and export reproduces it.
  priceOverride?: InvoicePriceOverride | null;
  // Frozen line items written to the row at issue time (see InvoiceLineSnapshot).
  lineItems?: InvoiceLineSnapshot[];
}

// A per-order fixed-price override. Tax-EXCLUSIVE: each goods line prints its
// forced unitPrice per piece and GST (gstRate %) is added on top. The lines
// are matched by Shopify line-item id, so an override can price every line
// independently; null = no override.
export interface InvoicePriceOverrideLine {
  key: string; // Shopify line-item id
  title: string; // display only
  qty: number;
  unitPrice: number; // pre-tax, per piece
}

export interface InvoicePriceOverride {
  gstRate: number; // percent, one rate for the whole invoice
  lines: InvoicePriceOverrideLine[];
}

// A logged invoice as read back from the Invoices database.
export interface InvoiceRecord {
  pageId: string;
  invoiceNo: string;
  shopifyOrderId: string;
  orderNumber: string;
  invoiceDate: string;
  customerName: string;
  placeOfSupply: string;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  grandTotal: number;
  fy: string;
  status: string;
  type: "retail" | "wholesale";
  filed: boolean;
  hsn: string; // wholesale uploads only — whole-invoice HSN for GSTR-1
  quantity?: number; // wholesale uploads only — total goods qty for GSTR-1
  gstin: string; // wholesale uploads only — buyer GSTIN, printed on the re-issued PDF
  pdfUrl: string; // Notion attachment URL for our re-issued wholesale PDF, else ""
  origPdfUrl: string; // Notion attachment URL for the seller's original PDF, else ""
  priceOverride: InvoicePriceOverride | null;
  lineItems?: InvoiceLineSnapshot[]; // frozen at issue time; absent on rows from before the snapshot existed
}

// A wholesale invoice issued outside the tool (paper / other software),
// recorded here so it joins the same UN/FY series as retail invoices.
export interface WholesaleInvoiceInput {
  invoiceDate: string; // YYYY-MM-DD
  customerName: string;
  gstin: string;
  stateCode: string; // key of GST_STATE_CODES, e.g. "DL"
  hsn: string; // optional — the whole invoice's HSN, for the GSTR-1 summary
  quantity: number; // total goods qty, feeds the GSTR-1 quantity column (0 if unknown)
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  grandTotal: number;
  reference: string; // the original invoice's own number, free text
}

// One invoice whose number moved when the series was re-ordered by date.
export interface RenumberChange {
  oldNo: string; // "" for the just-uploaded invoice
  invoiceNo: string;
  invoiceDate: string;
  customerName: string;
}

export interface CreateWholesaleResult {
  invoiceNo: string;
  renumbered: RenumberChange[];
}
