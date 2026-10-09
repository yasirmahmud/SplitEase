import fs from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { calculateReceiptAmounts, parseReceiptText, receiptFingerprint, toggleItemRefund, updateReceiptLinePrice } from '../lib/receipt.ts';
import { decodeSharedSplit, encodeSharedSplit } from '../lib/share-state.ts';

const fixtures = [
  { file: 'Order details - Walmart.com.pdf', items: 16, subtotal: 71.92, tax: 1.91, total: 68.27, excluded: 0 },
  { file: 't1.pdf', items: 9, subtotal: 11.74, tax: 0.53, total: 12.27, excluded: 0 },
  { file: 't2.pdf', items: 20, subtotal: 87.22, tax: 0.45, total: 85.46, excluded: 1 },
  { file: 't3.pdf', items: 6, subtotal: 12.78, tax: 0, total: 12.78, excluded: 0 },
  { file: 'new_test_with_refund.pdf', items: 20, subtotal: 129.09, tax: 4.78, refund: 10.47, total: 123.33, excluded: 2 },
];

async function parsePdf(file) {
  const source = new URL(`../../example_wallmart_receipt/${file}`, import.meta.url);
  const pdf = await getDocument({ data: new Uint8Array(await fs.readFile(source)), disableWorker: true }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += `${item.str}${item.hasEOL ? '\n' : ' '}`;
    }
    pages.push(text);
  }

  return { parsed: parseReceiptText(pages.join('\n')), text: pages.join('\n') };
}

const results = [];
for (const fixture of fixtures) {
  const { parsed, text } = await parsePdf(fixture.file);
  const itemSubtotal = parsed.items.filter((item) => !item.excluded).reduce((sum, item) => sum + item.price * item.quantity, 0);
  const receiptSubtotal = parsed.subtotal ?? itemSubtotal;
  const total = receiptSubtotal - parsed.adjustments.savings + parsed.adjustments.tax + parsed.adjustments.tip + parsed.adjustments.delivery - parsed.adjustments.refund;
  const excluded = parsed.items.filter((item) => item.excluded).length;

  if (parsed.items.length !== fixture.items) throw new Error(`${fixture.file}: expected ${fixture.items} items, found ${parsed.items.length}`);
  if (Math.abs(receiptSubtotal - fixture.subtotal) > 0.001) throw new Error(`${fixture.file}: expected $${fixture.subtotal.toFixed(2)} subtotal, found $${receiptSubtotal.toFixed(2)}`);
  if (Math.abs(parsed.adjustments.tax - fixture.tax) > 0.001) throw new Error(`${fixture.file}: expected $${fixture.tax.toFixed(2)} tax, found $${parsed.adjustments.tax.toFixed(2)}`);
  if (Math.abs(parsed.adjustments.refund - (fixture.refund ?? 0)) > 0.001) throw new Error(`${fixture.file}: expected $${(fixture.refund ?? 0).toFixed(2)} refund, found $${parsed.adjustments.refund.toFixed(2)}`);
  if (Math.abs(total - fixture.total) > 0.001) throw new Error(`${fixture.file}: expected $${fixture.total.toFixed(2)} total, found $${total.toFixed(2)}`);
  if (Math.abs((parsed.total ?? 0) - fixture.total) > 0.001) throw new Error(`${fixture.file}: expected printed total $${fixture.total.toFixed(2)}, found $${parsed.total?.toFixed(2)}`);
  if (excluded !== fixture.excluded) throw new Error(`${fixture.file}: expected ${fixture.excluded} excluded items, found ${excluded}`);
  if (fixture.refund && !parsed.items.some((item) => item.excluded && /Mainstays.*Roasting Pan/i.test(item.name))) throw new Error(`${fixture.file}: returned item was not excluded`);
  if (parsed.items.some((item) => /(?:shopped|substituted|weight adjusted|cancel(?:l)?ed)$/i.test(item.name))) {
    throw new Error(`${fixture.file}: an item name retained shopping status text`);
  }

  results.push({ fixture, parsed, text });
}

