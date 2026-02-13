const crypto = require("crypto");
const nodeFetch = require("node-fetch");

// Use node-fetch if global fetch is not available (Node.js < 18)
const fetch = globalThis.fetch || nodeFetch;

// ============================================
// Configuration
// ============================================
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const IS_PRODUCTION = process.env.PRODUCTION === "true";

if (!NOWPAYMENTS_API_KEY) {
  console.warn(
    "[WARNING] NOWPAYMENTS_API_KEY environment variable is not set!",
  );
}

const NOWPAYMENTS_BASE = IS_PRODUCTION
  ? "https://api.nowpayments.io/v1"
  : "https://api-sandbox.nowpayments.io/v1";

// ============================================
// In-memory stores (for demo — use a database in production)
// ============================================
const orders = new Map();

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
  if (!NOWPAYMENTS_API_KEY) {
    throw new Error(
      "NOWPAYMENTS_API_KEY is not configured on the server. Set it in Netlify dashboard → Site settings → Environment variables.",
    );
  }

  const url = `${NOWPAYMENTS_BASE}${endpoint}`;
  console.log(`[NOWPayments] ${method} ${url}`);

  const options = {
    method,
    headers: {
      "x-api-key": NOWPAYMENTS_API_KEY,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  let response;
  try {
    response = await fetch(url, options);
  } catch (fetchError) {
    console.error("[NOWPayments] fetch failed:", fetchError.message);
    throw new Error(`Network error calling NOWPayments: ${fetchError.message}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (jsonError) {
    const text = await response.text().catch(() => "");
    console.error("[NOWPayments] Invalid JSON response:", text);
    throw new Error(
      `NOWPayments returned invalid JSON (status ${response.status})`,
    );
  }

  if (!response.ok) {
    console.error("[NOWPayments] API error:", JSON.stringify(data));
    throw new Error(
      data.message || `NOWPayments API error: ${response.status}`,
    );
  }
  return data;
}

// ============================================
// Helper: Build response with CORS headers
// ============================================
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-nowpayments-sig",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

// ============================================
// Main handler — routes all /api/* requests
// ============================================
exports.handler = async (event, context) => {
  // Strip both possible prefixes: the rewritten path and the original path
  const rawPath = event.path || event.rawUrl || "";
  const path = rawPath
    .replace("/.netlify/functions/api", "")
    .replace(/^\/api\//, "/")
    .replace(/^\/+/, "");
  const method = event.httpMethod;

  console.log("[API] Incoming:", method, rawPath, "→ resolved path:", path);

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return respond(200, {});
  }

  try {
    // ---- GET /api/status ----
    if (method === "GET" && path === "status") {
      try {
        const status = await nowpaymentsRequest("/status");
        return respond(200, { server: "ok", nowpayments: status });
      } catch (error) {
        return respond(200, {
          server: "ok",
          nowpayments: { message: error.message },
        });
      }
    }

    // ---- GET /api/currencies ----
    if (method === "GET" && path === "currencies") {
      const data = await nowpaymentsRequest("/currencies");
      return respond(200, data);
    }

    // ---- GET /api/min-amount/:currency ----
    if (method === "GET" && path.startsWith("min-amount/")) {
      const currency = path.split("/")[1];
      const data = await nowpaymentsRequest(
        `/min-amount?currency_from=${currency}&currency_to=sar`,
      );
      return respond(200, data);
    }

    // ---- GET /api/estimate ----
    if (method === "GET" && path === "estimate") {
      const params = event.queryStringParameters || {};
      const data = await nowpaymentsRequest(
        `/estimate?amount=${params.amount}&currency_from=sar&currency_to=${params.currency}`,
      );
      return respond(200, data);
    }

    // ---- GET /api/cards ----
    if (method === "GET" && path === "cards") {
      return respond(200, players);
    }

    // ---- POST /api/create-payment ----
    if (method === "POST" && path === "create-payment") {
      const body = JSON.parse(event.body);
      const { playerId, currency, redeemOption, customer } = body;

      const player = players.find((p) => p.id === playerId);
      if (!player) return respond(404, { error: "Card not found" });
      if (player.sold) return respond(400, { error: "Card already sold" });
      if (!currency) return respond(400, { error: "Currency is required" });
      if (!customer || !customer.email)
        return respond(400, { error: "Customer email is required" });

      const orderId = `NASSR-${Date.now()}-${player.id}`;
      const host = event.headers.host || "localhost";
      const proto = event.headers["x-forwarded-proto"] || "https";

      const paymentData = await nowpaymentsRequest("/payment", "POST", {
        price_amount: player.price,
        price_currency: "sar",
        pay_currency: currency,
        order_id: orderId,
        order_description: `Al-Nassr VIP Card: ${player.nameEn} (PSA 10)`,
        ipn_callback_url: `${proto}://${host}/api/ipn`,
      });

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

      return respond(200, {
        success: true,
        orderId,
        paymentId: paymentData.payment_id,
        payAddress: paymentData.pay_address,
        payAmount: paymentData.pay_amount,
        payCurrency: currency,
        status: paymentData.payment_status,
        validUntil: paymentData.expiration_estimate_date,
      });
    }

    // ---- POST /api/create-invoice ----
    if (method === "POST" && path === "create-invoice") {
      const body = JSON.parse(event.body);
      const { playerId, redeemOption, customer } = body;

      const player = players.find((p) => p.id === playerId);
      if (!player) return respond(404, { error: "Card not found" });
      if (player.sold) return respond(400, { error: "Card already sold" });

      const orderId = `NASSR-${Date.now()}-${player.id}`;
      const host = event.headers.host || "localhost";
      const proto = event.headers["x-forwarded-proto"] || "https";

      const invoiceData = await nowpaymentsRequest("/invoice", "POST", {
        price_amount: player.price,
        price_currency: "sar",
        order_id: orderId,
        order_description: `Al-Nassr VIP Card: ${player.nameEn} (PSA 10)`,
        ipn_callback_url: `${proto}://${host}/api/ipn`,
        success_url: `${proto}://${host}/?payment=success&order=${orderId}`,
        cancel_url: `${proto}://${host}/?payment=cancelled`,
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

      return respond(200, {
        success: true,
        orderId,
        invoiceId: invoiceData.id,
        invoiceUrl: invoiceData.invoice_url,
      });
    }

    // ---- GET /api/payment-status/:paymentId ----
    if (method === "GET" && path.startsWith("payment-status/")) {
      const paymentId = path.split("/")[1];
      const data = await nowpaymentsRequest(`/payment/${paymentId}`);
      return respond(200, {
        paymentId: data.payment_id,
        status: data.payment_status,
        payAmount: data.pay_amount,
        actuallyPaid: data.actually_paid,
        payCurrency: data.pay_currency,
      });
    }

    // ---- POST /api/ipn ----
    if (method === "POST" && path === "ipn") {
      const payload = JSON.parse(event.body);

      if (NOWPAYMENTS_IPN_SECRET) {
        const hmac = crypto.createHmac("sha512", NOWPAYMENTS_IPN_SECRET);
        const sortedPayload = Object.keys(payload)
          .sort()
          .reduce((obj, key) => {
            obj[key] = payload[key];
            return obj;
          }, {});
        hmac.update(JSON.stringify(sortedPayload));
        const signature = hmac.digest("hex");
        const receivedSig = event.headers["x-nowpayments-sig"];
        if (receivedSig !== signature) {
          return respond(400, { error: "Invalid signature" });
        }
      }

      const { order_id, payment_status, actually_paid, pay_amount } = payload;
      console.log(
        `[IPN] Order: ${order_id} | Status: ${payment_status} | Paid: ${actually_paid}/${pay_amount}`,
      );

      if (orders.has(order_id)) {
        const order = orders.get(order_id);
        order.status = payment_status;
        order.actuallyPaid = actually_paid;
        if (payment_status === "confirmed" || payment_status === "finished") {
          const player = players.find((p) => p.id === order.playerId);
          if (player) player.sold = true;
        }
      }
      return respond(200, { success: true });
    }

    // ---- GET /api/order/:orderId ----
    if (method === "GET" && path.startsWith("order/")) {
      const orderId = path.replace("order/", "");
      const order = orders.get(orderId);
      if (!order) return respond(404, { error: "Order not found" });
      return respond(200, order);
    }

    // ---- POST /api/redeem ----
    if (method === "POST" && path === "redeem") {
      const body = JSON.parse(event.body);
      const { code, lightningAddress, email } = body;

      if (!code || !lightningAddress) {
        return respond(400, {
          error: "رمز الاسترداد وعنوان محفظة Lightning مطلوبان",
          message: "يرجى إدخال رمز الاسترداد وعنوان المحفظة",
        });
      }

      const normalizedCode = code.toUpperCase().trim();
      if (!redeemCodes.has(normalizedCode)) {
        return respond(404, {
          error: "رمز الاسترداد غير صالح",
          message:
            "الرمز المدخل غير موجود في قاعدة البيانات. تأكد من كتابة الرمز بشكل صحيح.",
        });
      }

      const codeData = redeemCodes.get(normalizedCode);
      if (codeData.redeemed) {
        return respond(400, {
          error: "تم استخدام هذا الرمز مسبقاً",
          message: `تم استرداد هذا الرمز بتاريخ ${new Date(codeData.redeemedAt).toLocaleDateString("ar-SA")}. كل رمز صالح للاستخدام مرة واحدة فقط.`,
        });
      }

      const txId = `LN-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
      codeData.redeemed = true;
      codeData.redeemedAt = new Date().toISOString();
      codeData.redeemedTo = lightningAddress;
      codeData.txId = txId;
      codeData.email = email || null;

      console.log(
        `[REDEEM] ✓ ${normalizedCode} | ${codeData.sats.toLocaleString()} sats → ${lightningAddress}`,
      );

      return respond(200, {
        success: true,
        message: `تم إرسال ${codeData.sats.toLocaleString()} ساتوشي إلى محفظتك بنجاح!`,
        playerName: codeData.playerName,
        sats: codeData.sats,
        lightningAddress,
        txId,
        redeemedAt: codeData.redeemedAt,
      });
    }

    // ---- GET /api/redeem/:code ----
    if (method === "GET" && path.startsWith("redeem/")) {
      const code = path.replace("redeem/", "").toUpperCase().trim();
      if (!redeemCodes.has(code))
        return respond(404, { error: "Code not found" });
      const codeData = redeemCodes.get(code);
      return respond(200, {
        playerName: codeData.playerName,
        sats: codeData.sats,
        redeemed: codeData.redeemed,
      });
    }

    // ---- 404 fallback ----
    return respond(404, { error: "Route not found", path, method });
  } catch (error) {
    console.error("[API ERROR]", error.message, error.stack);
    return respond(500, { error: error.message || "Internal server error" });
  }
};
