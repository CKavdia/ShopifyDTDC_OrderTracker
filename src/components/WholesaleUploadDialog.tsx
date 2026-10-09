"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2,
  Upload,
  FileCheck2,
  AlertTriangle,
  X,
} from "lucide-react";
import { STATE_OPTIONS } from "@/lib/invoice/manual";
import type { ParsedInvoice } from "@/lib/invoice/parse";
import type { RenumberChange } from "@/lib/data/types";

// One uploaded PDF mid-confirmation. Parsed values are editable suggestions;
// `result` is filled once its save call succeeds.
interface Draft {
  id: number;
  filename: string;
  pdfBase64: string;
  form: FormState;
  missing: string[];
  parseError: string | null;
  saving: boolean;
  error: string | null;
  result: {
    invoiceNo: string;
    renumbered: RenumberChange[];
    attachError?: string;
  } | null;
}

interface FormState {
  invoiceDate: string;
  customerName: string;
  gstin: string;
  stateCode: string;
  hsn: string;
  quantity: string;
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  grandTotal: string;
  reference: string;
}

const EMPTY: FormState = {
  invoiceDate: "",
  customerName: "",
  gstin: "",
  stateCode: "",
  hsn: "",
  quantity: "",
  taxableValue: "",
  cgst: "",
  sgst: "",
  igst: "",
  grandTotal: "",
  reference: "",
};

