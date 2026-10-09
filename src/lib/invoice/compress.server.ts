// Shrink a PDF that exceeds Notion's per-file upload cap by recompressing the
// embedded photos. Text, vectors and the text layer are untouched, so the
// stamped PDF stays parseable and printable.
//
// Notion enforces the cap at the file-upload API (free workspaces: 5 MiB per
// file), so anything larger must be reduced before it can be attached. Only
// JPEG images (DCTDecode) are touched — they are the usual bulk in scanned or
// photo-heavy invoices — and each is downsampled and re-encoded at a quality
// that still reads fine on screen and paper.
import {
  PDFDocument,
  PDFRawStream,
  PDFName,
  PDFArray,
  PDFDict,
  PDFNumber,
} from "pdf-lib";
import sharp from "sharp";

// 5 MiB with a small margin for the copy the stamping step writes back.
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 - 64 * 1024;

// ASCII85 decode (the ASCII85Decode filter PDF uses, whitespace-tolerant).
function a85decode(s: string): Buffer {
  const cleaned = s.replace(/\s+/g, "").replace(/~>/, "");
  const out: number[] = [];
  let i = 0;
  while (i < cleaned.length) {
    if (cleaned[i] === "z") {
      out.push(0, 0, 0, 0);
      i++;
      continue;
    }
    const chunk = cleaned
      .slice(i, i + 5)
      .split("")
      .map((c) => c.charCodeAt(0) - 33);
    let v = 0;
    for (let k = 0; k < 5; k++) v = v * 85 + (chunk[k] ?? 84);
    const bytes = [
      (v >>> 24) & 255,
      (v >>> 16) & 255,
      (v >>> 8) & 255,
      v & 255,
    ];
    out.push(...bytes.slice(0, Math.max(Math.min(cleaned.length - i, 5) - 1, 0)));
    i += 5;
  }
  return Buffer.from(out);
}

// Progressively harsher passes until the file fits; text is never affected,
// so the worst case is soft photos.
const PASSES = [
  { maxSide: 2000, quality: 82 },
  { maxSide: 1600, quality: 72 },
  { maxSide: 1200, quality: 62 },
];

async function recompressImages(
  data: Buffer,
  maxSide: number,
  quality: number
): Promise<Buffer | null> {
  const doc = await PDFDocument.load(data, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const ctx = doc.context;
  let touched = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
    const f = dict.get(PDFName.of("Filter"));
    const filterStr = f instanceof PDFArray ? f.toString() : f?.toString() || "";
    if (!filterStr.includes("DCTDecode")) continue;
    // A soft mask (transparency) must keep the base image's geometry; skip
    // such images rather than produce a mismatched pair.
    if (dict.has(PDFName.of("SMask"))) continue;
    const jpeg =
      filterStr.includes("ASCII85")
        ? a85decode(Buffer.from(obj.contents).toString("latin1"))
        : Buffer.from(obj.contents);
    const w = (dict.get(PDFName.of("Width")) as PDFNumber).asNumber();
    const h = (dict.get(PDFName.of("Height")) as PDFNumber).asNumber();
    let img = sharp(jpeg, { failOn: "none" }).rotate();
    const meta = await img.metadata();
    if (Math.max(meta.width || 0, meta.height || 0) > maxSide)
      img = img.resize(maxSide, undefined, { fit: "inside" });
    const out = await img.jpeg({ quality }).toBuffer();
    if (out.length >= jpeg.length && w <= maxSide) continue;
    const om = await sharp(out).metadata();
    const nd = PDFDict.withContext(ctx);
    nd.set(PDFName.of("Type"), PDFName.of("XObject"));
    nd.set(PDFName.of("Subtype"), PDFName.of("Image"));
    nd.set(PDFName.of("Width"), PDFNumber.of(om.width || w));
    nd.set(PDFName.of("Height"), PDFNumber.of(om.height || h));
    nd.set(
      PDFName.of("ColorSpace"),
      PDFName.of((om.channels || 3) === 1 ? "DeviceGray" : "DeviceRGB")
    );
    nd.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
    nd.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
    nd.set(PDFName.of("Length"), PDFNumber.of(out.length));
    // Replacing the object at its own reference keeps every page/content
    // reference to it intact.
    ctx.assign(ref, PDFRawStream.of(nd, out));
    touched++;
  }
  if (touched === 0) return null;
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// Returns the buffer unchanged when it already fits; otherwise a recompressed
// copy. Throws when even the harshest pass cannot get under the cap.
export async function compressPdfForUpload(
  data: Buffer,
  limit: number = MAX_UPLOAD_BYTES
): Promise<Buffer> {
  if (data.length <= limit) return data;
  for (const { maxSide, quality } of PASSES) {
    const out = await recompressImages(data, maxSide, quality);
    if (out && out.length <= limit) return out;
  }
  throw new Error(
    `PDF is ${(data.length / 1024 / 1024).toFixed(2)} MiB and could not be compressed under the ${(limit / 1024 / 1024).toFixed(1)} MiB upload limit. Compress it manually (e.g. a "compress PDF" tool) and re-upload.`
  );
}
