# 🛒 Going Forward Digital Shop Bot
## 🇲🇲 အကျဉ်းချုပ် (Myanmar summary)

ဒါက digital subscription (Netflix, Capcut, ChatGPT, VPN စတာတွေ) ပြန်လည်ရောင်းချရေးအတွက် Telegram bot တစ်ခုပါ။ ဝယ်သူက product ရွေး → ဈေးနဲ့ stock ကြည့် → Buy now → ငွေလွှဲ screenshot ပို့ → admin (ကျွန်တော်) က Verify လုပ် → bot က account ကို အလိုအလျောက် ပို့ပေးပါတယ်။ Data အားလုံးကို Google Sheets ထဲမှာ သိမ်းထားလို့ server မလိုပါဘူး။ **Claude Code** နဲ့ MCP + Skill + Agent သုံးပြီး တည်ဆောက်ထားပါတယ်။


A Telegram bot that runs a real digital-subscription reselling business — customers browse products, pay, get admin-verified, and receive their accounts automatically. Built with **Claude Code**, backed by **Google Sheets** (no server, no database).

> ch-3 personal project · vibecode.tours · cohort-1 · by [@yayyaylay1996](https://github.com/yayyaylay1996)

---

## ✨ Features

- **Two-step product menu** — pick a product, then a variant (Share / Private account)
- **Live stock counts** — calculated in real time from the Inventory sheet, not a hardcoded number
- **Full payment flow** — bank details → customer sends payslip → admin verifies with one tap
- **Admin verification** — payslip is forwarded to the admin with ✅ Verified / ❌ No Verify buttons
- **Automatic delivery** — on approval, ready-stock accounts are sent instantly and marked sold
- **Email products** — products needing the customer's own email are handed off to the admin
- **Google Sheets backend** — products, inventory, orders, and settings all live in one sheet

---

## 🧱 How it works

```
Customer                    Bot                      Admin
   │                         │                          │
   ├─ Browse products ──────▶│                          │
   │◀─ Variants + price ─────┤                          │
   ├─ Buy now ──────────────▶│                          │
   │◀─ Payment details ──────┤                          │
   ├─ Send payslip photo ───▶├─ Forward payslip ───────▶│
   │                         │◀──── Verified / No ──────┤
   │◀─ Account delivered ────┤                          │
```

---

## 🗂️ Data model (Google Sheets)

| Tab | Purpose |
|-----|---------|
| **Products** | Catalog — Product ID, Name, Variant, Type, Price, Description |
| **Inventory** | Real accounts I own — one row each, linked by Product ID. Stock = count of `Available` rows |
| **Orders** | Full lifecycle of every order — payment, verification, delivery, timestamps |
| **Settings** | Bank info + admin contact, editable without touching code |

Products and Inventory are joined by a unique **Product ID** — renaming a product never breaks past orders.

---

## 🤖 Built with Claude Code

This project uses an MCP, a Skill, and an Agent:

| Component | File | Role |
|-----------|------|------|
| **MCP** | `.mcp.json` | Google Sheets MCP — lets Claude Code read the live sheet during development |
| **Skill** | `.claude/skills/product-handler/SKILL.md` | Menu formatting, variant grouping, live stock logic |
| **Agent** | `.claude/agents/order-processor.md` | The order pipeline: verify → deliver → mark sold → log |

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

# 4. Run the bot
npm start
```

> 🔒 `.env` and `google-credentials.json` are git-ignored and never committed.

---

## 🛠️ Tech stack

- **Node.js** + `node-telegram-bot-api`
- **Google Sheets API** (`googleapis`) as the database
- **Claude Code** for development (MCP + Skill + Agent)

---

## 📈 What's next

- Restock alerts when a product's stock hits zero
- "My Orders" purchase history for returning customers

---

*A real business, fully working. ⭐ Stars welcome!*
