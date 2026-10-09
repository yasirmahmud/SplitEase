export type ReceiptImportItem = {
  external_item_id: string;
  name: string;
  quantity: number;
  line_total_cents: number;
  state: 'charged' | 'refunded' | 'not_charged';
};

export type ReceiptImport = {
  schema_version: 1;
  external_receipt_id: string;
  receipt_type: 'grocery' | 'grocery_delivery' | 'restaurant' | 'retail' | 'other';
  merchant: string;
  purchased_on: string;
  currency: 'USD';
  items: ReceiptImportItem[];
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  tip_cents: number;
  delivery_cents: number;
  order_refund_cents: number;
  total_cents: number;
};

export type ImportValidation = { ok: true; receipt: ReceiptImport } | { ok: false; code: string; path: string; message: string };

const receiptFields = ['schema_version', 'external_receipt_id', 'receipt_type', 'merchant', 'purchased_on', 'currency', 'items', 'subtotal_cents', 'discount_cents', 'tax_cents', 'tip_cents', 'delivery_cents', 'order_refund_cents', 'total_cents'];
const itemFields = ['external_item_id', 'name', 'quantity', 'line_total_cents', 'state'];
const centsFields = ['subtotal_cents', 'discount_cents', 'tax_cents', 'tip_cents', 'delivery_cents', 'order_refund_cents', 'total_cents'] as const;

function fail(code: string, path: string, message: string): ImportValidation { return { ok: false, code, path, message }; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactFields(value: Record<string, unknown>, fields: string[], path: string): ImportValidation | null {
  for (const field of fields) if (!(field in value)) return fail('MISSING_FIELD', `${path}.${field}`, `${field} is required`);
  for (const field of Object.keys(value)) if (!fields.includes(field)) return fail('UNKNOWN_FIELD', `${path}.${field}`, `${field} is not allowed`);
  return null;
}
function stringField(value: unknown, max: number): value is string { return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max; }
function cents(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

export function validateReceiptImport(input: unknown): ImportValidation {
  if (!record(input)) return fail('INVALID_BODY', '$', 'Body must be a JSON object');
  const fieldError = exactFields(input, receiptFields, '$');
  if (fieldError) return fieldError;
  if (input.schema_version !== 1) return fail('UNSUPPORTED_VERSION', '$.schema_version', 'schema_version must be 1');
  if (!stringField(input.external_receipt_id, 128)) return fail('INVALID_FIELD', '$.external_receipt_id', 'Provide a nonempty ID of at most 128 characters');
  if (!['grocery', 'grocery_delivery', 'restaurant', 'retail', 'other'].includes(String(input.receipt_type))) return fail('INVALID_FIELD', '$.receipt_type', 'Unsupported receipt type');
  if (!stringField(input.merchant, 120)) return fail('INVALID_FIELD', '$.merchant', 'Provide a merchant name of at most 120 characters');
  if (typeof input.purchased_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.purchased_on) || Number.isNaN(Date.parse(`${input.purchased_on}T00:00:00Z`)) || new Date(`${input.purchased_on}T00:00:00Z`).toISOString().slice(0, 10) !== input.purchased_on) return fail('INVALID_FIELD', '$.purchased_on', 'Use a real date in YYYY-MM-DD format');
  if (input.currency !== 'USD') return fail('UNSUPPORTED_CURRENCY', '$.currency', 'Only USD is supported in v1');
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 300) return fail('INVALID_ITEMS', '$.items', 'Provide 1 to 300 items');
  const ids = new Set<string>();
  let subtotal = 0;
  let itemRefunds = 0;
  for (const [index, value] of input.items.entries()) {
    const path = `$.items[${index}]`;
    if (!record(value)) return fail('INVALID_ITEM', path, 'Item must be an object');
    const itemError = exactFields(value, itemFields, path);
    if (itemError) return itemError;
    if (!stringField(value.external_item_id, 128)) return fail('INVALID_FIELD', `${path}.external_item_id`, 'Provide an item ID of at most 128 characters');
    if (ids.has(value.external_item_id)) return fail('DUPLICATE_ITEM_ID', `${path}.external_item_id`, 'Item IDs must be unique');
    ids.add(value.external_item_id);
    if (!stringField(value.name, 200)) return fail('INVALID_FIELD', `${path}.name`, 'Provide an item name of at most 200 characters');
    if (typeof value.quantity !== 'number' || !Number.isFinite(value.quantity) || value.quantity <= 0 || value.quantity > 1000000 || Math.abs(value.quantity * 1000 - Math.round(value.quantity * 1000)) > 1e-7) return fail('INVALID_FIELD', `${path}.quantity`, 'Quantity must be positive with at most three decimal places');
    if (!cents(value.line_total_cents)) return fail('INVALID_FIELD', `${path}.line_total_cents`, 'Line total must be nonnegative integer cents');
    if (!['charged', 'refunded', 'not_charged'].includes(String(value.state))) return fail('INVALID_FIELD', `${path}.state`, 'Unsupported item state');
    if (value.state !== 'not_charged') subtotal += value.line_total_cents;
    if (value.state === 'refunded') itemRefunds += value.line_total_cents;
  }
  for (const field of centsFields) if (!cents(input[field])) return fail('INVALID_FIELD', `$.${field}`, `${field} must be nonnegative integer cents`);
  if (!Number.isSafeInteger(subtotal) || subtotal !== input.subtotal_cents) return fail('SUBTOTAL_MISMATCH', '$.subtotal_cents', 'Subtotal must equal charged and refunded item line totals');
  const total = subtotal - (input.discount_cents as number) + (input.tax_cents as number) + (input.tip_cents as number) + (input.delivery_cents as number) - (input.order_refund_cents as number) - itemRefunds;
  if (!Number.isSafeInteger(total) || total < 0 || total !== input.total_cents) return fail('TOTAL_MISMATCH', '$.total_cents', 'Total does not reconcile');
  return { ok: true, receipt: input as ReceiptImport };
}
