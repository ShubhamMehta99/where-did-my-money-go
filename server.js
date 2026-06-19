// ═══════════════════════════════════════════
//  Spending Tracker — Plaid Backend
//  Run with: node server.js
// ═══════════════════════════════════════════

require("dotenv").config();  // Load .env variables (PLAID_CLIENT_ID, PLAID_SECRET, etc.)
const express = require("express");
const cors    = require("cors");
const { PlaidApi, PlaidEnvironments, Configuration } = require("plaid");
const path = require("path");

// ── YOUR CREDENTIALS ── (paste from dashboard.plaid.com)
const PLAID_CLIENT_ID  = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET     = process.env.PLAID_SECRET;
const PLAID_ENV        = process.env.PLAID_ENV;  // sandbox | development | production

const app  = express();

// Auto-open browser when server starts
const { exec } = require("child_process");
app.use(cors({ origin: "*" }));   // tighten this in production
app.use(express.json());

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
      "PLAID-SECRET":    PLAID_SECRET,
    },
  },
});

const plaid = new PlaidApi(plaidConfig);

// ── 1. Create a link token (frontend calls this first) ──
app.post("/create-link-token", async (req, res) => {
  try {
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: "personal-dashboard" },
      client_name: "My Spending Tracker",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    });
    res.json({ link_token: response.data.link_token });
  } catch (e) {
    console.error("create-link-token error:", e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 2. Exchange public token for access token ──
app.post("/exchange-token", async (req, res) => {
  const { public_token, bank } = req.body;
  try {
    const response = await plaid.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    // In production, store this securely (encrypted DB/file).
    // For personal use, we return it to the frontend to keep in sessionStorage.
    console.log(`✓ Connected ${bank} — access_token: ${access_token}`);
    res.json({ access_token });
  } catch (e) {
    console.error("exchange-token error:", e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 3. Fetch transactions for a date range ──
app.post("/transactions", async (req, res) => {
  const { access_token, start_date, end_date } = req.body;
  try {
    const response = await plaid.transactionsGet({
      access_token,
      start_date,
      end_date,
      options: { count: 500, offset: 0 },
    });
    res.json({ transactions: response.data.transactions });
  } catch (e) {
    console.error("transactions error:", e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Serve frontend static file ──
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ── Expose safe config to frontend ──
app.get("/config", (req, res) => {
  res.json({ plaidEnv: PLAID_ENV });
});

// ── Password auth ──
app.post("/auth", (req, res) => {
  const { password } = req.body;
  if (password === process.env.APP_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

// ── Start server ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✓ Spending Tracker backend running on http://localhost:${PORT}`);
  console.log(`  Environment: ${PLAID_ENV}`);
  exec(`open http://localhost:${PORT}`); // auto-opens on Mac
});
