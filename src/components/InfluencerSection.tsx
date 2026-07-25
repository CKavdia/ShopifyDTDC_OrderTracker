"use client";

import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { InfluencerShipment, Product, DeliveryStatus } from "@/lib/data/types";
import { dtdcTrackingUrl } from "@/lib/dtdc";
import { TrackingTimeline } from "./TrackingTimeline";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Search,
  Pencil,
  Trash2,
  Package,
  X,
  Activity,
  CheckCircle2,
  MapPin,
  Phone,
  AtSign,
  Calendar,
  PackageCheck,
  Video,
  Undo2,
  AlertTriangle,
  Truck,
  Check,
} from "lucide-react";

// Dark-themed status badge matching the orders table
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

const COMPLETED_INFLUENCER_STATUSES: DeliveryStatus[] = [
  "Completed",
];

interface ProductFormState {
  url: string;
  name: string;
  imageUrl: string;
  size: string;
  lookingUp: boolean;
  lookupDone: boolean;
  error: string;
}

const emptyForm: ProductFormState = {
  url: "",
  name: "",
  imageUrl: "",
  size: "",
  lookingUp: false,
  lookupDone: false,
  error: "",
};

export function InfluencerSection() {
  const [shipments, setShipments] = useState<InfluencerShipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newTracking, setNewTracking] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newInstagram, setNewInstagram] = useState("");
  const [isJaipurInfluencer, setIsJaipurInfluencer] = useState(false);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Product management state
  const [products, setProducts] = useState<Record<string, Product[]>>({});
  const [showProductForm, setShowProductForm] = useState<string | null>(null);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [productForm, setProductForm] = useState<ProductFormState>(emptyForm);
  const [savingProducts, setSavingProducts] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpen] = useState<Set<string>>(new Set());
  const [showCompleted, setShowCompleted] = useState(false);
  const [editingTrackingId, setEditingTrackingId] = useState<string | null>(null);
  const [editTrackingValue, setEditTrackingValue] = useState("");
  const [savingTracking, setSavingTracking] = useState(false);

  // Refs for auto-focus
  const labelInputRef = useRef<HTMLInputElement>(null);
  const productUrlInputRef = useRef<HTMLInputElement>(null);
  const sizeInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus label input when Add Shipment form opens
  useEffect(() => {
    if (showAdd) {
      setTimeout(() => labelInputRef.current?.focus(), 50);
    }
  }, [showAdd]);

  // Auto-focus product URL input when Add Product form opens
  useEffect(() => {
    if (showProductForm) {
      setTimeout(() => productUrlInputRef.current?.focus(), 50);
    }
  }, [showProductForm]);

  const fetchShipments = useCallback(async () => {
    try {
      const res = await fetch("/api/influencer");
      const data = await res.json();
      if (data.success) {
        setShipments(data.shipments);
        const productMap: Record<string, Product[]> = {};
        for (const s of data.shipments) {
          if (s.products) {
            productMap[s.id] = s.products;
          }
        }
        setProducts((prev) => ({ ...prev, ...productMap }));
      }
    } catch (err) {
      console.error("Failed to fetch influencer shipments:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchShipments();
  }, [fetchShipments]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/influencer/refresh", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setMessage({
          type: "success",
          text: `Refreshed ${data.refreshed} shipments${data.errors ? ` (${data.errors} errors)` : ""}`,
        });
        fetchShipments();
      } else {
        setMessage({ type: "error", text: data.error || "Refresh failed" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to refresh tracking" });
    } finally {
      setRefreshing(false);
    }
  };

  const handleAdd = async () => {
    if (!newPhone) return;
    setAdding(true);
    setMessage(null);
    try {
      const res = await fetch("/api/influencer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trackingNumber: newTracking,
          label: newLabel || "Untitled",
          phoneNumber: newPhone,
          instagramHandle: newInstagram || undefined,
          isJaipurInfluencer,
        }),
      });
      const data = await res.json();
      if (data.success) {
        const createdId = data.shipment?.id;
        setNewTracking("");
        setNewLabel("");
        setNewPhone("");
        setNewInstagram("");
        setIsJaipurInfluencer(false);
        setShowAdd(false);
        await fetchShipments();
        // Auto-expand the new shipment and open product form
        if (createdId) {
          setExpandedId(createdId);
          setShowProductForm(createdId);
          setEditingProductId(null);
          setProductForm(emptyForm);
        }
      } else {
        setMessage({ type: "error", text: data.error || "Failed to add" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to add shipment" });
    } finally {
      setAdding(false);
    }
  };

  const handleProductLookup = async () => {
    if (!productForm.url) return;
    setProductForm((f) => ({ ...f, lookingUp: true, error: "" }));
    try {
      const res = await fetch("/api/influencer/product-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: productForm.url }),
      });
      const data = await res.json();
      if (data.success) {
        setProductForm((f) => ({
          ...f,
          name: data.product.name,
          imageUrl: data.product.imageUrl,
          lookingUp: false,
          lookupDone: true,
          error: "",
        }));
        setTimeout(() => sizeInputRef.current?.focus(), 100);
      } else {
        setProductForm((f) => ({
          ...f,
          lookingUp: false,
          lookupDone: true,
          error: data.error || "Product not found. Enter name manually.",
        }));
      }
    } catch {
      setProductForm((f) => ({
        ...f,
        lookingUp: false,
        lookupDone: true,
        error: "Lookup failed. Enter name manually.",
      }));
    }
  };

  const autoSaveProducts = async (shipmentId: string, updatedProducts: Product[]) => {
    setSavingProducts(shipmentId);
    try {
      const res = await fetch(`/api/influencer/${shipmentId}/products`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ products: updatedProducts }),
      });
      const data = await res.json();
      if (!data.success) {
        setMessage({ type: "error", text: data.error || "Failed to save products" });
      } else if (data.inventoryWarnings?.length) {
        setMessage({ type: "error", text: data.inventoryWarnings.join(", ") });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to save products" });
    } finally {
      setSavingProducts(null);
    }
  };

  const handleAddProduct = (shipmentId: string) => {
    if (!productForm.name || !productForm.url) return;
    const newProduct: Product = {
      id: crypto.randomUUID(),
      name: productForm.name,
      imageUrl: productForm.imageUrl,
      size: productForm.size,
      productUrl: productForm.url,
    };

    const updated = [...(products[shipmentId] || []), newProduct];
    setProducts((prev) => ({ ...prev, [shipmentId]: updated }));
    setProductForm(emptyForm);
    setShowProductForm(null);
    autoSaveProducts(shipmentId, updated);
  };

  const handleEditProduct = (shipmentId: string) => {
    if (!productForm.name || !productForm.url || !editingProductId) return;

    const updated = (products[shipmentId] || []).map((p) =>
      p.id === editingProductId
        ? {
            ...p,
            name: productForm.name,
            imageUrl: productForm.imageUrl,
            size: productForm.size,
            productUrl: productForm.url,
          }
        : p
    );
    setProducts((prev) => ({ ...prev, [shipmentId]: updated }));
    setProductForm(emptyForm);
    setEditingProductId(null);
    setShowProductForm(null);
    autoSaveProducts(shipmentId, updated);
  };

  const handleRemoveProduct = (shipmentId: string, productId: string) => {
    const updated = (products[shipmentId] || []).filter((p) => p.id !== productId);
    setProducts((prev) => ({ ...prev, [shipmentId]: updated }));
    autoSaveProducts(shipmentId, updated);
  };

  const startEditProduct = (shipmentId: string, product: Product) => {
    setEditingProductId(product.id);
    setShowProductForm(shipmentId);
    setProductForm({
      url: product.productUrl,
      name: product.name,
      imageUrl: product.imageUrl,
      size: product.size,
      lookingUp: false,
      lookupDone: true,
      error: "",
    });
  };

  const handleToggleInfluencerShippingPaid = async (
    shipmentId: string,
    currentPaid: boolean
  ) => {
    setMessage(null);
    try {
      const res = await fetch(`/api/influencer/${shipmentId}/shipping-paid`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingChargePaid: !currentPaid }),
      });
      const data = await res.json();
      if (!res.ok || data?.success === false) {
        setMessage({
          type: "error",
          text: data?.error || "Failed to update shipping paid",
        });
        return;
      }
      fetchShipments();
    } catch {
      setMessage({ type: "error", text: "Failed to update shipping paid" });
    }
  };

  const handleMarkDelivered = async (shipmentId: string) => {
    setMessage(null);
    try {
      const res = await fetch(`/api/influencer/${shipmentId}/mark-delivered`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ type: "success", text: "Marked as delivered" });
        fetchShipments();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to mark delivered" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to mark delivered" });
    }
  };

  const cancelProductForm = () => {
    setShowProductForm(null);
    setEditingProductId(null);
    setProductForm(emptyForm);
  };

  const handleToggleProductReceived = (shipmentId: string, productId: string) => {
    const updated = (products[shipmentId] || []).map((p) =>
      p.id === productId ? { ...p, received: !p.received } : p
    );
    setProducts((prev) => ({ ...prev, [shipmentId]: updated }));
    autoSaveProducts(shipmentId, updated);
  };

  const handleUpdateInfluencerStatus = async (shipmentId: string, status: DeliveryStatus) => {
    setMessage(null);
    try {
      const res = await fetch(`/api/influencer/${shipmentId}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ type: "success", text: `Status updated to ${status}` });
        fetchShipments();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to update status" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to update status" });
    }
  };

  const handleSaveTracking = async (shipmentId: string) => {
    setSavingTracking(true);
    try {
      const res = await fetch(`/api/influencer/${shipmentId}/tracking`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackingNumber: editTrackingValue.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setEditingTrackingId(null);
        setEditTrackingValue("");
        fetchShipments();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to save tracking" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to save tracking number" });
    } finally {
      setSavingTracking(false);
    }
  };

  // Filter shipments: toggle OFF = active only, toggle ON = completed only
  const filteredShipments = showCompleted
    ? shipments.filter((s) => COMPLETED_INFLUENCER_STATUSES.includes(s.deliveryStatus))
    : shipments.filter((s) => !COMPLETED_INFLUENCER_STATUSES.includes(s.deliveryStatus));

  if (loading) {
    return (
      <div className="text-center py-12 text-zinc-500">
        Loading influencer shipments...
      </div>
    );
  }

  return (
    <div>
      {/* Actions */}
      <div className="flex gap-3 mb-4 items-center">
        <Button size="sm" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="h-4 w-4 mr-1" />
          Add Shipment
        </Button>
        <Button size="sm" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing..." : "Refresh All"}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Switch
            id="show-completed-influencer"
            checked={showCompleted}
            onCheckedChange={setShowCompleted}
            className="data-checked:bg-blue-600 data-unchecked:bg-zinc-700"
          />
          <label htmlFor="show-completed-influencer" className="text-sm text-zinc-400">
            Show completed
          </label>
        </div>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="mb-4 p-4 bg-zinc-900 rounded-md border border-zinc-800 space-y-3">
          {/* Jaipur toggle */}
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <div
              className={`relative w-9 h-5 rounded-full transition-colors ${isJaipurInfluencer ? "bg-blue-600" : "bg-zinc-700"}`}
              onClick={() => {
                setIsJaipurInfluencer(!isJaipurInfluencer);
                if (!isJaipurInfluencer) setNewTracking("");
              }}
            >
              <div
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${isJaipurInfluencer ? "translate-x-4" : ""}`}
              />
            </div>
            <MapPin className="h-3.5 w-3.5 text-zinc-400" />
            <span className="text-zinc-300">Jaipur Influencer</span>
            {isJaipurInfluencer && (
              <span className="text-xs text-blue-400">(hand delivery, no tracking)</span>
            )}
          </label>
          <div className="flex gap-2 flex-wrap items-center">
            <Input
              ref={labelInputRef}
              placeholder="Label / Name *"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              className="w-48"
            />
            <Input
              placeholder="Phone Number *"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              className="w-44"
            />
            {!isJaipurInfluencer && (
              <Input
                placeholder="Tracking Number (optional)"
                value={newTracking}
                onChange={(e) => setNewTracking(e.target.value)}
                className="w-52"
              />
            )}
            <Input
              placeholder="Instagram (optional)"
              value={newInstagram}
              onChange={(e) => setNewInstagram(e.target.value)}
              className="w-44"
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={adding || !newPhone}
            >
              {adding ? "Adding..." : "Add Shipment"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowAdd(false); setIsJaipurInfluencer(false); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Message */}
      {message && (
        <div
          className={`mb-4 p-3 rounded-md text-sm ${
            message.type === "success"
              ? "bg-green-900/50 text-green-300 border border-green-700"
              : "bg-red-900/50 text-red-300 border border-red-700"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Table */}
      {filteredShipments.length === 0 ? (
        <div className="text-center py-16 text-zinc-500">
          <Package className="h-12 w-12 mx-auto mb-3 text-zinc-700" />
          <p className="text-lg text-zinc-400">No influencer shipments</p>
          <p className="text-sm mt-1 text-zinc-600">
            Click &quot;Add Shipment&quot; to track a package
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-zinc-800">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-zinc-800/60 hover:bg-transparent">
                <TableHead className="w-[40px] text-zinc-500"></TableHead>
                <TableHead className="text-zinc-500 text-xs uppercase tracking-wider font-medium">
                  Label
                </TableHead>
                <TableHead className="text-zinc-500 text-xs uppercase tracking-wider font-medium">
                  Status
                </TableHead>
                <TableHead className="hidden md:table-cell text-zinc-500 text-xs uppercase tracking-wider font-medium">
                  Destination
                </TableHead>
                <TableHead className="hidden md:table-cell text-zinc-500 text-xs uppercase tracking-wider font-medium">
                  Sent
                </TableHead>
                <TableHead className="hidden md:table-cell text-zinc-500 text-xs uppercase tracking-wider font-medium">
                  Delivered
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredShipments.map((shipment) => {
                const isExpanded = expandedId === shipment.id;
                const shipmentProducts = products[shipment.id] || [];
                return (
                  <Fragment key={shipment.id}>
                    <TableRow
                      className={`
                        border-b border-zinc-800/40 hover:bg-zinc-800/40 transition-colors cursor-pointer
                        ${isExpanded ? "bg-zinc-800/30" : ""}
                      `}
                      onClick={() =>
                        setExpandedId(isExpanded ? null : shipment.id)
                      }
                    >
                      <TableCell className="px-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedId(isExpanded ? null : shipment.id);
                          }}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                      <TableCell className="font-medium text-sm text-zinc-200">
                        <div className="flex items-center gap-1.5">
                          {shipment.label}
                          {shipmentProducts.length > 0 && (
                            <span className="text-xs text-zinc-500">
                              ({shipmentProducts.length} product
                              {shipmentProducts.length !== 1 ? "s" : ""})
                            </span>
                          )}
                          {shipment.attemptCount >= 2 && (
                            <span className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded border ${shipment.attemptCount >= 3 ? "bg-red-500/15 text-red-400 border-red-500/30" : "bg-orange-500/15 text-orange-400 border-orange-500/30"}`}>
                              {shipment.attemptCount} attempts
                            </span>
                          )}
                          {shipment.shippingChargePaid && (
                            <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 inline-flex items-center gap-0.5">
                              <Truck className="h-2.5 w-2.5" />
                              Shipping Paid
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`${(darkStatusConfig[shipment.deliveryStatus] || darkStatusConfig["Booked"]).className} text-[11px] font-medium`}
                        >
                          {(darkStatusConfig[shipment.deliveryStatus] || darkStatusConfig["Booked"]).label}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-zinc-400">
                        {shipment.destinationCity ? `${shipment.destinationCity}${shipment.destinationPincode ? ` ${shipment.destinationPincode}` : ""}` : "-"}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-zinc-400">
                        {shipment.createdAt
                          ? new Date(shipment.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                          : "-"}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-zinc-400">
                        {shipment.deliveredDate
                          ? new Date(shipment.deliveredDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                          : "-"}
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow
                        key={`${shipment.id}-details`}
                        className="hover:bg-transparent"
                      >
                        <TableCell
                          colSpan={6}
                          className="bg-zinc-900/80 border-b border-zinc-800/40 p-0 whitespace-normal"
                        >
                          <div className="px-6 py-5 border-l-2 border-l-blue-500/30">
                            <div className="flex gap-8 text-sm mb-3 flex-wrap">
                              <div>
                                <span className="text-zinc-500">From:</span>{" "}
                                <span className="font-medium text-zinc-200">
                                  {shipment.originCity || "-"}
                                </span>
                              </div>
                              <div>
                                <span className="text-zinc-500">To:</span>{" "}
                                <span className="font-medium text-zinc-200">
                                  {shipment.destinationCity || "-"}
                                </span>
                              </div>
                              {shipment.phoneNumber && (
                                <div className="flex items-center gap-1">
                                  <Phone className="h-3 w-3 text-zinc-500" />
                                  <span className="font-medium text-zinc-200">
                                    {shipment.phoneNumber}
                                  </span>
                                </div>
                              )}
                              {shipment.instagramHandle && (
                                <div className="flex items-center gap-1">
                                  <AtSign className="h-3 w-3 text-zinc-500" />
                                  <span className="font-medium text-zinc-200">
                                    {shipment.instagramHandle}
                                  </span>
                                </div>
                              )}
                              {!shipment.isJaipurInfluencer && (
                                <div className="flex items-center gap-1">
                                  {editingTrackingId === shipment.id ? (
                                    <div className="flex items-center gap-1.5">
                                      <Package className="h-3 w-3 text-zinc-500" />
                                      <Input
                                        value={editTrackingValue}
                                        onChange={(e) => setEditTrackingValue(e.target.value)}
                                        placeholder="Tracking number"
                                        className="h-7 w-48 text-xs"
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter" && editTrackingValue.trim()) {
                                            handleSaveTracking(shipment.id);
                                          }
                                          if (e.key === "Escape") {
                                            setEditingTrackingId(null);
                                            setEditTrackingValue("");
                                          }
                                        }}
                                        autoFocus
                                        onClick={(e) => e.stopPropagation()}
                                      />
                                      <Button
                                        size="sm"
                                        className="h-7 text-xs px-2"
                                        disabled={savingTracking || !editTrackingValue.trim()}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleSaveTracking(shipment.id);
                                        }}
                                      >
                                        {savingTracking ? "..." : "Save"}
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 w-7 p-0 text-zinc-500 hover:text-zinc-300"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setEditingTrackingId(null);
                                          setEditTrackingValue("");
                                        }}
                                      >
                                        <X className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  ) : shipment.trackingNumber ? (
                                    <div className="flex items-center gap-1">
                                      <Package className="h-3 w-3 text-zinc-500" />
                                      <a
                                        href={dtdcTrackingUrl(shipment.trackingNumber)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        className="font-medium text-zinc-200 hover:text-white underline underline-offset-2 decoration-zinc-600"
                                      >
                                        {shipment.trackingNumber}
                                      </a>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-5 w-5 p-0 text-zinc-600 hover:text-zinc-300"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setEditingTrackingId(shipment.id);
                                          setEditTrackingValue(shipment.trackingNumber);
                                        }}
                                      >
                                        <Pencil className="h-2.5 w-2.5" />
                                      </Button>
                                    </div>
                                  ) : (
                                    <button
                                      className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setEditingTrackingId(shipment.id);
                                        setEditTrackingValue("");
                                      }}
                                    >
                                      <Plus className="h-3 w-3" />
                                      Add Tracking
                                    </button>
                                  )}
                                </div>
                              )}
                              {shipment.receiverName && (
                                <div>
                                  <span className="text-zinc-500">
                                    Received by:
                                  </span>{" "}
                                  <span className="font-medium text-zinc-200">
                                    {shipment.receiverName}
                                  </span>
                                </div>
                              )}
                              {shipment.isJaipurInfluencer && (
                                <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-[11px]">
                                  <MapPin className="h-3 w-3 mr-1" />
                                  Jaipur
                                </Badge>
                              )}
                            </div>
                            {/* Dates display (mobile) */}
                            <div className="flex gap-4 text-sm mb-3 md:hidden">
                              {shipment.createdAt && (
                                <div className="flex items-center gap-1">
                                  <Calendar className="h-3 w-3 text-zinc-500" />
                                  <span className="text-zinc-500">Sent:</span>{" "}
                                  <span className="text-zinc-200">
                                    {new Date(shipment.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                                  </span>
                                </div>
                              )}
                              {shipment.deliveredDate && (
                                <div className="flex items-center gap-1">
                                  <Calendar className="h-3 w-3 text-zinc-500" />
                                  <span className="text-zinc-500">Delivered:</span>{" "}
                                  <span className="text-zinc-200">
                                    {new Date(shipment.deliveredDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                                  </span>
                                </div>
                              )}
                            </div>
                            {/* Delivery person phone (Out for Delivery only) */}
                            {shipment.deliveryStatus === "Out for Delivery" && shipment.workerMobile && (
                              <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400 text-sm">
                                <Phone className="h-4 w-4 shrink-0" />
                                <span>Delivery Person:</span>
                                <a
                                  href={`tel:${shipment.workerMobile}`}
                                  className="font-medium hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {shipment.workerMobile}
                                </a>
                              </div>
                            )}

                            {/* Undelivered failure reason */}
                            {shipment.deliveryStatus === "Undelivered" && shipment.reasonDesc && (
                              <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                                <AlertTriangle className="h-4 w-4 shrink-0" />
                                <span>
                                  <strong>Reason:</strong> {shipment.reasonDesc}
                                  {shipment.reasonCode && (
                                    <span className="text-red-400/60 ml-1">({shipment.reasonCode})</span>
                                  )}
                                  {shipment.attemptCount > 0 && (
                                    <span className="text-red-400/60 ml-1">
                                      | {shipment.attemptCount} attempt{shipment.attemptCount !== 1 ? "s" : ""}
                                    </span>
                                  )}
                                </span>
                              </div>
                            )}

                            {/* Mark Delivered for Jaipur influencers + Shipping Paid toggle */}
                            <div className="mb-3 flex flex-wrap items-center gap-2">
                              {shipment.isJaipurInfluencer &&
                                shipment.deliveryStatus !== "Delivered" && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleMarkDelivered(shipment.id);
                                    }}
                                  >
                                    <CheckCircle2 className="h-3 w-3 mr-1" />
                                    Mark Delivered
                                  </Button>
                                )}
                              <Button
                                size="sm"
                                variant="outline"
                                className={`h-7 text-xs ${
                                  shipment.shippingChargePaid
                                    ? "border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
                                    : "border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
                                }`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleToggleInfluencerShippingPaid(
                                    shipment.id,
                                    shipment.shippingChargePaid
                                  );
                                }}
                              >
                                {shipment.shippingChargePaid ? (
                                  <Check className="h-3 w-3 mr-1" />
                                ) : (
                                  <Truck className="h-3 w-3 mr-1" />
                                )}
                                {shipment.shippingChargePaid
                                  ? "Shipping Paid"
                                  : "Mark Shipping Paid"}
                              </Button>
                              {/* Manual status override (DTDC auto-tracking down) */}
                              <div onClick={(e) => e.stopPropagation()}>
                                <Select
                                  value={shipment.deliveryStatus}
                                  onValueChange={(v) =>
                                    handleUpdateInfluencerStatus(shipment.id, v as DeliveryStatus)
                                  }
                                >
                                  <SelectTrigger className="w-40 h-7 text-xs font-medium bg-zinc-800/60 border-zinc-700/50 text-zinc-200">
                                    <span className="text-zinc-500 mr-1">Set:</span>
                                    <SelectValue placeholder="status" />
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
                              </div>
                            </div>
                            {/* Status actions */}
                            {shipment.deliveryStatus === "Delivered" && (
                              <div className="flex gap-2 mb-3">
                                <button
                                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-indigo-500/30 text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20 transition-colors"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleUpdateInfluencerStatus(shipment.id, "Video Received");
                                  }}
                                >
                                  <Video className="h-3.5 w-3.5" />
                                  Video Received
                                </button>
                                <button
                                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-zinc-600/50 text-zinc-300 bg-zinc-700/30 hover:bg-zinc-700/50 transition-colors"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleUpdateInfluencerStatus(shipment.id, "Completed");
                                  }}
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  Mark As Completed
                                </button>
                              </div>
                            )}
                            {shipment.deliveryStatus === "Video Received" && (
                              <div className="flex gap-2 mb-3">
                                <button
                                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-zinc-600/50 text-zinc-300 bg-zinc-700/30 hover:bg-zinc-700/50 transition-colors"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleUpdateInfluencerStatus(shipment.id, "Completed");
                                  }}
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  Mark As Completed
                                </button>
                              </div>
                            )}
                            {/* Courier Journey Toggle */}
                            <div className="border-t border-zinc-800 pt-3 mt-2">
                              <button
                                className="flex items-center gap-2 text-xs font-medium text-zinc-500 uppercase tracking-wider hover:text-zinc-300 transition-colors w-full"
                                onClick={() =>
                                  setTimelineOpen((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(shipment.id)) next.delete(shipment.id);
                                    else next.add(shipment.id);
                                    return next;
                                  })
                                }
                              >
                                <Activity className="h-3.5 w-3.5" />
                                Courier Journey
                                {shipment.trackingTimeline?.length > 0 && (
                                  <span className="text-zinc-600">
                                    ({shipment.trackingTimeline.length} events)
                                  </span>
                                )}
                                {timelineOpen.has(shipment.id) ? (
                                  <ChevronDown className="h-3.5 w-3.5 ml-auto" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5 ml-auto" />
                                )}
                              </button>
                              {timelineOpen.has(shipment.id) && (
                                <TrackingTimeline
                                  events={shipment.trackingTimeline}
                                />
                              )}
                            </div>

                            {/* Products Section */}
                            <div className="border-t border-zinc-800 pt-4 mt-3">
                              <div className="flex items-center justify-between mb-3">
                                <h4 className="text-sm font-medium text-zinc-300">
                                  Products
                                  {savingProducts === shipment.id && (
                                    <span className="ml-2 text-xs text-zinc-500">Saving...</span>
                                  )}
                                </h4>
                                <div className="flex gap-2">
                                  {showProductForm !== shipment.id && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 text-xs text-zinc-400 hover:text-zinc-200"
                                      onClick={() => {
                                        setShowProductForm(shipment.id);
                                        setEditingProductId(null);
                                        setProductForm(emptyForm);
                                      }}
                                    >
                                      <Plus className="h-3 w-3 mr-1" />
                                      Add Product
                                    </Button>
                                  )}
                                </div>
                              </div>

                              {/* Product List */}
                              {shipmentProducts.length > 0 && (
                                <div className="space-y-2 mb-3">
                                  {shipmentProducts.map((product) => (
                                    <div
                                      key={product.id}
                                      className="flex items-center gap-3 bg-zinc-900 border border-zinc-800 rounded-lg p-3"
                                    >
                                      {product.imageUrl ? (
                                        <img
                                          src={product.imageUrl}
                                          alt={product.name}
                                          className="w-12 h-12 rounded object-cover flex-shrink-0"
                                        />
                                      ) : (
                                        <div className="w-12 h-12 rounded bg-zinc-800 flex items-center justify-center flex-shrink-0">
                                          <Package className="h-5 w-5 text-zinc-600" />
                                        </div>
                                      )}
                                      <div className="flex-1 min-w-0">
                                        <a
                                          href={product.productUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-sm text-blue-400 hover:text-blue-300 truncate block"
                                        >
                                          {product.name}
                                        </a>
                                        {product.size && (
                                          <span className="text-xs text-zinc-500">
                                            Size: {product.size}
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex gap-1 flex-shrink-0 items-center">
                                        <button
                                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                                            product.received
                                              ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                                              : "border-zinc-700 text-zinc-500 bg-zinc-800/50 hover:text-zinc-300 hover:border-zinc-600"
                                          }`}
                                          onClick={() =>
                                            handleToggleProductReceived(
                                              shipment.id,
                                              product.id
                                            )
                                          }
                                          title={product.received ? "Mark as not received" : "Mark as received"}
                                        >
                                          <PackageCheck className="h-3 w-3" />
                                          {product.received ? "Received" : "Received Back ?"}
                                        </button>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-7 w-7 p-0 text-zinc-500 hover:text-zinc-300"
                                          onClick={() =>
                                            startEditProduct(
                                              shipment.id,
                                              product
                                            )
                                          }
                                        >
                                          <Pencil className="h-3 w-3" />
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-7 w-7 p-0 text-red-400/70 hover:text-red-400"
                                          onClick={() =>
                                            handleRemoveProduct(
                                              shipment.id,
                                              product.id
                                            )
                                          }
                                        >
                                          <Trash2 className="h-3 w-3" />
                                        </Button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* Add/Edit Product Form */}
                              {showProductForm === shipment.id && (
                                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-3">
                                  <div className="flex gap-2">
                                    <Input
                                      ref={productUrlInputRef}
                                      placeholder="Product URL (e.g. urbannaari.co.in/products/...)"
                                      value={productForm.url}
                                      onChange={(e) =>
                                        setProductForm((f) => ({
                                          ...f,
                                          url: e.target.value,
                                          error: "",
                                        }))
                                      }
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter" && productForm.url && !productForm.lookingUp) {
                                          handleProductLookup();
                                        }
                                      }}
                                      className="flex-1"
                                    />
                                    <Button
                                      size="sm"
                                      onClick={handleProductLookup}
                                      disabled={
                                        !productForm.url ||
                                        productForm.lookingUp
                                      }
                                      className="h-9"
                                    >
                                      <Search className="h-3 w-3 mr-1" />
                                      {productForm.lookingUp
                                        ? "Looking up..."
                                        : "Lookup"}
                                    </Button>
                                  </div>

                                  {productForm.error && (
                                    <p className="text-xs text-yellow-400">
                                      {productForm.error}
                                    </p>
                                  )}

                                  {productForm.lookupDone && (
                                    <>
                                      <div className="flex gap-3 items-start">
                                        {productForm.imageUrl ? (
                                          <img
                                            src={productForm.imageUrl}
                                            alt="Preview"
                                            className="w-12 h-12 rounded object-cover flex-shrink-0"
                                          />
                                        ) : (
                                          <div className="w-12 h-12 rounded bg-zinc-800 flex items-center justify-center flex-shrink-0">
                                            <Package className="h-5 w-5 text-zinc-600" />
                                          </div>
                                        )}
                                        <Input
                                          placeholder="Product Name *"
                                          value={productForm.name}
                                          onChange={(e) =>
                                            setProductForm((f) => ({
                                              ...f,
                                              name: e.target.value,
                                            }))
                                          }
                                          className="flex-1"
                                        />
                                      </div>
                                      <div className="flex gap-2 items-center">
                                        <Input
                                          ref={sizeInputRef}
                                          placeholder="Size (e.g. S, M, L, XL)"
                                          value={productForm.size}
                                          onChange={(e) =>
                                            setProductForm((f) => ({
                                              ...f,
                                              size: e.target.value,
                                            }))
                                          }
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter" && productForm.name && productForm.url) {
                                              editingProductId
                                                ? handleEditProduct(shipment.id)
                                                : handleAddProduct(shipment.id);
                                            }
                                          }}
                                          className="w-48"
                                        />
                                        <Button
                                          size="sm"
                                          onClick={() =>
                                            editingProductId
                                              ? handleEditProduct(shipment.id)
                                              : handleAddProduct(shipment.id)
                                          }
                                          disabled={
                                            !productForm.name ||
                                            !productForm.url
                                          }
                                          className="h-9"
                                        >
                                          {editingProductId
                                            ? "Update"
                                            : "Add"}
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          onClick={cancelProductForm}
                                          className="h-9 text-zinc-500 hover:text-zinc-300"
                                        >
                                          <X className="h-3 w-3" />
                                        </Button>
                                      </div>
                                    </>
                                  )}

                                  {/* Allow skipping lookup for manual entry */}
                                  {!productForm.lookupDone &&
                                    !productForm.lookingUp && (
                                      <button
                                        className="text-xs text-zinc-500 hover:text-zinc-400 underline"
                                        onClick={() =>
                                          setProductForm((f) => ({
                                            ...f,
                                            lookupDone: true,
                                          }))
                                        }
                                      >
                                        or enter details manually
                                      </button>
                                    )}
                                </div>
                              )}

                              {shipmentProducts.length === 0 &&
                                showProductForm !== shipment.id && (
                                  <p className="text-xs text-zinc-600">
                                    No products added yet
                                  </p>
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
        </div>
      )}
    </div>
  );
}
