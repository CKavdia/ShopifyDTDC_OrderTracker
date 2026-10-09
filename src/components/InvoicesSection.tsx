"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InvoiceRecord } from "@/lib/data/types";
import { ManualInvoicePanel } from "@/components/ManualInvoicePanel";
import { WholesaleUploadDialog } from "@/components/WholesaleUploadDialog";
import {
  RefreshCw,
  Download,
  FileText,
  FilePlus,
  Loader2,
  Search,
  Tag,
  Upload,
} from "lucide-react";

function inr(n: number): string {
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

interface Quarter {
  label: string;
  start: string; // YYYY-MM-DD
  end: string;
}

// Indian GST quarters (fiscal year starts April). Returns the most recent
// already-started quarters, newest first.
function gstQuarters(count = 8): Quarter[] {
  const isoDate = (y: number, m0: number, day: number) =>
    `${y}-${String(m0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const defs = [
    { q: "Q1", label: "Apr–Jun", sm: 3, em: 5 },
    { q: "Q2", label: "Jul–Sep", sm: 6, em: 8 },
    { q: "Q3", label: "Oct–Dec", sm: 9, em: 11 },
    { q: "Q4", label: "Jan–Mar", sm: 0, em: 2 }, // falls in the next calendar year
  ];
  const now = new Date();
  const out: Quarter[] = [];
  for (let fy = now.getFullYear() - 2; fy <= now.getFullYear() + 1; fy++) {
    for (const def of defs) {
      const calYear = def.q === "Q4" ? fy + 1 : fy;
      const start = new Date(calYear, def.sm, 1);
      if (start > now) continue; // quarter hasn't started yet
      const lastDay = new Date(calYear, def.em + 1, 0).getDate();
      const fyLabel = `FY${String(fy % 100).padStart(2, "0")}-${String((fy + 1) % 100).padStart(2, "0")}`;
      out.push({
        label: `${def.label} ${calYear} (${def.q} ${fyLabel})`,
        start: isoDate(calYear, def.sm, 1),
        end: isoDate(calYear, def.em, lastDay),
      });
    }
  }
  out.sort((a, b) => (a.start < b.start ? 1 : -1)); // newest first
  return out.slice(0, count);
}

const GST_QUARTERS = gstQuarters();
// Default to the most recently *completed* quarter (end already passed).
const DEFAULT_QUARTER = String(
  Math.max(
    0,
    GST_QUARTERS.findIndex((q) => new Date(`${q.end}T23:59:59+05:30`) < new Date())
  )
);

export function InvoicesSection() {
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Manual (non-Shopify) invoice form
  const [creating, setCreating] = useState(false);

  // Wholesale invoice upload + type filter (all / retail / wholesale)
  const [uploading, setUploading] = useState(false);
  const [typeFilter, setTypeFilter] = useState<"all" | "retail" | "wholesale">("all");

  // Re-attach the original PDF to a wholesale row whose upload-time
  // attachment failed (rows without a stored PDF URL).
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const [attachTarget, setAttachTarget] = useState<InvoiceRecord | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [regenerating, setRegenerating] = useState<string | null>(null);

  // Date-range merged-PDF export
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [exporting, setExporting] = useState(false);

  // GSTR-1 HSN summary (Excel)
  const [gstQuarter, setGstQuarter] = useState(DEFAULT_QUARTER);
  const [exportingGstr, setExportingGstr] = useState(false);
  const [exportingNotes, setExportingNotes] = useState(false);

  // Per-FY starting invoice number
  const [fy, setFy] = useState("");
  const [startInput, setStartInput] = useState("");
  const [currentMaxSeq, setCurrentMaxSeq] = useState(0);
  const [savingStart, setSavingStart] = useState(false);
  const [startMsg, setStartMsg] = useState<string | null>(null);

  // COD-fee display toggle (global; server-persisted)
  const [hideCodFee, setHideCodFee] = useState(true);
  const [savingCod, setSavingCod] = useState(false);

  // Per-order fixed-price override (edited from the ledger row)
  const [overrideTarget, setOverrideTarget] = useState<InvoiceRecord | null>(null);
  const [overrideLoading, setOverrideLoading] = useState(false);
  const [overrideLines, setOverrideLines] = useState<
    Array<{ key: string; title: string; variantTitle: string; qty: number; unitPrice: string }>
  >([]);
  const [overrideRate, setOverrideRate] = useState("5");
  const [overrideCurrentTotal, setOverrideCurrentTotal] = useState(0);
  const [overrideCollected, setOverrideCollected] = useState(0);
  const [savingOverride, setSavingOverride] = useState(false);
  const [overrideMsg, setOverrideMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/invoices");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load invoices");
      setInvoices(data.invoices || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load invoices");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/invoices/settings");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load settings");
      setFy(data.fy);
      setCurrentMaxSeq(data.currentMaxSeq ?? 0);
      setStartInput(data.startNumber != null ? String(data.startNumber) : "");
      setHideCodFee(data.hideCodFee !== false);
    } catch {
      // Non-fatal: the invoices list still works without settings.
    }
  }, []);

  useEffect(() => {
    load();
    loadSettings();
  }, [load, loadSettings]);

  const saveStart = async () => {
    setStartMsg(null);
    const n = Number(startInput);
    if (!Number.isInteger(n) || n < 1) {
      setStartMsg("Enter a positive whole number.");
      return;
    }
    setSavingStart(true);
    try {
      const res = await fetch("/api/invoices/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fy, startNumber: n }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      setStartMsg(`Saved — next new invoice will start at #${n}.`);
    } catch (e) {
      setStartMsg(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingStart(false);
    }
  };

  const openOverride = async (inv: InvoiceRecord) => {
    setOverrideMsg(null);
    setOverrideLines([]);
    setOverrideTarget(inv);
    setOverrideLoading(true);
    try {
      const res = await fetch(
        `/api/invoices/override?shopifyOrderId=${inv.shopifyOrderId}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load item lines");
      setOverrideLines(
        (data.lines || []).map(
          (l: { key: string; title: string; variantTitle: string; qty: number; unitPrice: number }) => ({
            key: l.key,
            title: l.title,
            variantTitle: l.variantTitle,
            qty: l.qty,
            unitPrice: String(l.unitPrice),
          })
        )
      );
      setOverrideRate(String(data.gstRate ?? 5));
      setOverrideCurrentTotal(data.currentTotal ?? 0);
      setOverrideCollected(data.collected ?? 0);
    } catch (e) {
      setOverrideMsg(e instanceof Error ? e.message : "Failed to load item lines");
    } finally {
      setOverrideLoading(false);
    }
  };

  // Invoice grand total the saved override would print (GST on top).
  const overridePreviewTotal =
    overrideLines.reduce(
      (sum, l) => sum + Number(l.unitPrice || 0) * l.qty,
      0
    ) *
    (1 + Number(overrideRate || 0) / 100);

  const saveOverride = async (clear: boolean) => {
    if (!overrideTarget) return;
    if (!clear && overrideLines.some((l) => !(Number(l.unitPrice) > 0))) {
      setOverrideMsg("Every unit price must be a positive number.");
      return;
    }
    setSavingOverride(true);
    setOverrideMsg(null);
    try {
      const res = await fetch("/api/invoices/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          clear
            ? { shopifyOrderId: overrideTarget.shopifyOrderId, clear: true }
            : {
                shopifyOrderId: overrideTarget.shopifyOrderId,
                gstRate: Number(overrideRate),
                lines: overrideLines.map((l) => ({
                  key: l.key,
                  title: l.title,
                  qty: l.qty,
                  unitPrice: Number(l.unitPrice),
                })),
              }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      setOverrideTarget(null);
      await load();
    } catch (e) {
      setOverrideMsg(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingOverride(false);
    }
  };

  const toggleCodFee = async (show: boolean) => {
    setSavingCod(true);
    try {
      const res = await fetch("/api/invoices/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hideCodFee: show }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      setHideCodFee(!!data.hideCodFee);
    } catch {
      // Non-fatal: leave the toggle as it was.
    } finally {
      setSavingCod(false);
    }
  };

  const exportRange = async () => {
    if (!rangeStart || !rangeEnd) {
      alert("Pick both a start and end date.");
      return;
    }
    if (rangeStart > rangeEnd) {
      alert("Start date must be on or before end date.");
      return;
    }
    const ok = window.confirm(
      "This will generate invoice numbers for any paid orders in this range that don't have one yet, and download retail + wholesale invoices as a single PDF. Continue?"
    );
    if (!ok) return;
    setExporting(true);
    try {
      const res = await fetch(
        `/api/invoices/export?start=${rangeStart}&end=${rangeEnd}`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      // Server names the file; fall back to the local label if missing.
      const match = /filename="([^"]+)"/.exec(
        res.headers.get("Content-Disposition") || ""
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = match?.[1] || `invoices-${rangeStart}-to-${rangeEnd}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      // Wholesale rows left out of the PDF (no attachment / failed download).
      const skipped = res.headers.get("X-Skipped-Invoices");
      if (skipped) {
        alert(
          `Some wholesale invoices were left out of the PDF:\n${decodeURIComponent(
            skipped
          )}`
        );
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const exportNotes = () => {
    if (!rangeStart || !rangeEnd) {
      alert("Pick both a start and end date.");
      return;
    }
    if (rangeStart > rangeEnd) {
      alert("Start date must be on or before end date.");
      return;
    }
    setExportingNotes(true);
    window.open(
      `/api/invoices/bk-notes?start=${rangeStart}&end=${rangeEnd}`,
      "_blank"
    );
    // The download opens in a new tab; re-enable shortly after.
    setTimeout(() => setExportingNotes(false), 8000);
  };

  const exportGstr1 = () => {
    const q = GST_QUARTERS[Number(gstQuarter)];
    if (!q) return;
    setExportingGstr(true);
    window.open(
      `/api/invoices/hsn-summary?start=${q.start}&end=${q.end}`,
      "_blank"
    );
    // The download opens in a new tab; re-enable shortly after.
    setTimeout(() => setExportingGstr(false), 8000);
  };

  const toggleFiled = async (inv: InvoiceRecord) => {
    // Optimistic flip; revert on failure.
    const filed = !inv.filed;
    setInvoices((prev) =>
      prev.map((p) => (p.pageId === inv.pageId ? { ...p, filed } : p))
    );
    try {
      const res = await fetch("/api/invoices/wholesale", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId: inv.pageId, filed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
    } catch {
      setInvoices((prev) =>
        prev.map((p) => (p.pageId === inv.pageId ? { ...p, filed: !filed } : p))
      );
      alert("Could not update the filed flag. Try again.");
    }
  };

  const regenerate = async (inv: InvoiceRecord) => {
    setRegenerating(inv.pageId);
    try {
      const res = await fetch("/api/invoices/wholesale/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId: inv.pageId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Regenerate failed");
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Regenerating the PDF failed");
    } finally {
      setRegenerating(null);
    }
  };

  const attachPdf = async (file: File) => {
    if (!attachTarget) return;
    setAttaching(true);
    const target = attachTarget;
    try {
      const fd = new FormData();
      fd.append("pageId", target.pageId);
      fd.append("file", file);
      const res = await fetch("/api/invoices/wholesale/attach", {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Attach failed");
      // With the seller's original in place, re-issue ours right away.
      await regenerate(target);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Attaching the PDF failed");
      await load();
    } finally {
      setAttaching(false);
      setAttachTarget(null);
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = invoices.filter(
    (i) =>
      (typeFilter === "all" || i.type === typeFilter) &&
      (!q ||
        i.invoiceNo.toLowerCase().includes(q) ||
        i.orderNumber.toLowerCase().includes(q) ||
        i.customerName.toLowerCase().includes(q))
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-blue-400" />
          <h2 className="text-lg font-semibold text-zinc-100">Invoices</h2>
          <span className="text-xs text-zinc-500">
            {filtered.length} issued
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
            <Input
              placeholder="Search invoice / order / customer"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 pl-8 w-64 bg-zinc-800/60 border-zinc-700/50 text-zinc-200"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10 bg-transparent"
            onClick={() => setUploading(true)}
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Upload wholesale invoice
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-blue-500/30 text-blue-300 hover:bg-blue-500/10 bg-transparent"
            onClick={() => setCreating((v) => !v)}
          >
            <FilePlus className="h-3.5 w-3.5 mr-1.5" />
            New manual invoice
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 bg-transparent"
            onClick={load}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      <ManualInvoicePanel
        visible={creating}
        onClose={() => setCreating(false)}
      />

      <WholesaleUploadDialog
        open={uploading}
        onClose={() => setUploading(false)}
        onSaved={load}
      />

      <input
        ref={attachInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // allow re-picking the same file
          if (f) attachPdf(f);
        }}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* Date-range merged-PDF export */}
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3 space-y-2">
          <div className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">
            Download range (retail + wholesale, merged PDF)
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-zinc-500">From</label>
              <Input
                type="date"
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
                className="h-9 w-40 bg-zinc-800/60 border-zinc-700/50 text-zinc-200"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-zinc-500">To</label>
              <Input
                type="date"
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
                className="h-9 w-40 bg-zinc-800/60 border-zinc-700/50 text-zinc-200"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-9 border-blue-500/30 text-blue-300 hover:bg-blue-500/10 bg-transparent"
              onClick={exportRange}
              disabled={exporting}
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5 mr-1.5" />
              )}
              Download
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-9 border-zinc-700 text-zinc-300 hover:bg-zinc-800 bg-transparent"
              onClick={exportNotes}
              disabled={exportingNotes}
            >
              {exportingNotes ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5 mr-1.5" />
              )}
              Return notes
            </Button>
          </div>
          <p className="text-[11px] text-zinc-500">
            Includes every paid order in the range — generates invoice numbers for
            any not yet invoiced. Large ranges may take a while.
            <br />
            <span className="text-zinc-400">
              Return notes: one bookkeeping page per closed return in the range
              (cash collected, invoice total, store credit payable) — for the
              accountant. Read-only.
            </span>
          </p>
        </div>

        {/* Per-FY starting invoice number */}
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3 space-y-2">
          <div className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">
            Starting number {fy && `· FY ${fy}`}
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-zinc-500">First invoice #</label>
              <Input
                type="number"
                min={1}
                value={startInput}
                onChange={(e) => setStartInput(e.target.value)}
                placeholder={String(currentMaxSeq + 1)}
                className="h-9 w-40 bg-zinc-800/60 border-zinc-700/50 text-zinc-200"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-9 border-zinc-700 text-zinc-300 hover:bg-zinc-800 bg-transparent"
              onClick={saveStart}
              disabled={savingStart}
            >
              {savingStart ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              Save
            </Button>
          </div>
          <p className="text-[11px] text-zinc-500">
            {startMsg ||
              (currentMaxSeq > 0
                ? `Highest issued this FY: #${currentMaxSeq}. New number must be greater.`
                : "Set where numbering starts (e.g. 51 to continue existing books).")}
          </p>
        </div>

        {/* GSTR-1 HSN-wise summary (Excel) */}
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3 space-y-2">
          <div className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">
            GSTR-1 HSN summary (Excel)
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-zinc-500">Quarter</label>
              <select
                value={gstQuarter}
                onChange={(e) => setGstQuarter(e.target.value)}
                className="h-9 w-44 rounded-md bg-zinc-800/60 border border-zinc-700/50 text-zinc-200 px-2 text-sm"
              >
                {GST_QUARTERS.map((q, i) => (
                  <option key={q.start} value={String(i)}>
                    {q.label}
                  </option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-9 border-blue-500/30 text-blue-300 hover:bg-blue-500/10 bg-transparent"
              onClick={exportGstr1}
              disabled={exportingGstr}
            >
              {exportingGstr ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5 mr-1.5" />
              )}
              GSTR-1 Excel
            </Button>
          </div>
          <p className="text-[11px] text-zinc-500">
            HSN-wise outward supplies split by state — pieces, taxable value & tax.
            Read-only; may take a while.
          </p>
        </div>
        {/* COD fee display toggle */}
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3 space-y-2">
          <div className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">
            COD fee on invoices
          </div>
          <label className="flex items-start gap-2 text-sm text-zinc-300 cursor-pointer select-none">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-blue-500"
              checked={!hideCodFee}
              disabled={savingCod}
              onChange={(e) => toggleCodFee(!e.target.checked)}
            />
            <span>
              Show COD fee on invoices
              <span className="block text-[11px] text-zinc-500">
                {hideCodFee
                  ? "Off — COD fee line is excluded from invoice PDFs and GSTR-1 summary."
                  : "On — COD fee is printed as a taxable shipping line."}
              </span>
            </span>
          </label>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        {(
          [
            ["all", "All"],
            ["retail", "Retail"],
            ["wholesale", "Wholesale"],
          ] as Array<[typeof typeFilter, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTypeFilter(key)}
            className={
              "rounded-full px-3 py-1 text-xs transition-colors " +
              (typeFilter === key
                ? "bg-blue-500/15 text-blue-300 border border-blue-500/40"
                : "bg-zinc-800/60 text-zinc-400 border border-zinc-700/50 hover:text-zinc-200")
            }
          >
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-zinc-800/60 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-zinc-800/60 hover:bg-transparent">
              <TableHead className="text-zinc-400">Invoice No.</TableHead>
              <TableHead className="text-zinc-400">Date</TableHead>
              <TableHead className="text-zinc-400">Type</TableHead>
              <TableHead className="text-zinc-400">Order</TableHead>
              <TableHead className="text-zinc-400">Customer</TableHead>
              <TableHead className="text-zinc-400 text-right">Taxable</TableHead>
              <TableHead className="text-zinc-400 text-right">GST</TableHead>
              <TableHead className="text-zinc-400 text-right">Total</TableHead>
              <TableHead className="text-zinc-400 text-center">Filed</TableHead>
              <TableHead className="text-zinc-400 text-right">Invoice</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loading && filtered.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={10} className="text-center text-zinc-500 py-10">
                  {invoices.length === 0
                    ? "No invoices issued yet. Download one from an order in the Orders tab."
                    : "No invoices match your search."}
                </TableCell>
              </TableRow>
            )}
            {filtered.map((inv) => {
              const gst = inv.cgst + inv.sgst + inv.igst;
              return (
                <TableRow
                  key={inv.invoiceNo}
                  className="border-zinc-800/40 hover:bg-zinc-800/40"
                >
                  <TableCell className="font-medium text-zinc-200">
                    {inv.invoiceNo}
                    {inv.priceOverride && (
                      <span
                        className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-normal text-amber-300 align-middle"
                        title={`Unit prices fixed, ${inv.priceOverride.gstRate}% GST on top`}
                      >
                        updated
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-zinc-400 text-sm">
                    {fmtDate(inv.invoiceDate)}
                  </TableCell>
                  <TableCell className="text-sm">
                    <span
                      className={
                        inv.type === "wholesale"
                          ? "rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] text-purple-300"
                          : "rounded bg-zinc-500/15 px-1.5 py-0.5 text-[10px] text-zinc-400"
                      }
                    >
                      {inv.type === "wholesale" ? "Wholesale" : "Retail"}
                    </span>
                  </TableCell>
                  <TableCell className="text-zinc-300 text-sm">
                    {inv.orderNumber}
                  </TableCell>
                  <TableCell className="text-zinc-300 text-sm">
                    {inv.customerName || "—"}
                  </TableCell>
                  <TableCell className="text-right text-zinc-300 text-sm">
                    {inr(inv.taxableValue)}
                  </TableCell>
                  <TableCell className="text-right text-zinc-400 text-sm">
                    {inr(gst)}
                  </TableCell>
                  <TableCell className="text-right font-medium text-zinc-100 text-sm">
                    {inr(inv.grandTotal)}
                  </TableCell>
                  <TableCell className="text-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-blue-500 cursor-pointer"
                      title={
                        inv.filed
                          ? "GST return filed — number is locked"
                          : "Mark this invoice's GST return as filed"
                      }
                      checked={inv.filed}
                      onChange={() => toggleFiled(inv)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {inv.type === "retail" && inv.shopifyOrderId && (
                      <Button
                        size="sm"
                        variant="outline"
                        className={
                          inv.priceOverride
                            ? "border-amber-500/40 text-amber-300 hover:bg-amber-500/10 bg-transparent mr-1.5"
                            : "border-zinc-600/40 text-zinc-400 hover:bg-zinc-500/10 bg-transparent mr-1.5"
                        }
                        title="Fix this invoice's unit price and GST rate"
                        onClick={() => openOverride(inv)}
                      >
                        <Tag className="h-3.5 w-3.5 mr-1.5" />
                        Update Invoice
                      </Button>
                    )}
                    {inv.type === "wholesale" && (
                      <>
                        {inv.pdfUrl ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-blue-500/30 text-blue-300 hover:bg-blue-500/10 bg-transparent mr-1.5"
                            title="Our re-issued invoice PDF (our UN/FY number on the face)"
                            onClick={() =>
                              window.open(
                                `/api/invoices/wholesale/pdf?pageId=${inv.pageId}`,
                                "_blank"
                              )
                            }
                          >
                            <Download className="h-3.5 w-3.5 mr-1.5" />
                            PDF
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10 bg-transparent mr-1.5"
                            title="Create our re-issued PDF from this row's ledger data"
                            disabled={regenerating === inv.pageId}
                            onClick={() => regenerate(inv)}
                          >
                            {regenerating === inv.pageId ? (
                              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                            )}
                            Regenerate
                          </Button>
                        )}
                        {inv.origPdfUrl && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-zinc-600/40 text-zinc-400 hover:bg-zinc-500/10 bg-transparent mr-1.5"
                            title="The seller's original PDF (kept for audit)"
                            onClick={() =>
                              window.open(
                                `/api/invoices/wholesale/pdf?pageId=${inv.pageId}&which=original`,
                                "_blank"
                              )
                            }
                          >
                            <FileText className="h-3.5 w-3.5 mr-1.5" />
                            Seller PDF
                          </Button>
                        )}
                        {!inv.pdfUrl && !inv.origPdfUrl && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10 bg-transparent mr-1.5"
                            title="Upload the seller's original PDF onto this row, then re-issue ours"
                            disabled={attaching}
                            onClick={() => {
                              setAttachTarget(inv);
                              attachInputRef.current?.click();
                            }}
                          >
                            <Upload className="h-3.5 w-3.5 mr-1.5" />
                            Attach PDF
                          </Button>
                        )}
                      </>
                    )}
                    {inv.type === "retail" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-blue-500/30 text-blue-300 hover:bg-blue-500/10 bg-transparent"
                        title="Download this invoice"
                        onClick={() =>
                          window.open(`/api/invoices/${inv.shopifyOrderId}`, "_blank")
                        }
                      >
                        <Download className="h-3.5 w-3.5 mr-1.5" />
                        Download
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={overrideTarget !== null}
        onOpenChange={(o) => {
          if (!o) setOverrideTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-lg bg-zinc-900 border-zinc-700">
          <DialogHeader>
            <DialogTitle className="text-zinc-100">
              Update Invoice — {overrideTarget?.invoiceNo}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-zinc-400">
            Set the unit price (GST-exclusive) for each item and the GST rate.
            Everything the customer paid above the resulting total is booked as
            a store-credit advance — see the Return notes button.
          </p>
          {overrideLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading item lines…
            </div>
          ) : (
            <div className="space-y-2">
              {overrideLines.map((l, i) => (
                <div key={l.key || i} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-zinc-200 truncate">
                      {l.title}
                      {l.variantTitle ? ` (${l.variantTitle})` : ""}
                    </div>
                    <div className="text-xs text-zinc-500">qty {l.qty}</div>
                  </div>
                  <div className="relative w-32">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-zinc-500">₹</span>
                    <Input
                      type="number"
                      value={l.unitPrice}
                      onChange={(e) =>
                        setOverrideLines((prev) =>
                          prev.map((p, j) =>
                            j === i ? { ...p, unitPrice: e.target.value } : p
                          )
                        )
                      }
                      className="bg-zinc-800 border-zinc-700 text-zinc-100 pl-6"
                    />
                  </div>
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <span className="text-sm text-zinc-400 flex-1">GST rate</span>
                <select
                  value={overrideRate}
                  onChange={(e) => setOverrideRate(e.target.value)}
                  className="w-28 h-9 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-100 px-2 text-sm"
                >
                  {[0, 5, 12, 18, 28].map((r) => (
                    <option key={r} value={r}>
                      {r}%
                    </option>
                  ))}
                </select>
              </div>
              {overrideLines.length > 0 && (
                <div className="text-xs text-zinc-500 space-y-0.5 pt-1 border-t border-zinc-800">
                  <div>
                    New invoice total:{" "}
                    <span className="text-zinc-300">
                      ₹{overridePreviewTotal.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>{" "}
                    (currently {inr(overrideCurrentTotal)})
                  </div>
                  {overridePreviewTotal < overrideCollected && (
                    <div>
                      Store-credit advance:{" "}
                      <span className="text-amber-300">
                        ₹{(overrideCollected - overridePreviewTotal).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {overrideMsg && (
            <p className="text-sm text-red-400">{overrideMsg}</p>
          )}
          <div className="flex justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={savingOverride}
              className="border-red-500/30 text-red-300 hover:bg-red-500/10 bg-transparent"
              onClick={() => saveOverride(true)}
              title="Remove the override; the next download reverts to Shopify-computed figures"
            >
              Clear override
            </Button>
            <Button
              size="sm"
              disabled={savingOverride || overrideLoading || overrideLines.length === 0}
              onClick={() => saveOverride(false)}
            >
              {savingOverride ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : null}
              Save &amp; apply
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
