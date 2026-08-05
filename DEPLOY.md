# Deploying the bot so it runs 24/7

Your bot uses **polling**, not webhooks, so it needs a host that keeps a process
alive — not a web server. On Railway that is the default; on Render you must
choose **Background Worker**, because a free Web Service sleeps and kills the bot.

Total time: about 20 minutes, most of it waiting for the first build.

---

## Before you start

Collect these five values. Everything else follows from them.

| Value | Where to get it |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Already in your local `.env` |
| `ADMIN_CHAT_ID` | Message **@userinfobot** on Telegram — it replies with your numeric ID |
| `GOOGLE_SHEET_ID` | Already in your local `.env` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Already in your local `.env` |
| `GOOGLE_PRIVATE_KEY` | Already in your local `.env` — copy it **exactly**, including the quotes and the `\n` sequences |

---

## Step 1 — Push to GitHub

Your repo already points at `github.com/yayyaylay1996/DigitalSellingProduct-bot`.

```bash
git add .
git commit -m "prepare for cloud deployment"
git push
```

**Check the repo is Private** before pushing: GitHub → your repo → Settings →
scroll to bottom → "Change repository visibility". Your secrets are gitignored,
so nothing sensitive leaks either way, but private is the right default for a
shop.

---

## Step 2 — Create the service on Railway

1. Go to **railway.app** and sign in with GitHub.
2. **New Project** → **Deploy from GitHub repo**.
3. Pick `DigitalSellingProduct-bot`. Authorize Railway to see the repo if asked.
4. Railway detects Node and starts building. **It will fail or crash-loop on
   this first attempt** — that is expected, there are no variables yet.

---

## Step 3 — Add the variables

Open your service → **Variables** tab → **New Variable** for each one:

```
TELEGRAM_BOT_TOKEN     = (from your .env)
ADMIN_CHAT_ID          = (your numeric ID from @userinfobot)
GOOGLE_SHEET_ID        = (from your .env)
GOOGLE_SERVICE_ACCOUNT_EMAIL = (from your .env)
GOOGLE_PRIVATE_KEY     = (from your .env — see the warning below)
TZ                     = Asia/Yangon
```

### The private key is the one thing people get wrong

Copy the value **exactly as it appears in your `.env`**, on one line, with the
`\n` sequences left as the two characters `\` and `n` — do not press Enter to
make real line breaks, and keep the surrounding double quotes.

The code now handles both the quotes and the `\n` conversion, so if you paste it
verbatim from `.env` it will work. If you see `DECODER routines::unsupported` or
`invalid PEM` in the logs, the key got mangled in the paste — delete the
variable and paste it again.

### Why `TZ` matters

Servers run on UTC. Without `TZ=Asia/Yangon` every order timestamp in your sheet
would be 6.5 hours off.

---

## Step 4 — Stop your local bot ⚠️

**This is the step that will bite you if you skip it.**

Telegram allows only one poller per bot token. If your laptop is still running
`npm start` while the server is also polling, both instances fight and you get
`409 Conflict` errors and messages arriving at random.

Press `Ctrl+C` in your terminal. If you ever set up pm2 locally, also run
`pm2 delete all`.

---

## Step 5 — Redeploy and check the logs

Railway redeploys automatically when you save variables. Open the **Deployments**
tab → click the running deployment → **View Logs**. You want to see:

```
🤖 Bot is running...
📦 Sheet cache warmed
```

If you see `Missing TELEGRAM_BOT_TOKEN` or the credential error, a variable name
is misspelled — they are case-sensitive.

---

## Step 6 — Test it properly

From your phone, not the machine you deployed from:

1. `/start` → the main menu appears
2. Open any product → the detail card shows the correct live stock
3. Tap **ဝယ်မယ်** → the payment instructions arrive
4. Send a screenshot → it reaches your admin chat with the Verified / No Verify buttons
5. Tap **Verified** → the account credentials are delivered and the Inventory row flips to Sold

If step 4 fails, `ADMIN_CHAT_ID` is wrong. If step 5 fails, check the service
account still has **Editor** access to the sheet.

---

## Living with it

**Updating the bot.** Edit code locally, `git push`, and Railway rebuilds and
restarts on its own. No server login needed.

**Sheet edits are picked up within a minute.** Products, prices, promos, FAQ and
Settings are cached briefly for speed. If you change a price and want to see it
immediately, restart the service from the Railway dashboard.

**Restarts lose in-flight orders.** Customers who are mid-purchase (waiting to
send a payslip) will need to tap Buy again after a redeploy. Orders already
written to the sheet are safe. Deploy at quiet hours if you can.

**Cost.** Railway bills by usage; a always-on bot this size lands around $5/month.
Add a payment method or the service is suspended when the trial credit runs out —
a suspended service is a stopped bot.

**Logs.** Railway keeps recent logs only. If something went wrong yesterday and
you want to know why, look sooner rather than later.

---

## If you prefer Render

Same variables, one critical difference: at **New +** choose **Background
Worker**, not Web Service. Build command `npm install`, start command `npm start`.
Render has no free Background Worker tier, so this is a paid service from day one.
