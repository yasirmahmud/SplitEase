import fs from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseReceiptText } from '../lib/receipt.ts';

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

if (parsed.items.length !== 7) throw new Error(`Expected 7 items, found ${parsed.items.length}`);
if (Math.abs(chargedSubtotal - 42.22) > 0.001) throw new Error(`Expected $42.22 subtotal, found $${chargedSubtotal.toFixed(2)}`);
if (Math.abs(total - 42.73) > 0.001) throw new Error(`Expected $42.73 total, found $${total.toFixed(2)}`);

console.log(`Verified ${parsed.items.length} items, $${chargedSubtotal.toFixed(2)} subtotal, $${total.toFixed(2)} total.`);
