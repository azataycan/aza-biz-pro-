const SESSION_DAYS = 14;
const PASSWORD_ITERATIONS = 600000;
const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_ALLOWED_ORIGINS = ["https://azataycan.github.io"];

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers
    }
  });
}

function cors(request, env) {
  const origin = request.headers.get("Origin");
  const configured = String(env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
    .split(",").map((item) => item.trim()).filter(Boolean);
  const headers = { "Vary": "Origin" };
  if (origin && configured.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,DELETE,OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization,Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function uuid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(digest));
}
async function passwordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_ITERATIONS }, key, 256);
  return `pbkdf2$${PASSWORD_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;
}
async function verifyPassword(password, encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) return false;
  const decode = (str) => {
    const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  };
  const salt = decode(parts[2]);
  const expected = decode(parts[3]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, expected.length * 8));
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

async function readJson(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) throw new ApiError("Слишком большой запрос.", 413);
  let raw;
  try { raw = await request.text(); }
  catch { throw new ApiError("Не удалось прочитать запрос.", 400); }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new ApiError("Слишком большой запрос.", 413);
  try { return JSON.parse(raw || "{}"); }
  catch { throw new ApiError("Некорректный JSON в запросе.", 400); }
}
function cleanText(value, max = 120, required = false) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new ApiError("Заполните обязательные поля.", 400);
  if (text.length > max) throw new ApiError("Слишком длинное значение.", 400);
  return text;
}
function positiveInt(value, label, { zero = false, max = 100000000 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (zero ? 0 : 1) || number > max) throw new ApiError(`Некорректное значение: ${label}.`, 400);
  return number;
}
class ApiError extends Error {
  constructor(message, status = 400, code = "BAD_REQUEST") { super(message); this.status = status; this.code = code; }
}

async function requireDb(env) {
  if (!env.DB) throw new ApiError("D1 database binding DB is not configured.", 503, "DATABASE_NOT_CONFIGURED");
  return env.DB;
}

async function authenticate(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || token.length < 30 || token.length > 200) throw new ApiError("Требуется вход в аккаунт.", 401, "UNAUTHORIZED");
  const db = await requireDb(env);
  const tokenHash = await sha256(token);
  const session = await db.prepare(`
    SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.business_id, u.name AS user_name,
           u.email, u.role, b.name AS business_name, b.currency, b.timezone
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN businesses b ON b.id = u.business_id
    WHERE s.token_hash = ? AND u.is_active = 1 AND s.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, nowIso()).first();
  if (!session) throw new ApiError("Сессия истекла. Войдите снова.", 401, "SESSION_EXPIRED");
  return {
    db,
    session,
    user: { id: session.user_id, name: session.user_name, email: session.email, role: session.role },
    business: { id: session.business_id, name: session.business_name, currency: session.currency, timezone: session.timezone }
  };
}

async function createSession(db, userId) {
  const token = randomToken();
  const id = uuid();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, userId, await sha256(token), expiresAt, nowIso()).run();
  return { token, expiresAt };
}

