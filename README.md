# AZA BIZ PRO — Complete source package v2.0.2

Professional dark business-management PWA with a Cloudflare Workers API and D1 database. This package combines the GitHub Pages frontend, Worker source, D1 schema, tests, and deployment notes in one repository-ready folder.

## Repository structure

- `index.html`, `styles.css`, `app.js` — responsive web application.
- `api-config.js` — production API endpoint configuration.
- `manifest.webmanifest`, `sw.js`, `assets/icon.svg` — PWA installation and static caching.
- `backend/worker.js` — Cloudflare Worker API source (v2.0.2 diagnostic build).
- `backend/migrations/0001_initial.sql` — D1 schema, indexes, and stock triggers.
- `tests/schema_smoke.py` — SQLite-compatible schema and stock-trigger test.
- `wrangler.toml`, `package.json` — Wrangler configuration and scripts.
- `capacitor.config.json` — Capacitor project configuration for a later native Android wrapper.
- `START_KY.md` — Kyrgyz deployment and verification guide.

## Current production connection

The frontend is configured to use:

`https://aza-biz-pro-api.azataycan2002.workers.dev`

The production Worker health check was verified to return `ok: true` and `database: connected`. This only confirms that the Worker is reachable and its D1 binding can execute a basic query; it does not prove that every application table/column matches the migration. Registration must still be retested and, if it fails, the Worker diagnostic log should be checked.

## Important: protect the existing production database

**Do not create a new D1 database and do not delete, reset, or replace the existing production database.** The live database identifier is intentionally not embedded in this source package. `wrangler.toml` contains `REPLACE_WITH_D1_DATABASE_ID` as a placeholder; before using Wrangler to deploy or apply migrations, replace it with the UUID of the existing `aza-biz-pro-db` database from the Cloudflare dashboard. Do not run `wrangler d1 create` for the live project.

Before changing an existing production schema, inspect it in the D1 Console with this read-only query:

```sql
SELECT name, sql
FROM sqlite_master
WHERE type = 'table'
  AND name IN ('businesses', 'branches', 'users', 'sessions')
ORDER BY name;
```

`CREATE TABLE IF NOT EXISTS` does not add missing columns to an already existing table. Compare the deployed schema with `backend/migrations/0001_initial.sql` and make a reviewed, additive migration if required. Keep a backup before any production schema change.

## Frontend: GitHub Pages

The site is intended to be published from the repository root on the `main` branch. Keep the following files at the repository root: `index.html`, `styles.css`, `api-config.js`, `app.js`, `manifest.webmanifest`, and `sw.js`. The allowed frontend origin in the Worker is `https://azataycan.github.io`. If the site moves to another domain, update the Worker `ALLOWED_ORIGINS` variable to the exact origin.

## Backend: Cloudflare Worker + D1

The Worker entry point is `backend/worker.js`; the D1 binding name must be exactly `DB`. The production Worker should keep its existing binding and existing D1 database.

For a fresh non-production environment only:

1. Install Node.js and run `npm install`.
2. Create a separate test D1 database and put its UUID in a separate Wrangler configuration.
3. Apply `backend/migrations/0001_initial.sql` to that test database.
4. Deploy the Worker to a test Worker name and configure `DB` plus `ALLOWED_ORIGINS`.
5. Verify `/api/health`, registration, login, products, customers, sales, and expenses end-to-end.

For the existing production Worker, use the Cloudflare dashboard and the current production D1 binding. Do not redeploy merely because the repository is updated.

## Included functionality

- Company registration and email/password login.
- PBKDF2-SHA-256 password hashes with random salts.
- Opaque bearer sessions; SHA-256 token hashes stored in D1; logout revocation and 14-day expiry.
- Failed-login throttling.
- Business-level tenant scoping in API queries.
- Products, customers, sales, expenses, and dashboard statistics backed by D1.
- Server-side sale price calculation and stock validation.
- SQL stock movement log and insufficient-stock trigger.
- Product archive/edit, customer archive, expense create/delete.
- Responsive Russian/Kyrgyz interface and installable PWA.

## Not included / not yet production-certified

Employee invitations and permissions UI, password reset email, receipt printer integration, barcode scanning, QR payment reconciliation, tax/accounting exports, automated backups, and a full independent security audit are not included. The Capacitor configuration is present, but this package does not include a signed Android APK or Play Store release.

## Local checks

```bash
node --check app.js
node --check backend/worker.js
python tests/schema_smoke.py
```

Or run the schema test through npm:

```bash
npm run test:schema
```

## Security

Never commit passwords, API tokens, Cloudflare secrets, or `.dev.vars`. Never put the D1 database credentials in browser code. All data access must go through the Worker. Do not use this as the sole financial ledger until production flows, backups, monitoring, and security review are completed.
