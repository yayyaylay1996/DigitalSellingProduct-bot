# Product Handler Skill

Guides the Telegram bot's product display, stock checking, and order-type routing logic.

## Product Menu Formatting

When building the product menu for a user:

1. **Fetch live data** — always call `sheets.getProducts()` at display time, never cache.
2. **Group by type** — split into two sections:
   - 📦 **Ready-Made Accounts** (`type: "ready"`)
   - 📧 **Email-Based Activation** (`type: "email"`)
3. **Filter out-of-stock** — only show products where `stock > 0`. If a section is empty, omit its header entirely.
4. **Each entry** shows: `• {name} — {price} Ks`
5. **Inline keyboard** — one button per product, callback_data = `buy_{name}` (keep name short; Telegram limits callback_data to 64 bytes).

Example message structure:
```
🛒 *Going Forward Digital Shop*

📦 *Ready-Made Accounts*
• ChatGPT Plus — 15000 Ks
• Netflix Premium — 8000 Ks

📧 *Email-Based Activation*
• Spotify Family — 5000 Ks

Tap a product below to order:
```

## Stock Availability Check

Before processing any order:

1. Re-fetch products from the sheet (don't trust stale data from the menu render).
2. Find the exact product by name.
3. If the product's stock is `"-"` in the sheet → it's unlimited (email products), always available.
4. If `product.stock <= 0` (numeric) → reply with: `❌ Sorry, "{name}" is out of stock.`
5. If the product is gone entirely → reply with: `❌ Product not found.`

**Why re-fetch?** Stock changes between when the user sees the menu and when they tap. Another user may have bought the last one.

**Why "-" for email products?** These are activated on the customer's own account — no physical inventory to track. The sheet uses `"-"` to mean "skip stock logic".

## Handling "ready" Products (type: "ready")

These are pre-made accounts. The flow is **immediate** — no extra input from the customer.

Steps:
1. Validate stock (see above).
2. Call `sheets.decreaseStock(productName)` to decrement stock by 1.
3. Call `sheets.logOrder({ customerId, product: productName, email: "" })` — email field is blank.
4. Format `customerId` as `@{username}` if available, otherwise `{firstName} (id:{telegramId})`.
5. Reply with confirmation:
   ```
   ✅ *Order Confirmed!*

   📦 Product: {name}
   💰 Price: {price} Ks

   Your order is being processed. You'll receive your account details shortly.
   ```

## Handling "email" Products (type: "email")

These require the customer's email for activation. The flow is **two-step**.

Steps:
1. Validate stock (see above).
2. Set the user's state to "awaiting email" (store in a `Map<chatId, { productName }>`).
3. Prompt: `📧 You selected *{name}* ({price} Ks).\n\nPlease type the email address linked to your account:`
4. When the user sends a plain text message and they are in the awaiting state:
   a. Validate it looks like an email (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`).
   b. If invalid → `⚠️ That doesn't look like a valid email. Please try again:` and keep waiting.
   c. If valid → clear their awaiting state, then:
      - Re-validate stock (it may have changed).
      - `decreaseStock` + `logOrder` (this time with the email).
      - Reply with confirmation including the email.

**Important:** The awaiting-email state must be cleaned up on successful order, on `/start` (optional reset), or if the user sends a command instead. Don't leave stale entries.

## Error Handling

- All Google Sheets calls should be wrapped in try/catch.
- On sheet errors, reply with: `⚠️ Failed to load products. Please try again.` (for reads) or `⚠️ Something went wrong. Please try again.` (for writes).
- Log the full error to console for debugging.
