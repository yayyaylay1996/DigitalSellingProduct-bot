# Staff slip-check bot

A separate Telegram bot for staff. Staff send a slip photo (caption = amount) and get the same
coloured verdict the admin sees in the shop bot. Under the verdict, the **approvers** get ✅ / ❌
buttons.

Reuses `slipcheck.js` as-is (same checks, same Anthropic key, same Slips sheet), so a slip
already used in the shop bot is flagged here too, and the other way round.

## Who can do what

| Person | Setting | Sends slips | Presses ✅ / ❌ |
|---|---|---|---|
| Staff | `STAFF_ALLOWED` | yes | no |
| Supervisor (approver) | `STAFF_APPROVERS` | no | yes |
| Admin | `ADMIN_CHAT_ID` (already set for the shop bot) | yes | yes |

**`ADMIN_CHAT_ID` must be ONE number** (your own ID). A list there matches nobody — not even you — and the
shop bot reads the same setting the same way. Put everyone else in `STAFF_ALLOWED` / `STAFF_APPROVERS`.

**Not sure of someone's ID, or why they can't press a button?** They send `/myid` to the staff bot (private
chat or the group). It replies with their Telegram ID and whether they may send slips and/or approve.

Use Telegram numeric IDs (they never change); @usernames also work. Someone listed in both
`STAFF_ALLOWED` and `STAFF_APPROVERS` can do both. An approver who isn't a sender is told they
can't send slips; their photos are never checked.

## What staff do

1. Open the staff bot (or the group) and send the slip photo. **Send as File** gives a clearer image (helps Wave).
2. In the caption type the amount the customer should pay, e.g. `95000` (Burmese digits work).
   No amount → the slip is still read, but amount match is not checked.
3. Read the reply: 🟢 all match · 🟡 check by eye · 🔴 problem, don't approve · ⚠️ couldn't read.
   Wave slips are always 🟡 — check them in the Wave app.

## Entering an order (`/order`)

For orders from TikTok / Viber / Telegram pages that staff enter themselves. Type `/order`, then tap:

1. **Source** (the Desk's Source list) → **payment method** (KPay, Wave …) → type the **customer**
   name / @username.
2. **Product** → **plan** (Access · Duration · list price from the Desk's `Prices` tab) → **amount**:
   the list price in one tap, or type it. A plan that isn't on the price list: "တခြား plan" →
   pick Access and Duration, then type the amount. Zoom-type products (Config "Needs Email") ask for
   the customer's email (can be skipped and added later).
3. **➕ Product ထပ်ထည့်** for the same payment — up to **10 products** on one slip.
4. **✅ ပြီးပြီ — slip ပို့မယ်**, then send the slip photo **once**. It is checked against the **basket
   total**. A mismatch is a warning the approver sees (🔴/🟡), never a hard stop.
5. An approver taps ✅ → the Order Desk gets **one row per product** (same customer, source, payment
   and slip), with Payment check = Done. ❌ writes nothing; staff can send a better slip into the same
   order, or `/cancel`.

The Desk's **Payment** column (U) holds `KPay · S-8F3K`: how it was paid + the basket reference. The
same reference is in the Slips sheet's "Ref" column, so a slip and its Desk rows can be matched.
Add the column once with `node desk-add-payment-column.mjs` (preview) then `--write`. Until then the
bot still works and just leaves the payment out.

Everything offered (products, sources, access, durations) comes from the Desk's `Config` tab (Active
rows only) and the `Prices` tab, spelled exactly as Config spells them. Prices for a product that
isn't an Active Config item are ignored. Staff in a private chat who can't press ✅/❌: the verdict is
sent to the approvers (they must have pressed /start in the bot once) and the result comes back.

Order drafts live in memory: a restart or ~3 hours idle drops them. Not yet handled: Supplier column
(left blank), Purchase Price (0), and the Desk's 14-day Zoom calendar reminder (see below).

## What approvers do

Open Bank/Wave and confirm the money arrived, then tap under the verdict:
- 🟢 **ပိုက်ဆံဝင်ပြီ — အတည်ပြု** or ❌ **မအတည်ပြု**
- 🟡 / ⚠️ **အတည်ပြု** or ❌ **မအတည်ပြု**
- 🔴 **မအတည်ပြု** first; approving needs **ဒါပေမဲ့ အတည်ပြု…** and then a confirming tap.

The decision is posted as a reply under the verdict ("✅ အတည်ပြုပြီး — @name · time") and the
buttons disappear, so the chat itself is the record. **It does not update the shop bot or the Order
Desk** — it is a record and a signal to the team, nothing more. The bot can't see the bank, so
"approved" means a person checked, not that the bot did.

Buttons appear in a group, and in a private chat with someone who is an approver. Non-approvers
who tap get "no permission". If two approvers tap at the same moment, the first counts.

## Private chat and group

Works in a private chat and in a group. In a private chat, people who can't use the bot get their
own Telegram ID so they can give it to the admin. In a group the bot stays silent for anyone who
can't send slips and for ordinary chat. A channel won't work: posts in a channel don't say who sent
them, so the bot can't tell staff from anyone else.

## One-time setup

1. **@BotFather** → `/newbot` → copy the token. (Don't paste it in chat or commit it.)
2. Get each person's numeric ID: they message **@userinfobot**.
3. Add to `.env` (local) and to Railway variables:
   ```
   STAFF_BOT_TOKEN=<new bot token>
   STAFF_ALLOWED=<staff ids>
   STAFF_APPROVERS=<supervisor ids>
   ```
   Everything else (`ANTHROPIC_API_KEY`, `SLIP_RECEIVERS`, Google sheet settings, `SLIP_THB_MMK_RATE`,
   `ADMIN_CHAT_ID`) is the same as the shop bot's.
4. **To use it in a group** (recommended): create a private group with the staff, the supervisor, the
   admin and the bot. In @BotFather: `/setprivacy` → pick the bot → **Disable** (otherwise the bot
   can't see photos in the group), then remove the bot from the group and add it again (the change
   only applies after that). Making the bot a group admin also works. Photos in an album: only the
   first carries the caption, so send one slip per message.
5. Try locally: `npm run start:staff`, then message the bot.
6. **Railway:** the shop bot runs `npm start`. Add a **second service** from the same repo with start
   command `npm run start:staff` and copy the shop bot's variables plus the three above. The repo is
   public — never commit tokens.

## Limits (same as the shop bot's checker)

- Wave photos in Burmese digits can be misread → always yellow, check in the Wave app.
- No received-money matching yet. Green means "the slip looks right", not "money is in".
- Approval of a plain photo-check is recorded in the chat only. Approval of an `/order` also writes the Order Desk rows.
- The Desk's Apps Script only creates the 14-day Zoom reminder for rows whose Seller is `Bot`. Staff-bot rows have the staff member as Seller, so they get no automatic reminder until `apps-script/BotSync.gs` is changed to also accept rows with a `· S-` reference in the Payment column.
- The in-memory duplicate guard is per process; across the two bots the Slips sheet is what
  catches reuse, so two copies of one slip sent within a second or two could both slip through.
- Pressed-button state is kept in memory: if the bot restarts, buttons already removed stay removed,
  but a decision half-made isn't remembered.
- Verdict detail text is still English; the headline, hints and footer are Burmese (Unicode).
- Each check costs a little Anthropic credit (estimated ~US$0.007, not measured).
