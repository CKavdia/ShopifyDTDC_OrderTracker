import { NextResponse } from "next/server";
import { data } from "@/lib/data";
import {
  getFulfilledOrders,
  getUnfulfilledOrders,
  getShopifyOrder,
  formatShippingAddress,
} from "@/lib/shopify";

export async function POST() {
  try {
    // Only sync orders updated in the last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const shopifyOrders = await getFulfilledOrders(sevenDaysAgo);
    let synced = 0;
    let skipped = 0;

    for (const order of shopifyOrders) {
      // Get tracking number from fulfillments
      const trackingNumber =
        order.fulfillments?.[0]?.tracking_number ||
        order.fulfillments?.[0]?.tracking_numbers?.[0] ||
        "";

      if (!trackingNumber) {
        skipped++;
        continue;
      }

      const customerName = order.customer
        ? `${order.customer.first_name || ""} ${order.customer.last_name || ""}`.trim()
        : "Unknown";

      // Determine COD vs Prepaid from financial status and payment gateways
      const gateways = (order.payment_gateway_names || []).map((g) =>
        g.toLowerCase()
      );
      const isCOD =
        order.financial_status === "pending" ||
        gateways.some(
          (g) =>
            g.includes("cash on delivery") ||
            g.includes("cod") ||
            g.includes("payment pending")
        );
      const paymentMethod = isCOD ? "COD" : "Prepaid";

      await data.upsertOrder({
        shopifyOrderId: order.id.toString(),
        orderNumber: order.name,
        customerName,
        customerEmail: order.email || order.customer?.email || "",
        customerPhone: order.shipping_address?.phone || "",
        shippingAddress: formatShippingAddress(order.shipping_address),
        trackingNumber,
        courierPartner:
          order.fulfillments?.[0]?.tracking_company || "DTDC",
        paymentMethod,
        orderTotal: parseFloat(order.current_total_price || order.total_price || "0"),
        codCollectionStatus: isCOD ? "Pending" : "",
        orderDate: order.created_at.split("T")[0],
        fulfilledDate: order.fulfillments?.[0]?.created_at?.split("T")[0] || "",
        deliveryStatus: "Booked",
        originCity: "",
        destinationCity: order.shipping_address?.city || "",
        expectedDeliveryDate: "",
        deliveredDate: "",
        deliveredTimestamp: "",
        receiverName: "",
        lastUpdated: new Date().toISOString().split("T")[0],
        trackingTimeline: [],
        rtoTrackingNumber: "",
        reasonCode: "",
        reasonDesc: "",
        attemptCount: 0,
        destinationPincode: "",
        workerMobile: "",
        deliveryEmailSent: false,
        reviewEmailSent: false,
        shippingMode: isCOD ? "Road" : "Air",
        weightGrams: 0,
        shippingChargePaid: false,
        cancellationReason: "",
        whatsappSent: false,
        codConfirmationStatus: "",
        whatsappFollowUpCount: 0,
        whatsappLastFollowUpDate: "",
        rtoWhatsappSent: false,
        rtoConfirmationStatus: "",
        rtoFollowUpCount: 0,
        rtoLastFollowUpDate: "",
        ofdWhatsappSent: false,
      });
      synced++;
    }

    // Phase 2: Sync unfulfilled orders
    const unfulfilledOrders = await getUnfulfilledOrders(sevenDaysAgo);
    let unfulfilled = 0;

    for (const order of unfulfilledOrders) {
      const customerName = order.customer
        ? `${order.customer.first_name || ""} ${order.customer.last_name || ""}`.trim()
        : "Unknown";

      const gateways = (order.payment_gateway_names || []).map((g) =>
        g.toLowerCase()
      );
      const isCOD =
        order.financial_status === "pending" ||
        gateways.some(
          (g) =>
            g.includes("cash on delivery") ||
            g.includes("cod") ||
            g.includes("payment pending")
        );
      const paymentMethod = isCOD ? "COD" : "Prepaid";

      await data.upsertOrder({
        shopifyOrderId: order.id.toString(),
        orderNumber: order.name,
        customerName,
        customerEmail: order.email || order.customer?.email || "",
        customerPhone: order.shipping_address?.phone || "",
        shippingAddress: formatShippingAddress(order.shipping_address),
        trackingNumber: "",
        courierPartner: "",
        paymentMethod,
        orderTotal: parseFloat(order.current_total_price || order.total_price || "0"),
        codCollectionStatus: isCOD ? "Pending" : "",
        orderDate: order.created_at.split("T")[0],
        fulfilledDate: "",
        deliveryStatus: "Unfulfilled",
        originCity: "",
        destinationCity: order.shipping_address?.city || "",
        expectedDeliveryDate: "",
        deliveredDate: "",
        deliveredTimestamp: "",
        receiverName: "",
        lastUpdated: new Date().toISOString().split("T")[0],
        trackingTimeline: [],
        rtoTrackingNumber: "",
        reasonCode: "",
        reasonDesc: "",
        attemptCount: 0,
        destinationPincode: "",
        workerMobile: "",
        deliveryEmailSent: false,
        reviewEmailSent: false,
        shippingMode: isCOD ? "Road" : "Air",
        weightGrams: 0,
        shippingChargePaid: false,
        cancellationReason: "",
        whatsappSent: false,
        codConfirmationStatus: "",
        whatsappFollowUpCount: 0,
        whatsappLastFollowUpDate: "",
        rtoWhatsappSent: false,
        rtoConfirmationStatus: "",
        rtoFollowUpCount: 0,
        rtoLastFollowUpDate: "",
        ofdWhatsappSent: false,
      });
      unfulfilled++;
    }

    // Phase 3: Detect orders cancelled on Shopify
    // Build set of Shopify order IDs that are still open+unfulfilled
    const shopifyUnfulfilledIds = new Set(
      unfulfilledOrders.map((o) => o.id.toString())
    );

    // Get all Notion orders currently marked as Unfulfilled
    const notionUnfulfilled = await data.getOrders({ status: "Unfulfilled" });
    let cancelled = 0;

    for (const notionOrder of notionUnfulfilled) {
      // If this order is still in the Shopify unfulfilled set, it's fine
      if (shopifyUnfulfilledIds.has(notionOrder.shopifyOrderId)) continue;

      // Otherwise, check if it was cancelled on Shopify
      try {
        const shopifyOrder = await getShopifyOrder(notionOrder.shopifyOrderId);
        if (shopifyOrder.cancelled_at) {
          await data.cancelOrder(notionOrder.id, "Cancelled on Shopify");
          cancelled++;
        }
      } catch (err) {
        console.warn(
          `Could not check cancellation for order ${notionOrder.orderNumber}:`,
          err
        );
      }
    }

    return NextResponse.json({
      success: true,
      synced,
      skipped,
      unfulfilled,
      cancelled,
      total: shopifyOrders.length + unfulfilledOrders.length,
    });
  } catch (error) {
    console.error("Shopify sync error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
