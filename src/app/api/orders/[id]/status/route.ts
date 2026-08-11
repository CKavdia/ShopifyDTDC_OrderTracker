import { NextRequest, NextResponse } from "next/server";
import { data } from "@/lib/data";
import { DeliveryStatus } from "@/lib/data/types";
import { validateTransition } from "@/lib/status-machine";
import { pushShopifyShipmentStatus, toShopifyShipmentStatus } from "@/lib/shopify";

const VALID_STATUSES: DeliveryStatus[] = [
  "Unfulfilled",
  "Booked",
  "Picked Up",
  "In Transit",
  "At Destination",
  "Out for Delivery",
  "Delivered",
  "Undelivered",
  "RTO",
  "RTO Confirmed",
  "RTO Received",
  "Return Initiated",
  "Return Complete",
  // "Cancelled" — use /api/orders/[id]/cancel instead (must go through Shopify)
];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { deliveryStatus } = body;

    if (!deliveryStatus || !VALID_STATUSES.includes(deliveryStatus)) {
      return NextResponse.json(
        { success: false, error: "Invalid delivery status" },
        { status: 400 }
      );
    }

    const order = await data.getOrderById(id);
    const validation = order
      ? validateTransition(order.deliveryStatus, deliveryStatus, true)
      : { allowed: true };

    await data.updateDeliveryStatus(id, deliveryStatus);

    // Mirror manual overrides to Shopify too, so a hand-set Delivered (e.g. the
    // "Delivered to Customer" button after an RTO re-attempt) shows up there.
    // Best-effort — the status is already saved, so surface failures as a
    // warning rather than failing the request.
    const shipmentStatus = toShopifyShipmentStatus(deliveryStatus);
    let shopifyWarning: string | undefined;
    if (order && shipmentStatus) {
      try {
        await pushShopifyShipmentStatus(order.shopifyOrderId, shipmentStatus, {
          trackingNumber: order.trackingNumber,
        });
      } catch (err) {
        shopifyWarning = `Saved, but Shopify was not updated: ${
          err instanceof Error ? err.message : "unknown error"
        }`;
        console.error(`Shopify shipment status push failed for order ${id}:`, err);
      }
    }

    return NextResponse.json({
      success: true,
      ...(validation.warning ? { warning: validation.warning } : {}),
      ...(shopifyWarning ? { shopifyWarning } : {}),
    });
  } catch (error) {
    console.error("Update status error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
