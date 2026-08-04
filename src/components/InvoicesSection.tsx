"use client";

import { useState, useEffect, useCallback } from "react";
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
import { InvoiceRecord } from "@/lib/data/types";
import { ManualInvoicePanel } from "@/components/ManualInvoicePanel";
import {
  RefreshCw,
  Download,
  FileText,
  FilePlus,
  Loader2,
  Search,
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

  // Date-range merged-PDF export
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [exporting, setExporting] = useState(false);

  // GSTR-1 HSN summary (Excel)
  const [gstQuarter, setGstQuarter] = useState(DEFAULT_QUARTER);
  const [exportingGstr, setExportingGstr] = useState(false);

  // Per-FY starting invoice number
  const [fy, setFy] = useState("");
  const [startInput, setStartInput] = useState("");
  const [currentMaxSeq, setCurrentMaxSeq] = useState(0);
  const [savingStart, setSavingStart] = useState(false);
  const [startMsg, setStartMsg] = useState<string | null>(null);

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

  const exportRange = () => {
    if (!rangeStart || !rangeEnd) {
      alert("Pick both a start and end date.");
      return;
    }
    if (rangeStart > rangeEnd) {
      alert("Start date must be on or before end date.");
      return;
    }
    const ok = window.confirm(
      "This will generate invoice numbers for any paid orders in this range that don't have one yet, and download them all as a single PDF. Continue?"
    );
    if (!ok) return;
    setExporting(true);
    window.open(
      `/api/invoices/export?start=${rangeStart}&end=${rangeEnd}`,
      "_blank"
    );
    // The download opens in a new tab; re-enable shortly after.
    setTimeout(() => setExporting(false), 4000);
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

  const q = query.trim().toLowerCase();
  const filtered = q
    ? invoices.filter(
        (i) =>
          i.invoiceNo.toLowerCase().includes(q) ||
          i.orderNumber.toLowerCase().includes(q) ||
          i.customerName.toLowerCase().includes(q)
      )
    : invoices;

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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* Date-range merged-PDF export */}
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3 space-y-2">
          <div className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">
            Download range (merged PDF)
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
          </div>
          <p className="text-[11px] text-zinc-500">
            Includes every paid order in the range — generates invoice numbers for
            any not yet invoiced. Large ranges may take a while.
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
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-zinc-800/60 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-zinc-800/60 hover:bg-transparent">
              <TableHead className="text-zinc-400">Invoice No.</TableHead>
              <TableHead className="text-zinc-400">Date</TableHead>
              <TableHead className="text-zinc-400">Order</TableHead>
              <TableHead className="text-zinc-400">Customer</TableHead>
              <TableHead className="text-zinc-400 text-right">Taxable</TableHead>
              <TableHead className="text-zinc-400 text-right">GST</TableHead>
              <TableHead className="text-zinc-400 text-right">Total</TableHead>
              <TableHead className="text-zinc-400 text-right">Invoice</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loading && filtered.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="text-center text-zinc-500 py-10">
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
                  </TableCell>
                  <TableCell className="text-zinc-400 text-sm">
                    {fmtDate(inv.invoiceDate)}
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
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-blue-500/30 text-blue-300 hover:bg-blue-500/10 bg-transparent"
                      onClick={() =>
                        window.open(
                          `/api/invoices/${inv.shopifyOrderId}`,
                          "_blank"
                        )
                      }
                    >
                      <Download className="h-3.5 w-3.5 mr-1.5" />
                      Download
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
