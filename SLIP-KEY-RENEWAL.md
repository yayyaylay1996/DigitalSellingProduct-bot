# Slip checker — when the API key expires or runs out

The slip checker uses a prepaid API key. When the key expires (or its credit runs out) **nothing breaks**:
customers' slips still reach you exactly as before, just without the automatic ✅/⚠️ verdict.
The bot also messages you on Telegram (14, 7, 3 and 1 day before expiry, when credit is under $1, and when the key is refused).

## Renewing the key (about 5 minutes)

1. **Get the new key** from your reseller (or buy a top-up). Ask them: *"Same base URL?"* — usually yes.
   Check the key starts with `sk-orynx-` (reseller) or `sk-ant-` (official Anthropic).
2. **On your Mac** — open `.env` in the bot folder and change only these lines:
   ```
   SLIP_API_KEY=<the new key>
   SLIP_KEY_EXPIRES=<new expiry date, YYYY-MM-DD>     # e.g. 2027-07-08 (a reminder only; the reseller also reports it)
   ```
   Make sure there is **only one** `SLIP_API_KEY=` line (an empty duplicate line cancels the real one).
3. **Test it** (Terminal, in the bot folder):
   ```
   node key-check.mjs --ping
   ```
   You want: `Expires: <new date>`, `Credit left: $…`, and `✅ Test request worked.`
   Optional accuracy check: `node try-slip.mjs "Pay Slip samples"`
4. **Update Railway**: your project → the bot service → **Variables** → edit `SLIP_API_KEY` (and `SLIP_KEY_EXPIRES`) → save.
   Railway redeploys by itself. No `git push` needed — keys are never in git.
5. **Confirm**: send one test slip to the bot (or wait for the next order) — the slip message to you shows the 🔍 Slip check block again.

## Switching provider (reseller ⇄ official Anthropic)

Only three `.env` / Railway lines differ:

| | Reseller (ORYNX) | Official Anthropic |
|---|---|---|
| `SLIP_API_KEY` | `sk-orynx-…` | `sk-ant-…` (platform.claude.com → API keys) |
| `SLIP_API_BASE_URL` | `https://api.orynx.dev` | *(delete the line)* |
| `SLIP_MODEL` | `claude-haiku-4-5` | `claude-haiku-4-5` (or a newer Haiku) |

Then repeat steps 3–4. If the new reseller uses a different base URL, put it in `SLIP_API_BASE_URL` (host only, no `/v1`).
Any provider that speaks the *Anthropic Messages* format (`/v1/messages`) works. Providers that only offer the OpenAI format are not supported.

## If the checker suddenly stops giving verdicts

- Run `node key-check.mjs --ping` on your Mac. `401/402/403` or "credit" = key expired / no credit → renew as above.
- Telegram "key was refused" message means the same thing.
- Switch it off temporarily: Railway variable `SLIP_CHECK=off`. The bot then behaves exactly as before the checker existed.

## Safety notes

- Never paste the key into chats, screenshots or git. `.env` is git-ignored.
- Customers' slips (names, last digits of accounts) pass through the reseller's server. An official Anthropic key avoids that middleman — worth switching once the business depends on this.
- If a key leaks, message the reseller for a replacement (credit stays) and do step 2–4 again.
