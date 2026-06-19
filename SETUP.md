# Spending Tracker — Setup Instructions

## What you need
- A computer (Mac, Windows, or Linux)
- About 15 minutes

---

## STEP 1 — Install Node.js

1. Go to https://nodejs.org
2. Download the **LTS** version (the green button)
3. Install it — click through all the defaults
4. To verify, open Terminal (Mac) or Command Prompt (Windows) and type:
   `node --version`
   You should see something like `v20.x.x`

---

## STEP 2 — Get your free Plaid API keys

1. Go to https://dashboard.plaid.com/signup
2. Create a free account (no credit card needed)
3. Once logged in, go to **Team Settings → Keys**
4. Copy your:
   - **client_id**
   - **Sandbox secret** (the one labeled "sandbox")
5. Keep this tab open — you'll paste these in Step 4

---

## STEP 3 — Set up your project files

1. Create a folder on your computer called `spending-tracker`
   (e.g. on your Desktop)
2. Copy all 3 files into that folder:
   - `index.html`
   - `server.js`
   - `package.json`

---

## STEP 4 — Add your credentials

### In `server.js`:
Open the file in any text editor (Notepad, TextEdit, VS Code) and replace:
```
"YOUR_PLAID_CLIENT_ID"      →  your actual client_id
"YOUR_PLAID_SANDBOX_SECRET" →  your actual sandbox secret
```

### In `index.html`:
Find the CONFIG section near the top and replace:
```
password:      "YOUR_PASSWORD_HERE"   →  a password only you know
plaidClientId: "YOUR_PLAID_CLIENT_ID" →  same client_id as above
plaidSecret:   "YOUR_PLAID_SANDBOX_SECRET" →  same secret as above
```

---

## STEP 5 — Install and run

1. Open Terminal (Mac: Spotlight → Terminal) or Command Prompt (Windows: Start → cmd)
2. Navigate to your folder:
   ```
   cd Desktop/spending-tracker
   ```
3. Install the required packages (only needed once):
   ```
   npm install
   ```
4. Start the backend server:
   ```
   node server.js
   ```
   You should see: `✓ Spending Tracker backend running on http://localhost:3000`

---

## STEP 6 — Open the app

1. Open `index.html` directly in your browser
   (double-click the file, or drag it into Chrome/Safari/Firefox)
2. Enter the password you set in Step 4
3. You'll see demo data already — click **Connect** on Amex or Chase

---

## STEP 7 — Connect your accounts (Sandbox test)

In Sandbox mode, Plaid uses **fake test credentials**:
- Username: `user_good`
- Password: `pass_good`

This logs you into a simulated bank account with realistic fake transactions.
Your real bank credentials are NOT used in sandbox mode.

---

## Going live with real bank data

When you're ready to connect real accounts:

1. In Plaid dashboard, apply for **Development** access
   (free, takes 1–3 days to get approved)
2. In both `server.js` and `index.html`, change:
   ```
   plaidEnv: "sandbox"  →  "development"
   ```
   And use your **Development secret** instead of Sandbox secret
3. Restart the server (`node server.js` again)
4. Click Connect — this time it will use real bank login

---

## Security notes

- The app only runs on your computer — nothing is uploaded to any server
- Your password is checked locally in the browser
- Access tokens (your bank connection) are stored only in your browser session
   and disappear when you close the tab
- In sandbox mode: zero risk — no real bank data involved

---

## Troubleshooting

**"Cannot connect" error when clicking Connect:**
→ Make sure `node server.js` is still running in your terminal

**"Incorrect password" even with the right password:**
→ Check `index.html` — make sure the password has no extra spaces

**Port already in use:**
→ Change `const PORT = 3000` to `3001` in `server.js`, and
   `backendUrl: "http://localhost:3001"` in `index.html`

---

Questions? Just ask Claude!
