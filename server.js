// ═══════════════════════════════════════════
//  Spending Tracker — Plaid Backend
//  Run with: node server.js
// ═══════════════════════════════════════════

require("dotenv").config();  // Load .env variables (PLAID_CLIENT_ID, PLAID_SECRET, etc.)
const express = require("express");
const cors    = require("cors");
const { PlaidApi, PlaidEnvironments, Configuration } = require("plaid");
const path = require("path");
const fs = require("fs");
const TOKENS_FILE = "./tokens.json";
const DATA_DIR    = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

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

function loadTokens() {
  if (fs.existsSync(TOKENS_FILE)) {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  }
  return {};
}

function saveToken(bank, access_token) {
  const tokens = loadTokens();
  tokens[bank] = access_token;
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function getMonthFile(year, month) {
  return path.join(DATA_DIR, `transactions-${year}-${String(month).padStart(2, "0")}.json`);
}

function loadCachedTransactions(year, month) {
  const file = getMonthFile(year, month);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  return {};
}

function saveCachedTransactions(year, month, bank, transactions) {
  const file = getMonthFile(year, month);
  const cached = loadCachedTransactions(year, month);
  // Deduplicate by transaction_id — new data wins
  const existingMap = new Map((cached[bank] || []).map(t => [t.transaction_id, t]));
  transactions.forEach(t => existingMap.set(t.transaction_id, t));
  // Remove pending transactions that have been superseded by a posted transaction.
  // When Plaid settles a pending tx it creates a new transaction_id and sets
  // pending_transaction_id to the old pending id — so we drop the old pending entry.
  const supersededIds = new Set(
    Array.from(existingMap.values())
      .map(t => t.pending_transaction_id)
      .filter(Boolean)
  );
  cached[bank] = Array.from(existingMap.values()).filter(t => !supersededIds.has(t.transaction_id));
  fs.writeFileSync(file, JSON.stringify(cached, null, 2));
}

// ── 1a. Create a link token for spending accounts (transactions product) ──
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

// ── 1b. Create a link token for investment accounts (investments product) ──
// If access_token is provided in the body, uses Plaid update mode to ADD the investments
// product to the existing Item — does NOT create a new connection, safe when near limits.
app.post("/create-investment-link-token", async (req, res) => {
  try {
    const { access_token } = req.body || {};
    const linkParams = {
      user: { client_user_id: "personal-dashboard" },
      client_name: "My Spending Tracker",
      country_codes: ["US"],
      language: "en",
    };
    if (access_token) {
      // Update mode: upgrade existing Item to add investments product.
      // This does NOT count as a new connection.
      linkParams.access_token = access_token;
      linkParams.additional_consented_products = ["investments"];
    } else {
      // New brokerage link
      linkParams.products = ["investments"];
    }
    const response = await plaid.linkTokenCreate(linkParams);
    res.json({ link_token: response.data.link_token });
  } catch (e) {
    console.error("create-investment-link-token error:", e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 2. Exchange public token for access token ──
app.post("/exchange-token", async (req, res) => {
  const { public_token, bank } = req.body;
  try {
    const response = await plaid.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    saveToken(bank, access_token);
    res.json({ access_token, bank });
  } catch (e) {
    console.error("exchange-token error:", e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 3. Fetch transactions for a date range ──
app.post("/transactions", async (req, res) => {
  const { access_token, start_date, end_date, bank } = req.body;
  try {
    const response = await plaid.transactionsGet({
      access_token,
      start_date,
      end_date,
      options: { count: 500, offset: 0 },
    });
    const transactions = response.data.transactions;
    // Persist to disk for future loads
    if (bank && start_date) {
      const [year, month] = start_date.split("-");
      saveCachedTransactions(year, month, bank, transactions);
    }
    res.json({ transactions });
  } catch (e) {
    console.error("transactions error:", e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 4. Fetch investment transactions (buy/sell/dividend) from brokerage accounts ──
app.post("/investment-transactions", async (req, res) => {
  const { access_token, start_date, end_date, bank } = req.body;
  if (!access_token) return res.status(400).json({ error: "access_token required" });
  try {
    const response = await plaid.investmentsTransactionsGet({
      access_token,
      start_date,
      end_date,
      options: { count: 500, offset: 0 },
    });
    const transactions = response.data.investment_transactions;
    if (bank && start_date) {
      const [year, month] = start_date.split("-");
      const file = getMonthFile(year, month);
      const cached = loadCachedTransactions(year, month);
      const invKey = bank + "_inv";
      const existingMap = new Map((cached[invKey] || []).map(t => [t.investment_transaction_id, t]));
      transactions.forEach(t => existingMap.set(t.investment_transaction_id, t));
      cached[invKey] = Array.from(existingMap.values());
      fs.writeFileSync(file, JSON.stringify(cached, null, 2));
    }
    res.json({ transactions });
  } catch (e) {
    console.error("investment-transactions error:", e.response?.data || e.message);
    const errCode = e.response?.data?.error_code || "UNKNOWN";
    res.status(500).json({ error: e.message, error_code: errCode });
  }
});

// ── 5. Return cached transactions for a given month ──
app.get("/cached-transactions", (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: "year and month required" });
  res.json(loadCachedTransactions(year, month));
});

// ── Serve frontend static file ──
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ── Expose safe config to frontend ──
app.get("/config", (req, res) => {
  res.json({ plaidEnv: PLAID_ENV });
});

// ── Expose stored tokens to frontend ──
app.get("/tokens", (req, res) => {
  res.json(loadTokens());
});

// ── Account types (spending vs investment) ──
app.get("/account-types", (req, res) => {
  const t = loadTokens();
  res.json(t._types || {});
});

app.post("/account-types", (req, res) => {
  const { bank, type } = req.body;
  if (!bank || !type) return res.status(400).json({ error: "bank and type required" });
  const t = loadTokens();
  t._types = t._types || {};
  t._types[bank] = type;
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2));
  res.json({ ok: true });
});

// ── Investment totals across all cached months ──
app.get("/investment-totals", (req, res) => {
  const t = loadTokens();
  const invBanks = Object.entries(t._types || {})
    .filter(([, type]) => type === "investment")
    .map(([bank]) => bank);
  if (invBanks.length === 0) return res.json({ allTime: 0, ytd: 0 });
  const currentYear = new Date().getFullYear();
  let allTime = 0, ytd = 0;
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => /^transactions-\d{4}-\d{2}\.json$/.test(f));
    files.forEach(file => {
      const match = file.match(/transactions-(\d{4})-\d{2}\.json/);
      if (!match) return;
      const year = parseInt(match[1]);
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
      invBanks.forEach(bank => {
        // Regular transactions: deposits are credits (amount < 0)
        const regTotal = (data[bank] || []).filter(tx => tx.amount < 0).reduce((s, tx) => s + Math.abs(tx.amount), 0);
        // Investment transactions: contributions/purchases are debits (amount > 0)
        const invTotal = (data[bank + "_inv"] || []).filter(tx => tx.amount > 0).reduce((s, tx) => s + tx.amount, 0);
        const total = regTotal + invTotal;
        allTime += total;
        if (year === currentYear) ytd += total;
      });
    });
  } catch(e) { console.error("investment-totals error:", e); }
  res.json({ allTime, ytd });
});

// ── Fetch current account balances ──
app.post("/balances", async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: "access_token required" });
  try {
    const response = await plaid.accountsBalanceGet({ access_token });
    res.json({ accounts: response.data.accounts });
  } catch(e) {
    console.error("balances error:", e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Category overrides (manual recategorisation) ──
const OVERRIDES_FILE = path.join(DATA_DIR, "category-overrides.json");

function loadOverrides() {
  if (fs.existsSync(OVERRIDES_FILE)) return JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8"));
  return {};
}

app.get("/category-overrides", (req, res) => {
  res.json(loadOverrides());
});

app.post("/category-overrides", (req, res) => {
  const { transaction_id, category } = req.body;
  if (!transaction_id) return res.status(400).json({ error: "transaction_id required" });
  const overrides = loadOverrides();
  if (category) {
    overrides[transaction_id] = category;
  } else {
    delete overrides[transaction_id]; // null/undefined category = clear override
  }
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
  res.json({ ok: true });
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
