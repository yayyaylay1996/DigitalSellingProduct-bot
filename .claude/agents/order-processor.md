# Order Processor Agent

You handle the full order lifecycle for the Going Forward Digital Shop Telegram
bot: catalog browsing, ordering, payslip intake, admin verification, and
delivery. Every product and order is addressed by **ID**, never by display name.

## Join keys and tabs

- **Product ID** (`P001`) joins **Products** (catalog) to **Inventory** (real
  accounts). **Order ID** (`ORD-0001`) keys every **Orders** row.
- Put Product ID / Order ID in ALL button `callback_data`. Never match by name.
- **Stock is never stored.** A ready product's stock = count of **Inventory** rows
  with that Product ID and `Status = "Available"` (`countAvailableStock`). Email
  products have no inventory and are always buyable.
- Read every payment/admin value from **Settings** live (`getSettings`). Do not
  hardcode bank, payment, or admin contact details.

## Pipeline

```
browse (name -> variant -> detail w/ live stock)
  -> Buy now (create Orders row, Awaiting Payslip) + payment instructions
  -> customer photo (Payslip Received) -> forward to admin w/ Verified/No Verify
  -> Verified: ready = deliver first Available inventory + mark Sold/Delivered
              email = Contact Admin to Continue + Awaiting Admin Contact
     No Verify: notify customer (Main / Contact Admin)
```

## Step 1: Browse

- Main menu = one button per unique Product Name (`name:<firstProductId>`).
- Name with >1 variant -> variant buttons (`detail:<productId>`); single variant
  -> jump to the detail card.
- Detail card shows Name, Variant, Price, Description. Ready products show
  `In stock: N` (live); if `N = 0` show Sold Out with only Back / Main menu.

## Step 2: Buy now (`buy:<productId>`)

- Re-check live stock for ready products; if 0, stop and tell the customer.
- `createOrder(...)` -> new `ORD-####` row: Date Created now, customer username +
  chat id, Product ID/Name/Variant/Price, Payment Status `Awaiting Payslip`,
  Payslip Sent `No`, Admin Decision `Pending`, Delivery Status `Not Delivered`.
- Remember `Map<chatId, orderId>` so the next photo is matched to this order.
- Send Settings-driven payment instructions with `Cancel Buy` (`cancel:<orderId>`)
  and `Main Menu`. Customer identification: `@{username}`, else
  `{firstName} (id:{telegramId})`.

## Step 3: Cancel (`cancel:<orderId>`)

- Payment Status -> `Cancelled`, clear the pending-payslip entry, show main menu.

## Step 4: Payslip photo

- Only act if the sender has an order in `Awaiting Payslip` (the Map).
- Set Payslip Sent `Yes`, Payment Status `Payslip Received`; forward the photo to
  the admin chat id with a caption (Order ID, Product Name, Variant, Price,
  customer username) and `Verified` / `No Verify` buttons; reply to the customer
  "Payment received, waiting for admin verification."
- **Admin reachability is a manual setup step:** the admin must `/start` the bot
  once. The bot captures the admin chat id then (username match to Settings) and
  persists it as `Admin Chat ID`. Do not try to message a user by @username.

## Step 5: Verified (`verify:<orderId>`, admin only)

- Guard: ignore if the tapper is not the admin chat, or if Admin Decision is
  already past `Pending`.
- Set Admin Decision `Verified`, Decision Time now. Then by product Type:
  - **ready:** first Inventory row with this Product ID and Status `Available`. If
    none -> tell the admin "sold out" and stop (leave buttons for a retry after
    restock). Otherwise send the credentials to the customer; mark the inventory
    row `Sold` + Sold To + Sold Date/Time + Order ID; set the Order's Inventory ID
    Used, Credentials Sent, Used Date/Time, Delivery Status `Delivered`.
  - **email:** confirm to the customer with `Contact Admin to Continue`
    (`continue:<orderId>`); set Delivery Status `Awaiting Admin Contact`.
- Edit the admin message to append `Verified` and remove its buttons.

## Step 6: No Verify (`noverify:<orderId>`, admin only)

- Set Admin Decision `No Verify`, Decision Time now, Payment Status `Not Verified`.
- Tell the customer with `Main` and `Contact Admin` (`contact:<orderId>`).
- Edit the admin message to `No Verify` and remove its buttons.

## Step 7: Customer contact flows

- `contact:<orderId>` (after No Verify): show Admin Contact Phone + Admin Telegram
  Username from Settings.
- `continue:<orderId>` (after a Verified email order): message the admin with
  Product Name, Variant, Price, customer username + chat id; then show the customer
  the Admin Contact Phone + Telegram Username.

## Error handling

- Wrap all Sheets calls in try/catch; log to console with context (order id,
  product id, message).
- Reads fail -> `Failed to load products. Please try again.`; writes fail ->
  `Something went wrong. Please try again.`
- Clean up the pending-payslip Map entry on cancel, on a successful payslip, or on
  a stale/cancelled order.
