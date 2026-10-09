# Receipt import API (v1)

External tools can read any receipt format (PDF, image, email, store export), normalize it, and submit **JSON**. SplitEase does not receive the original file through this API. The implementation is in `site/supabase/functions/receipt-import`, `site/supabase/receipt_import.sql`, and the website inbox. The endpoint becomes live after the database migration and Edge Function are deployed.

## Flow

1. Give each integration a revocable server-side token. The integration calls `POST https://pooobzllagsownfpmrpf.supabase.co/functions/v1/receipt-import` with `Authorization: Bearer <token>`, `Content-Type: application/json`, and `Idempotency-Key: <stable-unique-key>`.
2. A Supabase Edge Function authenticates the integration, checks the strict schema and money equation, and stores the submission in a new `receipt_submissions` table. It returns `201` and `status: "pending"`. A retry with the same key and identical payload returns the same import ID and its current status. A changed payload with the same key returns `409`.
3. The SplitEase site shows a **Pending receipts** inbox. A user previews and accepts a receipt; acceptance creates a new split session and marks the submission imported. A rejection keeps an audit record without changing a split. Duplicate detection also checks the existing session fingerprints.

The current GitHub Pages app is static, so the HTTP endpoint runs in Supabase. The existing `splitease_state` row is one shared workspace, and its anonymous policies allow public read and update. Pending submissions have the same public visibility as that workspace. Integration tokens and writes to the submissions table stay server-side. User sign-in and per-workspace policies would be needed for private receipts. Do not put an integration token or Supabase secret key in website JavaScript.

## Contract

The machine-readable contract is [receipt-import.openapi.yaml](receipt-import.openapi.yaml). The sample body is [receipt-import.example.json](receipt-import.example.json).

- `schema_version` is exactly `1`; unknown fields are rejected. New fields or different accounting rules require a new version.
- Currency is `USD` in v1 because the current UI formats every amount as USD. Each money value is an integer number of cents; no floating-point currency values.
- `quantity` is a positive number with up to three decimal places. `line_total_cents` is authoritative, including for weighted products. The site derives its current per-unit `price` as `line_total_cents / quantity / 100`.
- Each item has a unique `external_item_id` and one state: `charged`, `refunded`, or `not_charged`. A `refunded` item represents a **full line refund**. `not_charged` is excluded because it was unavailable, cancelled, or otherwise never billed; its listed price can remain positive. A partial item refund belongs in `order_refund_cents` until the site supports partial item refunds explicitly.
- `subtotal_cents` must equal the sum of line totals for `charged` and `refunded` items. `not_charged` items are excluded.
- `total_cents` must equal `subtotal_cents - discount_cents + tax_cents + tip_cents + delivery_cents - order_refund_cents - refunded item line totals`. This is exact, with no rounding tolerance because inputs are already cents. All amounts are nonnegative, and the result cannot be negative.
- `order_refund_cents` is for refunds **not represented by refunded items**. A full item refund must appear only in the item's state, preventing double subtraction.
- The first version accepts only the adjustment kinds the site can display today. A processor that cannot reconcile a receipt should flag it for manual review instead of inventing a line or hiding a fee in another category.

For the current app, accepting a submission maps `merchant` and `purchased_on` to the session title, item state `not_charged` to `excluded`, item state `refunded` to `refunded`, and `discount_cents` to `adjustments.savings`. `subtotal_cents` becomes `receiptSubtotal`; `total_cents` is used as a final reconciliation check. People assignments start empty or use the site's current default only after a user accepts the preview. The imported session stores the submission ID to prevent a second acceptance.

## Response and errors

Successful new submission:

```json
{"import_id":"a914ea83-22fd-4e51-a09f-96c319248db7","status":"pending","duplicate":false}
```

Expected statuses: `201` created, `200` identical retry, `400` malformed JSON or missing idempotency key, `401` invalid token, `409` idempotency conflict, `413` body too large, `422` schema or reconciliation failure, `429` rate limit. Errors use `{ "error": { "code": "TOTAL_MISMATCH", "message": "Total does not reconcile", "path": "$.total_cents" } }`; messages must not echo token or receipt contents.

## Deployment and integration setup

1. Run `site/supabase/schema.sql` if the shared workspace is not set up, then run `site/supabase/receipt_import.sql` in the Supabase SQL Editor.
2. From `site/`, deploy the function with `npx supabase functions deploy receipt-import --project-ref pooobzllagsownfpmrpf --no-verify-jwt` using a Supabase account authorized for that project. The function validates its own opaque bearer token. The Supabase runtime supplies `SUPABASE_URL` and a server-side secret key.
3. Generate a long random token for each integration, store only its SHA-256 hash in `receipt_import_integrations`, and give the token to the processor once. For example, generate 32 random bytes with a trusted password manager, then run `insert into public.receipt_import_integrations (name, token_hash) values ('Processor name', encode(digest('<token>', 'sha256'), 'hex'));` in SQL Editor. Remove the placeholder from any saved query history. To revoke access, set `active = false` for that integration.
4. Submit the sample body with a new idempotency key, refresh the site's **Pending receipts** inbox, review the items, and select **Import split**. A second identical request must return `200` with the same import ID.

The API rejects bodies over 256 KiB, over 300 items, duplicate item IDs, unknown fields, and unreconciled totals. Each integration is limited to 60 requests per minute. Unique database constraints make concurrent retries converge on one submission. Acceptance and marking imported happen in one database transaction. The site merges sessions after a cloud version conflict so a newly imported split is retained.

Example request (replace the token and idempotency key):

```bash
curl -X POST 'https://pooobzllagsownfpmrpf.supabase.co/functions/v1/receipt-import' \
  -H 'Authorization: Bearer YOUR_INTEGRATION_TOKEN' \
  -H 'Idempotency-Key: order-2026-10-09-1842' \
  -H 'Content-Type: application/json' \
  --data-binary @docs/receipt-import.example.json
```
