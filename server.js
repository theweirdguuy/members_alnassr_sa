require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ============================================
// Configuration
// ============================================
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const IS_PRODUCTION = process.env.PRODUCTION === "true";

const NOWPAYMENTS_BASE = IS_PRODUCTION
  ? "https://api.nowpayments.io/v1"
  : "https://api-sandbox.nowpayments.io/v1";

// ============================================
// In-memory orders store (replace with DB in production)
// ============================================
const orders = new Map();

// ============================================
// In-memory redeem codes store (replace with DB in production)
// Pre-populated with sample codes for each card
// ============================================
const redeemCodes = new Map([
  [
    "NASSR-R7CR-GOLD-2025",
    {
      playerId: 1,
      playerName: "كريستيانو رونالدو",
      playerNameEn: "Cristiano Ronaldo",
      sats: 5200000,
      redeemed: false,
      redeemedAt: null,
      redeemedTo: null,
    },
  ],
  [
    "NASSR-MANE-STAR-2025",
    {
      playerId: 2,
      playerName: "ساديو ماني",
      playerNameEn: "Sadio Mané",
      sats: 3600000,
      redeemed: false,
      redeemedAt: null,
      redeemedTo: null,
    },
  ],
  [
    "NASSR-LAPO-DFND-2025",
    {
      playerId: 3,
      playerName: "ايمريك لابورت",
      playerNameEn: "Aymeric Laporte",
      sats: 2700000,
      redeemed: false,
      redeemedAt: null,
      redeemedTo: null,
    },
  ],
  [
    "NASSR-BROZ-MIDX-2025",
    {
      playerId: 4,
      playerName: "مارسيلو بروزوفيتش",
      playerNameEn: "Marcelo Brozović",
      sats: 2100000,
      redeemed: false,
      redeemedAt: null,
      redeemedTo: null,
    },
  ],
  [
    "NASSR-TELL-WING-2025",
    {
      playerId: 5,
      playerName: "أليكس تيليس",
      playerNameEn: "Alex Telles",
      sats: 1600000,
      redeemed: false,
      redeemedAt: null,
      redeemedTo: null,
    },
  ],
  [
    "NASSR-FOFA-POWR-2025",
    {
      playerId: 6,
      playerName: "سيكو فوفانا",
      playerNameEn: "Seko Fofana",
      sats: 1100000,
      redeemed: false,
      redeemedAt: null,
      redeemedTo: null,
    },
  ],
]);

const players = [
  {
    id: 1,
    name: "كريستيانو رونالدو",
    nameEn: "Cristiano Ronaldo",
    price: 189999,
    btc: 0.75,
    sold: false,
  },
  {
    id: 2,
    name: "ساديو ماني",
    nameEn: "Sadio Mané",
    price: 129999,
    btc: 0.52,
    sold: false,
  },
  {
    id: 3,
    name: "ايمريك لابورت",
    nameEn: "Aymeric Laporte",
    price: 99999,
    btc: 0.27,
    sold: true,
  },
  {
    id: 4,
    name: "مارسيلو بروزوفيتش",
    nameEn: "Marcelo Brozović",
    price: 74999,
    btc: 0.21,
    sold: false,
  },
  {
    id: 5,
    name: "أليكس تيليس",
    nameEn: "Alex Telles",
    price: 59999,
    btc: 0.16,
    sold: true,
  },
  {
    id: 6,
    name: "سيكو فوفانا",
    nameEn: "Seko Fofana",
    price: 39999,
    btc: 0.11,
    sold: false,
  },
];

