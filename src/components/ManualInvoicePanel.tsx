"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, Download, Loader2, RotateCcw, X } from "lucide-react";
import {
  buildManualInvoiceModel,
  computeManualLine,
  validateManualInvoice,
  emptyParty,
  todayISO,
  GST_RATES,
  STATE_OPTIONS,
  type ManualInvoiceInput,
  type ManualParty,
} from "@/lib/invoice/manual";
import { HOME_STATE_CODE, SHIPPING_GST_RATE } from "@/lib/invoice/config";

const DRAFT_KEY = "manualInvoiceDraft";

function inr(n: number): string {
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Numeric fields are held as strings so a half-typed value ("", "0.", "1.2")
// survives editing instead of being coerced to 0 on every keystroke. `toInput`
// is the single place they become numbers.
interface DraftLine {
  itemCode: string;
  description: string;
  hsn: string;
  unit: string;
  qty: string;
  rate: string;
  gstRate: number;
  discount: string;
}

interface Draft {
  invoiceNo: string;
  invoiceDate: string;
  reference: string;
  pricesIncludeTax: boolean;
  buyer: ManualParty & { gstin: string };
  sameAsBilling: boolean;
  shipTo: ManualParty;
  lines: DraftLine[];
  shipping: { amount: string; gstRate: number };
  notes: string;
  markPaid: boolean;
}

function emptyDraftLine(): DraftLine {
  return { itemCode: "", description: "", hsn: "", unit: "PCS", qty: "1", rate: "", gstRate: 5, discount: "" };
}

function emptyDraft(): Draft {
  return {
    invoiceNo: "",
    invoiceDate: todayISO(),
    reference: "",
    pricesIncludeTax: false,
    buyer: { ...emptyParty(), gstin: "" },
    sameAsBilling: true,
    shipTo: { ...emptyParty() },
    lines: [emptyDraftLine()],
    shipping: { amount: "", gstRate: SHIPPING_GST_RATE },
    notes: "",
    markPaid: false,
  };
}

const num = (s: string): number => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

function toInput(d: Draft): ManualInvoiceInput {
  return {
    ...d,
    lines: d.lines.map((l) => ({
      itemCode: l.itemCode,
      description: l.description,
      hsn: l.hsn,
      unit: l.unit,
      qty: num(l.qty),
      rate: num(l.rate),
      gstRate: l.gstRate,
      discount: num(l.discount),
    })),
    shipping: { amount: num(d.shipping.amount), gstRate: d.shipping.gstRate },
  };
}

// Bump the trailing number of an invoice number, preserving zero padding:
// "UN/2026-27/00042" -> "UN/2026-27/00043". Returns the input unchanged when
// there is no trailing number to bump.
function nextInvoiceNo(s: string): string {
  const m = s.match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return s;
  const [, head, digits, tail] = m;
  return head + String(Number(digits) + 1).padStart(digits.length, "0") + tail;
}

const INPUT_CLASS = "h-9 bg-zinc-800/60 border-zinc-700/50 text-zinc-200";
const SELECT_CLASS =
  "h-9 rounded-md bg-zinc-800/60 border border-zinc-700/50 text-zinc-200 px-2 text-sm";

function Field({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label className="text-[11px] text-zinc-500">{label}</label>
      {children}
    </div>
  );
}

function PartyFields({
  party,
  onChange,
}: {
  party: ManualParty;
  onChange: (field: keyof ManualParty, value: string) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="Name *">
        <Input
          className={INPUT_CLASS}
          value={party.name}
          onChange={(e) => onChange("name", e.target.value)}
        />
      </Field>
      <Field label="Company">
        <Input
          className={INPUT_CLASS}
          value={party.company}
          onChange={(e) => onChange("company", e.target.value)}
        />
      </Field>
      <Field label="Address line 1">
        <Input
          className={INPUT_CLASS}
          value={party.address1}
          onChange={(e) => onChange("address1", e.target.value)}
        />
      </Field>
      <Field label="Address line 2">
        <Input
          className={INPUT_CLASS}
          value={party.address2}
          onChange={(e) => onChange("address2", e.target.value)}
        />
      </Field>
      <Field label="City">
        <Input
          className={INPUT_CLASS}
          value={party.city}
          onChange={(e) => onChange("city", e.target.value)}
        />
      </Field>
      <Field label="State *">
        <select
          className={SELECT_CLASS}
          value={party.stateCode}
          onChange={(e) => onChange("stateCode", e.target.value)}
        >
          {STATE_OPTIONS.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="PIN code">
        <Input
          className={INPUT_CLASS}
          value={party.zip}
          onChange={(e) => onChange("zip", e.target.value)}
        />
      </Field>
      <Field label="Phone">
        <Input
          className={INPUT_CLASS}
          value={party.phone}
          onChange={(e) => onChange("phone", e.target.value)}
        />
      </Field>
    </div>
  );
}

interface ManualInvoicePanelProps {
  visible: boolean;
  onClose: () => void;
}

export function ManualInvoicePanel({ visible, onClose }: ManualInvoicePanelProps) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [hydrated, setHydrated] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Restore a half-typed invoice after a refresh.
  useEffect(() => {
    if (!visible || hydrated) return;
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Draft;
        // A draft saved before a field existed must not reach the calc with
        // undefined values — merge each line over a fresh default.
        const lines = (saved.lines || []).map((l) => ({ ...emptyDraftLine(), ...l }));
        setDraft({ ...emptyDraft(), ...saved, lines: lines.length ? lines : [emptyDraftLine()] });
      }
    } catch {
      // Corrupt draft — start clean rather than blocking the form.
    }
    setHydrated(true);
  }, [visible, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Quota or private mode — persistence is a convenience, not a requirement.
    }
  }, [draft, hydrated]);

  const input = useMemo(() => toInput(draft), [draft]);
  const problem = useMemo(() => validateManualInvoice(input), [input]);
  // The live totals come from the exact function the PDF renderer uses, so what
  // is on screen cannot drift from what is printed.
  const model = useMemo(() => {
    try {
      return buildManualInvoiceModel(input);
    } catch {
      return null;
    }
  }, [input]);

  const patch = useCallback((p: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...p }));
    setDone(null);
  }, []);

  const setBuyer = (field: keyof ManualParty | "gstin", value: string) =>
    setDraft((prev) => ({ ...prev, buyer: { ...prev.buyer, [field]: value } }));

  const setShipTo = (field: keyof ManualParty, value: string) =>
    setDraft((prev) => ({ ...prev, shipTo: { ...prev.shipTo, [field]: value } }));

  const updateLine = (index: number, field: keyof DraftLine, value: string | number) =>
    setDraft((prev) => {
      const lines = [...prev.lines];
      lines[index] = { ...lines[index], [field]: value };
      return { ...prev, lines };
    });

  const addLine = () =>
    setDraft((prev) => ({ ...prev, lines: [...prev.lines, emptyDraftLine()] }));

  const removeLine = (index: number) =>
    setDraft((prev) => {
      const lines = prev.lines.filter((_, i) => i !== index);
      return { ...prev, lines: lines.length ? lines : [emptyDraftLine()] };
    });

  const reset = () => {
    setDraft(emptyDraft());
    setError(null);
    setDone(null);
  };

  const generate = async () => {
    setError(null);
    setDone(null);
    if (problem) {
      setError(problem);
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch("/api/invoices/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to generate the invoice.");
      }
      // A POST can't be handed to window.open the way the GET exports are, so
      // the PDF comes back as a blob and is saved via a synthetic anchor.
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${draft.invoiceNo.replace(/[\\/:*?"<>|]/g, "-")}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setDone(`${draft.invoiceNo} downloaded.`);
      // Keep the buyer for repeat billing; clear the items and suggest the next
      // number, which stays editable because numbering is manual here.
      setDraft((prev) => ({
        ...prev,
        invoiceNo: nextInvoiceNo(prev.invoiceNo),
        reference: "",
        lines: [emptyDraftLine()],
        shipping: { ...prev.shipping, amount: "" },
        notes: "",
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate the invoice.");
    } finally {
      setGenerating(false);
    }
  };

  if (!visible) return null;

  const t = model?.totals;
  const intraState = draft.buyer.stateCode === HOME_STATE_CODE;
  const basisHint = draft.pricesIncludeTax
    ? "Rates you type already contain GST — it is backed out."
    : "GST is added on top of the rates you type.";

  return (
    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-200">
            New manual invoice
          </div>
          <p className="text-[11px] text-zinc-500 mt-0.5 max-w-xl">
            For sales that aren&apos;t in Shopify. Not saved to the ledger and not
            included in the GSTR-1 export — the downloaded PDF is the only copy,
            so record it in your books separately.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 bg-transparent"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Invoice header */}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Invoice number *">
          <Input
            className={`${INPUT_CLASS} w-52`}
            placeholder="e.g. UN/M/2026-27/001"
            value={draft.invoiceNo}
            onChange={(e) => patch({ invoiceNo: e.target.value })}
          />
        </Field>
        <Field label="Invoice date *">
          <Input
            type="date"
            className={`${INPUT_CLASS} w-40`}
            value={draft.invoiceDate}
            onChange={(e) => patch({ invoiceDate: e.target.value })}
          />
        </Field>
        <Field label="Reference">
          <Input
            className={`${INPUT_CLASS} w-44`}
            placeholder="PO / order ref"
            value={draft.reference}
            onChange={(e) => patch({ reference: e.target.value })}
          />
        </Field>
        <div className="flex items-center gap-2 h-9">
          <Switch
            checked={draft.pricesIncludeTax}
            onCheckedChange={(checked: boolean) =>
              patch({ pricesIncludeTax: checked })
            }
          />
          <span className="text-xs text-zinc-300">Prices include GST</span>
        </div>
        <div className="flex items-center gap-2 h-9">
          <Switch
            checked={draft.markPaid}
            onCheckedChange={(checked: boolean) => patch({ markPaid: checked })}
          />
          <span className="text-xs text-zinc-300">Mark as PAID</span>
        </div>
      </div>
      <p className="text-[11px] text-zinc-500 -mt-2">{basisHint}</p>

      {/* Parties */}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3 space-y-2">
          <div className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">
            Bill to
          </div>
          <PartyFields party={draft.buyer} onChange={setBuyer} />
          <Field label="Buyer GSTIN (optional)">
            <Input
              className={INPUT_CLASS}
              placeholder="15-character GSTIN"
              value={draft.buyer.gstin}
              onChange={(e) => setBuyer("gstin", e.target.value.toUpperCase())}
            />
          </Field>
        </div>

        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">
              Ship to
            </div>
            <label className="flex items-center gap-2 text-[11px] text-zinc-400">
              <input
                type="checkbox"
                className="accent-blue-500"
                checked={draft.sameAsBilling}
                onChange={(e) => patch({ sameAsBilling: e.target.checked })}
              />
              Same as billing
            </label>
          </div>
          {draft.sameAsBilling ? (
            <p className="text-[11px] text-zinc-500 py-2">
              Shipping address will match the billing address.
            </p>
          ) : (
            <PartyFields party={draft.shipTo} onChange={setShipTo} />
          )}
        </div>
      </div>

      {/* Line items */}
      <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">
            Items
          </div>
          <span className="text-[11px] text-zinc-500">
            {intraState ? "Intra-state — CGST + SGST" : "Inter-state — IGST"}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[940px]">
            <thead>
              <tr className="text-[11px] text-zinc-500 text-left">
                <th className="font-normal pb-1 pr-2 w-24">Item Code</th>
                <th className="font-normal pb-1 pr-2">Description *</th>
                <th className="font-normal pb-1 pr-2 w-24">HSN/SAC</th>
                <th className="font-normal pb-1 pr-2 w-20">Qty</th>
                <th className="font-normal pb-1 pr-2 w-20">Per</th>
                <th className="font-normal pb-1 pr-2 w-28">Rate</th>
                <th className="font-normal pb-1 pr-2 w-24">Discount</th>
                <th className="font-normal pb-1 pr-2 w-20">GST %</th>
                <th className="font-normal pb-1 pr-2 w-28 text-right">Amount</th>
                <th className="w-9" />
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((l, i) => (
                <tr key={i}>
                  <td className="py-1 pr-2">
                    <Input
                      className={INPUT_CLASS}
                      value={l.itemCode}
                      onChange={(e) => updateLine(i, "itemCode", e.target.value)}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <Input
                      className={INPUT_CLASS}
                      placeholder="Item description"
                      value={l.description}
                      onChange={(e) => updateLine(i, "description", e.target.value)}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <Input
                      className={INPUT_CLASS}
                      value={l.hsn}
                      onChange={(e) => updateLine(i, "hsn", e.target.value)}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <Input
                      className={INPUT_CLASS}
                      inputMode="decimal"
                      value={l.qty}
                      onChange={(e) => updateLine(i, "qty", e.target.value)}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <Input
                      className={INPUT_CLASS}
                      placeholder="PCS"
                      value={l.unit}
                      onChange={(e) => updateLine(i, "unit", e.target.value)}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <Input
                      className={INPUT_CLASS}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={l.rate}
                      onChange={(e) => updateLine(i, "rate", e.target.value)}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <Input
                      className={INPUT_CLASS}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={l.discount}
                      onChange={(e) => updateLine(i, "discount", e.target.value)}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <select
                      className={`${SELECT_CLASS} w-full`}
                      value={l.gstRate}
                      onChange={(e) =>
                        updateLine(i, "gstRate", Number(e.target.value))
                      }
                    >
                      {GST_RATES.map((r) => (
                        <option key={r} value={r}>
                          {r}%
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1 pr-2 text-right text-zinc-300 tabular-nums">
                    {inr(
                      // The invoice's Amount column is the pre-tax line value.
                      computeManualLine(
                        input.lines[i],
                        intraState,
                        draft.pricesIncludeTax
                      ).grossPreTax.toNumber()
                    )}
                  </td>
                  <td className="py-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9 w-9 p-0 border-zinc-700 text-zinc-400 hover:bg-red-500/10 hover:text-red-400 bg-transparent"
                      onClick={() => removeLine(i)}
                      aria-label={`Remove line ${i + 1}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end gap-3 pt-1">
          <Button
            size="sm"
            variant="outline"
            className="h-9 border-zinc-700 text-zinc-300 hover:bg-zinc-800 bg-transparent"
            onClick={addLine}
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add row
          </Button>
          <Field label="Shipping / freight">
            <Input
              className={`${INPUT_CLASS} w-32`}
              inputMode="decimal"
              placeholder="0.00"
              value={draft.shipping.amount}
              onChange={(e) =>
                patch({ shipping: { ...draft.shipping, amount: e.target.value } })
              }
            />
          </Field>
          <Field label="Shipping GST %">
            <select
              className={`${SELECT_CLASS} w-24`}
              value={draft.shipping.gstRate}
              onChange={(e) =>
                patch({
                  shipping: { ...draft.shipping, gstRate: Number(e.target.value) },
                })
              }
            >
              {GST_RATES.map((r) => (
                <option key={r} value={r}>
                  {r}%
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      {/* Notes + totals */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Field label="Notes (printed on the invoice)">
          <textarea
            rows={4}
            className="rounded-md bg-zinc-800/60 border border-zinc-700/50 text-zinc-200 px-3 py-2 text-sm"
            value={draft.notes}
            onChange={(e) => patch({ notes: e.target.value })}
          />
        </Field>

        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <div className="text-xs font-semibold text-zinc-300 uppercase tracking-wide mb-2">
            Totals
          </div>
          {t ? (
            <table className="w-full text-sm tabular-nums">
              <tbody>
                <tr>
                  <td className="text-zinc-500 py-0.5">Subtotal (pre-tax)</td>
                  <td className="text-right text-zinc-300">
                    {inr(t.grossPreTax.toNumber())}
                  </td>
                </tr>
                <tr>
                  <td className="text-zinc-500 py-0.5">Discount</td>
                  <td className="text-right text-zinc-300">
                    {inr(t.discount.toNumber())}
                  </td>
                </tr>
                <tr>
                  <td className="text-zinc-500 py-0.5">Taxable value</td>
                  <td className="text-right text-zinc-300">
                    {inr(t.taxableValue.toNumber())}
                  </td>
                </tr>
                {intraState ? (
                  <>
                    <tr>
                      <td className="text-zinc-500 py-0.5">CGST</td>
                      <td className="text-right text-zinc-300">
                        {inr(t.cgst.toNumber())}
                      </td>
                    </tr>
                    <tr>
                      <td className="text-zinc-500 py-0.5">SGST</td>
                      <td className="text-right text-zinc-300">
                        {inr(t.sgst.toNumber())}
                      </td>
                    </tr>
                  </>
                ) : (
                  <tr>
                    <td className="text-zinc-500 py-0.5">IGST</td>
                    <td className="text-right text-zinc-300">
                      {inr(t.igst.toNumber())}
                    </td>
                  </tr>
                )}
                {!t.roundOff.isZero() && (
                  <tr>
                    <td className="text-zinc-500 py-0.5">Round off</td>
                    <td className="text-right text-zinc-300">
                      {inr(t.roundOff.toNumber())}
                    </td>
                  </tr>
                )}
                <tr className="border-t border-zinc-800">
                  <td className="text-zinc-200 font-semibold pt-1.5">Grand total</td>
                  <td className="text-right text-zinc-100 font-semibold pt-1.5">
                    {inr(t.grandTotal.toNumber())}
                  </td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="text-[11px] text-zinc-500">Add a line item to see totals.</p>
          )}
          {model && (
            <p className="text-[11px] text-zinc-500 mt-2">{model.amountInWords}</p>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400">
          {error}
        </div>
      )}
      {done && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-400">
          {done}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-9"
          onClick={generate}
          disabled={generating || !!problem}
        >
          {generating ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5 mr-1.5" />
          )}
          Generate PDF
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-9 border-zinc-700 text-zinc-300 hover:bg-zinc-800 bg-transparent"
          onClick={reset}
          disabled={generating}
        >
          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
          Reset
        </Button>
        {problem && !error && (
          <span className="text-[11px] text-zinc-500">{problem}</span>
        )}
      </div>
    </div>
  );
}
