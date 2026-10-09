import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateReceiptImport } from './receipt-import-schema.ts';

const encoder = new TextEncoder();
const maxBodyBytes = 256 * 1024;

function json(value: unknown, status: number) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function error(status: number, code: string, message: string, path?: string) {
  return json({ error: { code, message, ...(path ? { path } : {}) } }, status);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}

async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function limitedBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBodyBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED', 'Use POST');
  const token = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') || '')?.[1];
  if (!token) return error(401, 'UNAUTHORIZED', 'A valid integration token is required');
  const idempotencyKey = request.headers.get('idempotency-key') || '';
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return error(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8 to 128 safe characters');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return error(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json');
  if (Number(request.headers.get('content-length') || '0') > maxBodyBytes) return error(413, 'BODY_TOO_LARGE', 'Receipt JSON exceeds 256 KiB');
  let bodyText: string | null;
  try { bodyText = await limitedBody(request); } catch { return error(400, 'INVALID_JSON', 'Body must be valid UTF-8 JSON'); }
  if (bodyText === null) return error(413, 'BODY_TOO_LARGE', 'Receipt JSON exceeds 256 KiB');
  let body: unknown;
  try { body = JSON.parse(bodyText); } catch { return error(400, 'INVALID_JSON', 'Body must be valid JSON'); }
  const result = validateReceiptImport(body);
  if (!result.ok) return error(422, result.code, result.message, result.path);

  const url = Deno.env.get('SUPABASE_URL');
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}') as Record<string, string>;
  const serviceKey = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return error(503, 'SERVICE_UNAVAILABLE', 'Import service is not configured');
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const tokenHash = await sha256(token);
  const integration = await db.from('receipt_import_integrations').select('id').eq('token_hash', tokenHash).eq('active', true).maybeSingle();
  if (integration.error) return error(503, 'SERVICE_UNAVAILABLE', 'Import service is unavailable');
  if (!integration.data) return error(401, 'UNAUTHORIZED', 'A valid integration token is required');
  const allowance = await db.rpc('allow_receipt_import', { integration: integration.data.id });
  if (allowance.error) return error(503, 'SERVICE_UNAVAILABLE', 'Import service is unavailable');
  if (!allowance.data) return error(429, 'RATE_LIMITED', 'Try again after this minute');

  const payloadHash = await sha256(canonical(result.receipt));
  const inserted = await db.from('receipt_submissions').insert({
    integration_id: integration.data.id,
    external_receipt_id: result.receipt.external_receipt_id,
    idempotency_key: idempotencyKey,
    payload_hash: payloadHash,
    payload: result.receipt,
  }).select('id,status').single();
  if (!inserted.error && inserted.data) return json({ import_id: inserted.data.id, status: inserted.data.status, duplicate: false }, 201);
  if (inserted.error?.code !== '23505') return error(503, 'SERVICE_UNAVAILABLE', 'Could not store receipt');

  const existing = await db.from('receipt_submissions').select('id,status,idempotency_key,payload_hash')
    .eq('integration_id', integration.data.id).eq('external_receipt_id', result.receipt.external_receipt_id).maybeSingle();
  if (existing.error) return error(503, 'SERVICE_UNAVAILABLE', 'Could not check existing receipt');
  if (existing.data?.idempotency_key === idempotencyKey && existing.data.payload_hash === payloadHash) {
    return json({ import_id: existing.data.id, status: existing.data.status, duplicate: true }, 200);
  }
  return error(409, 'RECEIPT_CONFLICT', 'Receipt ID or idempotency key was already used for another submission');
});
