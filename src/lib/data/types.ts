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
}

// A logged invoice as read back from the Invoices database.
export interface InvoiceRecord {
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
}
