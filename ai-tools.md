# AI Tools Used — Going Forward Digital Shop Bot

A short list of the AI tools used to build and ship this project (ch-5).

| Tool | What I used it for |
|------|---------------------|
| **Claude Code** | Primary dev tool for the whole bot — writing/refactoring `index.js` and `sheets.js`, designing the Google Sheets data model, and debugging the buy → payslip → verify → deliver flow. Fired through a project-specific **Skill** and **Subagent** (see below), plus an **MCP** server for live Google Sheets access. |
| **Google Sheets MCP** (`.mcp.json`) | Let Claude Code read the live spreadsheet (Products/Inventory/Orders/Settings) while coding, instead of guessing at column names. |
| **Skill** — `.claude/skills/product-handler/SKILL.md` | Encodes the menu/variant-grouping/live-stock rules so Claude applies them consistently every time the catalog or stock logic changes. |
| **Subagent** — `.claude/agents/order-processor.md` | Owns the order pipeline (create order → payslip → admin verify → deliver → mark sold) as a repeatable, reviewable spec Claude follows when touching order logic. |
| **ChatGPT** | Brainstorming product copy, Burmese/English wording for customer-facing messages, and sanity-checking edge cases in the payment flow. |
| **Canva** | Designed the product logo grid used in the Mini App storefront (`webapp/`) and the FAQ images in `faq-images/`. |

## How they fire

- `claude` (Claude Code CLI) is run directly in the project repo; the MCP server auto-loads from `.mcp.json`.
- The Skill and Subagent are picked up automatically by Claude Code from `.claude/skills/` and `.claude/agents/` — no manual invocation needed, they trigger whenever the relevant work (catalog/stock vs. order lifecycle) comes up.
- ChatGPT and Canva were used standalone in the browser, outside the repo, for content and design assets.