// Upload wholesale invoice PDFs (issued offline) in one batch, confirm the
// parsed details, and file them into the shared UN/FY series — each save
// renumbers every unfiled invoice so the series stays in date order.
export function WholesaleUploadDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<"pick" | "confirm" | "done">("pick");
  const [parsing, setParsing] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);

  const reset = () => {
    setStage("pick");
    setParsing(false);
    setSavingAll(false);
    setDrafts([]);
  };

  const handleClose = () => {
    onClose();
    if (stage === "done") reset();
  };

  const pickFiles = async (files: FileList) => {
    setParsing(true);
    let nextId = drafts.length;
    const newDrafts: Draft[] = [];
    for (const file of Array.from(files)) {
      const id = nextId++;
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/invoices/wholesale/upload", {
          method: "POST",
          body: fd,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not read that PDF.");
        const parsed: ParsedInvoice = data.parsed;
        // Keep the raw bytes for the Notion attachment on save.
        const bytes = new Uint8Array(await file.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        newDrafts.push({
          id,
          filename: data.filename || file.name,
          pdfBase64: btoa(bin),
          form: {
            invoiceDate: parsed.invoiceDate || "",
            customerName: parsed.customerName || "",
            gstin: parsed.gstin || "",
            stateCode: parsed.stateCode || "",
            hsn: parsed.hsn || "",
            quantity: parsed.totalQty != null ? String(parsed.totalQty) : "",
            taxableValue: parsed.taxableValue != null ? String(parsed.taxableValue) : "",
            cgst: parsed.cgst != null ? String(parsed.cgst) : "",
            sgst: parsed.sgst != null ? String(parsed.sgst) : "",
            igst: parsed.igst != null ? String(parsed.igst) : "",
            grandTotal: parsed.grandTotal != null ? String(parsed.grandTotal) : "",
            reference: parsed.originalInvoiceNo || "",
          },
          missing: parsed.missing || [],
          parseError: null,
          saving: false,
          error: null,
          result: null,
        });
      } catch (e) {
        newDrafts.push({
          id,
          filename: file.name,
          pdfBase64: "",
          form: { ...EMPTY },
          missing: [],
          parseError:
            e instanceof Error ? e.message : "Could not read that PDF.",
          saving: false,
          error: null,
          result: null,
        });
      }
    }
    setDrafts((prev) => [...prev, ...newDrafts]);
    setParsing(false);
    setStage("confirm");
  };

  const setDraft = (id: number, patch: Partial<Draft>) =>
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const setField = (id: number, k: keyof FormState, v: string) =>
    setDrafts((prev) =>
      prev.map((d) =>
        d.id === id ? { ...d, form: { ...d.form, [k]: v } } : d
      )
    );

  const num = (s: string) => {
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  };

  const validate = (d: Draft): string | null => {
    if (!d.form.invoiceDate) return "Invoice date is required.";
    if (!d.form.customerName.trim()) return "Customer name is required.";
    if (!d.form.stateCode) return "Select the buyer's state.";
    if (!(num(d.form.taxableValue) > 0))
      return "Taxable value must be greater than zero.";
    if (!(num(d.form.grandTotal) > 0))
      return "Grand total must be greater than zero.";
    const heads =
      (num(d.form.cgst) || 0) + (num(d.form.sgst) || 0) + (num(d.form.igst) || 0);
    if (Math.abs(heads - (num(d.form.grandTotal) - num(d.form.taxableValue))) > 2)
      return "GST heads must add up to (Grand total − Taxable value).";
    return null;
  };

  const saveDraft = async (d: Draft) => {
    const problem = validate(d);
    if (problem) {
      setDraft(d.id, { error: problem });
      return null;
    }
    setDraft(d.id, { error: null, saving: true });
    try {
      const res = await fetch("/api/invoices/wholesale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceDate: d.form.invoiceDate,
          customerName: d.form.customerName.trim(),
          gstin: d.form.gstin.trim().toUpperCase(),
          stateCode: d.form.stateCode,
          hsn: d.form.hsn.trim(),
          quantity: num(d.form.quantity) || 0,
          taxableValue: num(d.form.taxableValue),
          cgst: num(d.form.cgst) || 0,
          sgst: num(d.form.sgst) || 0,
          igst: num(d.form.igst) || 0,
          grandTotal: num(d.form.grandTotal),
          reference: d.form.reference.trim(),
          filename: d.filename,
          pdfBase64: d.pdfBase64,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save.");
      const result = {
        invoiceNo: data.invoiceNo as string,
        renumbered: (data.renumbered || []) as RenumberChange[],
        attachError: data.attachError as string | undefined,
      };
      setDraft(d.id, { saving: false, result, error: null });
      return result;
    } catch (e) {
      setDraft(d.id, {
        saving: false,
        error: e instanceof Error ? e.message : "Failed to save.",
      });
      return null;
    }
  };

  // Save every not-yet-saved draft in order; the ledger locks the series per
  // call so numbers stay consistent. A failed draft stays editable — fix it
  // and hit Save again; only a fully successful batch moves to the summary.
  const saveAll = async () => {
    setSavingAll(true);
    let anyFailed = false;
    for (const d of drafts) {
      if (d.result || d.parseError) continue;
      const r = await saveDraft(d);
      if (!r) anyFailed = true;
    }
    setSavingAll(false);
    if (!anyFailed) {
      setStage("done");
      onSaved();
    }
  };

  const savedCount = drafts.filter((d) => d.result).length;

  const missingLabel = (d: Draft, needle: string) =>
    d.missing.some((m) => m.toLowerCase().includes(needle.toLowerCase()));

  const amountFields: Array<[keyof FormState, string]> = [
    ["taxableValue", "Taxable"],
    ["cgst", "CGST"],
    ["sgst", "SGST"],
    ["igst", "IGST"],
    ["grandTotal", "Grand total"],
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-2xl bg-zinc-900 border-zinc-700 max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">
            Upload wholesale invoices
          </DialogTitle>
        </DialogHeader>

        {stage === "pick" && (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">
              Attach the PDFs of invoices you issued outside the tool — one or
              many. Each gets a number in the same UN series, ordered by date.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files;
                if (files && files.length > 0) pickFiles(files);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              className="w-full h-24 border-dashed border-zinc-600 text-zinc-300 hover:bg-zinc-800 bg-transparent flex-col gap-1"
              disabled={parsing}
              onClick={() => fileRef.current?.click()}
            >
              {parsing ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Reading PDFs…
                </>
              ) : (
                <>
                  <Upload className="h-5 w-5" />
                  Choose invoice PDFs
                </>
              )}
            </Button>
            <p className="text-[11px] text-zinc-500">
              Details are read from the PDF text layer — scanned images
              won&apos;t parse; type those manually after picking the files.
            </p>
          </div>
        )}

        {stage === "confirm" && (
          <div className="space-y-3">
            {drafts.map((d) => (
              <div
                key={d.id}
                className={
                  "rounded-lg border p-3 space-y-2 " +
                  (d.parseError
                    ? "border-red-500/40 bg-red-500/5"
                    : d.result
                      ? "border-green-500/30 bg-green-500/5"
                      : "border-zinc-700/60 bg-zinc-800/30")
                }
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-400 truncate flex-1">
                    {d.filename}
                  </span>
                  {d.result && (
                    <span className="text-xs text-green-300 font-medium shrink-0">
                      {d.result.invoiceNo}
                    </span>
                  )}
                  {!d.result && (
                    <button
                      className="text-zinc-500 hover:text-zinc-300 shrink-0"
                      title="Remove this file"
                      disabled={d.saving || savingAll}
                      onClick={() =>
                        setDrafts((prev) => prev.filter((x) => x.id !== d.id))
                      }
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {d.parseError && (
                  <div className="text-xs text-red-400 flex gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    {d.parseError}
                  </div>
                )}

                {!d.parseError && !d.result && (
                  <>
                    {d.missing.length > 0 && (
                      <div className="text-xs text-amber-300 flex gap-1.5">
                        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <span>
                          Could not read: {d.missing.join(", ")}. Check the
                          highlighted fields.
                        </span>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex flex-col gap-1">
                        <label className="text-[11px] text-zinc-500">
                          Invoice date
                        </label>
                        <Input
                          type="date"
                          value={d.form.invoiceDate}
                          onChange={(e) =>
                            setField(d.id, "invoiceDate", e.target.value)
                          }
                          className={
                            "h-8 bg-zinc-800/60 border-zinc-700/50 text-zinc-200 " +
                            (missingLabel(d, "date") && !d.form.invoiceDate
                              ? "border-amber-500/50"
                              : "")
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[11px] text-zinc-500">
                          Original no. (reference)
                        </label>
                        <Input
                          value={d.form.reference}
                          onChange={(e) =>
                            setField(d.id, "reference", e.target.value)
                          }
                          className="h-8 bg-zinc-800/60 border-zinc-700/50 text-zinc-200"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[11px] text-zinc-500">
                          Customer
                        </label>
                        <Input
                          value={d.form.customerName}
                          onChange={(e) =>
                            setField(d.id, "customerName", e.target.value)
                          }
                          className={
                            "h-8 bg-zinc-800/60 border-zinc-700/50 text-zinc-200 " +
                            (missingLabel(d, "customer") && !d.form.customerName
                              ? "border-amber-500/50"
                              : "")
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[11px] text-zinc-500">
                          Buyer GSTIN
                        </label>
                        <Input
                          value={d.form.gstin}
                          onChange={(e) =>
                            setField(
                              d.id,
                              "gstin",
                              e.target.value.toUpperCase()
                            )
                          }
                          placeholder="Optional (B2C)"
                          className="h-8 bg-zinc-800/60 border-zinc-700/50 text-zinc-200"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[11px] text-zinc-500">
                          State
                        </label>
                        <select
                          value={d.form.stateCode}
                          onChange={(e) =>
                            setField(d.id, "stateCode", e.target.value)
                          }
                          className="h-8 rounded-md bg-zinc-800/60 border border-zinc-700/50 text-zinc-200 px-2 text-sm"
                        >
                          <option value="">Select…</option>
                          {STATE_OPTIONS.map((s) => (
                            <option key={s.code} value={s.code}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[11px] text-zinc-500">
                          HSN/SAC
                        </label>
                        <Input
                          value={d.form.hsn}
                          onChange={(e) =>
                            setField(
                              d.id,
                              "hsn",
                              e.target.value.replace(/\D/g, "").slice(0, 8)
                            )
                          }
                          placeholder="For the GSTR-1 summary"
                          className="h-8 bg-zinc-800/60 border-zinc-700/50 text-zinc-200"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[11px] text-zinc-500">
                          Total qty (pcs)
                        </label>
                        <Input
                          type="number"
                          step="1"
                          min="0"
                          value={d.form.quantity}
                          onChange={(e) =>
                            setField(d.id, "quantity", e.target.value)
                          }
                          placeholder="For the GSTR-1 quantity"
                          className={
                            "h-8 bg-zinc-800/60 border-zinc-700/50 text-zinc-200 " +
                            (!d.form.quantity ? "border-amber-500/50" : "")
                          }
                        />
                      </div>
                      {amountFields.map(([k, label]) => (
                        <div key={k} className="flex flex-col gap-1">
                          <label className="text-[11px] text-zinc-500">
                            {label}
                          </label>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={d.form[k]}
                            onChange={(e) => setField(d.id, k, e.target.value)}
                            className={
                              "h-8 bg-zinc-800/60 border-zinc-700/50 text-zinc-200 " +
                              (!d.form[k] ? "border-amber-500/50" : "")
                            }
                          />
                        </div>
                      ))}
                    </div>
                    {d.error && (
                      <p className="text-xs text-red-400">{d.error}</p>
                    )}
                  </>
                )}
              </div>
            ))}

            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 bg-transparent"
                disabled={parsing || savingAll}
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Add more
              </Button>
              <div className="flex-1" />
              <Button
                variant="outline"
                size="sm"
                className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 bg-transparent"
                onClick={reset}
                disabled={savingAll}
              >
                Clear all
              </Button>
            </div>
          </div>
        )}

        {stage === "done" && (
          <div className="space-y-3">
            <div className="rounded border border-green-500/30 bg-green-500/5 p-3 text-sm text-green-300 flex gap-2">
              <FileCheck2 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                Recorded {savedCount} invoice{savedCount === 1 ? "" : "s"}:
              </span>
            </div>
            <div className="space-y-1">
              {drafts
                .filter((d) => d.result)
                .map((d) => (
                  <div key={d.id} className="flex items-center gap-2 text-sm">
                    <span className="text-zinc-500 text-xs flex-1 truncate">
                      {d.filename}
                    </span>
                    <span className="font-medium text-zinc-100">
                      {d.result!.invoiceNo}
                    </span>
                  </div>
                ))}
              <div className="space-y-1 pt-1">
                {drafts
                  .filter((d) => d.result?.attachError)
                  .map((d) => (
                    <div
                      key={d.id}
                      className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-300"
                    >
                      {d.filename}: PDF not attached — {d.result!.attachError}{" "}
                      Use &quot;Regenerate&quot; on the invoice row later to attach it.
                    </div>
                  ))}
              </div>
            </div>
            {(() => {
              // Combined renumber report — deduplicated, most recent shift per
              // invoice (later saves supersede earlier ones in the same batch).
              const byNew = new Map<string, RenumberChange>();
              for (const d of drafts) {
                for (const r of d.result?.renumbered || []) {
                  byNew.set(r.invoiceNo, r);
                }
              }
              const list = [...byNew.values()];
              if (list.length === 0)
                return (
                  <p className="text-xs text-zinc-500">
                    No other invoice numbers changed.
                  </p>
                );
              return (
                <div className="text-xs text-zinc-400 space-y-1">
                  <div className="text-zinc-300 font-medium">
                    {list.length} invoice
                    {list.length === 1 ? "" : "s"} renumbered to keep date order:
                  </div>
                  {list.map((r) => (
                    <div key={r.invoiceNo} className="flex gap-2">
                      <span className="text-zinc-500 w-24 shrink-0">
                        {r.invoiceDate}
                      </span>
                      <span className="text-zinc-500 flex-1 truncate">
                        {r.customerName}
                      </span>
                      <span>
                        {r.oldNo ? `${r.oldNo} → ` : ""}
                        <span className="text-zinc-200 font-medium">
                          {r.invoiceNo}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        )}

        {stage === "confirm" && drafts.some((d) => !d.parseError && !d.result) && (
          <div className="flex justify-end pt-1">
            <Button size="sm" onClick={saveAll} disabled={savingAll || parsing}>
              {savingAll ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : null}
              Save {drafts.filter((d) => !d.result && !d.parseError).length}{" "}
              invoice{drafts.filter((d) => !d.result && !d.parseError).length === 1 ? "" : "s"}
            </Button>
          </div>
        )}
        {stage === "done" && (
          <div className="flex justify-end pt-1">
            <Button
              size="sm"
              variant="outline"
              className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 bg-transparent"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}