# 🛍 Mini App storefront — setup guide

This folder is a Telegram **Mini App**: a small web page that shows your products
as a **2-column logo grid grouped by category**. Tapping a product opens your bot
and jumps straight to that product's buy flow.

It reads products live from your Google Sheet (the **Products** tab, published as
CSV) — so it always matches your catalog. It never touches Inventory, so no
account credentials are ever exposed.

---

## One-time setup (about 15 minutes)

### 1. Publish the Products tab as CSV
In Google Sheets: **File ▸ Share ▸ Publish to web** → choose the **Products**
sheet, format **Comma-separated values (.csv)** → **Publish**. Copy the link.

### 2. Add logos (optional but nice)
- Put square logo images in `webapp/logos/` (e.g. `netflix.png`).
- In the Products sheet, write each filename in the **Logo** column (M).
- No logo? The grid falls back to the product's **Icon** emoji (column K).
- (Run `node migrate-sheet.mjs` once if the Logo column doesn't exist yet.)

### 3. Fill in the two config values
Open `webapp/index.html` and set, near the top:
```js
const BOT_USERNAME  = "YOUR_BOT_USERNAME";           // without @
const SHEET_CSV_URL = "YOUR_PUBLISHED_PRODUCTS_CSV_URL";
```

### 4. Deploy the `webapp/` folder (free hosting)
Any static host works. Easiest options:
- **Netlify Drop** — drag the `webapp` folder onto https://app.netlify.com/drop
- **Vercel** — `npm i -g vercel`, then run `vercel` inside `webapp/`
- **GitHub Pages** — push `webapp/` to a repo and enable Pages

You'll get an HTTPS URL like `https://your-app.netlify.app`.

### 5. Point the Shop button at it
From the project root:
```bash
WEBAPP_URL="https://your-app.netlify.app" node set-menu-button.mjs
```
This sets the bot's blue **🛍 Shop** button (next to the message box) to open the
Mini App. (You can also do it in @BotFather → Bot Settings ▸ Menu Button.)

---

## How the handoff works
Tapping a product in the Mini App opens `t.me/<bot>?start=p_<ProductID>`, which
launches the bot at that product — the existing variant / Buy-now / payment flow
takes over. Nothing about your payment or delivery logic changes.

## Updating
Add/edit products in the sheet as usual — the Mini App reflects changes on its
next open (Google's published CSV can cache for a few minutes). Redeploy the
`webapp/` folder only when you change logos or `index.html`.
