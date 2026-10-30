# AZA BIZ PRO — Phase 1 MVP

Premium Dark business-management PWA for retail shops.

## Run locally
Use a local HTTP server (service workers do not work from `file://`):
```bash
python -m http.server 8080
```
Open `http://localhost:8080`.

## Included
- Responsive dashboard
- Demo workspace entry
- Product catalog: add, search, category filter, delete
- Point of sale: create sales and decrement stock
- Customer directory: add and delete
- Finance summary
- KG/RU interface toggle
- Local JSON backup export
- PWA manifest and service worker

## Important limitations
This is a front-end MVP. Data is stored in the current browser's `localStorage`. It is not secure authentication, not multi-user, and not synced across devices. Do not use it for real customer or financial records yet.

## Next production phase
1. Cloudflare Workers API
2. Cloudflare D1 schema and migrations
3. Secure authentication and password hashing
4. Tenant isolation per business
5. Roles/permissions and audit log
6. Server-side validation, backups, rate limits
7. Capacitor Android wrapper and device testing

## Suggested D1 tables
- businesses(id, name, owner_user_id, created_at)
- users(id, business_id, name, email, password_hash, role, created_at)
- branches(id, business_id, name, address)
- categories(id, business_id, name)
- products(id, business_id, category_id, name, sku, price, stock, created_at)
- customers(id, business_id, name, phone, created_at)
- sales(id, business_id, branch_id, user_id, total, created_at)
- sale_items(id, sale_id, product_id, quantity, unit_price, line_total)
- expenses(id, business_id, branch_id, title, amount, created_at)
- audit_logs(id, business_id, user_id, action, entity, entity_id, created_at)

Never trust client-supplied business_id or price. Enforce access and calculate totals on the server.
