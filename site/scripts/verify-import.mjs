import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateReceiptImport } from '../supabase/functions/receipt-import/receipt-import-schema.ts';

const example = JSON.parse(readFileSync(new URL('../../docs/receipt-import.example.json', import.meta.url), 'utf8'));
assert.equal(validateReceiptImport(example).ok, true);

function rejects(change, code) {
  const receipt = structuredClone(example);
  change(receipt);
  const result = validateReceiptImport(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
}

rejects((receipt) => { receipt.total_cents += 1; }, 'TOTAL_MISMATCH');
rejects((receipt) => { receipt.subtotal_cents += 1; }, 'SUBTOTAL_MISMATCH');
rejects((receipt) => { receipt.items[1].state = 'not_charged'; }, 'SUBTOTAL_MISMATCH');
rejects((receipt) => { receipt.items[2].state = 'refunded'; }, 'SUBTOTAL_MISMATCH');
rejects((receipt) => { receipt.items[1].external_item_id = receipt.items[0].external_item_id; }, 'DUPLICATE_ITEM_ID');
rejects((receipt) => { receipt.items[0].line_total_cents = 1.5; }, 'INVALID_FIELD');
rejects((receipt) => { receipt.currency = 'EUR'; }, 'UNSUPPORTED_CURRENCY');
rejects((receipt) => { receipt.purchased_on = '2026-02-30'; }, 'INVALID_FIELD');
rejects((receipt) => { receipt.unexpected = true; }, 'UNKNOWN_FIELD');

console.log('Receipt import contract verified');
