// ═══════════════════════════════════════════
//  Where’d My Money Go? — Plaid Backend
//  Run with: node server.js
// ═══════════════════════════════════════════

require("dotenv").config();  // Load .env variables (PLAID_CLIENT_ID, PLAID_SECRET, etc.)
const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const { rateLimit } = require("express-rate-limit");
const { PlaidApi, PlaidEnvironments, Configuration } = require("plaid");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const TOKENS_FILE = path.join(__dirname, "tokens.json");
const DATA_DIR    = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ── YOUR CREDENTIALS ── (paste from dashboard.plaid.com)
const PLAID_CLIENT_ID  = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET     = process.env.PLAID_SECRET;
const PLAID_ENV        = process.env.PLAID_ENV || "sandbox";

if (!PLAID_CLIENT_ID || !PLAID_SECRET || !process.env.APP_PASSWORD) {
  console.error("Missing required environment variables: PLAID_CLIENT_ID, PLAID_SECRET, and APP_PASSWORD.");
  process.exit(1);
}
if (!PlaidEnvironments[PLAID_ENV]) {
  console.error(`Invalid PLAID_ENV: ${PLAID_ENV}. Use sandbox, development, or production.`);
  process.exit(1);
}

const app  = express();

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use(session({
  name: "wmmg.sid",
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "strict", secure: false, maxAge: 12 * 60 * 60 * 1000 },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { ok: false, error: "Too many login attempts. Try again later." },
});

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

function writePrivateJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

if (fs.existsSync(TOKENS_FILE)) fs.chmodSync(TOKENS_FILE, 0o600);
for (const file of fs.readdirSync(DATA_DIR).filter(name => name.endsWith(".json"))) {
  fs.chmodSync(path.join(DATA_DIR, file), 0o600);
}

function loadTokens() {
  if (fs.existsSync(TOKENS_FILE)) {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  }
  return {};
}

function saveToken(bank, access_token) {
  const tokens = loadTokens();
  tokens[bank] = access_token;
  writePrivateJson(TOKENS_FILE, tokens);
}

function validBank(bank) {
  return typeof bank === "string" && /^[a-z0-9_]{1,64}$/.test(bank);
}

function getAccessToken(bank) {
  return validBank(bank) ? loadTokens()[bank] : undefined;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function fetchAllTransactions(access_token, start_date, end_date) {
  const transactions = [];
  let offset = 0;
  let total = 0;
  do {
    const response = await plaid.transactionsGet({
      access_token,
      start_date,
      end_date,
      options: { count: 500, offset },
    });
    transactions.push(...response.data.transactions);
    total = response.data.total_transactions;
    offset = transactions.length;
  } while (offset < total);
  return transactions;
}

async function fetchAllInvestmentTransactions(access_token, start_date, end_date) {
  const transactions = [];
  let offset = 0;
  let total = 0;
  do {
    const response = await plaid.investmentsTransactionsGet({
      access_token,
      start_date,
      end_date,
      options: { count: 500, offset },
    });
    transactions.push(...response.data.investment_transactions);
    total = response.data.total_investment_transactions;
    offset = transactions.length;
  } while (offset < total);
  return transactions;
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
  writePrivateJson(file, cached);
}

// ── Authentication ──
app.post("/auth", loginLimiter, (req, res) => {
  const supplied = Buffer.from(String(req.body?.password || ""));
  const expected = Buffer.from(process.env.APP_PASSWORD);
  const matches = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  if (!matches) return res.status(401).json({ ok: false });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ ok: false, error: "Could not create session." });
    req.session.authenticated = true;
    res.json({ ok: true });
  });
});

app.get("/auth/status", (req, res) => {
  res.json({ authenticated: req.session.authenticated === true });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("wmmg.sid");
    res.json({ ok: true });
  });
});

app.use((req, res, next) => {
  if (req.method === "GET" && (req.path === "/" || req.path === "/config")) return next();
  if (req.session.authenticated === true) return next();
  res.status(401).json({ error: "Authentication required." });
});

