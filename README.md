# SplitEase

SplitEase is a receipt splitter for Walmart PDF and image receipts. Receipt parsing and OCR run in the browser; pressing **Save for everyone** publishes the parsed split details to Supabase so every visitor sees the same version and can acknowledge reviewing it. The original receipt file is never uploaded.

## Local development

```bash
cd site
npm install
npm run dev
```

## GitHub Pages

Push this repository to GitHub with `main` as the default branch, then open **Settings → Pages** and choose **GitHub Actions** as the source. The included workflow builds and deploys the site automatically.

The original example receipt remains in `example_wallmart_receipt/` and is not published with the site.
