# SplitEase

SplitEase is a receipt splitter for PDF and image receipts. Receipt parsing and OCR run in the browser, while parsed split details are automatically saved to Supabase. The app keeps a library of editable split sessions and detects duplicate receipt uploads before creating a new session. The original receipt file is never uploaded.

Supabase's free tier is sufficient for this app's small JSON records and autosave traffic. The included schema uses the existing single shared workspace row, so no schema migration is required when upgrading from the original one-session version.

## Cloud sync setup

In the Supabase project dashboard, open **SQL Editor** and run [`site/supabase/schema.sql`](site/supabase/schema.sql). This creates the `splitease_state` row that autosave requires. A missing table causes SplitEase to keep edits on the device and retry cloud sync.

If using a different Supabase project, set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` when building the site. The configured publishable key must belong to the same project URL.

## Local development

```bash
cd site
npm install
npm run dev
```

## GitHub Pages

Push this repository to GitHub with `main` as the default branch, then open **Settings → Pages** and choose **GitHub Actions** as the source. The included workflow builds and deploys the site automatically.

The original example receipt remains in `example_wallmart_receipt/` and is not published with the site.

## Receipt import API

External processors can submit normalized receipt JSON through a Supabase Edge Function. The website shows submissions in a pending inbox, then imports an accepted receipt into a new split. See the [API contract and deployment steps](docs/receipt-import-api.md), [OpenAPI specification](docs/receipt-import.openapi.yaml), and [sample payload](docs/receipt-import.example.json). Deploy `site/supabase/receipt_import.sql` and the `receipt-import` Edge Function before using this feature.
