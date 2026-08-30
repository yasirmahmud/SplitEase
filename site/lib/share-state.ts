import type { ParsedReceiptItem } from './receipt';

export type SharedPerson = { id: string; name: string; color: string };
export type SharedAdjustments = { savings: number; tax: number; tip: number; delivery: number };
export type SharedSplit = {
  version: 1;
  receiptName: string;
  people: SharedPerson[];
  items: ParsedReceiptItem[];
  adjustments: SharedAdjustments;
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64ToBytes(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeSharedSplit(state: SharedSplit) {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(state)));
}

export function isSharedSplit(value: unknown): value is SharedSplit {
  if (!value || typeof value !== 'object') return false;
  const parsed = value as Partial<SharedSplit>;
  if (parsed.version !== 1 || typeof parsed.receiptName !== 'string') return false;
  if (!Array.isArray(parsed.people) || !Array.isArray(parsed.items)) return false;
  if (!parsed.adjustments || ['savings', 'tax', 'tip', 'delivery'].some((key) => typeof parsed.adjustments?.[key as keyof SharedAdjustments] !== 'number')) return false;
  if (parsed.people.some((person) => typeof person?.id !== 'string' || typeof person?.name !== 'string' || typeof person?.color !== 'string')) return false;
  if (parsed.items.some((item) => typeof item?.id !== 'string' || typeof item?.name !== 'string' || typeof item?.price !== 'number' || typeof item?.quantity !== 'number' || !Array.isArray(item?.assignedTo))) return false;
  return true;
}

export function decodeSharedSplit(value: string): SharedSplit | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64ToBytes(value)));
    return isSharedSplit(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
