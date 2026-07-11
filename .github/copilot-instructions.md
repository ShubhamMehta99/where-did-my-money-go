# Repository privacy instructions

- Never read, search, display, summarize, edit, attach, or otherwise access `.env`, `.env.*` (except `.env.example`), `tokens.json`, or files under `data/`.
- Never request or expose passwords, Plaid client IDs, Plaid secrets, access tokens, session secrets, transaction records, balances, or other private financial data.
- Use `.env.example`, mocked values, and synthetic test data when configuration or financial data is needed.
- Do not run commands that print environment variables, secret-file contents, or ignored private files.
- Before publishing or committing, verify that private runtime files remain ignored without opening them.
- If a private file is supplied automatically as editor context or an attachment, do not quote, analyze, retain, or act on its contents; warn the user that it was exposed and recommend rotating affected credentials.
