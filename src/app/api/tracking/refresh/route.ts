import { NextResponse } from "next/server";
import { data } from "@/lib/data";
import { trackShipment } from "@/lib/dtdc";
import { resolveStatus, validateTransition, logBlockedTransition } from "@/lib/status-machine";
import { pushShopifyShipmentStatus, toShopifyShipmentStatus } from "@/lib/shopify";

export async function POST() {
  try {
    const activeOrders = await data.getActiveOrders();

    if (activeOrders.length === 0) {
      return NextResponse.json({
        success: true,
        refreshed: 0,
        message: "No active orders to refresh",
      });
    }

    let refreshed = 0;
    let errors = 0;
    let blocked = 0;
    let shopifyPushed = 0;
    const results: Array<{ trackingNumber: string; status: string; error?: string; blocked?: boolean; reason?: string; shopifyError?: string }> = [];

    for (const order of activeOrders) {
      if (!order.trackingNumber) continue;

      const result = await trackShipment(order.trackingNumber);

      if (result.success) {
        const resolvedStatus = resolveStatus(result.deliveryStatus, order.deliveryStatus);
        const validation = validateTransition(order.deliveryStatus, resolvedStatus, false);

        if (!validation.allowed) {
          logBlockedTransition(order.trackingNumber, order.deliveryStatus, resolvedStatus, "bulk-refresh");
          blocked++;
          results.push({
            trackingNumber: order.trackingNumber,
            status: order.deliveryStatus,
            blocked: true,
            reason: validation.warning,
          });
        } else {
          // Build delivered timestamp from DTDC data
          let deliveredTimestamp = "";
          if (resolvedStatus === "Delivered" || resolvedStatus === "RTO Received") {
            const lastEvent = result.timeline[result.timeline.length - 1];
            deliveredTimestamp = lastEvent?.timestamp || result.deliveredDate || "";
          }

          try {
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
            }, order.id);
            refreshed++;

            // Mirror the shipment status to Shopify. Deliberately not gated on
            // the status having changed: Notion is already committed, so a
            // transient push failure would otherwise never be retried and
            // Shopify would stay behind forever. The rank guard inside
            // pushShopifyShipmentStatus makes the repeat case a cheap no-op.
            // Best-effort — a Shopify failure must not count as a sync error.
            const shipmentStatus = toShopifyShipmentStatus(resolvedStatus);
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
                if (push.pushed) shopifyPushed++;
              } catch (err) {
                shopifyError = err instanceof Error ? err.message : "Shopify push failed";
                console.error(
                  `Shopify shipment status push failed for ${order.trackingNumber}:`,
                  shopifyError
                );
              }
            }

            results.push({
              trackingNumber: order.trackingNumber,
              status: resolvedStatus,
              ...(shopifyError ? { shopifyError } : {}),
            });
          } catch (updateError) {
            errors++;
            results.push({
              trackingNumber: order.trackingNumber,
              status: "Error",
              error: updateError instanceof Error ? updateError.message : "Notion update failed",
            });
          }
        }
      } else {
        errors++;
        results.push({
          trackingNumber: order.trackingNumber,
          status: "Error",
          error: result.error,
        });
      }

    }

    return NextResponse.json({
      success: true,
      refreshed,
      errors,
      blocked,
      shopifyPushed,
      total: activeOrders.length,
      results,
    });
  } catch (error) {
    console.error("Tracking refresh error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