async function authRegister(request, env) {
  let stage = "read_request";
  try {
    const body = await readJson(request);

    stage = "validate_input";
    const companyName = cleanText(body.companyName, 80, true);
    const ownerName = cleanText(body.ownerName, 80, true);
    const email = cleanText(body.email, 190, true).toLowerCase();
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError("Введите корректный email.", 400);
    if (password.length < 10 || password.length > 128) throw new ApiError("Пароль должен содержать от 10 до 128 символов.", 400);

    stage = "check_database_binding";
    const db = await requireDb(env);

    stage = "check_existing_email";
    const existing = await db.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first();
    if (existing) throw new ApiError("Этот email уже зарегистрирован. Войдите в аккаунт.", 409, "EMAIL_EXISTS");

    const businessId = uuid(), userId = uuid(), branchId = uuid();
    const createdAt = nowIso();

    stage = "hash_password";
    const hash = await passwordHash(password);

    stage = "insert_business_branch_owner";
    try {
      await db.batch([
        db.prepare("INSERT INTO businesses (id, name, currency, timezone, created_at, updated_at) VALUES (?, ?, 'KGS', 'Asia/Bishkek', ?, ?)").bind(businessId, companyName, createdAt, createdAt),
        db.prepare("INSERT INTO branches (id, business_id, name, is_default, created_at) VALUES (?, ?, 'Главный филиал', 1, ?)").bind(branchId, businessId, createdAt),
        db.prepare("INSERT INTO users (id, business_id, name, email, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, ?, 'OWNER', 1, ?)").bind(userId, businessId, ownerName, email, hash, createdAt)
      ]);
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) throw new ApiError("Этот email уже зарегистрирован.", 409, "EMAIL_EXISTS");
      throw error;
    }

    stage = "create_session";
    const session = await createSession(db, userId);

    stage = "send_registration_response";
    return json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: userId, name: ownerName, email, role: "OWNER" },
      business: { id: businessId, name: companyName, currency: "KGS", timezone: "Asia/Bishkek" }
    }, 201);
  } catch (error) {
    if (!(error instanceof ApiError)) {
      console.error("AZA_BIZ_PRO_REGISTER_DIAGNOSTIC", {
        stage,
        errorName: String(error?.name || "Error"),
        errorMessage: String(error?.message || error || "Unknown error").slice(0, 1000),
        stack: String(error?.stack || "").slice(0, 3000)
      });
    }
    throw error;
  }
}

async function authLogin(request, env) {
  const body = await readJson(request);
  const email = cleanText(body.email, 190, true).toLowerCase();
  const password = String(body.password || "");
  if (password.length > 128) throw new ApiError("Пароль слишком длинный.", 400);
  const db = await requireDb(env);
  const now = nowIso();
  const lock = await db.prepare("SELECT attempts, window_started_at, blocked_until FROM auth_attempts WHERE email = ? LIMIT 1").bind(email).first();
  if (lock?.blocked_until && lock.blocked_until > now) throw new ApiError("Слишком много попыток. Попробуйте позже.", 429, "RATE_LIMITED");
  const user = await db.prepare("SELECT id, business_id, name, email, password_hash, role, is_active FROM users WHERE email = ? LIMIT 1").bind(email).first();
  const valid = user && user.is_active === 1 ? await verifyPassword(password, user.password_hash) : false;
  if (!valid) {
    const withinWindow = lock?.window_started_at && Date.now() - new Date(lock.window_started_at).getTime() < 15 * 60 * 1000;
    const attempts = withinWindow ? Number(lock.attempts) + 1 : 1;
    const windowStarted = withinWindow ? lock.window_started_at : now;
    const blockedUntil = attempts >= 8 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
    await db.prepare(`INSERT INTO auth_attempts (email, attempts, window_started_at, blocked_until)
      VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET attempts = excluded.attempts,
      window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until`)
      .bind(email, attempts, windowStarted, blockedUntil).run();
    throw new ApiError("Email или пароль указаны неверно.", 401, "INVALID_CREDENTIALS");
  }
  await db.prepare("DELETE FROM auth_attempts WHERE email = ?").bind(email).run();
  const session = await createSession(db, user.id);
  const business = await db.prepare("SELECT id, name, currency, timezone FROM businesses WHERE id = ?").bind(user.business_id).first();
  return json({ token: session.token, expiresAt: session.expiresAt, user: { id: user.id, name: user.name, email: user.email, role: user.role }, business });
}

async function authMe(auth) {
  return json({ user: auth.user, business: auth.business });
}

async function authLogout(request, auth) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token) await auth.db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return json({ ok: true });
}

async function getProducts(auth, url) {
  const limit = Math.floor(Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200)));
  const result = await auth.db.prepare(`SELECT id, name, sku, category, price, cost_price, stock, min_stock, created_at, updated_at
    FROM products WHERE business_id = ? AND is_active = 1 ORDER BY name COLLATE NOCASE LIMIT ?`)
    .bind(auth.business.id, limit).all();
  return json({ products: result.results || [] });
}

