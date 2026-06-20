# Product Handler Skill

Guides the Telegram bot's catalog display, live stock checking, ordering,
payslip handling, and admin-verified delivery for the Going Forward Digital Shop.

## Data model — four tabs, joined by IDs

The Google Sheet has four tabs. **Never match products by display name** — the
join keys are **Product ID** (`P001`) and **Order ID** (`ORD-0001`), and they
appear in every button's `callback_data`.

- **Products** — catalog only: `Product ID | Product Name | Variant | Type
  (ready/email) | Price (MMK) | Description | Active`. No stock, no credentials.
- **Inventory** — one row per real account: `Inventory ID | Product ID | Account
  Credentials | Status (Available/Sold) | Sold To (Username) | Sold Date/Time |
  Order ID`.
- **Orders** — one row per order: `Order ID | Date Created | Customer Username |
  Customer Chat ID | Product ID | Product Name | Variant | Price (MMK) | Payment
  Status | Payslip Sent | Admin Decision | Decision Time | Delivery Status |
  Inventory ID Used | Credentials Sent | Used Date/Time | Notes`.
- **Settings** — `Key | Value | Notes`. Read **all** payment/admin values live at
  runtime (bank number/name, accepted methods, payment note, delivery promise,
  urgent phone, Admin Telegram Username, Admin Contact Phone). Never hardcode them.

### Live stock count (never stored)

Stock for a ready product = the number of **Inventory** rows where `Product ID`
matches **and** `Status = "Available"`. Compute it live with
`sheets.countAvailableStock(productId)` every time a detail card is shown or a
purchase is attempted. There is no stock column anywhere.

Email products have no inventory and no stock number — they are always buyable.

## Menu flow

1. **Main menu** (`/start` or the text "Products"): one button per **unique
   Product Name** (variants grouped under the same name). Each button's
   `callback_data` is `name:<firstProductId>` of that group — an ID, not a name.
2. **Name tapped** -> if the name has more than one variant, show one button per
   variant (`detail:<productId>`, label `"{Variant} — {Price} MMK"`). If only one
   variant exists, skip straight to the detail card.
3. **Detail card** (`detail:<productId>`): show Product Name, Variant, Price,
   Description. For **ready** products add `In stock: N` (live count). If
   `N = 0`, show `Sold Out` with only **Back** and **Main menu** (no Buy now).
   **email** products show no stock line and always show **Buy now**. Buttons when
   buyable: `Buy now` (`buy:<productId>`), `Back`, `Main menu`.

## Buy -> payslip -> verify -> deliver

4. **Buy now** (`buy:<productId>`): re-check live stock for ready products. Create
   an **Orders** row via `sheets.createOrder(...)` — auto Order ID `ORD-####`,
   Date Created now, customer username + chat id, Product ID/Name/Variant/Price,
   Payment Status `Awaiting Payslip`, Payslip Sent `No`, Admin Decision `Pending`,
   Delivery Status `Not Delivered`. Track `Map<chatId, orderId>` so the next photo
   is tied to this order. Send Settings-driven payment instructions with buttons
   `Cancel Buy` (`cancel:<orderId>`) and `Main Menu`.
5. **Cancel Buy** (`cancel:<orderId>`): set Payment Status `Cancelled`, clear the
   pending-payslip entry, return to the main menu.
6. **Customer sends a photo** while their order is `Awaiting Payslip`: set Payslip
   Sent `Yes`, Payment Status `Payslip Received`; forward the photo to the **Admin
   Telegram Username** (by resolved admin chat id) with a caption (Order ID,
   Product Name, Variant, Price, customer username) and `Verified` /
   `No Verify` buttons (`verify:<orderId>` / `noverify:<orderId>`); reply to the
   customer "Payment received, waiting for admin verification."
   - **Manual setup:** the admin must send `/start` to the bot once so the bot can
     message them. The bot captures the admin's chat id on that `/start` (matching
     their @username to the Settings value) and persists it as `Admin Chat ID`.
7. **Admin -> Verified** (`verify:<orderId>`, admin chat only): set Admin Decision
   `Verified`, Decision Time now.
   - **ready:** take the FIRST Inventory row with this Product ID and Status
     `Available`. If none, tell the admin it's sold out and stop. Otherwise send
     its Account Credentials to the customer; mark that Inventory row `Sold`, Sold
     To = customer username, Sold Date/Time now, Order ID = this order; and set the
     Order's Inventory ID Used, Credentials Sent (copy of the text), Used Date/Time
     now, Delivery Status `Delivered`.
   - **email:** send the customer a confirmation with one button `Contact Admin
     to Continue` (`continue:<orderId>`); set Delivery Status `Awaiting Admin
     Contact`.
   - Either way, edit the admin's payslip message to append `Verified` and remove
     its buttons so it can't be tapped twice.
8. **Admin -> No Verify** (`noverify:<orderId>`): set Admin Decision `No Verify`,
   Decision Time now, Payment Status `Not Verified`; send the customer a message
   with `Main` and `Contact Admin` (`contact:<orderId>`); edit the admin
   message to `No Verify` and remove buttons.
9. **Customer -> Contact Admin** (`contact:<orderId>`, after No Verify): show Admin
   Contact Phone and Admin Telegram Username from Settings.
10. **Customer -> Contact Admin to Continue** (`continue:<orderId>`, after a Verified
    email order): message the **admin** with the order's Product Name, Variant,
    Price, customer username + chat id; then show the customer the Admin Contact
    Phone and Telegram Username.

## Helper functions (`sheets.js`)

`getSettings`, `setSetting`, `getProducts`, `getProductById`,
`countAvailableStock`, `getAvailableInventory`, `markInventorySold`,
`createOrder`, `getOrderByOrderId`, `updateOrderByOrderId`, `now`.

## Error handling

- Wrap all Sheets calls in try/catch; log the full error to console with context.
- On failure reply: `Failed to load products. Please try again.` (reads) or
  `Something went wrong. Please try again.` (writes).
- Guard admin actions: ignore `verify`/`noverify` from non-admin chats, and skip
  any order whose Admin Decision is no longer `Pending` (prevents double delivery).
