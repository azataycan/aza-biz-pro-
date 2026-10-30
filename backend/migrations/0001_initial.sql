CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  currency TEXT NOT NULL DEFAULT 'KGS',
  timezone TEXT NOT NULL DEFAULT 'Asia/Bishkek',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_one_default ON branches(business_id) WHERE is_default = 1;
CREATE INDEX IF NOT EXISTS idx_branches_business ON branches(business_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'OWNER' CHECK(role IN ('OWNER','MANAGER','CASHIER')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_business ON users(business_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_attempts (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  blocked_until TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT,
  category TEXT NOT NULL DEFAULT 'Без категории',
  price INTEGER NOT NULL CHECK(price > 0),
  cost_price INTEGER NOT NULL DEFAULT 0 CHECK(cost_price >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
  min_stock INTEGER NOT NULL DEFAULT 0 CHECK(min_stock >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_business_sku ON products(business_id, sku) WHERE sku IS NOT NULL AND sku <> '';
CREATE INDEX IF NOT EXISTS idx_products_business_active ON products(business_id, is_active, name);
CREATE INDEX IF NOT EXISTS idx_products_low_stock ON products(business_id, stock, min_stock);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_business ON customers(business_id, is_archived, created_at);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(business_id, phone);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  receipt_no TEXT NOT NULL,
  subtotal INTEGER NOT NULL CHECK(subtotal > 0),
  total INTEGER NOT NULL CHECK(total > 0),
  payment_method TEXT NOT NULL DEFAULT 'cash' CHECK(payment_method IN ('cash','qr','card','transfer')),
  created_at TEXT NOT NULL,
  UNIQUE(business_id, receipt_no)
);
CREATE INDEX IF NOT EXISTS idx_sales_business_date ON sales(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);

CREATE TABLE IF NOT EXISTS sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_price INTEGER NOT NULL CHECK(unit_price > 0),
  line_total INTEGER NOT NULL CHECK(line_total > 0),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

CREATE TRIGGER IF NOT EXISTS trg_sale_item_validate_stock
BEFORE INSERT ON sale_items
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM products p JOIN sales s ON s.id = NEW.sale_id
    WHERE p.id = NEW.product_id AND p.business_id = s.business_id AND p.is_active = 1
  ) THEN RAISE(ABORT, 'PRODUCT_NOT_FOUND') END;
  SELECT CASE WHEN (
    SELECT p.stock FROM products p JOIN sales s ON s.id = NEW.sale_id
    WHERE p.id = NEW.product_id AND p.business_id = s.business_id
  ) < NEW.quantity THEN RAISE(ABORT, 'INSUFFICIENT_STOCK') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_item_reduce_stock
AFTER INSERT ON sale_items
BEGIN
  UPDATE products SET stock = stock - NEW.quantity, updated_at = NEW.created_at
  WHERE id = NEW.product_id;
END;

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
  movement_type TEXT NOT NULL CHECK(movement_type IN ('INITIAL','ADJUSTMENT','SALE')),
  quantity_delta INTEGER NOT NULL CHECK(quantity_delta <> 0),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_date ON stock_movements(business_id, product_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_sale_item_stock_movement
AFTER INSERT ON sale_items
BEGIN
  INSERT INTO stock_movements (id, business_id, product_id, user_id, sale_id, movement_type, quantity_delta, note, created_at)
  SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
         s.business_id, NEW.product_id, s.user_id, NEW.sale_id, 'SALE', -NEW.quantity, 'Sale stock deduction', NEW.created_at
  FROM sales s WHERE s.id = NEW.sale_id;
END;

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Другое',
  amount INTEGER NOT NULL CHECK(amount > 0),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_business_date ON expenses(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_business_date ON audit_logs(business_id, created_at DESC);