// ============================================
// Helper: NOWPayments API fetch wrapper
// ============================================
async function nowpaymentsRequest(endpoint, method = "GET", body = null) {
  const options = {
    method,
    headers: {
      "x-api-key": NOWPAYMENTS_API_KEY,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${NOWPAYMENTS_BASE}${endpoint}`, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.message || `NOWPayments API error: ${response.status}`,
    );
  }
  return data;
}

// ============================================
// Routes
// ============================================

// Health check / API status
app.get("/api/status", async (req, res) => {
  try {
    const status = await nowpaymentsRequest("/status");
    res.json({ server: "ok", nowpayments: status });
  } catch (error) {
    res.json({ server: "ok", nowpayments: { message: error.message } });
  }
});

// Get available currencies from NOWPayments
app.get("/api/currencies", async (req, res) => {
  try {
    const data = await nowpaymentsRequest("/currencies");
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get minimum payment amount for a currency
app.get("/api/min-amount/:currency", async (req, res) => {
  try {
    const data = await nowpaymentsRequest(
      `/min-amount?currency_from=${req.params.currency}&currency_to=sar`,
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get estimated price in crypto
app.get("/api/estimate", async (req, res) => {
  try {
    const { amount, currency } = req.query;
    const data = await nowpaymentsRequest(
      `/estimate?amount=${amount}&currency_from=sar&currency_to=${currency}`,
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Create a crypto payment via NOWPayments
// ============================================
app.post("/api/create-payment", async (req, res) => {
  try {
    const { playerId, currency, redeemOption, customer } = req.body;

    // Validate player
    const player = players.find((p) => p.id === playerId);
    if (!player) return res.status(404).json({ error: "Card not found" });
    if (player.sold)
      return res.status(400).json({ error: "Card already sold" });

    // Validate required fields
    if (!currency)
      return res.status(400).json({ error: "Currency is required" });
    if (!customer || !customer.email) {
      return res.status(400).json({ error: "Customer email is required" });
    }

    // Generate a unique order ID
    const orderId = `NASSR-${Date.now()}-${player.id}`;

    // Create payment via NOWPayments (price in BTC)
    const paymentData = await nowpaymentsRequest("/payment", "POST", {
      price_amount: player.btc,
      price_currency: "btc",
      pay_currency: currency,
      order_id: orderId,
      order_description: `Al-Nassr VIP Card: ${player.nameEn} (PSA 10)`,
      ipn_callback_url: `${req.protocol}://${req.get("host")}/api/ipn`,
    });

    // Store the order
    orders.set(orderId, {
      orderId,
      playerId: player.id,
      playerName: player.nameEn,
      priceAmount: player.price,
      payCurrency: currency,
      payAmount: paymentData.pay_amount,
      payAddress: paymentData.pay_address,
      paymentId: paymentData.payment_id,
      status: paymentData.payment_status,
      redeemOption,
      customer,
      createdAt: new Date().toISOString(),
    });

    console.log(
      `[ORDER] Created: ${orderId} | ${player.nameEn} | ${paymentData.pay_amount} ${currency}`,
    );

    res.json({
      success: true,
      orderId,
      paymentId: paymentData.payment_id,
      payAddress: paymentData.pay_address,
      payAmount: paymentData.pay_amount,
      payCurrency: currency,
      status: paymentData.payment_status,
      validUntil: paymentData.expiration_estimate_date,
    });
  } catch (error) {
    console.error("[ERROR] Create payment:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Create an invoice via NOWPayments (alternative)
// ============================================
app.post("/api/create-invoice", async (req, res) => {
  try {
    const { playerId, redeemOption, customer } = req.body;

    const player = players.find((p) => p.id === playerId);
    if (!player) return res.status(404).json({ error: "Card not found" });
    if (player.sold)
      return res.status(400).json({ error: "Card already sold" });

    const orderId = `NASSR-${Date.now()}-${player.id}`;

    // Create invoice - price in BTC
    const invoiceData = await nowpaymentsRequest("/invoice", "POST", {
      price_amount: player.btc,
      price_currency: "btc",
      order_id: orderId,
      order_description: `Al-Nassr VIP Card: ${player.nameEn} (PSA 10)`,
      ipn_callback_url: `${req.protocol}://${req.get("host")}/api/ipn`,
      success_url: `${req.protocol}://${req.get("host")}/?payment=success&order=${orderId}`,
      cancel_url: `${req.protocol}://${req.get("host")}/?payment=cancelled`,
    });

    orders.set(orderId, {
      orderId,
      playerId: player.id,
      playerName: player.nameEn,
      priceAmount: player.price,
      invoiceId: invoiceData.id,
      invoiceUrl: invoiceData.invoice_url,
      status: "waiting",
      redeemOption,
      customer,
      createdAt: new Date().toISOString(),
    });

    console.log(
      `[INVOICE] Created: ${orderId} | ${player.nameEn} | Invoice: ${invoiceData.id}`,
    );

    res.json({
      success: true,
      orderId,
      invoiceId: invoiceData.id,
      invoiceUrl: invoiceData.invoice_url,
    });
  } catch (error) {
    console.error("[ERROR] Create invoice:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Check payment status
// ============================================
app.get("/api/payment-status/:paymentId", async (req, res) => {
  try {
    const data = await nowpaymentsRequest(`/payment/${req.params.paymentId}`);
    res.json({
      paymentId: data.payment_id,
      status: data.payment_status,
      payAmount: data.pay_amount,
      actuallyPaid: data.actually_paid,
      payCurrency: data.pay_currency,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// IPN (Instant Payment Notification) Webhook
// ============================================
app.post("/api/ipn", (req, res) => {
  try {
    const payload = req.body;

    // Verify IPN signature
    if (NOWPAYMENTS_IPN_SECRET) {
      const hmac = crypto.createHmac("sha512", NOWPAYMENTS_IPN_SECRET);
      // Sort payload keys and create the string for HMAC
      const sortedPayload = Object.keys(payload)
        .sort()
        .reduce((obj, key) => {
          obj[key] = payload[key];
          return obj;
        }, {});
      hmac.update(JSON.stringify(sortedPayload));
      const signature = hmac.digest("hex");

      const receivedSig = req.headers["x-nowpayments-sig"];
      if (receivedSig !== signature) {
        console.error("[IPN] Invalid signature!");
        return res.status(400).json({ error: "Invalid signature" });
      }
    }

    const { order_id, payment_status, actually_paid, pay_amount } = payload;

    console.log(
      `[IPN] Order: ${order_id} | Status: ${payment_status} | Paid: ${actually_paid}/${pay_amount}`,
    );

    // Update order status
    if (orders.has(order_id)) {
      const order = orders.get(order_id);
      order.status = payment_status;
      order.actuallyPaid = actually_paid;

      // If payment is confirmed, mark card as sold
      if (payment_status === "confirmed" || payment_status === "finished") {
        const player = players.find((p) => p.id === order.playerId);
        if (player) {
          player.sold = true;
          console.log(`[SOLD] ${player.nameEn} card marked as sold!`);
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[IPN ERROR]", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Get order details
// ============================================
app.get("/api/order/:orderId", (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

// ============================================
// Get available cards
// ============================================
app.get("/api/cards", (req, res) => {
  res.json(players);
});

// ============================================
// Redeem Satoshi from card code
// ============================================
app.post("/api/redeem", (req, res) => {
  try {
    const { code, lightningAddress, email } = req.body;

    // Validate inputs
    if (!code || !lightningAddress) {
      return res.status(400).json({
        error: "رمز الاسترداد وعنوان محفظة Lightning مطلوبان",
        message: "يرجى إدخال رمز الاسترداد وعنوان المحفظة",
      });
    }

    // Normalize code
    const normalizedCode = code.toUpperCase().trim();

    // Check if code exists
    if (!redeemCodes.has(normalizedCode)) {
      console.log(`[REDEEM] Invalid code attempted: ${normalizedCode}`);
      return res.status(404).json({
        error: "رمز الاسترداد غير صالح",
        message:
          "الرمز المدخل غير موجود في قاعدة البيانات. تأكد من كتابة الرمز بشكل صحيح.",
      });
    }

    const codeData = redeemCodes.get(normalizedCode);

    // Check if already redeemed
    if (codeData.redeemed) {
      console.log(`[REDEEM] Already redeemed code: ${normalizedCode}`);
      return res.status(400).json({
        error: "تم استخدام هذا الرمز مسبقاً",
        message: `تم استرداد هذا الرمز بتاريخ ${new Date(codeData.redeemedAt).toLocaleDateString("ar-SA")}. كل رمز صالح للاستخدام مرة واحدة فقط.`,
      });
    }

    // Process the redemption
    // In production, this would call a Lightning Network payment API (e.g., LNBits, Strike, etc.)
    const txId = `LN-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    // Mark code as redeemed
    codeData.redeemed = true;
    codeData.redeemedAt = new Date().toISOString();
    codeData.redeemedTo = lightningAddress;
    codeData.txId = txId;
    codeData.email = email || null;

    console.log(
      `[REDEEM] ✓ Success: ${normalizedCode} | ${codeData.sats.toLocaleString()} sats → ${lightningAddress} | TX: ${txId}`,
    );

    res.json({
      success: true,
      message: `تم إرسال ${codeData.sats.toLocaleString()} ساتوشي إلى محفظتك بنجاح!`,
      playerName: codeData.playerName,
      sats: codeData.sats,
      lightningAddress,
      txId,
      redeemedAt: codeData.redeemedAt,
    });
  } catch (error) {
    console.error("[REDEEM ERROR]", error.message);
    res.status(500).json({
      error: "خطأ في الخادم",
      message: "حدث خطأ أثناء معالجة طلب الاسترداد. يرجى المحاولة لاحقاً.",
    });
  }
});

// ============================================
// Get redeem code info (check without redeeming)
// ============================================
app.get("/api/redeem/:code", (req, res) => {
  const normalizedCode = req.params.code.toUpperCase().trim();

  if (!redeemCodes.has(normalizedCode)) {
    return res.status(404).json({ error: "Code not found" });
  }

  const codeData = redeemCodes.get(normalizedCode);
  res.json({
    playerName: codeData.playerName,
    sats: codeData.sats,
    redeemed: codeData.redeemed,
  });
});

// ============================================
// Serve redeem page
// ============================================
app.get("/redeem", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "redeem.html"));
});

// ============================================
// Fallback to index.html for SPA
// ============================================
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================
// Start Server
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   Al-Nassr VIP Cards Server                  ║
  ║   Running on: http://localhost:${PORT}          ║
  ║   Mode: ${IS_PRODUCTION ? "PRODUCTION" : "SANDBOX   "}                      ║
  ║   NOWPayments: ${NOWPAYMENTS_API_KEY ? "Configured ✓" : "NOT SET ✗  "}              ║
  ╚══════════════════════════════════════════════╝
  `);
});
