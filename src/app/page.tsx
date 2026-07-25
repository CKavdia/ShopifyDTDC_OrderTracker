"use client";

import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Package,
  Users,
  BarChart3,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Phone,
  Mail,
  Check,
  Search,
  RefreshCw,
  ArrowDownUp,
  Truck,
  Plane,
  CircleAlert,
  CircleCheck,
  Clock,
  IndianRupee,
  RotateCcw,
  PencilLine,
  Plus,
  X,
  Menu,
  Activity,
  MapPin,
  Calendar,
  User,
  AlertTriangle,
  Loader2,
  Bell,
  Settings,
  Hash,
  Share2,
  Star,
  MessageCircle,
  Download,
  ShoppingCart,
  FileText,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfluencerSection } from "@/components/InfluencerSection";
import { AbandonedCheckoutsSection } from "@/components/AbandonedCheckoutsSection";
import { InvoicesSection } from "@/components/InvoicesSection";
import { DTDCExportDialog } from "@/components/DTDCExportDialog";
import { ShippingExportDialog } from "@/components/ShippingExportDialog";
import { ShippingRatesPanel } from "@/components/ShippingSettingsDialog";
import { WeightInput } from "@/components/WeightInput";
import { getShippingConfig, calculateShippingCharge } from "@/lib/shipping";
import { dtdcTrackingUrl } from "@/lib/dtdc";
import type { Order, DeliveryStatus, TrackingEvent, ShippingRateTable } from "@/lib/data/types";

// --- CONSTANTS ---
const AUTO_REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes
const SHOPIFY_STORE_URL = process.env.NEXT_PUBLIC_SHOPIFY_STORE_URL || "";
const DEFAULT_DELAYED_THRESHOLD_DAYS = 7;

type Tab = "orders" | "influencer" | "abandoned" | "analytics" | "invoices";

// --- UTILITY FUNCTIONS ---
function normalizeWhatsAppPhone(raw: string): string {
  let phone = raw.replace(/\D/g, "");
  // Indian mobile numbers saved with a leading STD trunk prefix (e.g. "09414172040")
  // leak through as 11 digits; strip the leading 0 so the country code prepends correctly.
  if (phone.length === 11 && phone.startsWith("0")) phone = phone.slice(1);
  if (phone.length === 10) phone = `91${phone}`;
  return phone;
}

function buildWhatsAppUrl(phone: string, message: string): string {
  const url = new URL("https://web.whatsapp.com/send");
  url.searchParams.set("phone", phone);
  url.searchParams.set("text", message);
  return url.toString();
}

function buildCodConfirmationMessage(order: Order, itemsText: string): string {
  const firstName = order.customerName.split(" ")[0];
  const E = {
    wave: String.fromCodePoint(0x1F44B),
    bag: String.fromCodePoint(0x1F6CD, 0xFE0F),
    pin: String.fromCodePoint(0x1F4CD),
    check: String.fromCodePoint(0x2705),
    heart: String.fromCodePoint(0x1F49C),
    hanger: String.fromCodePoint(0x1F45A),
  };
  return `Hi ${firstName}! ${E.wave}

Thank you for your order from *UrbanNaari*! ${E.bag}

Before we ship, we'd love to quickly confirm a couple of details:

${E.hanger} *Items Ordered:*
${itemsText || "(could not load items)"}

${E.pin} *Delivery Address:*
${order.shippingAddress}

Please confirm:
${E.check} Are the items and sizes correct?
${E.check} Is the delivery address correct?

Just reply *"Yes"* if everything looks good, or let us know the changes needed.

Thank you! ${E.heart}
-- Team UrbanNaari`;
}

async function fetchLineItemsText(orderId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/orders/${orderId}/line-items`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.lineItems) return null;
    return data.lineItems
      .map((li: { title: string; quantity: number; variantTitle: string }) => {
        const size = li.variantTitle ? ` (${li.variantTitle})` : "";
        return `- ${li.title}${size} x ${li.quantity}`;
      })
      .join("\n");
  } catch {
    return null;
  }
}

function isPendingCodConfirmation(order: Order): boolean {
  return (
    order.paymentMethod === "COD" &&
    order.deliveryStatus === "Unfulfilled" &&
    !order.whatsappSent &&
    !!order.customerPhone
  );
}

function isDelayed(order: Order, thresholdDays: number): boolean {
  const excludedStatuses: string[] = [
    "Delivered",
    "RTO",
    "RTO Confirmed",
    "RTO Received",
    "Return Initiated",
    "Return Complete",
    "Cancelled",
  ];
  if (excludedStatuses.includes(order.deliveryStatus) || !order.fulfilledDate) {
    return false;
  }
  const fulfilled = new Date(order.fulfilledDate);
  if (isNaN(fulfilled.getTime())) return false;
  const now = new Date();
  const diffDays =
    (now.getTime() - fulfilled.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays > thresholdDays;
}

function getDaysInTransit(order: Order): number {
  if (!order.fulfilledDate) return 0;
  const fulfilled = new Date(order.fulfilledDate);
  if (isNaN(fulfilled.getTime())) return 0;
  const now = new Date();
  return Math.max(0, Math.floor((now.getTime() - fulfilled.getTime()) / (1000 * 60 * 60 * 24)));
}

function getReturnWindowStatus(
  order: Order
): { isOpen: boolean; label: string } | null {
  if (order.deliveryStatus !== "Delivered") return null;
  const timestamp = order.deliveredTimestamp || order.deliveredDate;
  if (!timestamp) return null;
  const deliveredAt = new Date(timestamp);
  if (isNaN(deliveredAt.getTime())) return null;
  const windowEnd = new Date(deliveredAt.getTime() + 48 * 60 * 60 * 1000);
  const now = new Date();
  if (now < windowEnd) {
    return {
      isOpen: true,
      label: `Return window open (closes ${windowEnd.toLocaleString()})`,
    };
  }
  return { isOpen: false, label: "Return window closed" };
}

function formatTimestamp(ts: string): string {
  if (!ts) return "";
  try {
    const date = new Date(ts.replace(" ", "T"));
    return date.toLocaleString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  try {
    const [y, m, d] = dateStr.split("-");
    return `${d}/${m}/${y}`;
  } catch {
    return dateStr;
  }
}

const statuses: Array<{ value: string; label: string }> = [
  { value: "all", label: "All Statuses" },
  { value: "Unfulfilled", label: "Unfulfilled" },
  { value: "Booked", label: "Booked" },
  { value: "Picked Up", label: "Picked Up" },
  { value: "In Transit", label: "In Transit" },
  { value: "At Destination", label: "At Destination" },
  { value: "Out for Delivery", label: "Out for Delivery" },
  { value: "Delivered", label: "Delivered" },
  { value: "Undelivered", label: "Undelivered" },
  { value: "RTO", label: "RTO" },
  { value: "RTO Confirmed", label: "RTO Confirmed" },
  { value: "RTO Received", label: "RTO Received" },
  { value: "Return Initiated", label: "Return Initiated" },
  { value: "Return Complete", label: "Return Complete" },
];

// =============================================================================
// SIDEBAR COMPONENT
// =============================================================================
interface SidebarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

function Sidebar({ activeTab, onTabChange }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems: Array<{
    id: Tab;
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      id: "orders",
      label: "Orders",
      icon: <Package className="h-5 w-5" />,
    },
    {
      id: "influencer",
      label: "Influencer",
      icon: <Users className="h-5 w-5" />,
    },
    {
      id: "abandoned",
      label: "Abandoned",
      icon: <ShoppingCart className="h-5 w-5" />,
    },
    {
      id: "invoices",
      label: "Invoices",
      icon: <FileText className="h-5 w-5" />,
    },
    {
      id: "analytics",
      label: "Analytics",
      icon: <BarChart3 className="h-5 w-5" />,
    },
  ];

  const handleTabChange = (tab: Tab) => {
    onTabChange(tab);
    setMobileOpen(false);
  };

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        className="fixed top-4 left-4 z-50 lg:hidden flex items-center justify-center w-10 h-10 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label="Toggle navigation"
      >
        {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed top-0 left-0 z-40 h-screen bg-zinc-950 border-r border-zinc-800/50
          flex flex-col transition-all duration-300 ease-in-out
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
          lg:translate-x-0 lg:static lg:z-auto
          ${collapsed ? "lg:w-[68px]" : "lg:w-[220px]"}
          w-[220px]
        `}
      >
        {/* Logo / Brand */}
        <div className="flex items-center gap-3 px-4 h-16 border-b border-zinc-800/50 shrink-0">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-600 shrink-0">
            <Truck className="h-4 w-4 text-white" />
          </div>
          <span
            className={`font-semibold text-zinc-100 text-sm whitespace-nowrap overflow-hidden transition-all duration-300 ${
              collapsed ? "lg:w-0 lg:opacity-0" : "lg:w-auto lg:opacity-100"
            }`}
          >
            Urban Naari
          </span>
        </div>

        {/* Navigation items */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleTabChange(item.id)}
                className={`
                  w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium
                  transition-all duration-150 group relative
                  ${
                    isActive
                      ? "bg-blue-600/15 text-blue-400"
                      : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                  }
                `}
                title={collapsed ? item.label : undefined}
              >
                {/* Active indicator bar */}
                {isActive && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-blue-500 rounded-r" />
                )}
                <span className={`shrink-0 ${isActive ? "text-blue-400" : "text-zinc-500 group-hover:text-zinc-300"}`}>
                  {item.icon}
                </span>
                <span
                  className={`whitespace-nowrap overflow-hidden transition-all duration-300 ${
                    collapsed ? "lg:w-0 lg:opacity-0" : "lg:w-auto lg:opacity-100"
                  }`}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Collapse toggle (desktop only) */}
        <div className="hidden lg:flex items-center justify-center px-3 py-3 border-t border-zinc-800/50">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 transition-colors"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <ArrowDownUp className="h-3.5 w-3.5 rotate-90 shrink-0" />
            <span
              className={`whitespace-nowrap overflow-hidden transition-all duration-300 ${
                collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
              }`}
            >
              Collapse
            </span>
          </button>
        </div>
      </aside>
    </>
  );
}

// =============================================================================
// STATS CARDS (DARK)
// =============================================================================
interface StatsCardsDarkProps {
  orders: Order[];
  delayThresholdDays: number;
  shippingConfig: ShippingRateTable;
  onDelayedClick?: () => void;
}