// ── 1a. Create a link token for spending accounts (transactions product) ──
app.post("/create-link-token", async (req, res) => {
  try {
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: "personal-dashboard" },
      client_name: "Where'd My Money Go?",
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
    const { bank } = req.body || {};
    const access_token = bank ? getAccessToken(bank) : undefined;
    if (bank && !access_token) return res.status(404).json({ error: "Account not found." });
    const linkParams = {
      user: { client_user_id: "personal-dashboard" },
      client_name: "Where'd My Money Go?",
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
  if (!public_token || !validBank(bank)) return res.status(400).json({ error: "Valid public_token and bank are required." });
  try {
    const response = await plaid.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    saveToken(bank, access_token);
    res.json({ bank });
  } catch (e) {
    console.error("exchange-token error:", e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 3. Fetch transactions for a date range ──
app.post("/transactions", async (req, res) => {
  const { start_date, end_date, bank } = req.body;
  const access_token = getAccessToken(bank);
  if (!access_token) return res.status(404).json({ error: "Account not found." });
  if (!validDate(start_date) || !validDate(end_date) || start_date > end_date) {
    return res.status(400).json({ error: "Valid start_date and end_date are required." });
  }
  try {
    const transactions = await fetchAllTransactions(access_token, start_date, end_date);
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
  const { start_date, end_date, bank } = req.body;
  const access_token = getAccessToken(bank);
  if (!access_token) return res.status(404).json({ error: "Account not found." });
  if (!validDate(start_date) || !validDate(end_date) || start_date > end_date) {
    return res.status(400).json({ error: "Valid start_date and end_date are required." });
  }
  try {
    const transactions = await fetchAllInvestmentTransactions(access_token, start_date, end_date);
    if (bank && start_date) {
      const [year, month] = start_date.split("-");
      const file = getMonthFile(year, month);
      const cached = loadCachedTransactions(year, month);
      const invKey = bank + "_inv";
      const existingMap = new Map((cached[invKey] || []).map(t => [t.investment_transaction_id, t]));
      transactions.forEach(t => existingMap.set(t.investment_transaction_id, t));
      cached[invKey] = Array.from(existingMap.values());
      writePrivateJson(file, cached);
    }
    res.json({ transactions });
  } catch (e) {
    const errData = e.response?.data;
    const errCode = errData?.error_code || "UNKNOWN";
    // NO_INVESTMENT_ACCOUNTS is expected when an Item has no brokerage accounts — not a real error
    if (errCode === "NO_INVESTMENT_ACCOUNTS") {
      console.warn(`investment-transactions: ${bank || "unknown"} has no investment accounts, skipping.`);
      return res.json({ transactions: [], unavailable_reason: errCode });
    } else {
      console.error("investment-transactions error:", errData || e.message);
    }
    res.status(502).json({ error: "Plaid could not retrieve investment transactions.", error_code: errCode });
  }
});

// ── 5. Return cached transactions for a given month ──
app.get("/cached-transactions", (req, res) => {
  const { year, month } = req.query;
  if (!/^\d{4}$/.test(year || "") || !/^(0[1-9]|1[0-2])$/.test(month || "")) {
    return res.status(400).json({ error: "Valid year and month required." });
  }
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

// ── Expose connected account names only; access tokens never leave the server ──
app.get("/tokens", (req, res) => {
  const tokens = loadTokens();
  res.json(Object.fromEntries(Object.keys(tokens).filter(key => key !== "_types").map(key => [key, true])));
});

// ── Account types (spending vs investment) ──
app.get("/account-types", (req, res) => {
  const t = loadTokens();
  res.json(t._types || {});
});

app.post("/account-types", (req, res) => {
  const { bank, type } = req.body;
  if (!validBank(bank) || !["spending", "investment"].includes(type)) {
    return res.status(400).json({ error: "Valid bank and type required." });
  }
  const t = loadTokens();
  t._types = t._types || {};
  t._types[bank] = type;
  writePrivateJson(TOKENS_FILE, t);
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
  const access_token = getAccessToken(req.body?.bank);
  if (!access_token) return res.status(404).json({ error: "Account not found." });
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
  if (typeof transaction_id !== "string" || !transaction_id || transaction_id.length > 256) {
    return res.status(400).json({ error: "Valid transaction_id required." });
  }
  if (category != null && (typeof category !== "string" || category.length > 80)) {
    return res.status(400).json({ error: "Invalid category." });
  }
  const overrides = loadOverrides();
  if (category) {
    overrides[transaction_id] = category;
  } else {
    delete overrides[transaction_id]; // null/undefined category = clear override
  }
  writePrivateJson(OVERRIDES_FILE, overrides);
  res.json({ ok: true });
});

// ── Start server ──
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`\n✓ Where'd My Money Go? running on http://${HOST}:${PORT}`);
  console.log(`  Environment: ${PLAID_ENV}`);
  if (!process.env.SESSION_SECRET) console.warn("  Warning: SESSION_SECRET is unset; using a temporary cookie-signing key.");
});
