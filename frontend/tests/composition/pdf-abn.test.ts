import assert from "node:assert/strict";
import test from "node:test";
import { readPdfText, resolveSellerAbn, sellerAbns, validAbn, SellerAbnReviewError, type PdfTextItem } from "../../lib/composition/pdf-abn.ts";
import { textPdf } from "../helpers/text-pdf.ts";

const seller = "Harbour Test Supplier Pty Ltd", buyer = "Harbour Test Buyer Pty Ltd";
const item = (text: string, x: number, y: number): PdfTextItem => ({ text, x, y, page: 1 });
const parties = [item(seller, 40, 700), item(buyer, 320, 700)];
const evidence = [{ value: "47555222000", page: 1, labelled: true }];

test("ABN check digits reject typos and non-ABN values", () => {
  assert.ok(validAbn("47555222000"));
  for (const value of ["47555222001", "FR75412193567", "47 555 222 000", "", "123"]) assert.equal(validAbn(value), false);
});

test("local text extraction keeps positions and the original upload buffer intact", async () => {
  const bytes = textPdf([...parties, item("AU:ABN.47 555 222 000", 40, 650), item("ABN 80647710156", 320, 650)]);
  const original = bytes.slice();
  const text = await readPdfText(bytes);
  assert.deepEqual(bytes, original);
  assert.ok(text.some(line => line.text === seller && line.x === 40 && line.page === 1));
  assert.deepEqual(sellerAbns(text, seller, buyer), evidence);
});

test("a split ABN label is joined without accepting a buyer number or a 12-digit number", () => {
  const text = [...parties, item("ABN:", 40, 650), item("47 555 222 000", 78, 650), item("ABN 80647710156", 320, 650)];
  assert.deepEqual(sellerAbns(text, seller, buyer), evidence);
  assert.deepEqual(sellerAbns([...parties, item("ABN 47555222000 1", 40, 650)], seller, buyer), []);
  assert.deepEqual(sellerAbns(text, seller, seller), []);
});

test("an unlabelled seller number needs confirmation; a labelled ABN fills automatically", () => {
  assert.equal(resolveSellerAbn(evidence, null, undefined).abn, "47555222000");
  const unlabelled = sellerAbns([...parties, item("47555222000", 40, 650)], seller, buyer);
  assert.throws(() => resolveSellerAbn(unlabelled, null, undefined), error => error instanceof SellerAbnReviewError && error.suggestion?.value === "47555222000");
  assert.equal(resolveSellerAbn(unlabelled, null, "47555222000").abn, "47555222000");
});

test("conflicts, multiple candidates and a manual typo require review", () => {
  for (const [local, provider, manual] of [
    [evidence, "80647710156", undefined],
    [evidence, null, "80647710156"],
    [[], "47555222000", "80647710156"],
    [evidence, null, "47555222001"],
    [[...evidence, { value: "80647710156", page: 1, labelled: true }], null, undefined],
  ] as const) assert.throws(() => resolveSellerAbn(local, provider, manual), SellerAbnReviewError);
  assert.deepEqual(resolveSellerAbn([], null, undefined), { abn: null });
});

test("unreadable or text-free PDFs fall back and cancellation remains an abort", async () => {
  assert.deepEqual(await readPdfText(new TextEncoder().encode("%PDF-1.4 " + "bad ".repeat(30))), []);
  assert.deepEqual(await readPdfText(textPdf([])), []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readPdfText(textPdf(parties), controller.signal), (error: any) => error.status === 499);
});
