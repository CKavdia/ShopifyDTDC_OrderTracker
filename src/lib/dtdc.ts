import { DeliveryStatus, TrackingEvent } from "@/lib/data/types";

const DTDC_TRACK_URL =
  "https://www.dtdc.com/wp-json/custom/v1/domestic/track";

/**
 * Customer-facing DTDC deep-link that opens the parcel status page with the
 * AWB pre-filled. Used for both displayed tracking links and WhatsApp messages.
 */
export function dtdcTrackingUrl(trackingNumber: string): string {
  return `https://txk.dtdc.com/ctbs-tracking/customerInterface.tr?submitName=showCITrackingDetails&cType=Consignment&cnNo=${encodeURIComponent(trackingNumber)}`;
}

interface DTDCMilestone {
  mileName: string;
  mileLocationName: string;
  mileStatusDateTime: string;
  mileStatus: string; // "A" = active/done, "I" = inactive/pending
  branchName: string;
}

interface DTDCStatus {
  actBranchName: string;
  actCityName: string;
  statusDescription: string;
  remarks: string;
  statusTimestamp: string;
}

interface DTDCResponse {
  statusCode: number;
  statusDescription: string;
  errorMessage: string | null;
  shipmentNo: string;
  header: {
    currentStatusCode: string;
    currentStatusDescription: string;
    currentStatusDate: string;
    currentStatusTime: string;
    originCity: string;
    destinationCity: string;
    receiverName: string;
    opsEdd: string;
    bookingDate: string;
    rtoNumber: string;
    reasonCode: string;
    reasonDesc: string;
    attemptCount: number | null;
    destinationPincode: string;
    workerMobile: string;
  } | null;
  milestones: DTDCMilestone[] | null;
  statuses: DTDCStatus[] | null;
}

// Map DTDC status descriptions to our DeliveryStatus
function mapStatus(dtdcStatus: string): DeliveryStatus {
  const s = dtdcStatus.toLowerCase();
  // RTO / Return statuses — check before "delivered" to avoid false match
  // DTDC prefixes: "Return - ...", "RTO ...", "RTB ..."
  if (s.startsWith("return") || s.startsWith("rto") || s.includes("rtb")) return "RTO";
  if (s.includes("undelivered") || s.includes("not delivered"))
    return "Undelivered";
  if (s.includes("delivered")) return "Delivered";
  if (s.includes("out for delivery") || s.includes("scheduled for delivery"))
    return "Out for Delivery";
  if (
    s.includes("at destination") ||
    s.includes("reached at delivery") ||
    s.includes("reached at delivery centre")
  )
    return "At Destination";
  if (s.includes("in transit") || s.includes("at processing"))
    return "In Transit";
  if (s.includes("picked up") || s.includes("accepted")) return "Picked Up";
  if (s.includes("booked") || s.includes("pickup requested")) return "Booked";
  return "In Transit"; // default for unknown statuses
}

// Strip HTML tags from DTDC remarks
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

export interface TrackingResult {
  success: boolean;
  trackingNumber: string;
  deliveryStatus: DeliveryStatus;
  originCity: string;
  destinationCity: string;
  expectedDeliveryDate: string;
  deliveredDate: string;
  receiverName: string;
  rtoNumber: string;
  reasonCode: string;
  reasonDesc: string;
  attemptCount: number;
  destinationPincode: string;
  workerMobile: string;
  timeline: TrackingEvent[];
  error?: string;
}

export async function trackShipment(
  trackingNumber: string
): Promise<TrackingResult> {
  try {
    const response = await fetch(DTDC_TRACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trackType: "cnno",
        trackNumber: trackingNumber,
      }),
    });

    if (!response.ok) {
      throw new Error(`DTDC API returned ${response.status}`);
    }

    const data: DTDCResponse = await response.json();

    if (data.statusCode !== 200 || !data.header) {
      return {
        success: false,
        trackingNumber,
        deliveryStatus: "Booked",
        originCity: "",
        destinationCity: "",
        expectedDeliveryDate: "",
        deliveredDate: "",
        receiverName: "",
        rtoNumber: "",
        reasonCode: "",
        reasonDesc: "",
        attemptCount: 0,
        destinationPincode: "",
        workerMobile: "",
        timeline: [],
        error: data.errorMessage || "Tracking not found",
      };
    }

    const header = data.header;
    const status = mapStatus(header.currentStatusDescription);

    // Extract new DTDC fields
    const rtoNumber = header.rtoNumber || "";
    const reasonCode = header.reasonCode || "";
    const reasonDesc = header.reasonDesc || "";
    const attemptCount = header.attemptCount || 0;
    const destinationPincode = header.destinationPincode || "";
    const workerMobile = header.workerMobile || "";

    // Parse EDD
    let edd = "";
    if (header.opsEdd) {
      edd = header.opsEdd.split(" ")[0]; // "2026-03-24 00:00:00.0" → "2026-03-24"
    }

    // Parse delivered date
    let deliveredDate = "";
    if (status === "Delivered" && header.currentStatusDate) {
      deliveredDate = header.currentStatusDate;
    }

    // Build timeline from statuses (most recent first in API, we reverse)
    const timeline: TrackingEvent[] = (data.statuses || [])
      .map((s) => ({
        timestamp: s.statusTimestamp,
        status: s.statusDescription,
        description: stripHtml(s.remarks || ""),
        location: s.actCityName,
        branch: s.actBranchName,
      }))
      .reverse(); // chronological order

    return {
      success: true,
      trackingNumber,
      deliveryStatus: status,
      originCity: header.originCity || "",
      destinationCity: header.destinationCity || "",
      expectedDeliveryDate: edd,
      deliveredDate,
      receiverName: header.receiverName || "",
      rtoNumber,
      reasonCode,
      reasonDesc,
      attemptCount,
      destinationPincode,
      workerMobile,
      timeline,
    };
  } catch (error) {
    return {
      success: false,
      trackingNumber,
      deliveryStatus: "Booked",
      originCity: "",
      destinationCity: "",
      expectedDeliveryDate: "",
      deliveredDate: "",
      receiverName: "",
      rtoNumber: "",
      reasonCode: "",
      reasonDesc: "",
      attemptCount: 0,
      destinationPincode: "",
      workerMobile: "",
      timeline: [],
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
