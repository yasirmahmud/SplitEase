import fs from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseReceiptText, receiptFingerprint } from '../lib/receipt.ts';
import { decodeSharedSplit, encodeSharedSplit } from '../lib/share-state.ts';

const source = new URL('../../example_wallmart_receipt/Order details - Walmart.com.pdf', import.meta.url);
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

const parsed = parseReceiptText(pages.join('\n'));
const chargedSubtotal = parsed.items.filter((item) => !item.excluded).reduce((sum, item) => sum + item.price * item.quantity, 0);
const total = chargedSubtotal - parsed.adjustments.savings + parsed.adjustments.tax + parsed.adjustments.tip + parsed.adjustments.delivery;

if (parsed.items.length !== 10) throw new Error(`Expected 10 items, found ${parsed.items.length}: ${parsed.items.map((item) => item.name).join(' | ')}`);
if (Math.abs(chargedSubtotal - 92.14) > 0.001) throw new Error(`Expected $92.14 subtotal, found $${chargedSubtotal.toFixed(2)}`);
if (Math.abs(total - 87.55) > 0.001) throw new Error(`Expected $87.55 total, found $${total.toFixed(2)}`);
const hapiName = 'Hapi Snacks Wasabi Peas, Hot, Shelf-Stable, Gluten-Free, 9.9 oz';
if (!parsed.items.some((item) => item.name === hapiName)) throw new Error(`Expected full Hapi item name, found: ${parsed.items.map((item) => item.name).join(' | ')}`);
if (parsed.items.some((item) => /^(?:\d+\s*)?(?:shopped|substituted)$/i.test(item.name))) throw new Error('A shopping status was parsed as an item name');
const firstFingerprint = receiptFingerprint(parsed);
const secondFingerprint = receiptFingerprint(parseReceiptText(pages.join('\n')));
if (firstFingerprint !== secondFingerprint) throw new Error('The same receipt did not produce the same duplicate-detection fingerprint');
const changedFingerprint = receiptFingerprint({ ...parsed, adjustments: { ...parsed.adjustments, tax: parsed.adjustments.tax + 0.01 } });
if (firstFingerprint === changedFingerprint) throw new Error('A changed receipt produced the same duplicate-detection fingerprint');

const shared = {
  version: 1,
  receiptName: 'Walmart · Aug 25, 2026',
  people: [{ id: 'maya', name: 'Maya', color: '#ff7f66' }],
  items: parsed.items.map((item) => ({ ...item, assignedTo: ['maya'] })),
  adjustments: parsed.adjustments,
};
const restored = decodeSharedSplit(encodeSharedSplit(shared));
if (!restored || restored.items.length !== 10 || restored.people[0]?.name !== 'Maya') throw new Error('Shared split did not round-trip');

console.log(`Verified ${parsed.items.length} items, $${chargedSubtotal.toFixed(2)} subtotal, $${total.toFixed(2)} total, and shared-state links.`);
