// Pure helpers for sequential GST invoice numbering (UN/2026-27/00001).
import { seller } from "./config";

// Indian financial year for a Date: Apr 1 – Mar 31, formatted "2026-27".
export function financialYear(date: Date = new Date()): string {
  const y = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? y : y - 1; // month 3 = April
  const endShort = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endShort}`;
}

export function formatInvoiceNo(fy: string, counter: number): string {
  return `${seller.invoicePrefix}/${fy}/${String(counter).padStart(5, "0")}`;
}

// Extract the trailing sequence number from an invoice no (e.g. 1 from UN/2026-27/00001).
export function parseSequence(invoiceNo: string): number {
  const m = invoiceNo.match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}
