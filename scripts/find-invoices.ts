import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "fs";

async function main() {
  const m = await import("../src/lib/data");
  const ledger = await m.data.listInvoices();
  const lines = ledger
    .map((i) => [i.invoiceNo, i.shopifyOrderId, i.invoiceDate, i.grandTotal, i.customerName].join(" | "))
    .join("\n");
  writeFileSync("ledger-dump.txt", lines, "utf8");
  console.log("done rows", ledger.length);
}
main().catch((e) => {
  writeFileSync("ledger-err.txt", String(e), "utf8");
  console.log("failed");
});
