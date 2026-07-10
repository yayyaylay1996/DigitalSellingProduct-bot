# 🛒 Going Forward Digital Shop Bot
## 🇲🇲 အကျဉ်းချုပ် (Myanmar summary)

ဒါက digital subscription (Netflix, Capcut, ChatGPT, VPN စတာတွေ) ပြန်လည်ရောင်းချရေးအတွက် Telegram bot တစ်ခုပါ။ ဝယ်သူက product ရွေး → ဈေးနဲ့ stock ကြည့် → Buy now → ငွေလွှဲ screenshot ပို့ → admin (ကျွန်တော်) က Verify လုပ် → bot က account ကို အလိုအလျောက် ပို့ပေးပါတယ်။ Data အားလုံးကို Google Sheets ထဲမှာ သိမ်းထားလို့ server မလိုပါဘူး။ **Claude Code** နဲ့ MCP + Skill + Agent သုံးပြီး တည်ဆောက်ထားပါတယ်။


A Telegram bot that runs a real digital-subscription reselling business — customers browse products, pay, get admin-verified, and receive their accounts automatically. Built with **Claude Code**, backed by **Google Sheets** (no server, no database).

> ch-5 personal project · vibecode.tours · cohort-1 · by [@yayyaylay1996](https://github.com/yayyaylay1996)
> 🔗 Live repo: https://github.com/yayyaylay1996/DigitalSellingProduct-bot

---

## ✨ Features

- **Persistent menu** — a bottom keyboard: 🛍 Discover Products · 🎉 Promotions · 📞 Contact Admin · 📜 Order History · 🏠 Main Menu
- **Two-step product menu** — pick a product, then a duration / option (e.g. 1 Month, 3 Months, Share / Private)
- **Live stock counts** — calculated in real time from the Inventory sheet, not a hardcoded number
- **Promotions** — flag products on sale; the bot lists them and shows the discount (~~old~~ new price)
- **Full payment flow** — bank details → customer sends payslip → admin verifies with one tap
- **Tap-to-copy account number** — the payment number is monospace, so customers copy it with one tap
- **Two product types** — `auto` (delivered instantly from stock) and `manual` (handed off to the admin)
- **Per-product tips** — delivery includes tips pulled from the Tips tab (per product, with a type fallback)
- **Order history** — customers can view their own past orders
- **Admin broadcast** — `/announce` messages all past customers about new products
- **Google Sheets backend** — products, inventory, orders, tips, and settings all live in one sheet

---

## 🧱 How it works

```
Customer                    Bot                      Admin
   │                         │                          │
   ├─ Browse products ──────▶│                          │
   │◀─ Duration + price ─────┤                          │
   ├─ Buy now ──────────────▶│                          │
   │◀─ Payment details ──────┤                          │
   ├─ Send payslip photo ───▶├─ Forward payslip ───────▶│
   │                         │◀──── Verified / No ──────┤
   │◀─ Delivered / Contact ──┤                          │
```

On **Verify**, the path depends on the product type:
- **auto** → the bot sends the account credentials instantly (+ tips) and marks the inventory row sold.
- **manual** → the admin gets a "to set up" card (Product, Duration, option, verified time); the customer gets a button that opens the admin's Telegram chat directly to finish activation.

---

## 🗂️ Data model (Google Sheets)

| Tab | Purpose |
|-----|---------|
| **Products** | Catalog — see column list below |
| **Inventory** | Real accounts I own — one row each, linked by Product ID. Stock = count of `Available` rows |
| **Orders** | Recorded **only when the admin taps Verified** — cancelled / rejected / abandoned orders are never written |
| **Tips** | Delivery reminders — `Key` (`Name \| Variant`, Product Name, or Type) and `Tips` text |
| **FAQ** | Per-product Q&A buttons — `Key` (Product Name), `Question`, `Answer`, `Image` (optional filename) |
| **Settings** | Bank info + admin contact, editable without touching code |

**Products columns:**

| Col | Header | Notes |
|-----|--------|-------|
| A | Product ID | Unique join key (never reuse) |
| B | Product Name | Groups variants under one menu button |
| C | Variant | Option label, e.g. `Share Acc`, `Private` |
| D | Type | `auto` or `manual` (old `ready` / `email` still accepted) |
| E | Price (MMK) | Regular price |
| F | Description | Shown on the detail card |
| G | Active | `No` hides the row |
| H | Promo | `Yes` lists it under 🎉 Promotions |
| I | Promo Price | Optional discounted price (blank = featured at normal price) |
| J | Duration | Shown next to the price, e.g. `1 Month` |
| K | Icon | Emoji shown before the name in the menu, e.g. `🎬` |
| L | Category | Menu section heading, e.g. `Entertainment` |

**Menu:** Discover Products groups items under **Category** headings, two per row, each prefixed with its **Icon**. Real photo-logo grids need a Mini App (a hosted web page) — a separate follow-up.

**Tips lookup (most specific first):** `Product Name | Variant` → `Product Name` → `Type` (`auto`/`manual`). Tips auto-send only for `auto` products, so you can give Share vs Private variants different reminders.

**FAQ:** a product can have several FAQ rows (several ❓ buttons). If a row has an `Image` filename, the bot sends that photo from `faq-images/` as the answer; otherwise it sends the `Answer` text.

**Out of stock (`auto`):** the detail card shows a "stock out — buy from admin" notice with a direct-to-admin button, and the admin gets a restock alert the moment the last unit sells.

**Order recording:** from "Buy now" the order is held in memory only; a row is written to the Orders tab **the moment you tap Verified** (so the sheet contains verified sales only). If you tap No Verify or the customer cancels/abandons, nothing is recorded. (Trade-off: a bot restart between Buy and Verify loses that in-flight order.)

**Canva:** the `Canva` product runs a guided flow after Verify — customer sends their Gmail → invite request goes to admin → admin taps **Added** → customer confirms **OK** → final join instructions with an expiry date (delivery day + 1 year).

Products and Inventory are joined by a unique **Product ID** — renaming a product never breaks past orders.

---

## 🎛️ Bot commands & menu

| Action | What it does |
|--------|--------------|
| `/start` | Shows the welcome + persistent menu and the product list |
| 🛍 Discover Products / 🏠 Main Menu | Opens the product list |
| 🎉 Promotions | Lists products flagged `Promo = Yes` with their discount |
| 📞 Contact Admin | Shows the admin phone / Telegram from Settings |
| 📜 Order History | Lists the customer's last 10 orders |
| `/announce <message>` | **Admin only.** Broadcasts the message (with a Discover Products button) to all past buyers, throttled, skipping anyone who blocked the bot. No message = a default new-arrivals note |

---

## 🤖 Built with Claude Code

This project uses an MCP, a Skill, and an Agent:

| Component | File | Role |
|-----------|------|------|
| **MCP** | `.mcp.json` | Google Sheets MCP — lets Claude Code read the live sheet during development |
| **Skill** | `.claude/skills/product-handler/SKILL.md` | Menu formatting, variant grouping, live stock logic |
| **Agent** | `.claude/agents/order-processor.md` | The order pipeline: verify → deliver → mark sold → log |

**ch-5 additions:**

- [`ai-tools.md`](ai-tools.md) — every AI tool used on this project and how it fires
- [`slides/tech-stack.md`](slides/tech-stack.md) — tech-stack deck (stack, agents, skills, methodology, trigger, commands)
- [`interview.md`](interview.md) — user-interview template/notes (ch-5 feedback)

---

## 🚀 Setup

```bash
# 1. Install dependencies
npm install

# 2. Create a .env file with your secrets
TELEGRAM_BOT_TOKEN=your_bot_token
GOOGLE_SHEET_ID=your_sheet_id

# 3. Add your Google service-account key as google-credentials.json
#    (share your sheet with the service-account email as Editor)

# 4. One-time: add the new sheet columns/tabs (Promo, Promo Price, Duration,
#    Icon, Category, Tips, FAQ) and the faq-images/ folder
node migrate-sheet.mjs

# 4b. Put your FAQ images in faq-images/ (e.g. capcut-logout.png)

# 5. Run the bot
npm start
```

> 🔒 `.env` and `google-credentials.json` are git-ignored and never committed.

**`migrate-sheet.mjs`** is safe to re-run — it only adds the `Promo`, `Promo Price`,
and `Duration` headers to Products and creates the `Tips` tab if missing. It never
edits or deletes existing product data.

---

## 🛠️ Tech stack

- **Node.js** + `node-telegram-bot-api`
- **Google Sheets API** (`googleapis`) as the database
- **Claude Code** for development (MCP + Skill + Agent)

---

## 🛍 Mini App storefront

A 2-column **logo grid grouped by category** lives in `webapp/` — a Telegram Mini
App the blue **Shop** button opens. It reads products live from the published
Products CSV and hands taps back to the bot's buy flow. Setup steps are in
[`webapp/README.md`](webapp/README.md) (publish the sheet as CSV, add logos,
deploy the folder to free hosting, run `node set-menu-button.mjs`).

## 📈 What's next

- Auto-detect new products for `/announce` (currently triggered manually)
- Subscriber list so broadcasts also reach browsers, not only past buyers
- Persist in-flight state (payslip / Canva flow) so a restart doesn't lose it

---

*A real business, fully working. ⭐ Stars welcome!*
