---
marp: true
paginate: true
theme: default
---

<!--
ch-5 Tech-Stack Deck — Going Forward Digital Shop Bot
yayyaylay1996 · vibecode.tours · cohort-1
-->

<!-- Slide 1 -->
# Tech-Stack Deck
## Going Forward Digital Shop Bot

ch-5 personal project · **yayyaylay1996** · vibecode.tours · cohort-1

Repo: https://github.com/yayyaylay1996/DigitalSellingProduct-bot

---

<!-- Slide 2 -->
## 🧱 Stack

- **Runtime:** Node.js (`type: module`), `node-telegram-bot-api`
- **Database:** Google Sheets (`googleapis`) — no server, no separate DB
- **Storefront:** Telegram Mini App (`webapp/`), static logo grid, reads a
  published Products CSV
- **Dev tool:** Claude Code (MCP + Skill + Agent, see below)
- **Deploy:** long-running Node process (`npm start`); Mini App hosted as
  static files

---

<!-- Slide 3 -->
## 🤖 Agents

**Subagent:** `.claude/agents/order-processor.md`

Owns the full order lifecycle end to end:

```
browse -> buy now -> payslip photo -> admin verify -> deliver -> mark sold
```

Keeps every step ID-joined (Product ID / Order ID) instead of matching by
display name, so renaming a product never breaks past orders.

---

<!-- Slide 4 -->
## 🧩 Skills

**Skill:** `.claude/skills/product-handler/SKILL.md`

Encodes the catalog rules Claude applies whenever menu/stock logic changes:

- Group variants under one product-name button
- Compute stock **live** from Inventory rows (`Status = Available`) — never
  a stored number
- `auto` vs `manual` delivery types behave differently after Verify

---

<!-- Slide 5 -->
## 🔁 Methodology

1. **Design the data model first** (Sheets tabs + join keys) before writing
   bot code
2. **Write the Skill/Agent as specs**, then have Claude Code implement
   against them — keeps behavior consistent across sessions
3. **MCP for ground truth** — Claude reads the live sheet instead of
   guessing column names
4. **Ship small, verify live** — test each flow (browse, buy, payslip,
   verify) against the real Telegram bot before moving on

---

<!-- Slide 6 -->
## ⚡ Trigger

- Skill and Subagent **auto-load** from `.claude/skills/` and
  `.claude/agents/` — no manual invocation
- Skill fires on catalog / menu / stock work
- Subagent fires on order-lifecycle work (buy → payslip → verify → deliver)
- MCP server (`.mcp.json`) auto-connects when Claude Code starts in this repo

---

<!-- Slide 7 -->
## 💻 Commands

```bash
npm install               # install dependencies
node migrate-sheet.mjs    # one-time: add new sheet columns/tabs (idempotent)
npm start                 # run the bot
node set-menu-button.mjs  # wire the Mini App Shop button
```

Claude Code: `claude` in the repo root — MCP, Skill, and Agent load
automatically.
