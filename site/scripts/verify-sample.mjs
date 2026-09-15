import fs from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseReceiptText, receiptFingerprint } from '../lib/receipt.ts';
import { decodeSharedSplit, encodeSharedSplit } from '../lib/share-state.ts';

const fixtures = [
  { file: 'Order details - Walmart.com.pdf', items: 16, subtotal: 71.92, tax: 1.91, total: 68.27, excluded: 0 },
  { file: 't1.pdf', items: 9, subtotal: 11.74, tax: 0.53, total: 12.27, excluded: 0 },
  { file: 't2.pdf', items: 20, subtotal: 87.22, tax: 0.45, total: 85.46, excluded: 1 },
  { file: 't3.pdf', items: 6, subtotal: 12.78, tax: 0, total: 12.78, excluded: 0 },
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
  const total = receiptSubtotal - parsed.adjustments.savings + parsed.adjustments.tax + parsed.adjustments.tip + parsed.adjustments.delivery;
  const excluded = parsed.items.filter((item) => item.excluded).length;

  if (parsed.items.length !== fixture.items) throw new Error(`${fixture.file}: expected ${fixture.items} items, found ${parsed.items.length}`);
  if (Math.abs(receiptSubtotal - fixture.subtotal) > 0.001) throw new Error(`${fixture.file}: expected $${fixture.subtotal.toFixed(2)} subtotal, found $${receiptSubtotal.toFixed(2)}`);
  if (Math.abs(parsed.adjustments.tax - fixture.tax) > 0.001) throw new Error(`${fixture.file}: expected $${fixture.tax.toFixed(2)} tax, found $${parsed.adjustments.tax.toFixed(2)}`);
  if (Math.abs(total - fixture.total) > 0.001) throw new Error(`${fixture.file}: expected $${fixture.total.toFixed(2)} total, found $${total.toFixed(2)}`);
  if (Math.abs((parsed.total ?? 0) - fixture.total) > 0.001) throw new Error(`${fixture.file}: expected printed total $${fixture.total.toFixed(2)}, found $${parsed.total?.toFixed(2)}`);
  if (excluded !== fixture.excluded) throw new Error(`${fixture.file}: expected ${fixture.excluded} excluded items, found ${excluded}`);
  if (parsed.items.some((item) => /(?:shopped|substituted|weight adjusted|cancel(?:l)?ed)$/i.test(item.name))) {
    throw new Error(`${fixture.file}: an item name retained shopping status text`);
  }

  results.push({ fixture, parsed, text });
}

const original = results[0];
const firstFingerprint = receiptFingerprint(original.parsed);
const secondFingerprint = receiptFingerprint(parseReceiptText(original.text));
if (firstFingerprint !== secondFingerprint) throw new Error('The same receipt did not produce the same duplicate-detection fingerprint');
const changedFingerprint = receiptFingerprint({ ...original.parsed, adjustments: { ...original.parsed.adjustments, tax: original.parsed.adjustments.tax + 0.01 } });
if (firstFingerprint === changedFingerprint) throw new Error('A changed receipt produced the same duplicate-detection fingerprint');

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
