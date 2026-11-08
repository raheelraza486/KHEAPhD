import { InvoiceMappingError } from "./invoice-mapping.ts";
import { bounded } from "../workspace/execution.ts";

export type PdfTextItem = { text: string; x: number; y: number; page: number };
export type AbnEvidence = { value: string; page: number; labelled: boolean };

/** ABR's modulus-89 check. This checks the number, not its current registration or ownership. */
export function validAbn(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  return [...value].reduce((sum, digit, index) => sum + (Number(digit) - (index === 0 ? 1 : 0)) * weights[index], 0) % 89 === 0;
}

/** Read locally; neither the original document nor its text is sent to another service. */
export async function readPdfText(bytes: Uint8Array, parent?: AbortSignal): Promise<PdfTextItem[]> {
  if (bytes.length < 64) return [];
  const signal = AbortSignal.any([AbortSignal.timeout(5_000), ...(parent ? [parent] : [])]);
  const read = async () => {
    const { getDocumentProxy } = await import("unpdf");
    signal.throwIfAborted();
    // PDF.js may transfer its input buffer, so keep the original upload intact.
    const pdf = await getDocumentProxy(new Uint8Array(bytes), {
      useSystemFonts: true, disableFontFace: true, maxImageSize: 1, verbosity: 0,
    });
    try {
      if (pdf.numPages > 10) return [];
      const items: PdfTextItem[] = [];
      let characters = 0;
      for (let page = 1; page <= pdf.numPages; page++) {
        signal.throwIfAborted();
        const content = await (await pdf.getPage(page)).getTextContent();
        for (const item of content.items) {
          if (!("str" in item) || !item.str.trim()) continue;
          characters += item.str.length;
          if (characters > 200_000 || items.length >= 4_000) return [];
          items.push({ text: item.str, x: item.transform[4], y: item.transform[5], page });
        }
      }
      return items;
    } finally {
      await pdf.loadingTask.destroy();
    }
  };
  try { return await bounded(read(), signal); }
  catch (error) { if (parent?.aborted) throw error; return []; }
}

const nameKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Associate a number with the seller's block, never just the first 11 digits on the page. */
export function sellerAbns(items: readonly PdfTextItem[], seller: string, buyer: string): AbnEvidence[] {
  const vendor = nameKey(seller), customer = nameKey(buyer);
  if (vendor.length < 8 || vendor === customer) return [];
  const anchors = (name: string) => name.length < 8 ? [] : items.filter(item => nameKey(item.text).includes(name));
  const vendors = anchors(vendor), buyers = anchors(customer);
  const distance = (item: PdfTextItem, anchor: PdfTextItem) => item.page === anchor.page
    && Math.abs(item.x - anchor.x) <= 48 && anchor.y >= item.y - 2 && anchor.y - item.y <= 160
    ? anchor.y - item.y + Math.abs(item.x - anchor.x) : Infinity;
  const found = new Map<string, AbnEvidence>();
  for (const item of items) {
    // A label and its value may be separate PDF text items on the same line.
    const line = items.filter(other => other.page === item.page && Math.abs(other.y - item.y) <= 2
      && other.x >= item.x - 1 && other.x - item.x < 220).sort((a, b) => a.x - b.x).map(other => other.text).join(" ");
    const labelled = /\b(?:AU\s*[:.]\s*)?ABN\s*[:.#-]?\s*(\d(?:[ \u00a0]*\d){10})(?![ \u00a0]*\d)/i.exec(line);
    const plain = item.text.replace(/[ \u00a0]/g, "");
    const value = labelled ? labelled[1].replace(/\s/g, "") : /^\d{11}$/.test(plain) ? plain : null;
    if (!value || !validAbn(value)) continue;
    const sellerDistance = Math.min(...vendors.map(anchor => distance(item, anchor)));
    const buyerDistance = Math.min(...buyers.map(anchor => distance(item, anchor)));
    if (!Number.isFinite(sellerDistance) || buyerDistance <= sellerDistance) continue;
    if (!found.has(value) || labelled) found.set(value, { value, page: item.page, labelled: !!labelled });
  }
  return [...found.values()];
}

export class SellerAbnReviewError extends InvoiceMappingError {
  readonly suggestion?: AbnEvidence;
  constructor(message: string, suggestion?: AbnEvidence) {
    super("invalid_extraction", message);
    this.suggestion = suggestion;
  }
}

export function resolveSellerAbn(evidence: readonly AbnEvidence[], extracted: string | null, entered: string | undefined): { abn: string | null; note?: string } {
  const values = new Set(evidence.map(item => item.value));
  if (values.size > 1) throw new SellerAbnReviewError("Several possible seller ABNs were found in the PDF. Review the seller's details before continuing.");
  const local = evidence[0];
  const provider = extracted && validAbn(extracted) ? extracted : null;
  if (entered && !validAbn(entered)) throw new SellerAbnReviewError("The seller ABN fails its check-digit validation. Check the number on the invoice.");
  if ((local && provider && local.value !== provider) || (local && entered && local.value !== entered) || (provider && entered && provider !== entered)) {
    throw new SellerAbnReviewError("The seller ABN differs between the PDF, extraction or entered value. Review the source before continuing.");
  }
  if (entered) return { abn: entered };
  if (provider) return { abn: provider };
  if (local?.labelled) return { abn: local.value, note: `The seller's ABN (${local.value}) was read from the labelled seller block on PDF page ${local.page} and passed its check-digit validation.` };
  if (local) throw new SellerAbnReviewError(`A possible seller ABN (${local.value}) was found on PDF page ${local.page}, but it was not labelled ABN. Confirm it before continuing.`, local);
  return { abn: null };
}
