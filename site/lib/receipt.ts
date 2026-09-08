export type ParsedReceiptItem = {
  id: string;
  name: string;
  quantity: number;
  price: number;
  assignedTo: string[];
  excluded?: boolean;
};

function slugId(value: string, index: number) {
  return `${value.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 25)}-${index}`;
}

function cleanItemName(value: string) {
  return value
    .replace(/\s+(?:(?:\d+\s+)?(?:shopped|substituted)|Unavailable|Return complete|You(?:'|’)re all set!.*)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseReceiptText(raw: string) {
  const text = raw.replace(/\uFFFD/g, '').replace(/\r/g, '\n');
  const lines = text.split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const items: ParsedReceiptItem[] = [];
  let buffer: string[] = [];
  let inItems = false;

  for (const line of lines) {
    if (/^Subtotal\b/i.test(line)) break;
    const hasPrice = /\bQty\s+\d+\s+\$\d+[.,]\d{2}\b/i.test(line);
    if (!inItems && !hasPrice) continue;
    if (hasPrice) inItems = true;
    if (!hasPrice) {
      buffer.push(line);
      continue;
    }
    const beforeQty = line.split(/\bQty\b/i)[0]
      .replace(/(?:Unavailable|\d+ shopped|Return complete|You(?:'|’)re all set!.*)$/i, '')
      .trim();
    const meaningfulBeforeQty = beforeQty.replace(/^(?:\d+\s*)?(?:shopped|substituted|unavailable|return complete)$/i, '').trim();
    const joined = meaningfulBeforeQty.length > 4 ? line : [...buffer, line].join(' ');
    const match = joined.match(/^(.*?)\s+Qty\s+(\d+)\s+\$(\d+[.,]\d{2})(?:\s|$)/i);
    if (!match) continue;
    const name = cleanItemName(match[1]);
    const isStatusOnly = /^(?:\d+\s*)?(?:shopped|substituted|unavailable|return complete)$/i.test(name);
    if (name.length > 2 && !isStatusOnly) {
      const quantity = Number(match[2]);
      const lineTotal = Number(match[3].replace(',', '.'));
      items.push({ id: slugId(name, items.length), name, quantity, price: lineTotal / quantity, assignedTo: [], excluded: /Unavailable/i.test(joined) });
    }
    buffer = [];
  }

  const value = (pattern: RegExp) => Number(text.match(pattern)?.[1]?.replace(',', '.') || 0);
  const deliveryMatch = text.match(/(?:delivery|shipping)[^\n$]*\$(\d+[.,]\d{2})(?:\s+\$?(\d+[.,]?\d{0,2}))?/i);
  return {
    items,
    adjustments: {
      savings: value(/Savings\s+-?\$(\d+[.,]\d{2})/i),
      tax: value(/Tax\s+\$(\d+[.,]\d{2})/i),
      tip: value(/(?:Driver\s+)?tip\s+\$(\d+[.,]\d{2})/i),
      delivery: Number((deliveryMatch?.[2] || deliveryMatch?.[1] || '0').replace(',', '.')),
    },
    merchant: /Walmart/i.test(text) ? 'Walmart' : 'Imported receipt',
    date: text.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}/i)?.[0],
  };
}

export function receiptFingerprint(receipt: ReturnType<typeof parseReceiptText>) {
  const canonical = [
    receipt.merchant.toLowerCase().replace(/[^a-z0-9]/g, ''),
    receipt.date?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'no-date',
    ...receipt.items.map((item) => [
      item.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      item.quantity,
      Math.round(item.price * 100),
      item.excluded ? 1 : 0,
    ].join(':')),
    ...Object.values(receipt.adjustments).map((value) => Math.round(value * 100)),
  ].join('|');

  // This only flags likely duplicates; it is not used as a security boundary.
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `receipt-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
