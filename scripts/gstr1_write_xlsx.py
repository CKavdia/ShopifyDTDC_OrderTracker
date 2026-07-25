"""Write the GSTR-1 HSN-wise summary to a formatted .xlsx.

Reads the two JSON files produced by scripts/gstr1-hsn-summary.ts and writes a
two-sheet workbook to the user's Downloads folder:
  - "HSN Summary"   : one row per (HSN, rate), columns in GSTR-1 hsn-sheet order.
  - "Invoice Detail": per-order/per-line audit trail.

Run:  python scripts/gstr1_write_xlsx.py
"""
import json
import os

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

SCRATCH = (
    r"C:\Users\anush\AppData\Local\Temp\claude"
    r"\C--Users-anush-OneDrive-Desktop-Builder-ShopifyOrderTracker"
    r"\25664144-33d4-46e8-86c7-a5dbad7161c6\scratchpad"
)
OUT_PATH = r"C:\Users\anush\Downloads\GSTR1 HSN Summary Apr-Jun 2026.xlsx"

with open(os.path.join(SCRATCH, "gstr1-summary.json"), encoding="utf-8") as f:
    summary = json.load(f)
with open(os.path.join(SCRATCH, "gstr1-detail.json"), encoding="utf-8") as f:
    detail = json.load(f)

meta = summary["meta"]
rows = summary["rows"]

MONEY = "#,##0.00"
QTY = "#,##0"

HEADER_FILL = PatternFill("solid", fgColor="1F3864")
HEADER_FONT = Font(bold=True, color="FFFFFF", size=11)
TOTAL_FILL = PatternFill("solid", fgColor="D9E1F2")
BOLD = Font(bold=True)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
LEFT = Alignment(horizontal="left", vertical="center")
thin = Side(style="thin", color="BFBFBF")
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)


def style_header(ws, ncols):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = CENTER
        cell.border = BORDER
    ws.row_dimensions[1].height = 34
    ws.freeze_panes = "A2"


def autosize(ws, widths):
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


wb = Workbook()

# ---- Sheet 1: HSN Summary ---------------------------------------------------
ws = wb.active
ws.title = "HSN Summary"

# Small title block above the table (rows are inserted so header lands on row 1
# of the data table; we instead put the table at row 1 for clean copy-paste and
# keep the title on a separate note further right is overkill — keep it simple).
COLS = [
    "HSN", "State (Place of Supply)", "UQC", "Total Quantity", "Total Value",
    "Rate", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount",
    "State/UT Tax Amount", "Cess Amount", "HSN Type",
]
ws.append(COLS)
style_header(ws, len(COLS))

# 1-indexed with State inserted at col 2: qty=4, value=5, rate=6, taxable=7,
# igst=8, cgst=9, sgst=10, cess=11.
QTY_COL = 4
RATE_COL = 6
num_cols = {5, 7, 8, 9, 10, 11}  # money columns

# Split goods from the COD/shipping service lines (SAC 9968) so COD sits on its
# own, separated by blank rows — never merged into the goods block.
goods = [r for r in rows if r.get("hsnType") != "Services"]
cod = [r for r in rows if r.get("hsnType") == "Services"]


def fnum(x):
    return float(x)


def data_row(r, hsn_label=None):
    return [
        hsn_label if hsn_label is not None else r["hsn"],
        r["state"], r["uqc"], fnum(r["totalQuantity"]), fnum(r["totalValue"]),
        fnum(r["rate"]), fnum(r["taxableValue"]), fnum(r["igst"]),
        fnum(r["cgst"]), fnum(r["sgst"]), fnum(r["cess"]), r["hsnType"],
    ]


def fmt_data(row):
    ws.cell(row=row, column=QTY_COL).number_format = QTY
    ws.cell(row=row, column=RATE_COL).number_format = "0"
    for c in num_cols:
        ws.cell(row=row, column=c).number_format = MONEY
    for c in range(1, len(COLS) + 1):
        ws.cell(row=row, column=c).border = BORDER


