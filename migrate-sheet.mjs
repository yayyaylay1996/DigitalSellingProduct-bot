/**
 * Idempotent sheet migration for the bot's features. Safe to re-run — it only
 * ADDS missing headers / tabs / rows and never edits or deletes your own data.
 * Run locally (where the network can reach Google):  node migrate-sheet.mjs
 *
 *   1. Products header → H Promo, I Promo Price, J Duration, K Icon, L Category
 *   2. "Tips" tab (Key | Tips) + per-variant reminder rows
 *   3. "FAQ" tab (Key | Question | Answer | Image) + all seed Q&As
 *   4. Ensures the local faq-images/ folder exists
 */
import "dotenv/config";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credentials = JSON.parse(
  fs.readFileSync(path.join(__dirname, "digital-shop-bot-e817e6e12e92.json"), "utf-8")
);
const spreadsheetId = process.env.GOOGLE_SHEET_ID;
if (!spreadsheetId) {
  console.error("Missing GOOGLE_SHEET_ID in .env");
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ─── Seed content ────────────────────────────────────────────────────────────

const CAPCUT_A1 =
  "ဘာplan ဝယ်ရမလဲ စဉ်းစားရခက်နေရင်?\n" +
  "💥ဖုန်းတစ်လုံးပဲ သုံးမယ် ( Ai credit နဲ့သုံးရတာတွေလည်း မသုံးဘူး Pro Effects သုံးမယ် တခြား credit မပါတဲ့ဟာတွေပဲ သုံးမယ်ဆို စျေးသက်သက်သာသာနဲ့ နဲ့ budgetချွေတာချင်သူတွေအတွက် အကိုက်ညီဆုံးပါ) \n\n" +
  "💥Private - device (3)ခု သုံးလို့ရတယ် 👉🏻 PC /Phone/ Tablet စက်မရွေး အသုံးပြုလို့ရပါတယ်  Ai credit - 500 ပါပါတယ်😍";

const CAPCUT_A2 =
  '1️⃣ "အကောင့်သစ်ဝင်လိုက်ရင် ပြင်ထားတဲ့ video တွေပျက်သွားမှာလား"\n' +
  "❌ မပျက်ပါဘူး\n" +
  "Video project တွေက ဖုန်းထဲမှာပဲ သိမ်းထားတာဖြစ်လို့ Account ပြောင်းလည်း မပျောက်ပါဘူး။\n\n" +
  '2️⃣ "Share Account ဝယ်ရင် ကိုယ့်ဖုန်းထဲက video တွေ သူများမြင်မှာလား"\n' +
  "❌ ပုံမှန် ကိုယ့်ဖုန်းထဲက edited video/project တွေကို တခြားသူတွေ မြင်ရပါဘူး\n" +
  "☁️ ဒါပေမယ့် Upload to Space ထဲတင်ထားတဲ့ project/video တွေရှိရင်တော့ Account ဝင်ထားတဲ့သူတွေ မြင်နိုင်ပါတယ်။\n\n" +
  '3️⃣ "CapCut Pro ဝယ်မယ်ဆို Customer ဘက်က ဘာပေးဖို့လိုလဲ"\n' +
  "✅ Customer ဘက်က ဘာမှပေးစရာမလိုပါဘူး\n" +
  'ဒီဘက်ကနေ Account ဖောက်ပေးမှာဖြစ်လို့ ဒီဘက်က ပေးမယ့် Account ကို "Sign in with Email" နဲ့ဝင်သုံးရုံပါပဲ။';

const CAPCUT_A3 =
  "- Phone မှာ အရင်ဝင်ပါရှင့်\n\n" +
  '- ပီးရင် PC အတွက်က "Use Qr code" သုံးပီး ဖုန်းနဲ့ scan ပါရှင်\n\n' +
  "Thank you 😇";

const ZOOM_A1 =
  "Zoom Pro မှာ meeting time limit မရှိ,\n" +
  "• Long meeting, online class, business meeting တွေအတွက် သင့်တော်\n" +
  "• Cloud recording ပါလို့ meeting record သိမ်းနိုင်";

const ZOOM_A2 =
  "online class သင်သူ၊ teacher/trainer, business meeting များသူ၊ consultant, interview လုပ်သူ၊ regular meeting host လုပ်သူတွေဆို Zoom Pro သင့်တော်ပါတယ်။";

// [Key, Question, Answer, Image]
const FAQ_SEED = [
  ["Capcut Pro", "ဘာplan ဝယ်ရမလဲ စဉ်းစားရခက်နေရင်?", CAPCUT_A1, ""],
  ["Capcut Pro", "CapCut ဝယ်တဲ့အခါ အမေးများဆုံး မေးခွန်းများ", CAPCUT_A2, ""],
  ["Capcut Pro", "Capcut PC မှာ login ၀င်နည်း", CAPCUT_A3, ""],
  ["Capcut Pro", "Capcut account Log out ထွက်နည်း", "", "capcut-logout.png"],
  ["Zoom Pro", "zoom pro က ဘာတွေကောင်းတာလဲ", ZOOM_A1, ""],
  ["Zoom Pro", "ဘယ်သူတွေဝယ်သင့်တာလဲ", ZOOM_A2, ""],
];

const SHARE_REMINDER =
  'Reminder❗- Share\n📌Device 1 လုံးထပ်ပိုဝင်ခဲ့ပါက " Max Login Attempt တက်ပါမည် တက်ခဲ့ပါက 24 hours စောင့်ရပါမည် "\n👉ထို့အတွက်ကြောင့် device 1 ခုထပ် ပိုမဝင်ပါရန်👈';

const PRIVATE_REMINDER =
  'Reminder❗- Private \n📌Device 3 လုံးထပ်ပိုဝင်ခဲ့ပါက " Max Login Attempt တက်ပါမည် တက်ခဲ့ပါက 24 hours စောင့်ရပါမည် "\n👉ထို့အတွက်ကြောင့် device 3 ခုထပ် ပိုမဝင်ပါရန်👈';

// [Key, Tips].  Variant keys must match your Products "Variant" text exactly.
const TIPS_SEED = [
  ["Capcut Pro | Share Acc (1Month)", SHARE_REMINDER],
  ["Capcut Pro | Private Acc(1Month)", PRIVATE_REMINDER],
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function ensureTab(tabs, title) {
  if (tabs.includes(title)) return false;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return true;
}

async function getValues(range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function appendRows(range, values) {
  if (values.length === 0) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tabs = meta.data.sheets.map((s) => s.properties.title);
  console.log("Existing tabs:", tabs.join(", "));

  // 1. Products header H..M
  const header = (await getValues("Products!A1:M1"))[0] || [];
  const want = {
    7: "Promo", 8: "Promo Price", 9: "Duration", 10: "Icon", 11: "Category", 12: "Logo",
  };
  const needHeader = Object.entries(want).some(([i, v]) => (header[i] || "").trim() !== v);
  if (needHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Products!H1:M1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Promo", "Promo Price", "Duration", "Icon", "Category", "Logo"]] },
    });
    console.log("✔ Products headers ensured: H=Promo I=Promo Price J=Duration K=Icon L=Category M=Logo");
  } else {
    console.log("• Products headers already present");
  }

  // 2. Tips tab
  if (await ensureTab(tabs, "Tips")) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Tips!A1:B",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          ["Key", "Tips"],
          ["auto", "After logging in, please do not change the email or password."],
          ["manual", "Our admin will set up your account shortly — keep this chat open."],
        ],
      },
    });
    console.log('✔ Created "Tips" tab');
  }
  {
    const existing = await getValues("Tips!A2:A");
    const have = new Set(existing.map((r) => (r[0] || "").trim().toLowerCase()));
    const toAdd = TIPS_SEED.filter(([k]) => !have.has(k.toLowerCase()));
    await appendRows("Tips!A:B", toAdd);
    console.log(toAdd.length ? `✔ Added ${toAdd.length} variant reminder(s) to Tips` : "• Tips reminders already present");
  }

  // 3. FAQ tab (Key | Question | Answer | Image)
  const faqCreated = await ensureTab(tabs, "FAQ");
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "FAQ!A1:D1",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [["Key (Product Name)", "Question (button label)", "Answer (shown when tapped)", "Image (filename)"]],
    },
  });
  if (faqCreated) console.log('✔ Created "FAQ" tab');
  {
    const existing = await getValues("FAQ!A2:B");
    const have = new Set(
      existing.map((r) => `${(r[0] || "").trim().toLowerCase()}|||${(r[1] || "").trim().toLowerCase()}`)
    );
    const toAdd = FAQ_SEED.filter(
      ([k, q]) => !have.has(`${k.trim().toLowerCase()}|||${q.trim().toLowerCase()}`)
    );
    await appendRows("FAQ!A:D", toAdd);
    console.log(toAdd.length ? `✔ Added ${toAdd.length} FAQ row(s)` : "• FAQ rows already present");
  }

  // 4. Local faq-images/ folder
  const imgDir = path.join(__dirname, "faq-images");
  if (!fs.existsSync(imgDir)) {
    fs.mkdirSync(imgDir, { recursive: true });
    console.log("✔ Created faq-images/ folder");
  } else {
    console.log("• faq-images/ folder already exists");
  }

  console.log(
    "\nDone.\n" +
      "⚠️ Add your logout image as  faq-images/capcut-logout.png\n" +
      "⚠️ Check the Tips variant keys match your Products 'Variant' text exactly.\n" +
      "Then run the bot with:  npm start"
  );
}

main().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
