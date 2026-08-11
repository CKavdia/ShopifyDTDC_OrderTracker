import { NextRequest, NextResponse } from "next/server";
import { data } from "@/lib/data";
import { trackShipment } from "@/lib/dtdc";
import { resolveStatus, validateTransition, logBlockedTransition } from "@/lib/status-machine";
import { pushShopifyShipmentStatus, toShopifyShipmentStatus } from "@/lib/shopify";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const order = await data.getOrderById(id);

    if (!order) {
      return NextResponse.json(
        { success: false, error: "Order not found" },
        { status: 404 }
      );
    }

    if (!order.trackingNumber) {
      return NextResponse.json(
        { success: false, error: "Order has no tracking number" },
        { status: 400 }
      );
    }

    const result = await trackShipment(order.trackingNumber);

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error || "Tracking fetch failed" },
        { status: 502 }
      );
    }

    const resolvedStatus = resolveStatus(result.deliveryStatus, order.deliveryStatus);
    const validation = validateTransition(order.deliveryStatus, resolvedStatus, false);

    if (!validation.allowed) {
      logBlockedTransition(order.trackingNumber, order.deliveryStatus, resolvedStatus, "single-refresh");
      return NextResponse.json({
        success: true,
        blocked: true,
        currentStatus: order.deliveryStatus,
        attemptedStatus: resolvedStatus,
        message: validation.warning,
      });
    }

    let deliveredTimestamp = "";
    if (resolvedStatus === "Delivered" || resolvedStatus === "RTO Received") {
      const lastEvent = result.timeline[result.timeline.length - 1];
      deliveredTimestamp = lastEvent?.timestamp || result.deliveredDate || "";
    }

    await data.updateOrderTracking(order.trackingNumber, {
      deliveryStatus: resolvedStatus,
      originCity: result.originCity,
      destinationCity: result.destinationCity,
      expectedDeliveryDate: result.expectedDeliveryDate,
      deliveredDate: result.deliveredDate,
      deliveredTimestamp,
      receiverName: result.receiverName,
      rtoNumber: result.rtoNumber,
      reasonCode: result.reasonCode,
      reasonDesc: result.reasonDesc,
      attemptCount: result.attemptCount,
      destinationPincode: result.destinationPincode,
      workerMobile: result.workerMobile,
      lastUpdated: new Date().toISOString().split("T")[0],
      trackingTimeline: result.timeline,
    });

    // Best-effort mirror to Shopify — never fails the request, since the Notion
    // write above already succeeded. Not gated on the status having changed, so
    // this button doubles as the manual recovery for a push that failed earlier
    // (the rank guard makes an already-synced order a no-op).
    const shipmentStatus = toShopifyShipmentStatus(resolvedStatus);
    let shopifyPushed = false;
    let shopifyError: string | undefined;
    if (shipmentStatus) {
      try {
        const push = await pushShopifyShipmentStatus(
          order.shopifyOrderId,
          shipmentStatus,
          {
            trackingNumber: order.trackingNumber,
            happenedAt: deliveredTimestamp || undefined,
          }
        );
        shopifyPushed = push.pushed;
      } catch (err) {
        shopifyError = err instanceof Error ? err.message : "Shopify push failed";
        console.error(
          `Shopify shipment status push failed for ${order.trackingNumber}:`,
          shopifyError
        );
      }
    }

    return NextResponse.json({
      success: true,
      status: resolvedStatus,
      shopifyPushed,
      ...(shopifyError ? { shopifyError } : {}),
    });
  } catch (error) {
    console.error("Single order refresh error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