const original = results[0];
const chargedItem = original.parsed.items.find((item) => !item.excluded && item.quantity > 1);
if (!chargedItem) throw new Error('Fixture needs a charged multi-quantity item for price editing');
const editedLineTotal = Math.round(chargedItem.price * chargedItem.quantity * 100) / 100 + 1;
const edited = updateReceiptLinePrice(original.parsed.items, chargedItem.id, editedLineTotal, original.parsed.subtotal);
if (Math.abs((edited.receiptSubtotal ?? 0) - (original.parsed.subtotal ?? 0) - 1) > 0.001) throw new Error('Editing a line price did not update the receipt subtotal');
if (Math.abs((edited.items.find((item) => item.id === chargedItem.id)?.price ?? 0) * chargedItem.quantity - editedLineTotal) > 0.001) throw new Error('Edited line price was not saved per unit');
const refundReceipt = results.find((result) => result.fixture.refund);
const excludedItem = refundReceipt?.parsed.items.find((item) => item.excluded);
if (!refundReceipt || !excludedItem) throw new Error('Fixture needs an excluded item for price editing');
const editedExcluded = updateReceiptLinePrice(refundReceipt.parsed.items, excludedItem.id, excludedItem.price * excludedItem.quantity + 1, refundReceipt.parsed.subtotal);
if (editedExcluded.receiptSubtotal !== refundReceipt.parsed.subtotal) throw new Error('Editing an excluded item changed the charged subtotal');
const originalAmounts = calculateReceiptAmounts(original.parsed.items, original.parsed.adjustments, original.parsed.subtotal);
const refundedItems = toggleItemRefund(original.parsed.items, chargedItem.id);
const refundedAmounts = calculateReceiptAmounts(refundedItems, original.parsed.adjustments, original.parsed.subtotal);
const refundAmount = chargedItem.price * chargedItem.quantity;
if (Math.abs(refundedAmounts.grandTotal - (originalAmounts.grandTotal - refundAmount)) > 0.001) throw new Error('Refunding an item did not lower the total by its line price');
if (refundedAmounts.chargedItems.some((item) => item.id === chargedItem.id)) throw new Error('A refunded item remained in the split');
const restoredAmounts = calculateReceiptAmounts(toggleItemRefund(refundedItems, chargedItem.id), original.parsed.adjustments, original.parsed.subtotal);
if (Math.abs(restoredAmounts.grandTotal - originalAmounts.grandTotal) > 0.001) throw new Error('Undoing an item refund did not restore the total');
const unprintedSubtotal = calculateReceiptAmounts(refundedItems, original.parsed.adjustments);
const originalUnprintedSubtotal = calculateReceiptAmounts(original.parsed.items, original.parsed.adjustments);
if (Math.abs(unprintedSubtotal.grandTotal - (originalUnprintedSubtotal.grandTotal - refundAmount)) > 0.001) throw new Error('Refunding without a printed subtotal was counted twice');
const repricedRefund = updateReceiptLinePrice(refundedItems, chargedItem.id, refundAmount + 1, original.parsed.subtotal);
const repricedRefundAmounts = calculateReceiptAmounts(repricedRefund.items, original.parsed.adjustments, repricedRefund.receiptSubtotal);
if (Math.abs(repricedRefundAmounts.grandTotal - refundedAmounts.grandTotal) > 0.001) throw new Error('Repricing a refunded item changed the amount owed');
if (toggleItemRefund(refundReceipt.parsed.items, excludedItem.id).some((item) => item.refunded)) throw new Error('An already excluded item gained a second refund');
const firstFingerprint = receiptFingerprint(original.parsed);
const secondFingerprint = receiptFingerprint(parseReceiptText(original.text));
if (firstFingerprint !== secondFingerprint) throw new Error('The same receipt did not produce the same duplicate-detection fingerprint');
const changedFingerprint = receiptFingerprint({ ...original.parsed, adjustments: { ...original.parsed.adjustments, tax: original.parsed.adjustments.tax + 0.01 } });
if (firstFingerprint === changedFingerprint) throw new Error('A changed receipt produced the same duplicate-detection fingerprint');
const refundedFingerprint = receiptFingerprint({ ...original.parsed, adjustments: { ...original.parsed.adjustments, refund: 1 } });
if (firstFingerprint === refundedFingerprint) throw new Error('A refund produced the same duplicate-detection fingerprint');

const shared = {
  version: 1,
  receiptName: 'Walmart · Sep 13, 2026',
  people: [{ id: 'maya', name: 'Maya', color: '#ff7f66' }],
  items: original.parsed.items.map((item) => ({ ...item, assignedTo: ['maya'] })),
  adjustments: original.parsed.adjustments,
};
const restored = decodeSharedSplit(encodeSharedSplit(shared));
if (!restored || restored.items.length !== original.fixture.items || restored.people[0]?.name !== 'Maya') throw new Error('Shared split did not round-trip');

console.log(`Verified ${fixtures.length} receipts with exact subtotals, taxes, totals, excluded items, and clean item names.`);
