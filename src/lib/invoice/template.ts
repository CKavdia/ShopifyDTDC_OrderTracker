// Invoice HTML shell + CSS, inlined as strings so the server never depends on
// reading template files from disk at runtime.

export const CSS = `
:root {
  --color1: #2b2b2b;
  --color2: #6b6b6b;
  --color3: #d9d2c9;
  --accent: #7a4a2b;
  --accent-soft: #f4efe9;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; color: var(--color1);
  font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif;
  font-size: 12px; line-height: 1.5;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.page { position: relative; padding: 24px; max-width: 800px; margin: 0 auto; }
p { margin: 0; font-weight: 300; }
.muted { color: var(--color2); }
.b { font-weight: 700; }
.text-end { text-align: right; }
.text-center { text-align: center; }
.section-header { border-bottom: 2px solid var(--color1); padding-bottom: 16px; margin-bottom: 16px; }
.header-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.header-col { flex: 1 1 0; min-width: 0; }
.header-col.center { text-align: center; }
.header-col.right { text-align: right; }
.logo-img { max-width: 140px; max-height: 80px; }
.title-type { font-family: 'Poppins', 'Inter', sans-serif; font-size: 22px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: var(--accent); }
.invoice-no-box { display: inline-block; border: 1px solid var(--color1); padding: 6px 12px; margin-top: 8px; font-weight: 600; font-size: 13px; }
.seller-name { font-family: 'Poppins', 'Inter', sans-serif; font-size: 16px; font-weight: 700; color: var(--accent); margin-bottom: 2px; }
.parties { display: flex; gap: 16px; margin-bottom: 16px; }
.party-col { flex: 1 1 0; min-width: 0; border: 1px solid var(--color3); padding: 10px 12px; }
.section-title { font-family: 'Poppins', 'Inter', sans-serif; font-size: 12px; font-weight: 700; color: var(--accent); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.4px; }
.items { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
.items thead th { border-bottom: 1.5px solid var(--color1); padding: 6px 6px; font-weight: 700; font-size: 11px; vertical-align: bottom; }
.items tbody td { border-bottom: 1px solid var(--color3); padding: 8px 6px; vertical-align: top; }
.items .num { text-align: right; white-space: nowrap; }
.items .ctr { text-align: center; white-space: nowrap; }
.items .prod-name { font-weight: 700; }
.items .prod-sub { font-size: 10.5px; color: var(--color2); }
.footer-row { display: flex; gap: 16px; align-items: flex-start; }
.footer-left { flex: 1 1 0; min-width: 0; }
.footer-right { width: 46%; }
.totals { width: 100%; border-collapse: collapse; }
.totals td { padding: 4px 6px; }
.totals .label { text-align: left; }
.totals .val { text-align: right; white-space: nowrap; }
.totals tr.rule td { border-top: 1px solid var(--color3); }
.totals tr.grand td { border-top: 1.5px solid var(--color1); border-bottom: 1.5px solid var(--color1); background: var(--accent-soft); font-weight: 700; font-size: 13px; }
.words { margin-top: 8px; padding: 8px 0; border-top: 1px dashed var(--color3); font-weight: 600; }
.notes-title { font-weight: 700; margin-bottom: 2px; }
.declaration { font-size: 10.5px; color: var(--color2); margin-top: 12px; }
.terms { font-size: 10.5px; color: var(--color2); margin-top: 6px; }
.terms li { margin-bottom: 2px; }
.signature { margin-top: 28px; text-align: right; }
.signature-img { max-height: 70px; max-width: 180px; display: inline-block; }
.signature-caption { margin-top: 4px; font-weight: 600; }
.watermark { position: absolute; top: 45%; left: 50%; transform: translate(-50%, -50%) rotate(-15deg); border: 3px solid rgba(220, 40, 40, 0.35); color: rgba(220, 40, 40, 0.35); font-size: 46px; font-weight: 800; letter-spacing: 4px; padding: 6px 22px; border-radius: 6px; pointer-events: none; }
@media print { @page { size: A4; margin: 0; } }
`;

export const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>{{TITLE}}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Poppins:wght@600;700&display=swap" rel="stylesheet" />
  <style>{{CSS}}</style>
</head>
<body>
  <div class="page">
    {{WATERMARK}}
    {{BODY}}
  </div>
</body>
</html>`;