function StatsCardsDark({ orders, delayThresholdDays, shippingConfig, onDelayedClick }: StatsCardsDarkProps) {
  const total = orders.length;
  const unfulfilled = orders.filter(
    (o) => o.deliveryStatus === "Unfulfilled"
  ).length;
  const delivered = orders.filter(
    (o) => o.deliveryStatus === "Delivered"
  ).length;
  const inTransit = orders.filter(
    (o) =>
      o.deliveryStatus === "In Transit" ||
      o.deliveryStatus === "At Destination" ||
      o.deliveryStatus === "Out for Delivery"
  ).length;
  const booked = orders.filter(
    (o) => o.deliveryStatus === "Booked" || o.deliveryStatus === "Picked Up"
  ).length;
  const rto = orders.filter(
    (o) => o.deliveryStatus === "RTO" || o.deliveryStatus === "RTO Confirmed" || o.deliveryStatus === "RTO Received"
  ).length;
  const returns = orders.filter(
    (o) =>
      o.deliveryStatus === "Return Initiated" ||
      o.deliveryStatus === "Return Complete"
  ).length;
  const delayed = orders.filter((o) => isDelayed(o, delayThresholdDays)).length;
  const pendingCodAmount = orders
    .filter(
      (o) =>
        o.paymentMethod === "COD" &&
        o.codCollectionStatus !== "Collected" &&
        o.deliveryStatus === "Delivered"
    )
    .reduce((sum, o) => sum + (o.orderTotal || 0), 0);

  const shippingPendingAmount = orders.reduce((sum, o) => {
    if (o.shippingChargePaid) return sum;
    if (o.deliveryStatus === "Cancelled" || o.deliveryStatus === "Unfulfilled") return sum;
    const charge = calculateShippingCharge(
      o.weightGrams,
      o.paymentMethod,
      o.shippingMode,
      shippingConfig
    );
    return charge !== null ? sum + charge : sum;
  }, 0);

  const stats: Array<{
    title: string;
    value: string | number;
    icon: React.ReactNode;
    accentColor: string;
    glowColor: string;
  }> = [
    {
      title: "Total Orders",
      value: total,
      icon: <Package className="h-5 w-5" />,
      accentColor: "text-zinc-100",
      glowColor: "shadow-zinc-500/5",
    },
    {
      title: "Unfulfilled",
      value: unfulfilled,
      icon: <Clock className="h-5 w-5" />,
      accentColor: "text-yellow-400",
      glowColor: "shadow-yellow-500/10",
    },
    {
      title: "In Transit",
      value: inTransit,
      icon: <Truck className="h-5 w-5" />,
      accentColor: "text-blue-400",
      glowColor: "shadow-blue-500/10",
    },
    {
      title: "Delivered",
      value: delivered,
      icon: <CircleCheck className="h-5 w-5" />,
      accentColor: "text-emerald-400",
      glowColor: "shadow-emerald-500/10",
    },
    {
      title: "Booked",
      value: booked,
      icon: <Clock className="h-5 w-5" />,
      accentColor: "text-amber-400",
      glowColor: "shadow-amber-500/10",
    },
    {
      title: "Delayed",
      value: delayed,
      icon: <AlertTriangle className="h-5 w-5" />,
      accentColor: "text-red-400",
      glowColor: "shadow-red-500/10",
    },
    {
      title: "RTO",
      value: rto,
      icon: <RotateCcw className="h-5 w-5" />,
      accentColor: "text-purple-400",
      glowColor: "shadow-purple-500/10",
    },
    {
      title: "Returns",
      value: returns,
      icon: <RotateCcw className="h-5 w-5" />,
      accentColor: "text-rose-400",
      glowColor: "shadow-rose-500/10",
    },
    {
      title: "Pending COD",
      value:
        pendingCodAmount > 0
          ? `\u20B9${pendingCodAmount.toLocaleString("en-IN")}`
          : "\u20B90",
      icon: <IndianRupee className="h-5 w-5" />,
      accentColor: "text-orange-400",
      glowColor: "shadow-orange-500/10",
    },
    {
      title: "Shipping Pending",
      value:
        shippingPendingAmount > 0
          ? `₹${shippingPendingAmount.toLocaleString("en-IN")}`
          : "₹0",
      icon: <Truck className="h-5 w-5" />,
      accentColor: "text-cyan-400",
      glowColor: "shadow-cyan-500/10",
    },
  ];

  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-10 gap-2">
      {stats.map((stat) => (
        <div
          key={stat.title}
          onClick={stat.title === "Delayed" ? onDelayedClick : undefined}
          className={`
            relative rounded-lg bg-zinc-900 border border-zinc-800/60 px-3 py-2.5
            shadow-lg ${stat.glowColor}
            hover:border-zinc-700/80 transition-all duration-200 group
            ${stat.title === "Delayed" ? "cursor-pointer" : ""}
          `}
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider leading-tight">
              {stat.title}
            </span>
            <span className={`${stat.accentColor} opacity-40 group-hover:opacity-70 transition-opacity [&>svg]:h-4 [&>svg]:w-4`}>
              {stat.icon}
            </span>
          </div>
          <div className={`text-xl lg:text-2xl font-bold ${stat.accentColor} tracking-tight`}>
            {stat.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// SEARCH FILTER (COMMAND PALETTE STYLE)
// =============================================================================
interface SearchFilterDarkProps {
  search: string;
  onSearchChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string | null) => void;
  showDelivered: boolean;
  onShowDeliveredChange: (value: boolean) => void;
  shippingModeFilter: string;
  onShippingModeChange: (value: string | null) => void;
}

function SearchFilterDark({
  search,
  onSearchChange,
  statusFilter,
  onStatusChange,
  showDelivered,
  onShowDeliveredChange,
  shippingModeFilter,
  onShippingModeChange,
}: SearchFilterDarkProps) {
  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 p-4">
      <div className="flex flex-col lg:flex-row gap-3 items-start lg:items-center">
        {/* Command palette style search */}
        <div className="relative flex-1 w-full lg:max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
          <Input
            placeholder="Search orders, customers, tracking..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-9 pr-16 h-9 bg-zinc-800/60 border-zinc-700/50 text-zinc-200 placeholder:text-zinc-500 focus-visible:border-blue-500/50 focus-visible:ring-blue-500/20"
          />
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center gap-0.5 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">
            Ctrl K
          </kbd>
        </div>

        {/* Status filter */}
        <Select value={statusFilter} onValueChange={onStatusChange}>
          <SelectTrigger className="w-full sm:w-44 h-9 bg-zinc-800/60 border-zinc-700/50 text-zinc-300 [&_svg]:text-zinc-500">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent className="bg-zinc-900 border-zinc-700/50 text-zinc-300">
            {statuses.map((s) => (
              <SelectItem
                key={s.value}
                value={s.value}
                className="text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100"
              >
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Shipping mode filter */}
        <Select value={shippingModeFilter} onValueChange={onShippingModeChange}>
          <SelectTrigger className="w-full sm:w-36 h-9 bg-zinc-800/60 border-zinc-700/50 text-zinc-300 [&_svg]:text-zinc-500">
            <SelectValue placeholder="All Modes" />
          </SelectTrigger>
          <SelectContent className="bg-zinc-900 border-zinc-700/50 text-zinc-300">
            <SelectItem value="all" className="text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100">All Modes</SelectItem>
            <SelectItem value="Air" className="text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100">BY AIR</SelectItem>
            <SelectItem value="Road" className="text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100">BY ROAD</SelectItem>
          </SelectContent>
        </Select>

        {/* Show delivered toggle */}
        <div className="flex items-center gap-2.5 shrink-0">
          <Switch
            id="show-delivered-dark"
            checked={showDelivered}
            onCheckedChange={onShowDeliveredChange}
            className="data-checked:bg-blue-600 data-unchecked:bg-zinc-700"
          />
          <label
            htmlFor="show-delivered-dark"
            className="text-sm text-zinc-400 cursor-pointer whitespace-nowrap select-none"
          >
            Show delivered
          </label>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// STATUS BADGE (DARK)
// =============================================================================
const darkStatusConfig: Record<
  DeliveryStatus,
  { className: string; label: string }
> = {
  Unfulfilled: {
    className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    label: "Unfulfilled",
  },
  Booked: {
    className: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    label: "Booked",
  },
  "Picked Up": {
    className: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    label: "Picked Up",
  },
  "In Transit": {
    className: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    label: "In Transit",
  },
  "At Destination": {
    className: "bg-orange-500/10 text-orange-400 border-orange-500/20",
    label: "At Destination",
  },
  "Out for Delivery": {
    className: "bg-sky-500/10 text-sky-400 border-sky-500/20",
    label: "Out for Delivery",
  },
  Delivered: {
    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    label: "Delivered",
  },
  Undelivered: {
    className: "bg-red-500/10 text-red-400 border-red-500/20",
    label: "Undelivered",
  },
  RTO: {
    className: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    label: "RTO",
  },
  "RTO Confirmed": {
    className: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    label: "RTO Confirmed",
  },
  "RTO Received": {
    className: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    label: "RTO Received",
  },
  "Return Initiated": {
    className: "bg-rose-500/10 text-rose-400 border-rose-500/20",
    label: "Return Initiated",
  },
  "Return Complete": {
    className: "bg-teal-500/10 text-teal-400 border-teal-500/20",
    label: "Return Complete",
  },
  "Video Received": {
    className: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20",
    label: "Video Received",
  },
  "Product Received Back": {
    className: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
    label: "Product Received Back",
  },
  Completed: {
    className: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
    label: "Completed",
  },
  Cancelled: {
    className: "bg-red-500/10 text-red-400 border-red-500/20",
    label: "Cancelled",
  },
};

function StatusBadgeDark({ status }: { status: DeliveryStatus }) {
  const config = darkStatusConfig[status] || darkStatusConfig["Booked"];
  return (
    <Badge
      variant="outline"
      className={`${config.className} text-[11px] font-medium`}
    >
      {config.label}
    </Badge>
  );
}

// =============================================================================
// PAYMENT BADGE (DARK)
// =============================================================================
function PaymentBadgeDark({ method }: { method: "COD" | "Prepaid" }) {
  const config =
    method === "COD"
      ? {
          className:
            "bg-orange-500/10 text-orange-400 border-orange-500/20",
          label: "COD",
        }
      : {
          className:
            "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
          label: "Prepaid",
        };

  return (
    <Badge
      variant="outline"
      className={`${config.className} text-[10px] px-1.5 py-0`}
    >
      {config.label}
    </Badge>
  );
}

function ShippingModeBadgeDark({ mode }: { mode: "Air" | "Road" | "" }) {
  if (!mode) return null;
  const config =
    mode === "Air"
      ? {
          className: "bg-sky-500/10 text-sky-400 border-sky-500/20",
          label: "BY AIR",
        }
      : {
          className: "bg-amber-500/10 text-amber-400 border-amber-500/20",
          label: "BY ROAD",
        };

  return (
    <Badge
      variant="outline"
      className={`${config.className} text-[10px] px-1.5 py-0`}
    >
      {config.label}
    </Badge>
  );
}

// =============================================================================
// TRACKING TIMELINE (DARK)
// =============================================================================
interface TrackingTimelineDarkProps {
  events: TrackingEvent[];
}

function TrackingTimelineDark({ events }: TrackingTimelineDarkProps) {
  if (!events || events.length === 0) {
    return (
      <p className="text-sm text-zinc-500 py-4">
        No tracking events yet. Click &quot;Refresh Tracking&quot; to fetch
        updates.
      </p>
    );
  }

  const sortedEvents = [...events].reverse();

  return (
    <div className="py-4 px-2">
      <div className="relative">
        {sortedEvents.map((event, index) => (
          <div key={index} className="flex gap-4 pb-4 last:pb-0">
            {/* Timeline dot and line */}
            <div className="flex flex-col items-center">
              <div
                className={`w-2.5 h-2.5 rounded-full ring-2 ${
                  index === 0
                    ? "bg-blue-500 ring-blue-500/30"
                    : "bg-zinc-700 ring-zinc-700/30"
                }`}
              />
              {index < sortedEvents.length - 1 && (
                <div className="w-px h-full bg-zinc-800 mt-1" />
              )}
            </div>

            {/* Event content */}
            <div className="flex-1 -mt-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm text-zinc-200">
                  {event.status}
                </span>
                <span className="text-xs text-zinc-500">
                  {event.location}
                  {event.branch ? ` - ${event.branch}` : ""}
                </span>
              </div>
              {event.description && (
                <p className="text-xs text-zinc-500 mt-0.5">
                  {event.description}
                </p>
              )}
              <p className="text-xs text-zinc-600 mt-0.5">
                {formatTimestamp(event.timestamp)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// ORDER TABLE (DARK)
// =============================================================================
interface OrderTableDarkProps {
  orders: Order[];
  onOrderUpdated?: () => void;
  delayThresholdDays: number;
  shippingConfig: ShippingRateTable;
}

function OrderTableDark({ orders, onOrderUpdated, delayThresholdDays, shippingConfig }: OrderTableDarkProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rtoInput, setRtoInput] = useState<Record<string, string>>({});
  const [trackingInputs, setTrackingInputs] = useState<Record<string, string>>({});
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpen] = useState<Set<string>>(new Set());
  const [cancelDialogOrder, setCancelDialogOrder] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cachedLineItems, setCachedLineItems] = useState<Record<string, string>>({});

  const handleExpandOrder = useCallback((orderId: string, isExpanded: boolean) => {
    if (isExpanded) {
      setExpandedId(null);
      return;
    }
    setExpandedId(orderId);
    // Pre-fetch line items in background for WhatsApp message
    if (!cachedLineItems[orderId]) {
      fetch(`/api/orders/${orderId}/line-items`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.lineItems) {
            const text = data.lineItems
              .map((li: { title: string; quantity: number; variantTitle: string }) => {
                const size = li.variantTitle ? ` (${li.variantTitle})` : "";
                return `- ${li.title}${size} x ${li.quantity}`;
              })
              .join("\n");
            setCachedLineItems((prev) => ({ ...prev, [orderId]: text }));
          }
        })
        .catch(() => {}); // Silent — items will be fetched again if needed
    }
  }, [cachedLineItems]);

  if (orders.length === 0) {
    return (
      <div className="text-center py-16 text-zinc-500">
        <Package className="h-12 w-12 mx-auto mb-3 text-zinc-700" />
        <p className="text-lg text-zinc-400">No orders found</p>
        <p className="text-sm mt-1 text-zinc-600">
          Click &quot;Sync Orders&quot; to pull orders from Shopify
        </p>
      </div>
    );
  }

  const handleCodToggle = async (orderId: string, currentStatus: string) => {
    setActionLoading(`cod-${orderId}`);
    try {
      const newStatus =
        currentStatus === "Collected" ? "Pending" : "Collected";
      const res = await fetch(`/api/orders/${orderId}/cod-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codCollectionStatus: newStatus }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        alert(`COD update failed: ${json?.error || res.statusText}`);
        return;
      }
      if (json?.shopifyWarning) {
        alert(
          `COD marked ${newStatus} in Notion, but Shopify mark-paid failed: ${json.shopifyWarning}`
        );
      }
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  const handleWeightSaved = (orderId: string, weight: number) => {
    // Update the order in local state optimistically
    const orderEl = orders.find((o) => o.id === orderId);
    if (orderEl) orderEl.weightGrams = weight;
    onOrderUpdated?.();
  };

  const handleShippingPaidToggle = async (orderId: string, currentPaid: boolean) => {
    setActionLoading(`shipping-paid-${orderId}`);
    try {
      const res = await fetch(`/api/orders/${orderId}/shipping-paid`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingChargePaid: !currentPaid }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        alert(`Shipping paid update failed: ${json?.error || res.statusText}`);
        return;
      }
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  const handleShippingModeChange = async (orderId: string, mode: string | null) => {
    if (!mode || (mode !== "Air" && mode !== "Road")) return;
    setActionLoading(`shipping-${orderId}`);
    try {
      const res = await fetch(`/api/orders/${orderId}/shipping-mode`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingMode: mode }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("Shipping mode update failed:", err);
      }
      onOrderUpdated?.();
    } catch (err) {
      console.error("Shipping mode fetch error:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleInitiateRto = async (orderId: string) => {
    setActionLoading(`initiate-rto-${orderId}`);
    try {
      await fetch(`/api/orders/${orderId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryStatus: "RTO" }),
      });
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancelOrder = async (orderId: string) => {
    setActionLoading(`cancel-${orderId}`);
    try {
      const res = await fetch(`/api/orders/${orderId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: cancelReason }),
      });
      const result = await res.json();
      if (!result.success) {
        alert(`Cancel failed: ${result.error}`);
        return;
      }
      if (result.warning) {
        alert(result.warning);
      }
      setCancelDialogOrder(null);
      setCancelReason("");
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  const handleMarkRtoConfirmed = async (orderId: string) => {
    setActionLoading(`rto-confirmed-${orderId}`);
    try {
      await fetch(`/api/orders/${orderId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryStatus: "RTO Confirmed" }),
      });
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeliveredToCustomer = async (orderId: string) => {
    setActionLoading(`delivered-to-customer-${orderId}`);
    try {
      await fetch(`/api/orders/${orderId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryStatus: "Delivered" }),
      });
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  const handleStatusChange = async (orderId: string, status: string | null) => {
    if (!status) return;
    setActionLoading(`status-${orderId}`);
    try {
      const res = await fetch(`/api/orders/${orderId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryStatus: status }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        alert(`Status update failed: ${json?.error || res.statusText}`);
        return;
      }
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  const handleMarkRtoReceived = async (orderId: string) => {
    setActionLoading(`rto-received-${orderId}`);
    try {
      await fetch(`/api/orders/${orderId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryStatus: "RTO Received" }),
      });
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  const handleInitiateReturn = async (orderId: string) => {
    setActionLoading(`return-init-${orderId}`);
    try {
      await fetch(`/api/orders/${orderId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryStatus: "Return Initiated" }),
      });
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  const handleReturnComplete = async (orderId: string) => {
    setActionLoading(`return-complete-${orderId}`);
    try {
      await fetch(`/api/orders/${orderId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryStatus: "Return Complete" }),
      });
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  const handleSaveRtoTracking = async (orderId: string) => {
    const trackingNum = rtoInput[orderId];
    if (!trackingNum) return;
    setActionLoading(`rto-save-${orderId}`);
    try {
      await fetch(`/api/orders/${orderId}/rto-tracking`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtoTrackingNumber: trackingNum }),
      });
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  const handleAssignTracking = async (order: Order) => {
    const orderId = order.id;
    const rawTracking = trackingInputs[orderId];
    if (!rawTracking?.trim()) return;
    const trackingNum = rawTracking.trim();

    // Reserve a blank tab synchronously so browsers don't popup-block the
    // later window.open (after the await, user-gesture context is lost).
    const waTab = order.customerPhone ? window.open("about:blank") : null;

    setActionLoading(`assign-${orderId}`);
    try {
      const res = await fetch(`/api/orders/${orderId}/assign-tracking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trackingNumber: trackingNum,
          courierPartner: "DTDC",
        }),
      });
      const result = await res.json();
      if (!result.success) {
        alert(`Failed: ${result.error}`);
        waTab?.close();
        return;
      }
      setTrackingInputs((prev) => ({ ...prev, [orderId]: "" }));

      if (waTab && order.customerPhone) {
        const phone = normalizeWhatsAppPhone(order.customerPhone);
        const firstName = order.customerName.split(" ")[0];

        const E = {
          pkg: String.fromCodePoint(0x1F4E6),
          truck: String.fromCodePoint(0x1F69A),
          link: String.fromCodePoint(0x1F517),
          sparkles: String.fromCodePoint(0x2728),
          heart: String.fromCodePoint(0x1F49C),
        };

        const zwspTracking = trackingNum.split("").join("\u200B");
        const trackingLink = dtdcTrackingUrl(trackingNum);

        const message = `Hi ${firstName}! ${E.pkg}

Great news \u2014 your *UrbanNaari* order is on its way! ${E.truck}

*Tracking Number:* ${zwspTracking}
${E.link} *Track here:* ${trackingLink}

You'll receive your parcel in 4\u20137 business days. ${E.sparkles}

We hope you love what you've picked ${String.fromCodePoint(0x1F457)} \u2014 can't wait to see you style it!

Thank you for shopping with us! ${E.heart}
-- Team UrbanNaari`;

        const waUrl = new URL("https://web.whatsapp.com/send");
        waUrl.searchParams.set("phone", phone);
        waUrl.searchParams.set("text", message);
        waTab.location.href = waUrl.toString();
      } else {
        waTab?.close();
      }

      onOrderUpdated?.();
    } catch (err) {
      waTab?.close();
      throw err;
    } finally {
      setActionLoading(null);
    }
  };

  const handleSendEmail = async (orderId: string) => {
    setActionLoading(`email-${orderId}`);
    try {
      const res = await fetch("/api/email/delivery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      const data = await res.json();
      if (!data.success) {
        alert(`Email failed: ${data.error}`);
        return;
      }
      alert("Delivery email sent!");
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  const handleSendReviewEmail = async (orderId: string) => {
    setActionLoading(`review-${orderId}`);
    try {
      const res = await fetch("/api/email/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      const data = await res.json();
      if (!data.success) {
        alert(`Review email failed: ${data.error}`);
        return;
      }
      alert("Review email sent!");
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  const handleWhatsAppConfirmation = async (order: Order) => {
    const phone = normalizeWhatsAppPhone(order.customerPhone);
    const itemsText = cachedLineItems[order.id] || "";
    const message = buildCodConfirmationMessage(order, itemsText);
    window.open(buildWhatsAppUrl(phone, message));

    // Mark as WhatsApp sent in Notion
    setActionLoading(`whatsapp-${order.id}`);
    try {
      const res = await fetch(`/api/orders/${order.id}/whatsapp-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isCod: order.paymentMethod === "COD" }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error("markWhatsAppSent failed:", res.status, body);
        alert(`Failed to mark WhatsApp sent (${res.status}): ${body.slice(0, 300)}`);
        return;
      }
      onOrderUpdated?.();
    } catch (err) {
      console.error("markWhatsAppSent error:", err);
      alert(`Failed to mark WhatsApp sent: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleWhatsAppFollowUp = async (order: Order) => {
    const phone = normalizeWhatsAppPhone(order.customerPhone);
    const firstName = order.customerName.split(" ")[0];

    const E = {
      wave: String.fromCodePoint(0x1F44B),
      sparkle: String.fromCodePoint(0x2728),
      point: String.fromCodePoint(0x1F449),
      heart: String.fromCodePoint(0x1F49C),
    };

    const message = `Hi ${firstName}! ${E.wave}

Just a quick follow-up regarding your UrbanNaari order ${E.sparkle}

We sent you a message earlier to confirm your order details. Could you please reply when you get a chance? ${E.point}

Thank you! ${E.heart}
-- Team UrbanNaari`;

    const url = new URL("https://web.whatsapp.com/send");
    url.searchParams.set("phone", phone);
    url.searchParams.set("text", message);
    window.open(url.toString());

    // Record follow-up in Notion
    setActionLoading(`whatsapp-followup-${order.id}`);
    try {
      const res = await fetch(`/api/orders/${order.id}/whatsapp-status`, {
        method: "PUT",
      });
      if (!res.ok) {
        const body = await res.text();
        console.error("recordWhatsAppFollowUp failed:", res.status, body);
        alert(`Failed to record follow-up (${res.status}): ${body.slice(0, 300)}`);
        return;
      }
      onOrderUpdated?.();
    } catch (err) {
      console.error("recordWhatsAppFollowUp error:", err);
      alert(`Failed to record follow-up: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleCodConfirmation = async (orderId: string, status: "Confirmed on Call" | "Confirmed on WhatsApp" | "Declined" | "No Reply") => {
    setActionLoading(`cod-confirm-${orderId}`);
    try {
      const res = await fetch(`/api/orders/${orderId}/whatsapp-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        onOrderUpdated?.();
      } else {
        alert("Failed to update COD confirmation status");
      }
    } catch {
      alert("Failed to update COD confirmation status");
    } finally {
      setActionLoading(null);
    }
  };

  const handleWhatsAppReview = (order: Order) => {
    const phone = normalizeWhatsAppPhone(order.customerPhone);
    const heart = String.fromCodePoint(0x1F49C);
    const message = `Hi ${order.customerName}! Thank you for shopping with UrbanNaari. We hope you're loving your order (${order.orderNumber}). We'd really appreciate it if you could share your experience with us — it helps other shoppers too! Leave a review here: https://urbannaari.co.in\n\nThank you! ${heart}\n— Team UrbanNaari`;
    const url = new URL(`https://web.whatsapp.com/send`);
    url.searchParams.set("phone", phone);
    url.searchParams.set("text", message);
    window.open(url.toString());
  };

  const handleRtoWhatsApp = (order: Order) => {
    const phone = normalizeWhatsAppPhone(order.customerPhone);
    const firstName = order.customerName.split(" ")[0];

    const E = {
      wave: String.fromCodePoint(0x1F44B),
      package: String.fromCodePoint(0x1F4E6),
      heart: String.fromCodePoint(0x1F49C),
    };

    const message = `Hi ${firstName}! ${E.wave}

Our delivery partner tried to deliver your order but was unable to reach you. ${E.package}

Could you please ensure you're available at your registered number so the delivery can be completed?

Just reply *"Yes"* if you're reachable, and we'll coordinate the re-delivery.

Thank you! ${E.heart}
-- Team UrbanNaari`;

    const url = new URL("https://web.whatsapp.com/send");
    url.searchParams.set("phone", phone);
    url.searchParams.set("text", message);
    window.open(url.toString());

    // Mark as RTO WhatsApp sent in Notion (fire-and-forget)
    fetch(`/api/orders/${order.id}/rto-whatsapp-status`, {
      method: "POST",
    })
      .then(() => onOrderUpdated?.())
      .catch(() => {});
  };

  const handleOfdWhatsApp = (order: Order) => {
    const phone = normalizeWhatsAppPhone(order.customerPhone);
    const firstName = order.customerName.split(" ")[0];

    const E = {
      wave: String.fromCodePoint(0x1F44B),
      truck: String.fromCodePoint(0x1F69A),
      heart: String.fromCodePoint(0x1F49C),
    };

    const message = `Hi ${firstName}! ${E.wave}

Your UrbanNaari order is out for delivery today! ${E.truck}

Please ensure someone is available to receive it.

Thank you! ${E.heart}
-- Team UrbanNaari`;

    window.open(buildWhatsAppUrl(phone, message));

    // Mark as OFD WhatsApp sent in Notion (fire-and-forget)
    fetch(`/api/orders/${order.id}/ofd-whatsapp-status`, {
      method: "POST",
    })
      .then(() => onOrderUpdated?.())
      .catch(() => {});
  };

  const handleRtoFollowUp = (order: Order) => {
    const phone = normalizeWhatsAppPhone(order.customerPhone);
    const firstName = order.customerName.split(" ")[0];

    const E = {
      wave: String.fromCodePoint(0x1F44B),
      point: String.fromCodePoint(0x1F449),
      heart: String.fromCodePoint(0x1F49C),
    };

    const message = `Hi ${firstName}! ${E.wave}

Just a quick follow-up — our delivery partner was unable to reach you for your UrbanNaari order. ${E.point}

Could you please reply so we can arrange the re-delivery?

Thank you! ${E.heart}
-- Team UrbanNaari`;

    const url = new URL("https://web.whatsapp.com/send");
    url.searchParams.set("phone", phone);
    url.searchParams.set("text", message);
    window.open(url.toString());

    // Record follow-up in Notion (fire-and-forget)
    fetch(`/api/orders/${order.id}/rto-whatsapp-status`, {
      method: "PUT",
    })
      .then(() => onOrderUpdated?.())
      .catch(() => {});
  };

  const handleRtoConfirmation = async (orderId: string, status: "Reachable" | "Cancel" | "No Reply") => {
    setActionLoading(`rto-confirm-${orderId}`);
    try {
      const res = await fetch(`/api/orders/${orderId}/rto-whatsapp-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        onOrderUpdated?.();
      } else {
        alert("Failed to update RTO confirmation status");
      }
    } catch {
      alert("Failed to update RTO confirmation status");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRefreshOrder = async (orderId: string) => {
    setActionLoading(`refresh-${orderId}`);
    try {
      const res = await fetch(`/api/orders/${orderId}/refresh`, {
        method: "POST",
      });
      if (!res.ok) {
        const text = await res.text();
        let errorMsg = `Server error (${res.status})`;
        try {
          const json = JSON.parse(text);
          errorMsg = json.error || errorMsg;
        } catch {}
        alert(`Refresh failed: ${errorMsg}`);
        return;
      }
      const data = await res.json();
      if (!data.success) {
        alert(`Refresh failed: ${data.error}`);
        return;
      }
      onOrderUpdated?.();
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-zinc-800/60 hover:bg-transparent">
            <TableHead className="w-[40px] text-zinc-500"></TableHead>
            <TableHead className="w-[110px] text-zinc-500 text-xs uppercase tracking-wider font-medium">
              Order
            </TableHead>
            <TableHead className="text-zinc-500 text-xs uppercase tracking-wider font-medium">
              Customer
            </TableHead>
            <TableHead className="hidden md:table-cell text-zinc-500 text-xs uppercase tracking-wider font-medium">
              Destination
            </TableHead>
            <TableHead className="text-zinc-500 text-xs uppercase tracking-wider font-medium">
              Status
            </TableHead>
            <TableHead className="hidden md:table-cell text-zinc-500 text-xs uppercase tracking-wider font-medium">
              Initiated
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.map((order) => {
            const delayed = isDelayed(order, delayThresholdDays);
            const isExpanded = expandedId === order.id;

            return (
              <Fragment key={order.id}>
                <TableRow
                  className={`
                    border-b border-zinc-800/40 hover:bg-zinc-800/40 transition-colors cursor-pointer

                    ${isExpanded ? "bg-zinc-800/30" : ""}
                  `}
                  onClick={() =>
                    handleExpandOrder(order.id, isExpanded)
                  }
                >
                  <TableCell className="px-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleExpandOrder(order.id, isExpanded);
                      }}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  </TableCell>
                  <TableCell className="font-medium">
                    {SHOPIFY_STORE_URL ? (
                      <a
                        href={`https://${SHOPIFY_STORE_URL}/admin/orders/${order.shopifyOrderId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 hover:underline inline-flex items-center gap-1 text-sm"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {order.orderNumber}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-zinc-200 text-sm">
                        {order.orderNumber}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-sm text-zinc-200">
                          {order.customerName}
                        </span>
                        <PaymentBadgeDark method={order.paymentMethod} />
                        {order.paymentMethod === "COD" &&
                          order.deliveryStatus !== "Unfulfilled" &&
                          (order.codCollectionStatus === "Collected" ? (
                            <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 inline-flex items-center gap-0.5">
                              <Check className="h-2.5 w-2.5" />
                              Paid
                            </span>
                          ) : order.deliveryStatus === "RTO Received" ||
                            order.deliveryStatus === "RTO Confirmed" ? (
                            <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-zinc-500/10 text-zinc-500 border border-zinc-500/30 line-through">
                              ₹{order.orderTotal} due
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">
                              ₹{order.orderTotal} due
                            </span>
                          ))}
                        {order.shippingChargePaid && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 inline-flex items-center gap-0.5">
                            <Truck className="h-2.5 w-2.5" />
                            Shipping Paid
                          </span>
                        )}
                        {delayed && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-red-500/15 text-red-400 border border-red-500/30">
                            Delayed
                          </span>
                        )}
                        {order.attemptCount >= 2 && (
                          <span className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded border ${order.attemptCount >= 3 ? "bg-red-500/15 text-red-400 border-red-500/30" : "bg-orange-500/15 text-orange-400 border-orange-500/30"}`}>
                            {order.attemptCount} attempts
                          </span>
                        )}
                      </div>
                      {order.customerPhone && (
                        <a
                          href={`tel:${order.customerPhone}`}
                          className="text-xs text-blue-400/70 hover:text-blue-400 hover:underline inline-flex items-center gap-0.5 mt-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Phone className="h-3 w-3" />
                          {order.customerPhone}
                        </a>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-zinc-400">
                    {order.destinationCity ? `${order.destinationCity}${order.destinationPincode ? ` ${order.destinationPincode}` : ""}` : "-"}
                  </TableCell>
                  <TableCell>
                    <StatusBadgeDark status={order.deliveryStatus} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-zinc-400">
                    {order.deliveryStatus === "Unfulfilled"
                      ? formatDate(order.orderDate) || "-"
                      : formatDate(order.fulfilledDate) || "-"}
                  </TableCell>
                </TableRow>

                {/* Expanded detail row */}
                {isExpanded && (
                  <TableRow
                    key={`${order.id}-details`}
                    className="hover:bg-transparent"
                  >
                    <TableCell
                      colSpan={6}
                      className="bg-blue-950/40 border-b border-zinc-800/40 p-0 whitespace-normal"
                    >
                      <div className="px-6 py-5 border-l-2 border-l-blue-500/30">
                        {/* GST Invoice */}
                        <div className="flex items-center justify-between gap-3 mb-4 pb-4 border-b border-zinc-800/60">
                          <span className="text-xs text-zinc-500">
                            GST Tax Invoice for {order.orderNumber}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-blue-500/30 text-blue-300 hover:bg-blue-500/10 bg-transparent"
                            onClick={(e) => {
                              e.stopPropagation();
                              window.open(
                                `/api/orders/${order.id}/invoice`,
                                "_blank"
                              );
                            }}
                          >
                            <Download className="h-3.5 w-3.5 mr-1.5" />
                            Download Invoice
                          </Button>
                        </div>
                        {/* Assign tracking for unfulfilled orders */}
                        {order.deliveryStatus === "Unfulfilled" && (
                          <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-lg p-4 mb-4">
                            <p className="text-sm font-medium text-yellow-400 mb-3 flex items-center gap-2">
                              <Package className="h-4 w-4" />
                              Assign Tracking Number
                            </p>
                            <div className="flex items-center gap-2">
                              <Input
                                placeholder="Enter DTDC tracking number"
                                value={trackingInputs[order.id] || ""}
                                onChange={(e) =>
                                  setTrackingInputs((prev) => ({
                                    ...prev,
                                    [order.id]: e.target.value,
                                  }))
                                }
                                className="h-9 bg-zinc-800/60 border-zinc-700/50 text-zinc-200 flex-1 max-w-xs"
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => e.stopPropagation()}
                              />
                              <Button
                                size="sm"
                                className="bg-blue-600 hover:bg-blue-700 text-white"
                                disabled={
                                  !trackingInputs[order.id]?.trim() ||
                                  actionLoading === `assign-${order.id}`
                                }
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleAssignTracking(order);
                                }}
                              >
                                {actionLoading === `assign-${order.id}` ? (
                                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                ) : (
                                  <Truck className="h-3.5 w-3.5 mr-1.5" />
                                )}
                                Fulfill &amp; Track
                              </Button>
                              {order.customerPhone && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className={`bg-transparent ${order.whatsappSent ? "border-green-500/30 text-green-300" : "border-green-700/50 text-green-400 hover:bg-green-900/30"}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleWhatsAppConfirmation(order);
                                  }}
                                >
                                  {order.whatsappSent ? (
                                    <Check className="h-3.5 w-3.5 mr-1.5" />
                                  ) : (
                                    <svg className="h-3.5 w-3.5 mr-1.5" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                                  )}
                                  {order.whatsappSent ? "WhatsApp Sent" : "Confirm on WhatsApp"}
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-red-500/30 text-red-400 hover:bg-red-500/10 bg-transparent"
                                disabled={actionLoading === `cancel-${order.id}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCancelDialogOrder(order.id);
                                }}
                              >
                                <X className="h-3.5 w-3.5 mr-1.5" />
                                Cancel Order
                              </Button>
                            </div>
                          </div>
                        )}

                        {/* COD Confirmation Status */}
                        {order.paymentMethod === "COD" && (
                          <div className="flex items-center gap-3 mb-4 px-1">
                            <span className="text-xs text-zinc-500">COD Confirmation:</span>
                            <Select
                              value={order.codConfirmationStatus || "_none"}
                              onValueChange={(val) => {
                                if (val !== "_none") {
                                  handleCodConfirmation(order.id, val as "Confirmed on Call" | "Confirmed on WhatsApp" | "Declined" | "No Reply");
                                }
                              }}
                              disabled={actionLoading === `cod-confirm-${order.id}`}
                            >
                              <SelectTrigger
                                className={`w-[200px] h-7 text-xs bg-transparent border ${
                                  order.codConfirmationStatus === "Confirmed on Call"
                                    ? "border-green-500/40 text-green-400"
                                    : order.codConfirmationStatus === "Confirmed on WhatsApp"
                                    ? "border-blue-500/40 text-blue-400"
                                    : order.codConfirmationStatus === "Declined"
                                    ? "border-red-500/40 text-red-400"
                                    : order.codConfirmationStatus === "No Reply"
                                    ? "border-zinc-500/40 text-zinc-400"
                                    : "border-zinc-700 text-zinc-500"
                                }`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <SelectValue placeholder="Select status..." />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="Confirmed on Call">
                                  <span className="text-green-400">Confirmed on Call</span>
                                </SelectItem>
                                <SelectItem value="Confirmed on WhatsApp">
                                  <span className="text-blue-400">Confirmed on WhatsApp</span>
                                </SelectItem>
                                <SelectItem value="Declined">
                                  <span className="text-red-400">Declined</span>
                                </SelectItem>
                                <SelectItem value="No Reply">
                                  <span className="text-zinc-400">No Reply</span>
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            {actionLoading === `cod-confirm-${order.id}` && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />
                            )}
                            {order.whatsappSent && (!order.codConfirmationStatus || order.codConfirmationStatus === "No Reply") && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs border-amber-500/30 text-amber-400 hover:bg-amber-900/20 bg-transparent ml-auto"
                                disabled={actionLoading === `whatsapp-followup-${order.id}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleWhatsAppFollowUp(order);
                                }}
                              >
                                {actionLoading === `whatsapp-followup-${order.id}` ? (
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                ) : (
                                  <svg className="h-3 w-3 mr-1" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                                )}
                                Follow Up
                              </Button>
                            )}
                            {order.whatsappFollowUpCount > 0 && (
                              <span className={`text-[10px] text-zinc-500 ${order.whatsappSent && (!order.codConfirmationStatus || order.codConfirmationStatus === "No Reply") ? "" : "ml-auto"}`}>
                                Follow-ups: <span className="text-amber-400">{order.whatsappFollowUpCount}</span>
                                {order.whatsappLastFollowUpDate && (
                                  <> · Last: {new Date(order.whatsappLastFollowUpDate).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</>
                                )}
                              </span>
                            )}
                          </div>
                        )}

                        {/* RTO Confirmation Status */}
                        {order.deliveryStatus === "RTO" && (
                          <div className="flex items-center gap-3 mb-4 px-1">
                            <span className="text-xs text-zinc-500">RTO Confirmation:</span>
                            <Select
                              value={order.rtoConfirmationStatus || "_none"}
                              onValueChange={(val) => {
                                if (val !== "_none") {
                                  handleRtoConfirmation(order.id, val as "Reachable" | "Cancel" | "No Reply");
                                }
                              }}
                              disabled={actionLoading === `rto-confirm-${order.id}`}
                            >
                              <SelectTrigger
                                className={`w-[200px] h-7 text-xs bg-transparent border ${
                                  order.rtoConfirmationStatus === "Reachable"
                                    ? "border-green-500/40 text-green-400"
                                    : order.rtoConfirmationStatus === "Cancel"
                                    ? "border-red-500/40 text-red-400"
                                    : order.rtoConfirmationStatus === "No Reply"
                                    ? "border-zinc-500/40 text-zinc-400"
                                    : "border-zinc-700 text-zinc-500"
                                }`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <SelectValue placeholder="Select status..." />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="Reachable">
                                  <span className="text-green-400">Reachable</span>
                                </SelectItem>
                                <SelectItem value="Cancel">
                                  <span className="text-red-400">Cancel</span>
                                </SelectItem>
                                <SelectItem value="No Reply">
                                  <span className="text-zinc-400">No Reply</span>
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            {actionLoading === `rto-confirm-${order.id}` && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />
                            )}
                            {order.rtoWhatsappSent && (!order.rtoConfirmationStatus || order.rtoConfirmationStatus === "No Reply") && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs border-amber-500/30 text-amber-400 hover:bg-amber-900/20 bg-transparent ml-auto"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRtoFollowUp(order);
                                  }}
                                >
                                  <svg className="h-3 w-3 mr-1" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                                  Follow Up
                                  {order.rtoFollowUpCount > 0 && (
                                    <span className="ml-1 bg-amber-500/30 rounded-full px-1.5 text-[10px]">
                                      {order.rtoFollowUpCount}
                                    </span>
                                  )}
                                </Button>
                                {order.rtoFollowUpCount > 0 && order.rtoLastFollowUpDate && (
                                  <span className="text-[10px] text-zinc-600">
                                    Last: {new Date(order.rtoLastFollowUpDate).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                        )}

                        {/* Info grid */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-4">
                          <div className="flex items-center gap-2">
                            <Hash className="h-3.5 w-3.5 text-zinc-600" />
                            <div>
                              <span className="text-zinc-500 text-xs block">
                                Tracking #
                              </span>
                              {order.trackingNumber ? (
                                <a
                                  href={dtdcTrackingUrl(order.trackingNumber)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-medium text-zinc-300 hover:text-white underline underline-offset-2 decoration-zinc-600"
                                >
                                  {order.trackingNumber}
                                </a>
                              ) : (
                                <span className="font-medium text-zinc-300">
                                  -
                                </span>
                              )}
                            </div>
                          </div>
                          {order.deliveredTimestamp && (
                            <div className="flex items-center gap-2">
                              <Calendar className="h-3.5 w-3.5 text-zinc-600" />
                              <div>
                                <span className="text-zinc-500 text-xs block">
                                  Delivered at
                                </span>
                                <span className="font-medium text-zinc-300">
                                  {order.deliveredTimestamp}
                                </span>
                              </div>
                            </div>
                          )}
                          {order.paymentMethod === "COD" && (
                            <div className="flex items-center gap-2">
                              <IndianRupee className="h-3.5 w-3.5 text-zinc-600" />
                              <div>
                                <span className="text-zinc-500 text-xs block">
                                  Order Total
                                </span>
                                <span className="font-medium text-zinc-300">
                                  {"\u20B9"}
                                  {order.orderTotal?.toLocaleString("en-IN") ||
                                    "0"}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Shipping address */}
                        {order.shippingAddress && (
                          <p className="text-xs text-zinc-500 mb-4 flex items-start gap-1.5">
                            <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
                            {order.shippingAddress}
                          </p>
                        )}

                        {/* Delivery person phone (Out for Delivery only) */}
                        {order.deliveryStatus === "Out for Delivery" && order.workerMobile && (
                          <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400 text-sm">
                            <Phone className="h-4 w-4 shrink-0" />
                            <span>Delivery Person:</span>
                            <a
                              href={`tel:${order.workerMobile}`}
                              className="font-medium hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {order.workerMobile}
                            </a>
                          </div>
                        )}

                        {/* OFD WhatsApp button (Out for Delivery only) */}
                        {order.deliveryStatus === "Out for Delivery" && order.customerPhone && (
                          <div className="flex items-center gap-2 mb-4">
                            <Button
                              size="sm"
                              variant="outline"
                              className={`h-7 px-2 text-xs bg-transparent ${
                                order.ofdWhatsappSent
                                  ? "border-zinc-700 text-zinc-500"
                                  : "border-sky-500/40 text-sky-400 hover:bg-sky-900/20"
                              }`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOfdWhatsApp(order);
                              }}
                            >
                              <svg className="h-3 w-3 mr-1" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                              {order.ofdWhatsappSent ? "OFD Message Sent" : "Send OFD WhatsApp"}
                            </Button>
                          </div>
                        )}

                        {/* Cancellation reason */}
                        {order.deliveryStatus === "Cancelled" && order.cancellationReason && (
                          <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                            <X className="h-4 w-4 shrink-0" />
                            <span>
                              <strong>Cancellation Reason:</strong>{" "}
                              {order.cancellationReason}
                            </span>
                          </div>
                        )}

                        {/* Delayed warning */}
                        {delayed && (
                          <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                            <AlertTriangle className="h-4 w-4 shrink-0" />
                            <span>
                              This order has been in transit for more than{" "}
                              {delayThresholdDays} days ({getDaysInTransit(order)} days)
                            </span>
                          </div>
                        )}

                        {/* Undelivered failure reason */}
                        {order.deliveryStatus === "Undelivered" && order.reasonDesc && (
                          <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                            <AlertTriangle className="h-4 w-4 shrink-0" />
                            <span>
                              <strong>Reason:</strong> {order.reasonDesc}
                              {order.reasonCode && (
                                <span className="text-red-400/60 ml-1">({order.reasonCode})</span>
                              )}
                              {order.attemptCount > 0 && (
                                <span className="text-red-400/60 ml-1">
                                  | {order.attemptCount} attempt{order.attemptCount !== 1 ? "s" : ""}
                                </span>
                              )}
                            </span>
                          </div>
                        )}

                        {/* Return window */}
                        {(() => {
                          const rw = getReturnWindowStatus(order);
                          if (!rw) return null;
                          return (
                            <div
                              className={`text-sm mb-4 px-3 py-2 rounded-lg inline-flex items-center gap-2 ${
                                rw.isOpen
                                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                  : "bg-zinc-800 text-zinc-500 border border-zinc-700/50"
                              }`}
                            >
                              {rw.isOpen ? (
                                <Clock className="h-3.5 w-3.5" />
                              ) : (
                                <Check className="h-3.5 w-3.5" />
                              )}
                              {rw.label}
                            </div>
                          );
                        })()}

                        {/* Actions row */}
                        <div className="flex flex-wrap gap-2 mt-4 mb-4">
                          {/* Refresh this order */}
                          {order.trackingNumber && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-zinc-700/50 text-zinc-300 hover:bg-zinc-800 bg-transparent"
                              disabled={
                                actionLoading === `refresh-${order.id}`
                              }
                              onClick={() => handleRefreshOrder(order.id)}
                            >
                              {actionLoading === `refresh-${order.id}` ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                              )}
                              Refresh Tracking
                            </Button>
                          )}

                          {/* Manual status override (DTDC auto-tracking down) */}
                          <Select
                            value={order.deliveryStatus}
                            onValueChange={(v) => handleStatusChange(order.id, v)}
                          >
                            <SelectTrigger className="w-44 h-8 text-xs font-medium bg-zinc-800/60 border-zinc-700/50 text-zinc-200 [&_svg]:text-current">
                              <div className="flex items-center gap-1.5">
                                {actionLoading === `status-${order.id}` ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <PencilLine className="h-3.5 w-3.5" />
                                )}
                                <span className="text-zinc-500">Set:</span>
                                <SelectValue placeholder="status" />
                              </div>
                            </SelectTrigger>
                            <SelectContent className="bg-zinc-900 border-zinc-700/50 text-zinc-300">
                              <SelectItem value="In Transit" className="focus:bg-zinc-800">
                                In Transit
                              </SelectItem>
                              <SelectItem value="Out for Delivery" className="focus:bg-zinc-800">
                                Out for Delivery
                              </SelectItem>
                              <SelectItem value="Delivered" className="text-emerald-400 focus:bg-zinc-800 focus:text-emerald-300">
                                Delivered
                              </SelectItem>
                              <SelectItem value="Undelivered" className="text-amber-400 focus:bg-zinc-800 focus:text-amber-300">
                                Undelivered
                              </SelectItem>
                              <SelectItem value="RTO" className="text-red-400 focus:bg-zinc-800 focus:text-red-300">
                                RTO
                              </SelectItem>
                            </SelectContent>
                          </Select>

                          {/* COD collection toggle */}
                          {order.paymentMethod === "COD" && (
                            <Button
                              size="sm"
                              variant={
                                order.codCollectionStatus === "Collected"
                                  ? "outline"
                                  : "default"
                              }
                              disabled={
                                actionLoading === `cod-${order.id}`
                              }
                              onClick={() =>
                                handleCodToggle(
                                  order.id,
                                  order.codCollectionStatus
                                )
                              }
                              className={
                                order.codCollectionStatus === "Collected"
                                  ? "border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 bg-transparent"
                                  : "bg-blue-600 hover:bg-blue-700 text-white"
                              }
                            >
                              {actionLoading === `cod-${order.id}` ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                              ) : (
                                <IndianRupee className="h-3.5 w-3.5 mr-1.5" />
                              )}
                              {order.codCollectionStatus === "Collected"
                                ? "COD Collected"
                                : "Mark COD Collected"}
                              {order.codCollectionStatus === "Collected" && (
                                <Check className="h-3.5 w-3.5 ml-1" />
                              )}
                            </Button>
                          )}

                          {/* Shipping Mode */}
                          <Select
                            value={order.shippingMode}
                            onValueChange={(v) => handleShippingModeChange(order.id, v)}
                          >
                            <SelectTrigger
                              className={`w-36 h-8 text-xs font-medium ${
                                order.shippingMode === "Air"
                                  ? "bg-sky-500/10 border-sky-500/30 text-sky-400"
                                  : "bg-amber-500/10 border-amber-500/30 text-amber-400"
                              } [&_svg]:text-current`}
                            >
                              <div className="flex items-center gap-1.5">
                                {actionLoading === `shipping-${order.id}` ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : order.shippingMode === "Air" ? (
                                  <Plane className="h-3.5 w-3.5" />
                                ) : (
                                  <Truck className="h-3.5 w-3.5" />
                                )}
                                <SelectValue />
                              </div>
                            </SelectTrigger>
                            <SelectContent className="bg-zinc-900 border-zinc-700/50 text-zinc-300">
                              <SelectItem value="Air" className="text-sky-400 focus:bg-zinc-800 focus:text-sky-300">
                                BY AIR
                              </SelectItem>
                              <SelectItem value="Road" className="text-amber-400 focus:bg-zinc-800 focus:text-amber-300">
                                BY ROAD
                              </SelectItem>
                            </SelectContent>
                          </Select>

                          {/* Weight + Shipping Charge */}
                          <WeightInput
                            orderId={order.id}
                            initialWeight={order.weightGrams}
                            shippingCharge={calculateShippingCharge(
                              order.weightGrams,
                              order.paymentMethod,
                              order.shippingMode,
                              shippingConfig
                            )}
                            onWeightSaved={handleWeightSaved}
                          />

                          {/* Shipping Paid toggle */}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={actionLoading === `shipping-paid-${order.id}`}
                            onClick={() =>
                              handleShippingPaidToggle(
                                order.id,
                                order.shippingChargePaid
                              )
                            }
                            className={
                              order.shippingChargePaid
                                ? "border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 bg-transparent"
                                : "border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 bg-transparent"
                            }
                          >
                            {actionLoading === `shipping-paid-${order.id}` ? (
                              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                            ) : order.shippingChargePaid ? (
                              <Check className="h-3.5 w-3.5 mr-1.5" />
                            ) : (
                              <Truck className="h-3.5 w-3.5 mr-1.5" />
                            )}
                            {order.shippingChargePaid
                              ? "Shipping Paid"
                              : "Mark Shipping Paid"}
                          </Button>

                          {/* Initiate RTO */}
                          {order.deliveryStatus === "Undelivered" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-purple-500/30 text-purple-400 hover:bg-purple-500/10 bg-transparent"
                              disabled={
                                actionLoading === `initiate-rto-${order.id}`
                              }
                              onClick={() =>
                                handleInitiateRto(order.id)
                              }
                            >
                              {actionLoading ===
                              `initiate-rto-${order.id}` ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                              )}
                              Initiate RTO
                            </Button>
                          )}

                          {/* RTO Confirmed / Delivered to Customer / RTO WhatsApp */}
                          {order.deliveryStatus === "RTO" && (
                            <>
                              {order.customerPhone && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className={`bg-transparent ${order.rtoWhatsappSent ? "border-green-500/30 text-green-300" : "border-green-700/50 text-green-400 hover:bg-green-900/30"}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRtoWhatsApp(order);
                                  }}
                                >
                                  {order.rtoWhatsappSent ? (
                                    <Check className="h-3.5 w-3.5 mr-1.5" />
                                  ) : (
                                    <svg className="h-3.5 w-3.5 mr-1.5" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                                  )}
                                  {order.rtoWhatsappSent ? "RTO WA Sent" : "RTO WhatsApp"}
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-purple-500/30 text-purple-400 hover:bg-purple-500/10 bg-transparent"
                                disabled={
                                  actionLoading === `rto-confirmed-${order.id}`
                                }
                                onClick={() =>
                                  handleMarkRtoConfirmed(order.id)
                                }
                              >
                                {actionLoading ===
                                `rto-confirmed-${order.id}` ? (
                                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                ) : (
                                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                                )}
                                RTO Confirmed
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-green-500/30 text-green-400 hover:bg-green-500/10 bg-transparent"
                                disabled={
                                  actionLoading === `delivered-to-customer-${order.id}`
                                }
                                onClick={() =>
                                  handleDeliveredToCustomer(order.id)
                                }
                              >
                                {actionLoading ===
                                `delivered-to-customer-${order.id}` ? (
                                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                ) : (
                                  <Check className="h-3.5 w-3.5 mr-1.5" />
                                )}
                                Delivered to Customer
                              </Button>
                            </>
                          )}

                          {/* RTO Received */}
                          {order.deliveryStatus === "RTO Confirmed" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-purple-500/30 text-purple-400 hover:bg-purple-500/10 bg-transparent"
                              disabled={
                                actionLoading === `rto-received-${order.id}`
                              }
                              onClick={() =>
                                handleMarkRtoReceived(order.id)
                              }
                            >
                              {actionLoading ===
                              `rto-received-${order.id}` ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                              ) : (
                                <Package className="h-3.5 w-3.5 mr-1.5" />
                              )}
                              RTO Received
                            </Button>
                          )}

                          {/* Initiate Return */}
                          {order.deliveryStatus === "Delivered" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-rose-500/30 text-rose-400 hover:bg-rose-500/10 bg-transparent"
                              disabled={
                                actionLoading ===
                                `return-init-${order.id}`
                              }
                              onClick={() =>
                                handleInitiateReturn(order.id)
                              }
                            >
                              {actionLoading ===
                              `return-init-${order.id}` ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                              )}
                              Initiate Return
                            </Button>
                          )}

                          {/* Mark Return Complete */}
                          {order.deliveryStatus === "Return Initiated" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-teal-500/30 text-teal-400 hover:bg-teal-500/10 bg-transparent"
                              disabled={
                                actionLoading ===
                                `return-complete-${order.id}`
                              }
                              onClick={() =>
                                handleReturnComplete(order.id)
                              }
                            >
                              {actionLoading ===
                              `return-complete-${order.id}` ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                              ) : (
                                <Package className="h-3.5 w-3.5 mr-1.5" />
                              )}
                              Mark Return Complete
                            </Button>
                          )}

                          {/* Send delivery email */}
                          {order.deliveryStatus === "Delivered" &&
                            !order.deliveryEmailSent && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-zinc-700/50 text-zinc-300 hover:bg-zinc-800 bg-transparent"
                                disabled={
                                  actionLoading === `email-${order.id}`
                                }
                                onClick={() =>
                                  handleSendEmail(order.id)
                                }
                              >
                                {actionLoading === `email-${order.id}` ? (
                                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                ) : (
                                  <Mail className="h-3.5 w-3.5 mr-1.5" />
                                )}
                                Send Delivery Email
                              </Button>
                            )}
                          {order.deliveryEmailSent && (
                            <span className="text-xs text-emerald-500 flex items-center gap-1.5 px-2 py-1">
                              <Check className="h-3.5 w-3.5" />
                              Delivery email sent
                            </span>
                          )}

                          {/* Review email */}
                          {order.deliveryStatus === "Delivered" &&
                            order.reviewEmailSent && (
                              <span className="text-xs text-emerald-500 flex items-center gap-1.5 px-2 py-1">
                                <Check className="h-3.5 w-3.5" />
                                Review email sent
                              </span>
                            )}
                          {order.deliveryStatus === "Delivered" &&
                            !order.reviewEmailSent &&
                            order.deliveredTimestamp &&
                            (() => {
                              const elapsed = Date.now() - new Date(order.deliveredTimestamp).getTime();
                              const threeDays = 3 * 24 * 60 * 60 * 1000;
                              if (elapsed >= threeDays) {
                                return (
                                  <>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="border-zinc-700/50 text-zinc-300 hover:bg-zinc-800 bg-transparent"
                                      disabled={actionLoading === `review-${order.id}`}
                                      onClick={() => handleSendReviewEmail(order.id)}
                                    >
                                      {actionLoading === `review-${order.id}` ? (
                                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                      ) : (
                                        <Star className="h-3.5 w-3.5 mr-1.5" />
                                      )}
                                      Send Review Email
                                    </Button>
                                    {order.customerPhone && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="border-zinc-700/50 text-zinc-300 hover:bg-zinc-800 bg-transparent"
                                        onClick={() => handleWhatsAppReview(order)}
                                      >
                                        <MessageCircle className="h-3.5 w-3.5 mr-1.5" />
                                        WhatsApp Review
                                      </Button>
                                    )}
                                  </>
                                );
                              }
                              const daysLeft = Math.ceil((threeDays - elapsed) / (24 * 60 * 60 * 1000));
                              return (
                                <span className="text-xs text-zinc-500 flex items-center gap-1.5 px-2 py-1">
                                  <Clock className="h-3.5 w-3.5" />
                                  Review email in {daysLeft}d
                                </span>
                              );
                            })()}
                        </div>

                        {/* RTO tracking input */}
                        {order.deliveryStatus === "RTO" && (
                          <div className="flex gap-2 items-center mb-4">
                            {order.rtoTrackingNumber ? (
                              <div className="text-sm flex items-center gap-2">
                                <span className="text-zinc-500">
                                  RTO Tracking:
                                </span>
                                <code className="bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded text-xs border border-zinc-700/50 font-mono">
                                  {order.rtoTrackingNumber}
                                </code>
                              </div>
                            ) : (
                              <>
                                <Input
                                  placeholder="Enter RTO tracking number"
                                  className="w-64 h-8 text-sm bg-zinc-800/60 border-zinc-700/50 text-zinc-200 placeholder:text-zinc-600"
                                  value={rtoInput[order.id] || ""}
                                  onChange={(e) =>
                                    setRtoInput((prev) => ({
                                      ...prev,
                                      [order.id]: e.target.value,
                                    }))
                                  }
                                />
                                <Button
                                  size="sm"
                                  disabled={
                                    !rtoInput[order.id] ||
                                    actionLoading ===
                                      `rto-save-${order.id}`
                                  }
                                  className="bg-blue-600 hover:bg-blue-700 text-white"
                                  onClick={() =>
                                    handleSaveRtoTracking(order.id)
                                  }
                                >
                                  {actionLoading ===
                                  `rto-save-${order.id}` ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    "Save"
                                  )}
                                </Button>
                              </>
                            )}
                          </div>
                        )}

                        {/* Courier Journey Toggle */}
                        <div className="border-t border-zinc-800/60 pt-3 mt-2">
                          <button
                            className="flex items-center gap-2 text-xs font-medium text-zinc-500 uppercase tracking-wider hover:text-zinc-300 transition-colors w-full"
                            onClick={() =>
                              setTimelineOpen((prev) => {
                                const next = new Set(prev);
                                if (next.has(order.id)) next.delete(order.id);
                                else next.add(order.id);
                                return next;
                              })
                            }
                          >
                            <Activity className="h-3.5 w-3.5" />
                            Courier Journey
                            {order.trackingTimeline?.length > 0 && (
                              <span className="text-zinc-600">
                                ({order.trackingTimeline.length} events)
                              </span>
                            )}
                            {order.lastUpdated && (
                              <span className="text-zinc-600 ml-2">
                                · Last synced {formatDate(order.lastUpdated)}
                              </span>
                            )}
                            {timelineOpen.has(order.id) ? (
                              <ChevronDown className="h-3.5 w-3.5 ml-auto" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 ml-auto" />
                            )}
                          </button>
                          {timelineOpen.has(order.id) && (
                            <TrackingTimelineDark
                              events={order.trackingTimeline}
                            />
                          )}
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      {/* Cancel Order Dialog */}
      <Dialog
        open={!!cancelDialogOrder}
        onOpenChange={(open) => {
          if (!open) {
            setCancelDialogOrder(null);
            setCancelReason("");
          }
        }}
      >
        <DialogContent className="bg-zinc-900 border-zinc-800 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-red-400">Cancel Order</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-zinc-400">
              This will cancel the order on Shopify. This action cannot be undone.
            </p>
            <div>
              <label className="text-sm text-zinc-400 block mb-1.5">
                Cancellation Reason / Remarks
              </label>
              <Input
                placeholder="Enter reason for cancellation..."
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="bg-zinc-800/60 border-zinc-700/50 text-zinc-200"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                className="border-zinc-700/50 text-zinc-300 hover:bg-zinc-800 bg-transparent"
                onClick={() => {
                  setCancelDialogOrder(null);
                  setCancelReason("");
                }}
              >
                Go Back
              </Button>
              <Button
                size="sm"
                className="bg-red-600 hover:bg-red-700 text-white"
                disabled={!cancelReason.trim() || actionLoading === `cancel-${cancelDialogOrder}`}
                onClick={() => {
                  if (cancelDialogOrder) handleCancelOrder(cancelDialogOrder);
                }}
              >
                {actionLoading === `cancel-${cancelDialogOrder}` ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5 mr-1.5" />
                )}
                Confirm Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// =============================================================================
// ANALYTICS PLACEHOLDER (DARK)
// =============================================================================
function AnalyticsSectionDark({ orders }: { orders: Order[] }) {
  const total = orders.length;
  const delivered = orders.filter(
    (o) => o.deliveryStatus === "Delivered"
  ).length;
  const deliveryRate = total > 0 ? ((delivered / total) * 100).toFixed(1) : "0";
  const rto = orders.filter(
    (o) => o.deliveryStatus === "RTO" || o.deliveryStatus === "RTO Confirmed" || o.deliveryStatus === "RTO Received"
  ).length;
  const rtoRate = total > 0 ? ((rto / total) * 100).toFixed(1) : "0";

  const codOrders = orders.filter((o) => o.paymentMethod === "COD");
  const prepaidOrders = orders.filter((o) => o.paymentMethod === "Prepaid");
  const codCollected = codOrders.filter(
    (o) => o.codCollectionStatus === "Collected"
  ).length;

  // Group by destination city
  const cityMap: Record<string, number> = {};
  orders.forEach((o) => {
    const city = o.destinationCity || "Unknown";
    cityMap[city] = (cityMap[city] || 0) + 1;
  });
  const topCities = Object.entries(cityMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="space-y-6">
      {/* Key metrics row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 p-5">
          <span className="text-xs text-zinc-500 uppercase tracking-wider">
            Delivery Rate
          </span>
          <div className="text-3xl font-bold text-emerald-400 mt-2">
            {deliveryRate}%
          </div>
          <div className="text-xs text-zinc-600 mt-1">
            {delivered} of {total} orders
          </div>
        </div>
        <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 p-5">
          <span className="text-xs text-zinc-500 uppercase tracking-wider">
            RTO Rate
          </span>
          <div className="text-3xl font-bold text-purple-400 mt-2">
            {rtoRate}%
          </div>
          <div className="text-xs text-zinc-600 mt-1">
            {rto} returns to origin
          </div>
        </div>
        <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 p-5">
          <span className="text-xs text-zinc-500 uppercase tracking-wider">
            COD Collection
          </span>
          <div className="text-3xl font-bold text-orange-400 mt-2">
            {codOrders.length > 0
              ? ((codCollected / codOrders.length) * 100).toFixed(0)
              : 0}
            %
          </div>
          <div className="text-xs text-zinc-600 mt-1">
            {codCollected} of {codOrders.length} collected
          </div>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Payment method breakdown */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 p-5">
          <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-4">
            Payment Methods
          </h3>
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-zinc-400">COD</span>
                <span className="text-zinc-300 font-medium">
                  {codOrders.length}
                </span>
              </div>
              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-orange-500/60 rounded-full transition-all duration-500"
                  style={{
                    width: total > 0 ? `${(codOrders.length / total) * 100}%` : "0%",
                  }}
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-zinc-400">Prepaid</span>
                <span className="text-zinc-300 font-medium">
                  {prepaidOrders.length}
                </span>
              </div>
              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500/60 rounded-full transition-all duration-500"
                  style={{
                    width:
                      total > 0
                        ? `${(prepaidOrders.length / total) * 100}%`
                        : "0%",
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Top destinations */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800/60 p-5">
          <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-4">
            Top Destinations
          </h3>
          {topCities.length > 0 ? (
            <div className="space-y-2.5">
              {topCities.map(([city, count], index) => (
                <div
                  key={city}
                  className="flex items-center justify-between text-sm"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-600 w-4 text-right font-mono">
                      {index + 1}
                    </span>
                    <span className="text-zinc-300">{city}</span>
                  </div>
                  <span className="text-zinc-500 font-mono text-xs">
                    {count} order{count !== 1 ? "s" : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-600">No data available</p>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// MAIN DASHBOARD
// =============================================================================
export default function DashboardCommandCenter() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingCodBanner, setPendingCodBanner] = useState<Order[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [shippingModeFilter, setShippingModeFilter] = useState("all");
  const [showDelivered, setShowDelivered] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
  const [activeTab, setActiveTab] = useState<Tab>("orders");
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [delayThresholdDays, setDelayThresholdDays] = useState(DEFAULT_DELAYED_THRESHOLD_DAYS);
  const [thresholdInput, setThresholdInput] = useState("");
  const [showDelayedOnly, setShowDelayedOnly] = useState(false);
  const [delayBannerOpen, setDelayBannerOpen] = useState(false);
  const [delayDialogOpen, setDelayDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [dtdcExportOpen, setDtdcExportOpen] = useState(false);
  const [shippingExportOpen, setShippingExportOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"alerts" | "shipping">("alerts");
  const [shippingConfig, setShippingConfig] = useState<ShippingRateTable>(() => getShippingConfig());

  // Load threshold from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("delayThresholdDays");
    if (saved) {
      const num = parseInt(saved, 10);
      if (!isNaN(num) && num > 0) {
        setDelayThresholdDays(num);
      }
    }
  }, []);

  const delayedOrders = useMemo(
    () => orders.filter((o) => isDelayed(o, delayThresholdDays)),
    [orders, delayThresholdDays]
  );

  const handleSaveThreshold = () => {
    const num = parseInt(thresholdInput, 10);
    if (!isNaN(num) && num > 0) {
      setDelayThresholdDays(num);
      localStorage.setItem("delayThresholdDays", String(num));
      setSettingsDialogOpen(false);
    }
  };

  const fetchOrders = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter && statusFilter !== "all")
        params.set("status", statusFilter);
      if (shippingModeFilter && shippingModeFilter !== "all")
        params.set("shippingMode", shippingModeFilter);
      if (search) params.set("search", search);
      if (!showDelivered) params.set("hideDelivered", "true");

      const res = await fetch(`/api/orders?${params}`);
      const data = await res.json();
      if (data.success) {
        setOrders(data.orders);
      }
    } catch (err) {
      console.error("Failed to fetch orders:", err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, shippingModeFilter, search, showDelivered]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // Auto-refresh tracking every 30 minutes
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        await fetch("/api/tracking/refresh", { method: "POST" });
        setLastRefreshed(new Date().toLocaleTimeString());
        fetchOrders();
      } catch {
        // silent fail for auto-refresh
      }
    }, AUTO_REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  const handleSync = async () => {
    // Reserve tabs synchronously (before any await) for every currently-known
    // pending COD confirmation, so window.open isn't popup-blocked after the
    // sync fetch resolves. Mirrors handleAssignTracking pattern.
    const pendingAtClick = orders.filter(isPendingCodConfirmation);
    const reservedTabs: Array<{ order: Order; tab: Window | null }> = pendingAtClick.map(
      (order) => ({ order, tab: window.open("about:blank") })
    );

    setSyncing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/shopify/sync", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setMessage({
          type: "success",
          text: `Synced ${data.synced} fulfilled + ${data.unfulfilled || 0} unfulfilled orders${data.cancelled ? ` (${data.cancelled} cancelled)` : ""} from Shopify`,
        });
        fetchOrders();

        // Auto-dispatch WhatsApp confirmations via the reserved tabs
        await dispatchCodConfirmations(reservedTabs);

        // Detect orders newly surfaced by this sync that also need confirmation
        // (weren't in `orders` state at click time → no reserved tab → surface
        // a one-click banner instead of popup-blocked opens).
        try {
          const params = new URLSearchParams();
          if (statusFilter && statusFilter !== "all") params.set("status", statusFilter);
          if (shippingModeFilter && shippingModeFilter !== "all") params.set("shippingMode", shippingModeFilter);
          if (search) params.set("search", search);
          if (!showDelivered) params.set("hideDelivered", "true");
          const freshRes = await fetch(`/api/orders?${params}`);
          const freshData = await freshRes.json();
          if (freshData.success) {
            const knownIds = new Set(pendingAtClick.map((o) => o.id));
            const newPending = (freshData.orders as Order[]).filter(
              (o) => isPendingCodConfirmation(o) && !knownIds.has(o.id)
            );
            setPendingCodBanner(newPending);
          }
        } catch {
          // Non-fatal — banner just won't show.
        }
      } else {
        setMessage({ type: "error", text: data.error || "Sync failed" });
        reservedTabs.forEach(({ tab }) => tab?.close());
      }
    } catch {
      setMessage({ type: "error", text: "Failed to connect to Shopify" });
      reservedTabs.forEach(({ tab }) => tab?.close());
    } finally {
      setSyncing(false);
    }
  };

  // Dispatch WhatsApp COD confirmations by pointing reserved blank tabs at
  // web.whatsapp.com/send URLs — the whatsapp-autosend-extension clicks Send
  // and auto-closes each tab. Marks each order as whatsappSent in Notion.
  const dispatchCodConfirmations = async (
    pairs: Array<{ order: Order; tab: Window | null }>
  ) => {
    if (pairs.length === 0) return;

    const results = await Promise.all(
      pairs.map(async ({ order, tab }) => {
        if (!tab) return { order, sent: false };
        const itemsText = await fetchLineItemsText(order.id);
        if (itemsText === null) {
          tab.close();
          return { order, sent: false };
        }
        const phone = normalizeWhatsAppPhone(order.customerPhone);
        const message = buildCodConfirmationMessage(order, itemsText);
        try {
          tab.location.href = buildWhatsAppUrl(phone, message);
        } catch {
          return { order, sent: false };
        }
        return { order, sent: true };
      })
    );

    const sent = results.filter((r) => r.sent);
    if (sent.length === 0) return;

    await Promise.all(
      sent.map(({ order }) =>
        fetch(`/api/orders/${order.id}/whatsapp-status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isCod: true }),
        }).catch((err) => {
          console.error(`markWhatsAppSent failed for ${order.id}:`, err);
        })
      )
    );
    fetchOrders();
  };

  const handleSendPendingCodBanner = async () => {
    if (pendingCodBanner.length === 0) return;
    // This click IS a user gesture — safe to window.open directly in a loop.
    const pairs = pendingCodBanner.map((order) => ({
      order,
      tab: window.open("about:blank"),
    }));
    setPendingCodBanner([]);
    await dispatchCodConfirmations(pairs);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/tracking/refresh", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setMessage({
          type: "success",
          text: `Refreshed ${data.refreshed} orders${data.errors ? ` (${data.errors} errors)` : ""}`,
        });
        setLastRefreshed(new Date().toLocaleTimeString());
        fetchOrders();
      } else {
        setMessage({ type: "error", text: data.error || "Refresh failed" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to refresh tracking" });
    } finally {
      setRefreshing(false);
    }
  };

  const [sendingReviews, setSendingReviews] = useState(false);

  const pendingReviewCount = useMemo(() => {
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    return orders.filter(
      (o) =>
        o.deliveryStatus === "Delivered" &&
        !o.reviewEmailSent &&
        o.customerEmail &&
        o.deliveredTimestamp &&
        new Date(o.deliveredTimestamp).getTime() <= threeDaysAgo
    ).length;
  }, [orders]);

  const handleBulkReviewEmails = async () => {
    setSendingReviews(true);
    setMessage(null);
    try {
      const res = await fetch("/api/email/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bulk: true }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage({
          type: "success",
          text: `Sent ${data.sent} review email${data.sent === 1 ? "" : "s"}${data.failed ? ` (${data.failed} failed)` : ""}`,
        });
        fetchOrders();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to send review emails" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to send review emails" });
    } finally {
      setSendingReviews(false);
    }
  };

  // Auto-dismiss message after 8 seconds
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 8000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      {/* Sidebar */}
      <Sidebar activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Main content area */}
      <main className="flex-1 overflow-y-auto">
        {/* Top bar */}
        <header className="sticky top-0 z-20 bg-zinc-950/80 backdrop-blur-md border-b border-zinc-800/50">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-4 lg:px-6 py-4">
            <div className="pl-12 lg:pl-0">
              <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
                {activeTab === "orders" && (
                  <>
                    <Package className="h-5 w-5 text-blue-400" />
                    Order Command Center
                  </>
                )}
                {activeTab === "influencer" && (
                  <>
                    <Users className="h-5 w-5 text-blue-400" />
                    Influencer Tracking
                  </>
                )}
                {activeTab === "analytics" && (
                  <>
                    <BarChart3 className="h-5 w-5 text-blue-400" />
                    Analytics Overview
                  </>
                )}
              </h1>
              <p className="text-xs text-zinc-500 mt-0.5">
                Shopify + DTDC tracking
                {lastRefreshed && (
                  <span className="text-zinc-600">
                    {" "}
                    | Last refreshed: {lastRefreshed}
                  </span>
                )}
              </p>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 pl-12 lg:pl-0 items-center">
              {/* Notification bell (orders tab only) */}
              {activeTab === "orders" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="relative h-9 w-9 p-0 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                  onClick={() => setDelayDialogOpen(true)}
                >
                  <Bell className="h-4 w-4" />
                  {delayedOrders.length > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 rounded-full bg-red-500 text-[10px] text-white flex items-center justify-center font-bold px-1">
                      {delayedOrders.length}
                    </span>
                  )}
                </Button>
              )}

              {/* Settings (orders tab only) */}
              {activeTab === "orders" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 w-9 p-0 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                  onClick={() => {
                    setThresholdInput(String(delayThresholdDays));
                    setSettingsDialogOpen(true);
                  }}
                >
                  <Settings className="h-4 w-4" />
                </Button>
              )}

              {activeTab === "orders" && pendingReviewCount > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBulkReviewEmails}
                  disabled={sendingReviews}
                  className="border-zinc-700/50 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 bg-transparent"
                >
                  {sendingReviews ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Star className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  {sendingReviews
                    ? "Sending..."
                    : `Review Emails (${pendingReviewCount})`}
                </Button>
              )}
              {activeTab === "orders" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShippingExportOpen(true)}
                  className="border-zinc-700/50 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 bg-transparent"
                >
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                  Export Invoice
                </Button>
              )}
              {activeTab === "orders" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDtdcExportOpen(true)}
                  className="border-zinc-700/50 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 bg-transparent"
                >
                  <Share2 className="h-3.5 w-3.5 mr-1.5" />
                  Follow Ups
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleSync}
                disabled={syncing}
                className="border-zinc-700/50 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 bg-transparent"
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <ArrowDownUp className="h-3.5 w-3.5 mr-1.5" />
                )}
                {syncing ? "Syncing..." : "Sync Orders"}
              </Button>
              <Button
                size="sm"
                onClick={handleRefresh}
                disabled={refreshing}
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                {refreshing ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                )}
                {refreshing ? "Refreshing..." : "Refresh Tracking"}
              </Button>
            </div>
          </div>
        </header>

        {/* Page content */}
        <div className="px-4 lg:px-6 py-6 space-y-6">
          {/* Message toast */}
          {message && (
            <div
              className={`flex items-center gap-2 p-3 rounded-lg text-sm border ${
                message.type === "success"
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                  : "bg-red-500/10 text-red-400 border-red-500/20"
              }`}
            >
              {message.type === "success" ? (
                <CircleCheck className="h-4 w-4 shrink-0" />
              ) : (
                <CircleAlert className="h-4 w-4 shrink-0" />
              )}
              <span className="flex-1">{message.text}</span>
              <button
                onClick={() => setMessage(null)}
                className="text-zinc-500 hover:text-zinc-300 shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Pending COD WhatsApp confirmations banner (new-from-sync fallback) */}
          {pendingCodBanner.length > 0 && (
            <div className="flex items-center gap-3 p-3 rounded-lg text-sm border bg-green-500/10 text-green-300 border-green-500/20">
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              <span className="flex-1">
                {pendingCodBanner.length} new COD order{pendingCodBanner.length !== 1 ? "s" : ""} need WhatsApp confirmation
              </span>
              <Button
                size="sm"
                className="bg-green-600 hover:bg-green-700 text-white h-7"
                onClick={handleSendPendingCodBanner}
              >
                Send all
              </Button>
              <button
                onClick={() => setPendingCodBanner([])}
                className="text-zinc-500 hover:text-zinc-300 shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Orders tab */}
          {activeTab === "orders" && (
            <>
              {/* Stats */}
              <StatsCardsDark
                orders={orders}
                delayThresholdDays={delayThresholdDays}
                shippingConfig={shippingConfig}
                onDelayedClick={() => setShowDelayedOnly((prev) => !prev)}
              />

              {/* Delay alert banner */}
              {delayedOrders.length > 0 && (
                <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-4">
                  <div
                    className="flex items-center justify-between cursor-pointer"
                    onClick={() => setDelayBannerOpen((prev) => !prev)}
                  >
                    <div className="flex items-center gap-2">
                      {delayBannerOpen ? (
                        <ChevronDown className="h-4 w-4 text-red-400" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-red-400" />
                      )}
                      <AlertTriangle className="h-5 w-5 text-red-400" />
                      <span className="text-sm font-semibold text-red-400">
                        {delayedOrders.length} order{delayedOrders.length !== 1 ? "s" : ""} delayed
                      </span>
                      <span className="text-xs text-red-400/60">
                        — in transit for more than {delayThresholdDays} days
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={`text-xs ${showDelayedOnly ? "text-red-300 bg-red-500/20" : "text-red-400/70 hover:text-red-300 hover:bg-red-500/10"}`}
                      onClick={(e) => { e.stopPropagation(); setShowDelayedOnly((prev) => !prev); }}
                    >
                      {showDelayedOnly ? "Show All" : "View Delayed Only"}
                    </Button>
                  </div>
                  {delayBannerOpen && (
                    <div className="space-y-1.5 mt-3">
                      {delayedOrders.slice(0, 5).map((order) => (
                        <div
                          key={order.id}
                          className="flex items-center justify-between text-sm px-3 py-1.5 rounded-lg bg-red-500/5"
                        >
                          <div className="flex items-center gap-3">
                            <span className="text-red-300 font-mono text-xs">{order.orderNumber}</span>
                            <span className="text-zinc-300">{order.customerName}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-zinc-500 text-xs">{order.destinationCity || "-"}</span>
                            <span className="text-red-400 font-medium text-xs">
                              {getDaysInTransit(order)}d
                            </span>
                          </div>
                        </div>
                      ))}
                      {delayedOrders.length > 5 && (
                        <p className="text-xs text-red-400/50 px-3 pt-1">
                          +{delayedOrders.length - 5} more delayed order{delayedOrders.length - 5 !== 1 ? "s" : ""}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Search & Filter */}
              <SearchFilterDark
                search={search}
                onSearchChange={setSearch}
                statusFilter={statusFilter}
                onStatusChange={(v) => setStatusFilter(v || "all")}
                showDelivered={showDelivered}
                onShowDeliveredChange={setShowDelivered}
                shippingModeFilter={shippingModeFilter}
                onShippingModeChange={(v) => setShippingModeFilter(v || "all")}
              />

              {/* Delayed-only filter indicator */}
              {showDelayedOnly && (
                <div className="flex items-center gap-2 text-sm text-red-400">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>Showing delayed orders only</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-zinc-400 hover:text-zinc-200 h-6 px-2"
                    onClick={() => setShowDelayedOnly(false)}
                  >
                    Clear filter
                  </Button>
                </div>
              )}

              {/* Orders Table */}
              {loading ? (
                <div className="flex items-center justify-center py-16 text-zinc-500">
                  <Loader2 className="h-6 w-6 mr-2 animate-spin" />
                  Loading orders...
                </div>
              ) : (
                <OrderTableDark
                  orders={showDelayedOnly ? delayedOrders : orders}
                  onOrderUpdated={fetchOrders}
                  delayThresholdDays={delayThresholdDays}
                  shippingConfig={shippingConfig}
                />
              )}
            </>
          )}

          {/* Influencer tab */}
          {activeTab === "influencer" && <InfluencerSection />}

          {/* Abandoned checkouts tab */}
          {activeTab === "abandoned" && <AbandonedCheckoutsSection />}

          {/* Invoices tab */}
          {activeTab === "invoices" && <InvoicesSection />}

          {/* Analytics tab */}
          {activeTab === "analytics" && (
            <AnalyticsSectionDark orders={orders} />
          )}
        </div>

        {/* Delay notification dialog */}
        <Dialog open={delayDialogOpen} onOpenChange={setDelayDialogOpen}>
          <DialogContent className="bg-zinc-900 border-zinc-800 text-zinc-100 max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-zinc-100">
                <Bell className="h-5 w-5 text-red-400" />
                Delayed Orders
                {delayedOrders.length > 0 && (
                  <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/20 ml-2">
                    {delayedOrders.length}
                  </Badge>
                )}
              </DialogTitle>
            </DialogHeader>
            {delayedOrders.length === 0 ? (
              <div className="text-center py-8 text-zinc-500">
                <CircleCheck className="h-10 w-10 mx-auto mb-3 text-emerald-500/50" />
                <p className="text-sm">No delayed orders</p>
                <p className="text-xs text-zinc-600 mt-1">
                  All orders within {delayThresholdDays}-day threshold
                </p>
              </div>
            ) : (
              <div className="space-y-2 mt-2">
                <p className="text-xs text-zinc-500 mb-3">
                  Orders in transit for more than {delayThresholdDays} days since fulfillment
                </p>
                {delayedOrders.map((order) => (
                  <div
                    key={order.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-zinc-800/60 border border-zinc-700/30"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-200">{order.orderNumber}</span>
                        <StatusBadgeDark status={order.deliveryStatus} />
                      </div>
                      <div className="text-xs text-zinc-500">
                        {order.customerName} — {order.destinationCity || "Unknown"}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold text-red-400">
                        {getDaysInTransit(order)}d
                      </div>
                      <div className="text-[10px] text-zinc-600">in transit</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Settings dialog */}
        <Dialog open={settingsDialogOpen} onOpenChange={(open) => {
          if (!open) {
            setThresholdInput(String(delayThresholdDays));
            setSettingsTab("alerts");
          }
          setSettingsDialogOpen(open);
        }}>
          <DialogContent className="bg-zinc-900 border-zinc-800 text-zinc-100 max-w-xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-zinc-100">
                <Settings className="h-5 w-5 text-zinc-400" />
                Settings
              </DialogTitle>
            </DialogHeader>

            {/* Settings tabs */}
            <div className="flex gap-1 bg-zinc-800/40 rounded-lg p-1">
              <button
                onClick={() => setSettingsTab("alerts")}
                className={`flex-1 text-xs font-medium px-3 py-1.5 rounded-md transition-all ${
                  settingsTab === "alerts"
                    ? "bg-zinc-700 text-zinc-100 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Alerts
              </button>
              <button
                onClick={() => setSettingsTab("shipping")}
                className={`flex-1 text-xs font-medium px-3 py-1.5 rounded-md transition-all ${
                  settingsTab === "shipping"
                    ? "bg-zinc-700 text-zinc-100 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Shipping Rates
              </button>
            </div>

            {settingsTab === "alerts" ? (
              <div className="space-y-4 mt-1">
                <div>
                  <label className="text-sm text-zinc-400 block mb-2">
                    Mark orders as delayed after
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={thresholdInput}
                      onChange={(e) => setThresholdInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSaveThreshold()}
                      className="w-24 h-9 bg-zinc-800/60 border-zinc-700/50 text-zinc-200 text-center"
                    />
                    <span className="text-sm text-zinc-500">days in transit</span>
                  </div>
                  <p className="text-xs text-zinc-600 mt-2">
                    Currently set to {delayThresholdDays} day{delayThresholdDays !== 1 ? "s" : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  className="bg-blue-600 hover:bg-blue-700 text-white w-full"
                  onClick={handleSaveThreshold}
                >
                  Save
                </Button>
              </div>
            ) : (
              <ShippingRatesPanel
                visible={settingsTab === "shipping"}
                onConfigSaved={() => setShippingConfig(getShippingConfig())}
              />
            )}
          </DialogContent>
        </Dialog>
        <DTDCExportDialog
          open={dtdcExportOpen}
          onOpenChange={setDtdcExportOpen}
          orders={orders}
        />
        <ShippingExportDialog
          open={shippingExportOpen}
          onOpenChange={setShippingExportOpen}
          orders={orders}
          shippingConfig={shippingConfig}
        />
      </main>
    </div>
  );
}
