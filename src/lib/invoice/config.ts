// Seller / store configuration for the GST invoice.
//
// GSTIN is NOT stored in Shopify (verified against the live store), so it lives
// here. Fill in the TODO values before issuing real invoices.

export const seller = {
  legalName: "UrbanNaari",
  companyName: "",
  // TODO: real GSTIN. 15 chars; first 2 digits are the state code (08 = Rajasthan).
  gstin: "08XXXXXXXXXXXZX",
  address: {
    line1: "Reti Mohalla, PATTA NO 824",
    line2: "Near Temple Stair, MOHAN MARG",
    city: "Kankroli, Rajsamand",
    state: "Rajasthan",
    stateCode: "08",
    pincode: "313324",
    country: "India",
  },
  phone: "",
  email: "admin@urbannaari.co.in",
  website: "urbannaari.co.in",

  // Printed as "Company's PAN". Leave blank to derive it from the GSTIN, whose
  // characters 3-12 are the PAN (08FELPM3724K1Z1 -> FELPM3724K).
  pan: "",

  // Optional assets. Absolute paths, or paths relative to the project root.
  logoPath: "public/invoice-logo.png",
  signaturePath: "",

  invoicePrefix: "UN",

  terms: [
    "Goods once sold will only be exchanged/returned as per our return policy.",
    "This is a computer-generated invoice.",
  ],
  declaration:
    "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.",
};

// Fallback GST applied when Shopify recorded no tax line on a line item (e.g.
// "Charge tax" was off for that product). The line's tax-inclusive amount is
// treated as GST-inclusive and the tax is backed out at a rate that depends on
// the per-piece selling price: highRate when the piece price is ABOVE
// thresholdPerPiece, else lowRate. Confirm rates/threshold with your CA.
export const DEFAULT_GST = {
  thresholdPerPiece: 2500, // ₹ per piece
  lowRate: 5, // price ≤ threshold
  highRate: 18, // price > threshold
};

// GST rate (%) applied to the shipping / COD fee, treated as a GST-inclusive
// taxable service line. Confirm with your CA.
export const SHIPPING_GST_RATE = 18;

// The store's home state — decides intra-state (CGST+SGST) vs inter-state (IGST).
export const HOME_STATE_CODE = "RJ";
export const HOME_STATE_NAME = "Rajasthan";
export const HOME_STATE_GST_CODE = "08";

export const GST_STATE_CODES: Record<string, string> = {
  AN: "35", AP: "37", AR: "12", AS: "18", BR: "10", CH: "04", CT: "22",
  DN: "26", DD: "25", DL: "07", GA: "30", GJ: "24", HR: "06", HP: "02",
  JK: "01", JH: "20", KA: "29", KL: "32", LA: "38", LD: "31", MP: "23",
  MH: "27", MN: "14", ML: "17", MZ: "15", NL: "13", OR: "21", PY: "34",
  PB: "03", RJ: "08", SK: "11", TN: "33", TG: "36", TS: "36", TR: "16",
  UP: "09", UT: "05", UK: "05", WB: "19",
};

// Display names for the same codes. Shopify supplies the province name on its
// orders, but a manually-typed invoice only has the code, so the name has to
// come from here. TS/UK are duplicate codes for TG/UT and are deliberately
// omitted so a state dropdown built from this map has no repeated entries.
export const GST_STATE_NAMES: Record<string, string> = {
  AN: "Andaman and Nicobar Islands",
  AP: "Andhra Pradesh",
  AR: "Arunachal Pradesh",
  AS: "Assam",
  BR: "Bihar",
  CH: "Chandigarh",
  CT: "Chhattisgarh",
  DN: "Dadra and Nagar Haveli",
  DD: "Daman and Diu",
  DL: "Delhi",
  GA: "Goa",
  GJ: "Gujarat",
  HR: "Haryana",
  HP: "Himachal Pradesh",
  JK: "Jammu and Kashmir",
  JH: "Jharkhand",
  KA: "Karnataka",
  KL: "Kerala",
  LA: "Ladakh",
  LD: "Lakshadweep",
  MP: "Madhya Pradesh",
  MH: "Maharashtra",
  MN: "Manipur",
  ML: "Meghalaya",
  MZ: "Mizoram",
  NL: "Nagaland",
  OR: "Odisha",
  PY: "Puducherry",
  PB: "Punjab",
  RJ: "Rajasthan",
  SK: "Sikkim",
  TN: "Tamil Nadu",
  TG: "Telangana",
  TR: "Tripura",
  UP: "Uttar Pradesh",
  UT: "Uttarakhand",
  WB: "West Bengal",
};
