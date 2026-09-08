# SplitEase

SplitEase is a receipt splitter for PDF and image receipts. Receipt parsing and OCR run in the browser, while parsed split details are automatically saved to Supabase. The app keeps a library of editable split sessions and detects duplicate receipt uploads before creating a new session. The original receipt file is never uploaded.

Supabase's free tier is sufficient for this app's small JSON records and autosave traffic. The included schema uses the existing single shared workspace row, so no schema migration is required when upgrading from the original one-session version.

## Local development

```bash
cd site
npm install
npm run dev
```

## GitHub Pages

Push this repository to GitHub with `main` as the default branch, then open **Settings → Pages** and choose **GitHub Actions** as the source. The included workflow builds and deploys the site automatically.

The original example receipt remains in `example_wallmart_receipt/` and is not published with the site.
