# 🎨 Real product logos on the bot's buttons

The menu used to show `🎬 Netflix` / `🤖 ChatGPT Plus`. It now shows the **actual
Netflix and ChatGPT logos**, rendered by Telegram itself — on buttons, in the
variant screen, and on every product detail card.

This works because of **Bot API 9.4** (9 February 2026):

> "Bots can now use custom emoji in outgoing messages if their owner has Telegram Premium."
> Keyboard and inline buttons gained support for background colors and custom emoji.

Before 9.4 this needed a Fragment username auction. Your Premium subscription
replaces that.

---

## ⚠️ The one requirement

The Telegram account that **owns this bot in @BotFather** must have an active
Telegram Premium subscription. Not the bot, not the customers — the owner
account. Customers do **not** need Premium; they see the logos either way.

If Premium lapses, nothing breaks: Telegram quietly falls back to the plain
emoji from the Products sheet's `Icon` column, exactly like before.

---

## 🚀 Setup (once, ~2 minutes)

```bash
# 1. Make sure ADMIN_CHAT_ID is set in .env — the sticker set needs an owner.
#    Message @userinfobot on Telegram if you don't know your numeric id.

# 2. Open a chat with your own bot from that account and send /start.
#    Telegram refuses to make a user the owner of a set otherwise.

# 3. Build the custom emoji set from the tiles in emoji-logos/
node make-emoji-set.mjs

# 4. Restart the bot
npm start
```

Step 3 finishes by sending you a **test message on Telegram**. Look at it:

- **Real logos** → done. Restart the bot and open 🛍 Discover Products.
- **Plain emoji (🎬 🤖 🧠)** → the owner account's Premium isn't active. The
  script and the bot both keep working; you just get the old look.

Telegram never returns an error for this, which is why the check is a message
you look at rather than something the script can assert on its own.

---

## 📁 What was added

| File | Role |
|------|------|
| `emoji-logos/` | Your 20 logos as 100×100 PNG tiles — the exact size Telegram requires for custom emoji. Opaque logos were rounded to an app-icon silhouette so they don't read as white squares in dark mode. |
| `make-emoji-set.mjs` | One-time setup. Uploads the tiles, creates the custom emoji set, reads back each `custom_emoji_id`, writes `logo-emoji.json`, sends the test message. Safe to re-run. |
| `logo-emoji.json` | The generated `logo name → custom_emoji_id` map. **Commit this** — the deployed bot on Railway reads it at startup. |

`index.js` changed in five places: a `LOGO_EMOJI` loader, the `logoEmojiId` /
`logoTag` / `productButton` helpers, and the three menus that now use them
(main menu, variant list, promotions) plus the detail-card title.

---

## ➕ Adding a logo later

1. Drop a **100×100 PNG** into `emoji-logos/`, named after the value in the
   Products sheet's `Logo` column (extension doesn't matter — `capcut.png` in
   the sheet matches `capcut.png` here, and `canva.jpeg` matches `canva.png`).
2. `node make-emoji-set.mjs` — it only uploads what's new.
3. Restart the bot.

A blank `Logo` cell still works: the bot slugs the product name and tries that,
which is how `Claude AI` finds `claude.png` and `Meitu (SVIP)` finds `meitu.png`.

If you ever need to rebuild the set from scratch:

```bash
node make-emoji-set.mjs --reset
```

---

## 🔧 How the matching works

```
Products sheet                     emoji-logos/          Rendered
──────────────                     ────────────          ────────
Logo column   "youtube-premium.jpeg"  → youtube-premium.png → ▶ real logo
Logo blank,  name "Claude AI"         → claude.png          → real logo
Logo blank,  name "Zoom Pro"          → zoom.png            → real logo
no match at all                       —                     → Icon column emoji
```

Buttons carry the logo on the API's `icon_custom_emoji_id` slot, so the label
text stays clean; message text uses `<tg-emoji emoji-id="…">🎬</tg-emoji>`,
where the emoji inside the tag is what old clients fall back to.