async function createProduct(request, auth) {
  const body = await readJson(request);
  const name = cleanText(body.name, 120, true);
  const sku = cleanText(body.sku, 60) || null;
  const category = cleanText(body.category, 60) || "Без категории";
  const price = positiveInt(body.price, "price");
  const costPrice = positiveInt(body.costPrice ?? 0, "costPrice", { zero: true });
  const stock = positiveInt(body.stock, "stock", { zero: true, max: 10000000 });
  const minStock = positiveInt(body.minStock ?? 0, "minStock", { zero: true, max: 10000000 });
  const id = uuid(), timestamp = nowIso();
  try {
    const statements = [auth.db.prepare(`INSERT INTO products (id, business_id, name, sku, category, price, cost_price, stock, min_stock, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(id, auth.business.id, name, sku, category, price, costPrice, stock, minStock, timestamp, timestamp)];
    if (stock > 0) statements.push(auth.db.prepare(`INSERT INTO stock_movements (id, business_id, product_id, user_id, movement_type, quantity_delta, note, created_at)
      VALUES (?, ?, ?, ?, 'INITIAL', ?, 'Initial stock', ?)`)
      .bind(uuid(), auth.business.id, id, auth.user.id, stock, timestamp));
    await auth.db.batch(statements);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new ApiError("Товар с таким артикулом уже существует.", 409);
    throw error;
  }
  return json({ product: { id, name, sku, category, price, cost_price: costPrice, stock, min_stock: minStock, created_at: timestamp, updated_at: timestamp } }, 201);
}

async function updateProduct(request, auth, id) {
  const body = await readJson(request);
  const current = await auth.db.prepare("SELECT * FROM products WHERE id = ? AND business_id = ? AND is_active = 1 LIMIT 1").bind(id, auth.business.id).first();
  if (!current) throw new ApiError("Товар не найден.", 404);
  const name = body.name === undefined ? current.name : cleanText(body.name, 120, true);
  const sku = body.sku === undefined ? current.sku : (cleanText(body.sku, 60) || null);
  const category = body.category === undefined ? current.category : (cleanText(body.category, 60) || "Без категории");
  const price = body.price === undefined ? current.price : positiveInt(body.price, "price");
  const costPrice = body.costPrice === undefined ? current.cost_price : positiveInt(body.costPrice, "costPrice", { zero: true });
  const stock = body.stock === undefined ? current.stock : positiveInt(body.stock, "stock", { zero: true, max: 10000000 });
  const minStock = body.minStock === undefined ? current.min_stock : positiveInt(body.minStock, "minStock", { zero: true, max: 10000000 });
  const timestamp = nowIso();
  const statements = [auth.db.prepare(`UPDATE products SET name=?, sku=?, category=?, price=?, cost_price=?, stock=?, min_stock=?, updated_at=? WHERE id=? AND business_id=?`)
    .bind(name, sku, category, price, costPrice, stock, minStock, timestamp, id, auth.business.id)];
  if (stock !== Number(current.stock)) statements.push(auth.db.prepare(`INSERT INTO stock_movements (id, business_id, product_id, user_id, movement_type, quantity_delta, note, created_at)
    VALUES (?, ?, ?, ?, 'ADJUSTMENT', ?, 'Manual stock adjustment', ?)`)
    .bind(uuid(), auth.business.id, id, auth.user.id, stock - Number(current.stock), timestamp));
  try { await auth.db.batch(statements); }
  catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new ApiError("Товар с таким артикулом уже существует.", 409);
    throw error;
  }
  return json({ ok: true });
}

async function archiveProduct(auth, id) {
  const result = await auth.db.prepare("UPDATE products SET is_active = 0, updated_at = ? WHERE id = ? AND business_id = ? AND is_active = 1")
    .bind(nowIso(), id, auth.business.id).run();
  if (!result.meta?.changes) throw new ApiError("Товар не найден.", 404);
  return json({ ok: true });
}

async function getCustomers(auth, url) {
  const limit = Math.floor(Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200)));
  const result = await auth.db.prepare("SELECT id, name, phone, email, created_at FROM customers WHERE business_id = ? AND is_archived = 0 ORDER BY created_at DESC LIMIT ?")
    .bind(auth.business.id, limit).all();
  return json({ customers: result.results || [] });
}

async function createCustomer(request, auth) {
  const body = await readJson(request);
  const name = cleanText(body.name, 100, true);
  const phone = cleanText(body.phone, 30) || null;
  const email = cleanText(body.email, 190).toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError("Некорректный email клиента.", 400);
  const id = uuid(), timestamp = nowIso();
  await auth.db.prepare("INSERT INTO customers (id, business_id, name, phone, email, is_archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .bind(id, auth.business.id, name, phone, email, timestamp).run();
  return json({ customer: { id, name, phone, email, created_at: timestamp } }, 201);
}

async function archiveCustomer(auth, id) {
  const result = await auth.db.prepare("UPDATE customers SET is_archived = 1 WHERE id = ? AND business_id = ? AND is_archived = 0")
    .bind(id, auth.business.id).run();
  if (!result.meta?.changes) throw new ApiError("Клиент не найден.", 404);
  return json({ ok: true });
}

async function createSale(request, auth) {
  const body = await readJson(request);
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 40) throw new ApiError("Добавьте от 1 до 40 позиций в чек.", 400);
  const paymentMethod = ["cash", "qr", "card", "transfer"].includes(body.paymentMethod) ? body.paymentMethod : "cash";
  const aggregated = new Map();
  for (const item of body.items) {
    const productId = cleanText(item.productId, 64, true);
    const quantity = positiveInt(item.quantity, "quantity", { max: 100000 });
    aggregated.set(productId, (aggregated.get(productId) || 0) + quantity);
  }
  let customerId = body.customerId ? cleanText(body.customerId, 64) : null;
  if (customerId) {
    const customer = await auth.db.prepare("SELECT id FROM customers WHERE id = ? AND business_id = ? AND is_archived = 0 LIMIT 1").bind(customerId, auth.business.id).first();
    if (!customer) throw new ApiError("Выбранный клиент не найден.", 404);
  }
  const items = [];
  let subtotal = 0;
  for (const [productId, quantity] of aggregated.entries()) {
    const product = await auth.db.prepare("SELECT id, name, price, stock FROM products WHERE id = ? AND business_id = ? AND is_active = 1 LIMIT 1").bind(productId, auth.business.id).first();
    if (!product) throw new ApiError("Один из товаров не найден или архивирован.", 404);
    if (Number(product.stock) < quantity) throw new ApiError(`Недостаточно остатка товара «${product.name}». Доступно: ${product.stock} шт.`, 409, "INSUFFICIENT_STOCK");
    const lineTotal = Number(product.price) * quantity;
    if (!Number.isSafeInteger(lineTotal) || lineTotal > 100000000000) throw new ApiError("Слишком большая сумма продажи.", 400);
    subtotal += lineTotal;
    items.push({ productId, quantity, unitPrice: Number(product.price), lineTotal });
  }
  if (!Number.isSafeInteger(subtotal) || subtotal <= 0) throw new ApiError("Некорректная сумма продажи.", 400);
  const id = uuid(), timestamp = nowIso();
  const receiptNo = `ABP-${timestamp.slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const statements = [auth.db.prepare(`INSERT INTO sales (id, business_id, branch_id, user_id, customer_id, receipt_no, subtotal, total, payment_method, created_at)
    VALUES (?, ?, (SELECT id FROM branches WHERE business_id = ? AND is_default = 1 LIMIT 1), ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, auth.business.id, auth.business.id, auth.user.id, customerId, receiptNo, subtotal, subtotal, paymentMethod, timestamp)];
  for (const item of items) {
    statements.push(auth.db.prepare("INSERT INTO sale_items (id, sale_id, product_id, quantity, unit_price, line_total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(uuid(), id, item.productId, item.quantity, item.unitPrice, item.lineTotal, timestamp));
  }
  try { await auth.db.batch(statements); }
  catch (error) {
    const message = String(error);
    if (message.includes("INSUFFICIENT_STOCK")) throw new ApiError("Остаток изменился. Обновите чек и попробуйте снова.", 409, "INSUFFICIENT_STOCK");
    if (message.includes("PRODUCT_NOT_FOUND")) throw new ApiError("Один из товаров больше недоступен.", 409);
    throw error;
  }
  return json({ sale: { id, receipt_no: receiptNo, subtotal, total: subtotal, payment_method: paymentMethod, created_at: timestamp, items_count: items.length } }, 201);
}

async function getSales(auth, url) {
  const limit = Math.floor(Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100)));
  const result = await auth.db.prepare(`SELECT s.id, s.receipt_no, s.subtotal, s.total, s.payment_method, s.created_at,
      COALESCE(c.name, '') AS customer_name,
      (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items_count
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.business_id = ? ORDER BY s.created_at DESC LIMIT ?`)
    .bind(auth.business.id, limit).all();
  return json({ sales: result.results || [] });
}

async function getExpenses(auth, url) {
  const limit = Math.floor(Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200)));
  const result = await auth.db.prepare("SELECT id, title, category, amount, note, created_at FROM expenses WHERE business_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(auth.business.id, limit).all();
  return json({ expenses: result.results || [] });
}

async function createExpense(request, auth) {
  const body = await readJson(request);
  const title = cleanText(body.title, 120, true);
  const category = cleanText(body.category, 60) || "Другое";
  const amount = positiveInt(body.amount, "amount");
  const note = cleanText(body.note, 250);
  const id = uuid(), timestamp = nowIso();
  await auth.db.prepare("INSERT INTO expenses (id, business_id, user_id, title, category, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, auth.business.id, auth.user.id, title, category, amount, note, timestamp).run();
  return json({ expense: { id, title, category, amount, note, created_at: timestamp } }, 201);
}

async function deleteExpense(auth, id) {
  const result = await auth.db.prepare("DELETE FROM expenses WHERE id = ? AND business_id = ?").bind(id, auth.business.id).run();
  if (!result.meta?.changes) throw new ApiError("Расход не найден.", 404);
  return json({ ok: true });
}

function kyrgyzDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bishkek", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

async function getStats(auth) {
  const db = auth.db, businessId = auth.business.id;
  const today = kyrgyzDate();
  const [totals, todayTotals, counts, daily, lowStock] = await Promise.all([
    db.prepare("SELECT COALESCE(SUM(total),0) AS totalRevenue, COUNT(*) AS salesCount FROM sales WHERE business_id = ?").bind(businessId).first(),
    db.prepare("SELECT COALESCE(SUM(total),0) AS todayRevenue, COUNT(*) AS todaySalesCount FROM sales WHERE business_id = ? AND date(datetime(created_at, '+6 hours')) = ?").bind(businessId, today).first(),
    db.prepare(`SELECT (SELECT COUNT(*) FROM products WHERE business_id = ? AND is_active = 1) AS productCount,
      (SELECT COUNT(*) FROM customers WHERE business_id = ? AND is_archived = 0) AS customerCount`).bind(businessId, businessId).first(),
    db.prepare(`SELECT date(datetime(created_at, '+6 hours')) AS day, COALESCE(SUM(total),0) AS total FROM sales
      WHERE business_id = ? AND date(datetime(created_at, '+6 hours')) >= date(?, '-6 days')
      GROUP BY date(datetime(created_at, '+6 hours')) ORDER BY day`).bind(businessId, today).all(),
    db.prepare("SELECT COUNT(*) AS lowStockCount FROM products WHERE business_id = ? AND is_active = 1 AND stock <= min_stock").bind(businessId).first()
  ]);
  const expenseTotals = await db.prepare("SELECT COALESCE(SUM(amount),0) AS totalExpenses FROM expenses WHERE business_id = ?").bind(businessId).first();
  const dailyMap = new Map((daily.results || []).map((row) => [row.day, Number(row.total)]));
  const dailySales = [];
  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date(`${today}T12:00:00+06:00`);
    date.setDate(date.getDate() - offset);
    const day = kyrgyzDate(date);
    dailySales.push({ day, total: dailyMap.get(day) || 0 });
  }
  return json({
    totalRevenue: Number(totals?.totalRevenue || 0), salesCount: Number(totals?.salesCount || 0),
    todayRevenue: Number(todayTotals?.todayRevenue || 0), todaySalesCount: Number(todayTotals?.todaySalesCount || 0),
    productCount: Number(counts?.productCount || 0), customerCount: Number(counts?.customerCount || 0),
    lowStockCount: Number(lowStock?.lowStockCount || 0), totalExpenses: Number(expenseTotals?.totalExpenses || 0), dailySales
  });
}

async function updateBusiness(request, auth) {
  if (auth.user.role !== "OWNER") throw new ApiError("Недостаточно прав для изменения компании.", 403, "FORBIDDEN");
  const body = await readJson(request);
  const name = cleanText(body.name, 80, true);
  const ownerName = cleanText(body.ownerName, 80, true);
  const timestamp = nowIso();
  await auth.db.batch([
    auth.db.prepare("UPDATE businesses SET name = ?, updated_at = ? WHERE id = ?").bind(name, timestamp, auth.business.id),
    auth.db.prepare("UPDATE users SET name = ? WHERE id = ? AND business_id = ?").bind(ownerName, auth.user.id, auth.business.id)
  ]);
  return json({ business: { ...auth.business, name }, user: { ...auth.user, name: ownerName } });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request, env) });
  if (path === "/api/health" && method === "GET") {
    const db = await requireDb(env);
    await db.prepare("SELECT 1 AS ok").first();
    return json({ ok: true, service: "AZA BIZ PRO API", database: "connected", version: "2.0.2" });
  }
  if (path === "/api/auth/register" && method === "POST") return authRegister(request, env);
  if (path === "/api/auth/login" && method === "POST") return authLogin(request, env);
  if (path.startsWith("/api/")) {
    const auth = await authenticate(request, env);
    if (path === "/api/auth/me" && method === "GET") return authMe(auth);
    if (path === "/api/auth/logout" && method === "POST") return authLogout(request, auth);
    if (path === "/api/business" && method === "PATCH") return updateBusiness(request, auth);
    if (path === "/api/stats" && method === "GET") return getStats(auth);
    if (path === "/api/products" && method === "GET") return getProducts(auth, url);
    if (path === "/api/products" && method === "POST") return createProduct(request, auth);
    if (path.startsWith("/api/products/") && method === "PATCH") return updateProduct(request, auth, decodeURIComponent(path.slice("/api/products/".length)));
    if (path.startsWith("/api/products/") && method === "DELETE") return archiveProduct(auth, decodeURIComponent(path.slice("/api/products/".length)));
    if (path === "/api/customers" && method === "GET") return getCustomers(auth, url);
    if (path === "/api/customers" && method === "POST") return createCustomer(request, auth);
    if (path.startsWith("/api/customers/") && method === "DELETE") return archiveCustomer(auth, decodeURIComponent(path.slice("/api/customers/".length)));
    if (path === "/api/sales" && method === "GET") return getSales(auth, url);
    if (path === "/api/sales" && method === "POST") return createSale(request, auth);
    if (path === "/api/expenses" && method === "GET") return getExpenses(auth, url);
    if (path === "/api/expenses" && method === "POST") return createExpense(request, auth);
    if (path.startsWith("/api/expenses/") && method === "DELETE") return deleteExpense(auth, decodeURIComponent(path.slice("/api/expenses/".length)));
  }
  throw new ApiError("Маршрут не найден.", 404, "NOT_FOUND");
}

export default {
  async fetch(request, env) {
    const corsHeaders = cors(request, env);
    try {
      const origin = request.headers.get("Origin");
      const configured = String(env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(",")).split(",").map((item) => item.trim());
      if (origin && !configured.includes(origin)) return json({ error: "Origin is not allowed." }, 403, corsHeaders);
      const response = await route(request, env);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status, corsHeaders);
      console.error("AZA BIZ PRO API error:", error);
      return json({ error: "Внутренняя ошибка сервера. Повторите попытку позже.", code: "INTERNAL_ERROR" }, 500, corsHeaders);
    }
  }
};
