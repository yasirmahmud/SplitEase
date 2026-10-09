export type ParsedReceiptItem = {
  id: string;
  name: string;
  quantity: number;
  price: number;
  assignedTo: string[];
  excluded?: boolean;
};

export function updateReceiptLinePrice<T extends ParsedReceiptItem>(items: T[], itemId: string, lineTotal: number, receiptSubtotal?: number) {
  const item = items.find((entry) => entry.id === itemId);
  if (!item || item.quantity <= 0 || !Number.isFinite(lineTotal) || lineTotal < 0) return { items, receiptSubtotal };
  const roundedTotal = Math.round(lineTotal * 100) / 100;
  const difference = item.excluded ? 0 : roundedTotal - item.price * item.quantity;
  return {
    items: items.map((entry) => entry.id === itemId ? { ...entry, price: roundedTotal / entry.quantity } : entry),
    receiptSubtotal: receiptSubtotal === undefined ? undefined : Math.round((receiptSubtotal + difference) * 100) / 100,
  };
}

function slugId(value: string, index: number) {
  return `${value.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 25)}-${index}`;
}

function cleanItemName(value: string) {
  return value
    .replace(/\s+(?:(?:\d+\s+)?(?:shopped|substituted|weight adjusted)|Unavailable|Cancel(?:l)?ed|Return complete|You(?:'|’)re all set!.*)$/i, '')
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
      .replace(/(?:(?:\d+\s+)?weight adjusted|Unavailable|Cancel(?:l)?ed|\d+ shopped|Return complete|You(?:'|’)re all set!.*)$/i, '')
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
      items.push({ id: slugId(name, items.length), name, quantity, price: lineTotal / quantity, assignedTo: [], excluded: /Unavailable|Cancel(?:l)?ed|Return complete/i.test(joined) });
    }
    buffer = [];
  }

  const matchedValue = (pattern: RegExp) => {
    const match = text.match(pattern)?.[1];
    return match === undefined ? undefined : Number(match.replace(',', '.'));
  };
  const value = (pattern: RegExp) => matchedValue(pattern) ?? 0;
  const deliveryMatch = text.match(/(?:delivery|shipping)[^\n$]*\$(\d+[.,]\d{2})(?:\s+\$?(\d+[.,]?\d{0,2}))?/i);
  const refund = [...text.matchAll(/(?:^|\n)\s*Refund\s+-?\$(\d+[.,]\d{2})/gim)]
    .reduce((sum, match) => sum + Number(match[1].replace(',', '.')), 0);
  return {
    items,
    adjustments: {
      savings: value(/Savings\s+-?\$(\d+[.,]\d{2})/i),
      tax: value(/Taxes?\s+\$(\d+[.,]\d{2})/i),
      tip: value(/(?:Driver\s+)?tip\s+\$(\d+[.,]\d{2})/i),
      delivery: Number((deliveryMatch?.[2] || deliveryMatch?.[1] || '0').replace(',', '.')),
      refund,
    },
    merchant: /Walmart/i.test(text) ? 'Walmart' : 'Imported receipt',
    date: text.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}/i)?.[0],
    subtotal: matchedValue(/Subtotal[^\n$]*\$(\d+[.,]\d{2})/i),
    total: matchedValue(/(?:^|\n)\s*Total\s+\$(\d+[.,]\d{2})/im),
  };
}

export function receiptFingerprint(receipt: Pick<ReturnType<typeof parseReceiptText>, 'merchant' | 'date' | 'items'> & {
  adjustments: Omit<ReturnType<typeof parseReceiptText>['adjustments'], 'refund'> & { refund?: number };
}) {
  const canonical = [
    receipt.merchant.toLowerCase().replace(/[^a-z0-9]/g, ''),
    receipt.date?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'no-date',
    ...receipt.items.map((item) => [
      item.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      item.quantity,
      Math.round(item.price * 100),
      item.excluded ? 1 : 0,
    ].join(':')),
    ...(['savings', 'tax', 'tip', 'delivery'] as const).map((key) => Math.round(receipt.adjustments[key] * 100)),
    ...(receipt.adjustments.refund ? [`refund:${Math.round(receipt.adjustments.refund * 100)}`] : []),
  ].join('|');

  // This only flags likely duplicates; it is not used as a security boundary.
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `receipt-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