def subtotal(items):
    def s(k):
        return round(sum(float(i[k]) for i in items), 2)
    return {
        "qty": round(sum(float(i["totalQuantity"]) for i in items)),
        "totalValue": s("totalValue"), "taxableValue": s("taxableValue"),
        "igst": s("igst"), "cgst": s("cgst"), "sgst": s("sgst"),
    }


def total_row(label, t):
    ws.append([
        label, "", "", t["qty"], t["totalValue"], "", t["taxableValue"],
        t["igst"], t["cgst"], t["sgst"], 0.0, "",
    ])
    tr = ws.max_row
    for c in range(1, len(COLS) + 1):
        cell = ws.cell(row=tr, column=c)
        cell.font = BOLD
        cell.fill = TOTAL_FILL
        cell.border = BORDER
    ws.cell(row=tr, column=QTY_COL).number_format = QTY
    for c in num_cols:
        ws.cell(row=tr, column=c).number_format = MONEY


# --- Goods block (one row per HSN + rate + state), then its own subtotal.
for r in goods:
    ws.append(data_row(r))
    fmt_data(ws.max_row)
total_row("TOTAL - Goods", subtotal(goods))

# --- 2 blank rows, then the COD / shipping lines (SAC 9968) kept separate.
ws.append([])
ws.append([])
for r in cod:
    ws.append(data_row(r))
    fmt_data(ws.max_row)

# --- Overall total (goods + COD) for reconciliation with the return.
g = meta["grand"]
total_row("GRAND TOTAL (Goods + COD)", {
    "qty": round(float(g["qty"])), "totalValue": float(g["totalValue"]),
    "taxableValue": float(g["taxableValue"]), "igst": float(g["igst"]),
    "cgst": float(g["cgst"]), "sgst": float(g["sgst"]),
})

autosize(ws, [30, 24, 12, 13, 14, 7, 15, 18, 16, 17, 12, 10])

# ---- Sheet 2: Invoice Detail ------------------------------------------------
wsd = wb.create_sheet("Invoice Detail")
DCOLS = [
    "Order", "Order Date", "State (Place of Supply)", "HSN", "Product", "Qty",
    "Rate %", "Taxable Value", "CGST", "SGST", "IGST", "Line Total (incl. tax)",
]
wsd.append(DCOLS)
style_header(wsd, len(DCOLS))

for row in detail:
    wsd.append([
        row["order"], row["date"], row["state"], row["hsn"], row["product"],
        float(row["qty"]), float(row["rate"]), float(row["taxableValue"]),
        float(row["cgst"]), float(row["sgst"]), float(row["igst"]),
        float(row["lineTotal"]),
    ])

dlast = wsd.max_row
for r in range(2, dlast + 1):
    wsd.cell(row=r, column=6).number_format = QTY
    wsd.cell(row=r, column=7).number_format = "0"
    for c in (8, 9, 10, 11, 12):
        wsd.cell(row=r, column=c).number_format = MONEY

autosize(wsd, [10, 12, 24, 12, 60, 6, 7, 14, 11, 11, 11, 20])

base, ext = os.path.splitext(OUT_PATH)
candidates = [OUT_PATH] + [f"{base} (v{n}){ext}" for n in range(2, 50)]
for i, path in enumerate(candidates):
    try:
        wb.save(path)
        OUT_PATH = path
        if i:
            print("(a locked/open copy already exists — wrote a fresh version instead)")
        break
    except PermissionError:
        continue
else:
    raise SystemExit("All candidate filenames are locked. Close the open Excel files and re-run.")

# ---- Console recap ----------------------------------------------------------
print(f"Wrote {OUT_PATH}")
print(f"  Period          : {meta['start']} .. {meta['end']}")
print(f"  Orders          : {meta['ordersProcessed']}")
print(f"  HSN summary rows : {len(rows)}")
print(f"  Detail rows      : {len(detail)}")
print(f"  Grand total value: {g['totalValue']}  (taxable {g['taxableValue']}, "
      f"IGST {g['igst']}, CGST {g['cgst']}, SGST {g['sgst']})")
if meta.get("missingHsnCount"):
    print(f"  ⚠ {meta['missingHsnCount']} goods line(s) missing HSN metafield.")
