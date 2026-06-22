---
marp: true
paginate: true
theme: default
auto-advance: 20
---

<!--
ch-3 Pecha Kucha — 6 slides, 20 seconds each, auto-advance.
Bilingual: Burmese first, English below, on each slide.
Present with auto-advance 20s per slide. Keep to 6 slides.
-->

<!-- Slide 1 -->
# Going Forward Digital Shop Bot

ကျွန်တော့်ရဲ့ digital subscription ရောင်းချရေး စီးပွားရေးကို လည်ပတ်ပေးတဲ့ Telegram bot

*A Telegram bot that runs my real digital-subscription reselling business*

**yayyaylay1996** · vibecode.tours · cohort-1

---

<!-- Slide 2 -->
## ပြဿနာ (The Problem)

🇲🇲 ကျွန်တော် Telegram ကနေ subscription တွေ ရောင်းပါတယ်။ Order တွေကို လက်နဲ့ spreadsheet ထဲ ရိုက်ထည့်နေရတယ်။ Stock live မရှိ၊ မှားယွင်းမှုလွယ်တယ်။ customer က ငွေလွှဲပီးတာနဲ့ ၀◌ယ်သူဆီက အကောင့်ပြန်ရဖို့ အချိန် စောင့်ရတယ် 

🇬🇧 I resell subscriptions over Telegram. Orders were tracked **by hand** — no live stock, lots of manual work, easy mistakes. **The bot makes it self-serve.**

---

<!-- Slide 3 -->
## ဘယ်လိုအလုပ်လုပ်လဲ (How It Works)

🇲🇲 ဝယ်သူ product ရွေး → Share/Private ရွေး → ဈေးနဲ့ stock ကြည့် → Buy now → ငွေလွှဲ screenshot ပို့ → admin verify → bot က account ပို့ပေး

🇬🇧 Browse → pick variant → see price + **live stock** → Buy now → send payslip → I tap **Verified** → bot **auto-delivers** the account

---

<!-- Slide 4 -->
## Data Model

🇲🇲 Google Sheets ကို backend အဖြစ်သုံးတယ် — server မလို။ **Products** (catalog), **Inventory** (account အစစ်), **Orders**, **Settings**။ Stock ကို `Available` row တွေ live တွက်တယ်။

🇬🇧 Google Sheets backend, no server. **Products** (catalog), **Inventory** (real accounts), **Orders**, **Settings**. Stock = live count of `Available` rows, joined by `Product ID`.

---

<!-- Slide 5 -->
## MCP · Skill · Agent

🇲🇲 **MCP (Google Sheets)** — Claude Code က live sheet ဖတ်နိုင်တယ်။ **Skill (product-handler)** — menu နဲ့ stock logic။ **Agent (order-processor)** — verify→deliver→mark-sold pipeline။

🇬🇧 **MCP** lets Claude Code read my live sheet. **Skill** handles menu + stock logic. **Agent** defines the verify→deliver→mark-sold pipeline. Built with Claude Code, tested end-to-end.

---

<!-- Slide 6 -->
## နောက်ဆက်တွဲ (What's Next)

🇲🇲 **Restock alerts** — stock 0 ရောက်ရင် သတိပေး။ **"My Orders"** — ဝယ်သူရဲ့ မှတ်တမ်းပြ။

🇬🇧 **Restock alerts** when stock hits zero. **"My Orders"** purchase history. A real business, fully working — thank you!

**github.com/yayyaylay1996/DigitalSellingProduct-bot**
