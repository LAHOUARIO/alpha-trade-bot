
// 🔧 إعداد البيئة
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const fetch = require("node-fetch");
const path = require("path");
const { RSI, MACD, EMA } = require("technicalindicators");

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, "../users.json");

let goldHistory = [];
let btcHistory = [];
let latestSignals = [];

// 🛠️ إعداد الميدل وير
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));

// ⌛️ تحقق الاشتراك
function isExpired(user) {
  const start = new Date(user.startDate);
  const end = new Date(start);
  end.setDate(end.getDate() + user.durationDays);
  return new Date() > end;
}

// 🔑 تسجيل الدخول
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const users = JSON.parse(fs.readFileSync(USERS_FILE));
  const user = users.find(u => u.username === username && u.password === password);

  if (!user) return res.status(401).send("معلومات غير صحيحة");
  if (isExpired(user)) return res.status(403).send("انتهى الاشتراك");

  res.send("success");
});

// ➕ إضافة مستخدم
app.post("/admin", (req, res) => {
  const { adminUser, adminPass, username, password, durationDays } = req.body;
  if (adminUser !== process.env.ADMIN_USER || adminPass !== process.env.ADMIN_PASS) {
    return res.status(403).send("ممنوع");
  }

  const users = JSON.parse(fs.readFileSync(USERS_FILE));
  users.push({
    username,
    password,
    startDate: new Date().toISOString().split("T")[0],
    durationDays: parseInt(durationDays),
  });

  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  res.send("تمت الإضافة ✅");
});

// 📄 قائمة المستخدمين (للإدارة)
app.post("/users-list", (req, res) => {
  const { adminUser, adminPass } = req.body;
  if (adminUser !== process.env.ADMIN_USER || adminPass !== process.env.ADMIN_PASS) {
    return res.status(403).send("ممنوع");
  }

  const users = JSON.parse(fs.readFileSync(USERS_FILE));
  res.json(users);
});

// ❌ حذف مستخدم
app.post("/delete-user", (req, res) => {
  const { adminUser, adminPass, username } = req.body;
  if (adminUser !== process.env.ADMIN_USER || adminPass !== process.env.ADMIN_PASS) {
    return res.status(403).send("ممنوع");
  }

  let users = JSON.parse(fs.readFileSync(USERS_FILE));
  users = users.filter(u => u.username !== username);

  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  res.send("تم الحذف ✅");
});

// ✅ API الإشارات
app.get("/signals", (req, res) => {
  res.json(latestSignals.slice(-10).reverse());
});

// ✅ سعر الذهب
async function fetchGoldPrice() {
  try {
    const response = await fetch("https://www.goldapi.io/api/XAU/USD", {
      headers: {
        "x-access-token": process.env.GOLD_API_KEY,
        "Content-Type": "application/json",
      },
    });
    const data = await response.json();
    console.log("🧪 GOLD API Response:", data);
    return data.price || null;
  } catch (error) {
    console.error("❌ fetchGoldPrice Error:", error.message);
    return null;
  }
}

// ✅ سعر البيتكوين
async function fetchBTCPrice() {
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
    const data = await response.json();
    console.log("🧪 BTC API Response:", data);
    if (data.bitcoin && data.bitcoin.usd) {
      return data.bitcoin.usd;
    } else {
      throw new Error("بيانات البيتكوين غير متوفرة");
    }
  } catch (error) {
    console.error("❌ fetchBTCPrice Error:", error.message);
    return null;
  }
}

// 🔎 تحليل
function analyzeAsset(price, history, assetName) {
  history.push(price);
  if (history.length < 30) return null;

  const rsi = RSI.calculate({ values: history, period: 14 }).slice(-1)[0];
  const macd = MACD.calculate({
    values: history,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  }).slice(-1)[0];
  const ema = EMA.calculate({ values: history, period: 20 }).slice(-1)[0];

  let signal = null;
  let reasons = [];

  if (rsi < 30) reasons.push("RSI");
  if (macd.histogram > 0) reasons.push("MACD");
  if (price > ema) reasons.push("EMA");

  if (reasons.length >= 2) {
    signal = "📈 BUY ⬆";
  } else {
    reasons = [];
  }

  if (rsi > 70) reasons.push("RSI");
  if (macd.histogram < 0) reasons.push("MACD");
  if (price < ema) reasons.push("EMA");

  if (reasons.length >= 2 && !signal) {
    signal = "📉 SELL ⬇";
  }

  if (signal && reasons.length >= 2) {
    let strength = "🟡 متوسطة";
    if (reasons.length >= 3) strength = "🟢 قوية ✅";
    return { asset: assetName, signal, reasons, strength };
  }

  return null;
}

// 🚀 إرسال لتليغرام
async function sendToTelegram(text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage";
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHANNEL_ID,
      text,
      parse_mode: "Markdown",
    }),
  });
}

// 🧠 تشغيل البوت كل 5 د
async function run() {
  try {
    const now = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const goldPrice = await fetchGoldPrice();
    const btcPrice = await fetchBTCPrice();
    console.log("✅ GOLD:", goldPrice, "| ✅ BTC:", btcPrice);

    if (!goldPrice || !btcPrice) return;

    const goldSignal = analyzeAsset(goldPrice, goldHistory, "الذهب");
    const btcSignal = analyzeAsset(btcPrice, btcHistory, "البيتكوين");

    if (goldSignal) {
      const msg = `🟡 *إشارة الذهب*\n⌛️ ${now}\n${goldSignal.signal}\n📊 ${goldSignal.reasons.join(" + ")}\n📈 *قوة الإشارة:* ${goldSignal.strength}`;
      latestSignals.push({ ...goldSignal, time: now });
      await sendToTelegram(msg);
    }

    if (btcSignal) {
      const msg = `₿ *إشارة البيتكوين*\n⌛️ ${now}\n${btcSignal.signal}\n📊 ${btcSignal.reasons.join(" + ")}\n📈 *قوة الإشارة:* ${btcSignal.strength}`;
      latestSignals.push({ ...btcSignal, time: now });
      await sendToTelegram(msg);
    }
  } catch (err) {
    console.error("❌ خطأ:", err.message);
  }
}

run();
setInterval(run, 5 * 60 * 1000);

// ✅ تشغيل السيرفر
app.listen(PORT, () => {
  console.log(`✅ ALPHA TRADE ACADEMY bot running on http://localhost:${PORT}`);
});
