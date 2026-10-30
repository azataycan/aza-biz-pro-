(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const API_BASE = String(window.AZA_API_BASE || "").replace(/\/$/, "");
  const TOKEN_KEY = "aza_biz_pro_session_v2";
  const LANG_KEY = "aza_biz_pro_language";
  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || "",
    user: null,
    business: null,
    products: [],
    customers: [],
    sales: [],
    expenses: [],
    stats: null,
    cart: [],
    lang: localStorage.getItem(LANG_KEY) || "ru",
    authMode: "login",
    busy: false
  };

  const words = {
    ru: {
      dashboard: "Обзор", products: "Товары", sales: "Продажи / Касса", customers: "Клиенты", finance: "Финансы", expenses: "Расходы", settings: "Настройки",
      welcome: "Добро пожаловать", signIn: "Войти", create: "Создать компанию", today: "Ваш бизнес сегодня", newSale: "Новая продажа", logout: "Выйти из аккаунта",
      loading: "Загрузка данных…", saved: "Сохранено", failed: "Не удалось выполнить операцию", noData: "Пока нет данных", cloud: "Облачная синхронизация"
    },
    kg: {
      dashboard: "Башкы бет", products: "Товарлар", sales: "Сатуу / Касса", customers: "Кардарлар", finance: "Финансы", expenses: "Чыгымдар", settings: "Жөндөөлөр",
      welcome: "Кош келиңиз", signIn: "Кирүү", create: "Компания түзүү", today: "Бизнесиңиздин бүгүнкү абалы", newSale: "Жаңы сатуу", logout: "Аккаунттан чыгуу",
      loading: "Маалымат жүктөлүүдө…", saved: "Сакталды", failed: "Аракет аткарылган жок", noData: "Азырынча маалымат жок", cloud: "Булуттагы синхрондоштуруу"
    }
  };
  const tr = (key) => (words[state.lang] && words[state.lang][key]) || words.ru[key] || key;

  function apiConfigured() {
    return API_BASE && !API_BASE.includes("YOUR-WORKER-NAME") && /^https:\/\//i.test(API_BASE);
  }

  function toast(message, type = "success") {
    const el = $("toast");
    el.textContent = message;
    el.dataset.type = type;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function setMessage(message, success = false) {
    const el = $("authMessage");
    el.textContent = message || "";
    el.classList.toggle("success", Boolean(success));
  }

  function money(value) {
    return new Intl.NumberFormat(state.lang === "kg" ? "ky-KG" : "ru-RU", { maximumFractionDigits: 0 }).format(Number(value) || 0) + " сом";
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  async function request(path, options = {}) {
    if (!apiConfigured()) throw new Error("API_NOT_CONFIGURED");
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: "no-store"
      });
    } catch {
      throw new Error("Серверге туташуу жок. Интернетти жана API дарегин текшериңиз.");
    }
    let payload = {};
    try { payload = await response.json(); } catch { /* non-JSON response */ }
    if (!response.ok) {
      if (response.status === 401 && state.token && !path.startsWith("/api/auth/")) {
        clearSession(); showAuth();
      }
      throw new Error(payload.error || payload.message || `Сервер катасы (${response.status})`);
    }
    return payload;
  }

  function showAuth() {
    $("bootScreen").classList.add("hidden");
    $("app").classList.add("hidden");
    $("authScreen").classList.remove("hidden");
    setAuthMode(state.authMode);
    if (!apiConfigured()) {
      setMessage("Система Cloudflare API менен туташтырыла элек. Алгач api-config.js файлына Worker дарегин жазыңыз.");
      $("authSubmit").disabled = true;
      $("authSubmit").style.opacity = ".5";
    } else {
      $("authSubmit").disabled = false;
      $("authSubmit").style.opacity = "1";
    }
    applyLanguage();
  }

  function showApp() {
    $("bootScreen").classList.add("hidden");
    $("authScreen").classList.add("hidden");
    $("app").classList.remove("hidden");
    closeSidebar();
  }

  function clearSession() {
    state.token = "";
    state.user = null;
    state.business = null;
    sessionStorage.removeItem(TOKEN_KEY);
  }

  function setAuthMode(mode) {
    state.authMode = mode === "register" ? "register" : "login";
    const isRegister = state.authMode === "register";
    document.querySelectorAll("[data-auth-mode]").forEach((button) => button.classList.toggle("active", button.dataset.authMode === state.authMode));
    $("registerFields").classList.toggle("hidden", !isRegister);
    $("authTitle").textContent = isRegister ? "Создайте рабочее пространство" : "С возвращением";
    $("authSubtitle").textContent = isRegister ? "Зарегистрируйте компанию и аккаунт владельца." : "Войдите в свой рабочий кабинет.";
    $("passwordInput").autocomplete = isRegister ? "new-password" : "current-password";
    $("passwordInput").placeholder = isRegister ? "Не менее 10 символов" : "Ваш пароль";
    $("authSubmit").querySelector("span").textContent = isRegister ? "Создать аккаунт" : "Войти в AZA BIZ PRO";
    setMessage("");
  }

  async function handleAuth(event) {
    event.preventDefault();
    if (!apiConfigured() || state.busy) return;
    const email = $("emailInput").value.trim().toLowerCase();
    const password = $("passwordInput").value;
    const body = { email, password };
    if (state.authMode === "register") {
      body.companyName = $("companyInput").value.trim();
      body.ownerName = $("ownerInput").value.trim();
      if (!body.companyName || !body.ownerName) return setMessage("Укажите название компании и имя владельца.");
      if (password.length < 10) return setMessage("Пароль должен содержать не менее 10 символов.");
    }
    state.busy = true;
    const button = $("authSubmit");
    button.disabled = true;
    button.querySelector("span").textContent = "Подключение…";
    setMessage("");
    try {
      const result = await request(state.authMode === "register" ? "/api/auth/register" : "/api/auth/login", { method: "POST", body });
      state.token = result.token;
      sessionStorage.setItem(TOKEN_KEY, state.token);
      state.user = result.user;
      state.business = result.business;
      await loadWorkspace();
      showApp();
      toast(state.authMode === "register" ? "Компания создана" : "Вы вошли в аккаунт");
    } catch (error) {
      setMessage(error.message || tr("failed"));
    } finally {
      state.busy = false;
      button.disabled = false;
      button.querySelector("span").textContent = state.authMode === "register" ? "Создать аккаунт" : "Войти в AZA BIZ PRO";
    }
  }

  async function restoreSession() {
    if (!apiConfigured()) return showAuth();
    if (!state.token) return showAuth();
    try {
      const result = await request("/api/auth/me");
      state.user = result.user;
      state.business = result.business;
      await loadWorkspace();
      showApp();
    } catch {
      clearSession();
      showAuth();
    }
  }

  async function loadWorkspace() {
    setSync("Загрузка данных…", true);
    const [products, customers, sales, expenses, stats] = await Promise.all([
      request("/api/products?limit=500"), request("/api/customers?limit=500"),
      request("/api/sales?limit=100"), request("/api/expenses?limit=100"), request("/api/stats")
    ]);
    state.products = products.products || [];
    state.customers = customers.customers || [];
    state.sales = sales.sales || [];
    state.expenses = expenses.expenses || [];
    state.stats = stats;
    renderAll();
    setSync("Данные синхронизированы", false);
  }

  function setSync(text, pending) {
    $("syncLabel").textContent = text;
    $("syncLabel").style.color = pending ? "var(--gold2)" : "#7fb69e";
  }

  function renderAll() {
    if (!state.user || !state.business) return;
    const name = state.user.name || "Пользователь";
    const initial = name.trim().slice(0, 1).toUpperCase() || "A";
    $("companyLabel").textContent = state.business.name;
    $("accountName").textContent = name;
    $("accountEmail").textContent = state.user.email;
    $("ownerLabel").textContent = name.split(" ")[0];
    $("accountAvatar").textContent = initial;
    $("topAvatar").textContent = initial;
    $("navProductCount").textContent = state.products.length;
    $("settingsCompany").value = state.business.name || "";
    $("settingsOwner").value = name;
    $("settingsEmail").value = state.user.email || "";
    renderDashboard(); renderProducts(); renderCustomers(); renderSales(); renderExpenses(); renderFinance();
    applyLanguage();
  }

  function table(headers, rows, emptyText = "Пока нет данных") {
    if (!rows.length) return `<div class="empty-table">${esc(emptyText)}</div>`;
    return `<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
  }

  function dateLabel(value, withTime = false) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(state.lang === "kg" ? "ky-KG" : "ru-RU", withTime ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "short" }).format(date);
  }

  function renderDashboard() {
    const stats = state.stats || {};
    $("todayRevenue").textContent = money(stats.todayRevenue || 0);
    $("todayOrders").textContent = `${stats.todaySalesCount || 0} продаж сегодня`;
    $("salesCount").textContent = stats.salesCount || 0;
    $("productCount").textContent = stats.productCount || 0;
    $("customerCount").textContent = stats.customerCount || 0;
    $("lowStockCount").textContent = `${stats.lowStockCount || 0} позиций требуют внимания`;
    const recent = state.sales.slice(0, 6).map((sale) => `<tr><td><div class="cell-title">${esc(sale.receipt_no || sale.id.slice(0, 8))}</div><div class="cell-sub">${dateLabel(sale.created_at, true)}</div></td><td>${esc(sale.customer_name || "Розничный покупатель")}</td><td class="money-cell">${money(sale.total)}</td><td><span class="status-pill">Завершено</span></td></tr>`);
    $("recentSales").innerHTML = table(["ЧЕК / ДАТА", "КЛИЕНТ", "СУММА", "СТАТУС"], recent, "Продаж пока нет. Первая продажа появится здесь.");
    const low = state.products.filter((p) => Number(p.stock) <= Number(p.min_stock)).sort((a, b) => a.stock - b.stock).slice(0, 5);
    $("lowStockList").innerHTML = low.length ? low.map((p) => `<div class="low-stock-item"><div><b>${esc(p.name)}</b><small>${esc(p.sku || "Без артикула")}</small></div><span class="low-stock-qty">${Number(p.stock)} шт.</span></div>`).join("") : `<div class="empty-state">Нет товаров с низким остатком</div>`;
    renderSalesChart(stats.dailySales || []);
  }

  function renderSalesChart(days) {
    const chart = $("salesChart");
    if (!days.length || !days.some((day) => Number(day.total) > 0)) {
      chart.innerHTML = `<div class="chart-empty">Пока нет продаж за выбранный период</div>`;
      return;
    }
    const max = Math.max(1, ...days.map((day) => Number(day.total) || 0));
    chart.innerHTML = days.map((day) => {
      const amount = Number(day.total) || 0;
      const height = amount ? Math.max(7, amount / max * 100) : 2;
      const label = new Date(`${day.day}T12:00:00`).toLocaleDateString(state.lang === "kg" ? "ky-KG" : "ru-RU", { weekday: "short" });
      return `<div class="chart-bar-wrap" title="${money(amount)}"><div class="chart-bar" style="height:${height}%"></div><small>${esc(label)}</small></div>`;
    }).join("");
  }

  function renderProducts() {
    const query = ($("productSearch")?.value || "").trim().toLowerCase();
    const filter = $("stockFilter")?.value || "all";
    const rows = state.products.filter((product) => {
      const matches = `${product.name} ${product.sku || ""} ${product.category || ""}`.toLowerCase().includes(query);
      const stock = Number(product.stock), min = Number(product.min_stock);
      return matches && (filter === "all" || (filter === "low" && stock > 0 && stock <= min) || (filter === "out" && stock <= 0));
    }).map((product) => {
      const stock = Number(product.stock), min = Number(product.min_stock);
      const status = stock <= 0 ? `<span class="status-pill status-out">Нет в наличии</span>` : stock <= min ? `<span class="status-pill status-low">Низкий остаток</span>` : `<span class="status-pill">В наличии</span>`;
      return `<tr><td><div class="cell-title">${esc(product.name)}</div><div class="cell-sub">${esc(product.sku || "Без артикула")}</div></td><td>${esc(product.category || "Без категории")}</td><td class="money-cell">${money(product.price)}</td><td>${stock} шт.</td><td>${status}</td><td><div class="row-actions"><button class="table-action" data-edit-product="${esc(product.id)}">Изменить</button><button class="table-action danger" data-delete-product="${esc(product.id)}">Архив</button></div></td></tr>`;
    });
    $("productsTable").innerHTML = table(["ТОВАР", "КАТЕГОРИЯ", "ЦЕНА", "ОСТАТОК", "СТАТУС", "ДЕЙСТВИЯ"], rows, "Каталог пуст. Добавьте первый товар.");
    $("productResultCount").textContent = `${rows.length} товаров`;
    renderPosProducts();
  }

  function renderCustomers() {
    const query = ($("customerSearch")?.value || "").trim().toLowerCase();
    const filtered = state.customers.filter((customer) => `${customer.name} ${customer.phone || ""} ${customer.email || ""}`.toLowerCase().includes(query));
    const rows = filtered.map((customer) => `<tr><td><div class="cell-title">${esc(customer.name)}</div><div class="cell-sub">${esc(customer.email || "")}</div></td><td>${esc(customer.phone || "—")}</td><td>${dateLabel(customer.created_at)}</td><td><button class="table-action danger" data-delete-customer="${esc(customer.id)}">Удалить</button></td></tr>`);
    $("customersTable").innerHTML = table(["КЛИЕНТ", "ТЕЛЕФОН", "ДОБАВЛЕН", "ДЕЙСТВИЯ"], rows, "Клиентов пока нет. Добавьте первую запись.");
    $("customerResultCount").textContent = `${filtered.length} клиентов`;
    const current = $("saleCustomer").value;
    $("saleCustomer").innerHTML = `<option value="">Без привязки к клиенту</option>` + state.customers.map((customer) => `<option value="${esc(customer.id)}">${esc(customer.name)}${customer.phone ? ` · ${esc(customer.phone)}` : ""}</option>`).join("");
    if (state.customers.some((c) => c.id === current)) $("saleCustomer").value = current;
  }

  function renderPosProducts() {
    const current = $("posProduct").value;
    const available = state.products.filter((product) => Number(product.stock) > 0);
    $("posProduct").innerHTML = available.map((product) => `<option value="${esc(product.id)}">${esc(product.name)} · ${money(product.price)} · ${product.stock} шт.</option>`).join("");
    if (available.some((p) => p.id === current)) $("posProduct").value = current;
    if (!available.length) $("posProduct").innerHTML = `<option value="">Нет товаров в наличии</option>`;
  }

  function addCartItem() {
    const id = $("posProduct").value;
    const product = state.products.find((item) => item.id === id);
    const qty = Number($("posQty").value);
    if (!product) return toast("Сначала добавьте товар в каталог", "error");
    if (!Number.isInteger(qty) || qty < 1) return toast("Укажите корректное количество", "error");
    const existing = state.cart.find((item) => item.productId === id);
    const nextQty = qty + (existing?.quantity || 0);
    if (nextQty > Number(product.stock)) return toast("Количество превышает складской остаток", "error");
    if (existing) existing.quantity = nextQty;
    else state.cart.push({ productId: id, quantity: qty });
    $("posQty").value = 1;
    renderCart();
  }

  function renderCart() {
    const lines = state.cart.map((item) => {
      const product = state.products.find((p) => p.id === item.productId);
      if (!product) return "";
      return `<div class="cart-line"><div><b>${esc(product.name)}</b><small>${item.quantity} × ${money(product.price)}</small></div><strong>${money(item.quantity * product.price)}</strong><button class="cart-remove" data-remove-cart="${esc(item.productId)}" aria-label="Убрать">×</button></div>`;
    }).join("");
    $("cartItems").innerHTML = lines || `<div class="empty-state">Добавьте товар в чек</div>`;
    const total = state.cart.reduce((sum, item) => {
      const product = state.products.find((p) => p.id === item.productId);
      return sum + (product ? Number(product.price) * item.quantity : 0);
    }, 0);
    $("cartTotal").textContent = money(total);
    $("cartCount").textContent = `${state.cart.length} позиций`;
  }

  function renderSales() {
    const rows = state.sales.map((sale) => `<tr><td><div class="cell-title">${esc(sale.receipt_no || sale.id.slice(0, 8))}</div><div class="cell-sub">${dateLabel(sale.created_at, true)}</div></td><td>${esc(sale.customer_name || "Розничный покупатель")}</td><td>${esc(paymentLabel(sale.payment_method))}</td><td>${Number(sale.items_count) || 0}</td><td class="money-cell">${money(sale.total)}</td></tr>`);
    $("salesTable").innerHTML = table(["ЧЕК / ДАТА", "КЛИЕНТ", "ОПЛАТА", "ПОЗИЦИИ", "СУММА"], rows, "История продаж пока пуста.");
    $("salesTotalCount").textContent = `${state.sales.length} операций`;
    renderCart();
  }

  function paymentLabel(method) {
    return ({ cash: "Наличные", qr: "QR", card: "Карта", transfer: "Перевод" })[method] || method || "—";
  }

  function renderExpenses() {
    const rows = state.expenses.map((expense) => `<tr><td><div class="cell-title">${esc(expense.title)}</div><div class="cell-sub">${esc(expense.category || "Общее")}</div></td><td>${dateLabel(expense.created_at, true)}</td><td>${esc(expense.note || "—")}</td><td class="money-cell">${money(expense.amount)}</td><td><button class="table-action danger" data-delete-expense="${esc(expense.id)}">Удалить</button></td></tr>`);
    $("expensesTable").innerHTML = table(["РАСХОД", "ДАТА", "ПРИМЕЧАНИЕ", "СУММА", ""], rows, "Расходов пока нет.");
    $("expenseCount").textContent = `${state.expenses.length} операций`;
  }

  function renderFinance() {
    const stats = state.stats || {};
    const revenue = Number(stats.totalRevenue) || 0;
    const expenses = Number(stats.totalExpenses) || 0;
    const count = Number(stats.salesCount) || 0;
    $("totalRevenue").textContent = money(revenue);
    $("totalExpenses").textContent = money(expenses);
    $("netResult").textContent = money(revenue - expenses);
    $("averageCheck").textContent = money(count ? Math.round(revenue / count) : 0);
    const entries = [
      ...state.sales.map((item) => ({ type: "Продажа", label: item.receipt_no || "Продажа", date: item.created_at, amount: Number(item.total), positive: true })),
      ...state.expenses.map((item) => ({ type: "Расход", label: item.title, date: item.created_at, amount: Number(item.amount), positive: false }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 30);
    const rows = entries.map((item) => `<tr><td><div class="cell-title">${esc(item.label)}</div><div class="cell-sub">${item.type}</div></td><td>${dateLabel(item.date, true)}</td><td class="${item.positive ? "money-cell" : ""}">${item.positive ? "+" : "−"}${money(item.amount)}</td></tr>`);
    $("financeTable").innerHTML = table(["ОПЕРАЦИЯ", "ДАТА", "СУММА"], rows, "Финансовых операций пока нет.");
  }

  function showPage(page) {
    const target = $(`${page}Page`);
    if (!target) return;
    document.querySelectorAll(".page").forEach((section) => section.classList.add("hidden"));
    target.classList.remove("hidden");
    document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
    const item = document.querySelector(`.nav-item[data-page="${page}"] span:not(.nav-icon)`);
    $("pageTitle").textContent = item?.textContent || page;
    closeSidebar();
  }

  function openSidebar() {
    $("sidebar").classList.add("open");
    $("drawerBackdrop").classList.add("visible");
    $("menuBtn").setAttribute("aria-expanded", "true");
  }
  function closeSidebar() {
    $("sidebar").classList.remove("open");
    $("drawerBackdrop").classList.remove("visible");
    $("menuBtn").setAttribute("aria-expanded", "false");
  }

  function openModal(title, html, onMount) {
    $("modalTitle").textContent = title;
    $("modalBody").innerHTML = html;
    $("modal").classList.remove("hidden");
    if (onMount) onMount();
  }
  function closeModal() { $("modal").classList.add("hidden"); }
  function modalActions(cancelText = "Отмена", submitText = "Сохранить") {
    return `<div class="modal-actions"><button type="button" class="btn secondary" id="modalCancel">${cancelText}</button><button type="submit" class="btn primary">${submitText}</button></div>`;
  }

  function productForm(product = null) {
    const editing = Boolean(product);
    openModal(editing ? "Изменить товар" : "Новый товар", `
      <form id="productForm">
        <label for="fProductName">Название товара</label><input class="form-control" id="fProductName" maxlength="120" required value="${esc(product?.name || "")}" placeholder="Например, Чайник электрический">
        <div class="form-two"><div><label for="fProductSku">Артикул / SKU</label><input class="form-control" id="fProductSku" maxlength="60" value="${esc(product?.sku || "")}" placeholder="SKU-001"></div><div><label for="fProductCategory">Категория</label><input class="form-control" id="fProductCategory" maxlength="60" value="${esc(product?.category || "")}" placeholder="Посуда"></div></div>
        <div class="form-two"><div><label for="fProductPrice">Цена продажи (сом)</label><input class="form-control" id="fProductPrice" type="number" min="1" max="100000000" step="1" required value="${product?.price ?? ""}"></div><div><label for="fProductCost">Себестоимость (сом)</label><input class="form-control" id="fProductCost" type="number" min="0" max="100000000" step="1" value="${product?.cost_price ?? 0}"></div></div>
        <div class="form-two"><div><label for="fProductStock">Остаток (шт.)</label><input class="form-control" id="fProductStock" type="number" min="0" max="10000000" step="1" required value="${product?.stock ?? 0}"></div><div><label for="fProductMin">Мин. остаток</label><input class="form-control" id="fProductMin" type="number" min="0" max="10000000" step="1" value="${product?.min_stock ?? 2}"></div></div>
        ${modalActions("Отмена", editing ? "Сохранить" : "Добавить товар")}
      </form>`, () => {
      $("modalCancel").onclick = closeModal;
      $("productForm").onsubmit = async (event) => {
        event.preventDefault();
        const body = { name: $("fProductName").value.trim(), sku: $("fProductSku").value.trim(), category: $("fProductCategory").value.trim(), price: Number($("fProductPrice").value), costPrice: Number($("fProductCost").value || 0), stock: Number($("fProductStock").value), minStock: Number($("fProductMin").value || 0) };
        try {
          await request(editing ? `/api/products/${encodeURIComponent(product.id)}` : "/api/products", { method: editing ? "PATCH" : "POST", body });
          closeModal(); await loadWorkspace(); toast(editing ? "Товар обновлён" : "Товар добавлен");
        } catch (error) { toast(error.message, "error"); }
      };
    });
  }

  function customerForm() {
    openModal("Новый клиент", `<form id="customerForm"><label for="fCustomerName">Имя и фамилия</label><input class="form-control" id="fCustomerName" maxlength="100" required placeholder="Имя покупателя"><label for="fCustomerPhone">Телефон</label><input class="form-control" id="fCustomerPhone" maxlength="30" placeholder="+996 ..."><label for="fCustomerEmail">Email (необязательно)</label><input class="form-control" id="fCustomerEmail" type="email" maxlength="190" placeholder="client@example.com">${modalActions()}</form>`, () => {
      $("modalCancel").onclick = closeModal;
      $("customerForm").onsubmit = async (event) => {
        event.preventDefault();
        try {
          await request("/api/customers", { method: "POST", body: { name: $("fCustomerName").value.trim(), phone: $("fCustomerPhone").value.trim(), email: $("fCustomerEmail").value.trim() } });
          closeModal(); await loadWorkspace(); toast("Клиент добавлен");
        } catch (error) { toast(error.message, "error"); }
      };
    });
  }

  function expenseForm() {
    openModal("Новый расход", `<form id="expenseForm"><label for="fExpenseTitle">Название расхода</label><input class="form-control" id="fExpenseTitle" maxlength="120" required placeholder="Аренда, доставка, упаковка…"><div class="form-two"><div><label for="fExpenseCategory">Категория</label><select class="form-control" id="fExpenseCategory"><option>Аренда</option><option>Зарплата</option><option>Доставка</option><option>Закупка</option><option>Коммунальные услуги</option><option>Реклама</option><option>Другое</option></select></div><div><label for="fExpenseAmount">Сумма (сом)</label><input class="form-control" id="fExpenseAmount" type="number" min="1" max="100000000" step="1" required></div></div><label for="fExpenseNote">Примечание</label><input class="form-control" id="fExpenseNote" maxlength="250" placeholder="Дополнительная информация">${modalActions()}</form>`, () => {
      $("modalCancel").onclick = closeModal;
      $("expenseForm").onsubmit = async (event) => {
        event.preventDefault();
        try {
          await request("/api/expenses", { method: "POST", body: { title: $("fExpenseTitle").value.trim(), category: $("fExpenseCategory").value, amount: Number($("fExpenseAmount").value), note: $("fExpenseNote").value.trim() } });
          closeModal(); await loadWorkspace(); toast("Расход сохранён");
        } catch (error) { toast(error.message, "error"); }
      };
    });
  }

  async function completeSale() {
    if (!state.cart.length) return toast("Добавьте товары в чек", "error");
    const button = $("completeSale");
    button.disabled = true;
    try {
      const result = await request("/api/sales", { method: "POST", body: {
        items: state.cart.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        customerId: $("saleCustomer").value || null,
        paymentMethod: $("paymentMethod").value
      } });
      state.cart = [];
      await loadWorkspace();
      toast(`Продажа проведена · ${money(result.sale.total)}`);
      showPage("sales");
    } catch (error) { toast(error.message, "error"); }
    finally { button.disabled = false; }
  }

  async function deleteRecord(type, id) {
    const map = { product: "/api/products/", customer: "/api/customers/", expense: "/api/expenses/" };
    const messages = { product: "Переместить товар в архив?", customer: "Удалить клиента?", expense: "Удалить расход?" };
    if (!window.confirm(messages[type] || "Подтвердить действие?")) return;
    try {
      await request(map[type] + encodeURIComponent(id), { method: "DELETE" });
      await loadWorkspace(); toast("Изменения сохранены");
    } catch (error) { toast(error.message, "error"); }
  }

  async function saveBusiness(event) {
    event.preventDefault();
    try {
      const result = await request("/api/business", { method: "PATCH", body: { name: $("settingsCompany").value.trim(), ownerName: $("settingsOwner").value.trim() } });
      state.business = result.business; state.user.name = result.user.name;
      renderAll(); toast("Настройки сохранены");
    } catch (error) { toast(error.message, "error"); }
  }

  function applyLanguage() {
    document.documentElement.lang = state.lang === "kg" ? "ky" : "ru";
    const label = state.lang === "ru" ? "KG" : "RU";
    $("langBtn").textContent = label;
    $("authLangBtn").textContent = label;
    const labels = {
      dashboard: "Обзор", products: "Товары", sales: "Продажи / Касса", customers: "Клиенты", finance: "Финансы", expenses: "Расходы", settings: "Настройки"
    };
    document.querySelectorAll(".nav-item").forEach((button) => {
      const text = button.querySelector("span:not(.nav-icon):not(.nav-count)");
      if (text) text.textContent = state.lang === "kg" ? words.kg[button.dataset.page] : labels[button.dataset.page];
    });
    $("logoutBtn").querySelector("span").textContent = tr("logout");
    $("todayLabel").textContent = tr("today");
    const active = document.querySelector(".nav-item.active");
    if (active) $("pageTitle").textContent = active.querySelector("span:not(.nav-icon):not(.nav-count)")?.textContent || tr("dashboard");
  }

  async function logout() {
    try { if (state.token) await request("/api/auth/logout", { method: "POST", body: {} }); } catch { /* local session is still cleared */ }
    clearSession(); state.products = []; state.customers = []; state.sales = []; state.expenses = []; state.cart = [];
    showAuth(); toast("Вы вышли из аккаунта");
  }

  function bindEvents() {
    $("authForm").addEventListener("submit", handleAuth);
    document.querySelectorAll("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));
    $("togglePassword").onclick = () => { const input = $("passwordInput"); input.type = input.type === "password" ? "text" : "password"; };
    $("authLangBtn").onclick = $("langBtn").onclick = () => { state.lang = state.lang === "ru" ? "kg" : "ru"; localStorage.setItem(LANG_KEY, state.lang); applyLanguage(); };
    $("navigation").addEventListener("click", (event) => { const button = event.target.closest("[data-page]"); if (button) showPage(button.dataset.page); });
    document.addEventListener("click", (event) => {
      const go = event.target.closest("[data-go]"); if (go) showPage(go.dataset.go);
      const action = event.target.closest("[data-action]"); if (action?.dataset.action === "add-product") productForm(); if (action?.dataset.action === "add-customer") customerForm();
      const editProduct = event.target.closest("[data-edit-product]"); if (editProduct) { const product = state.products.find((item) => item.id === editProduct.dataset.editProduct); if (product) productForm(product); }
      const deleteProduct = event.target.closest("[data-delete-product]"); if (deleteProduct) deleteRecord("product", deleteProduct.dataset.deleteProduct);
      const deleteCustomer = event.target.closest("[data-delete-customer]"); if (deleteCustomer) deleteRecord("customer", deleteCustomer.dataset.deleteCustomer);
      const deleteExpense = event.target.closest("[data-delete-expense]"); if (deleteExpense) deleteRecord("expense", deleteExpense.dataset.deleteExpense);
      const removeCart = event.target.closest("[data-remove-cart]"); if (removeCart) { state.cart = state.cart.filter((item) => item.productId !== removeCart.dataset.removeCart); renderCart(); }
    });
    $("addProductBtn").onclick = () => productForm();
    $("addCustomerBtn").onclick = customerForm;
    $("addExpenseBtn").onclick = expenseForm;
    $("addToCartBtn").onclick = addCartItem;
    $("completeSale").onclick = completeSale;
    $("productSearch").oninput = renderProducts; $("stockFilter").onchange = renderProducts;
    $("customerSearch").oninput = renderCustomers;
    $("businessForm").onsubmit = saveBusiness;
    $("logoutBtn").onclick = logout;
    $("menuBtn").onclick = openSidebar;
    $("closeSidebar").onclick = closeSidebar;
    $("drawerBackdrop").onclick = closeSidebar;
    $("closeModal").onclick = closeModal;
    $("modal").onclick = (event) => { if (event.target === $("modal")) closeModal(); };
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeModal(); closeSidebar(); } });
  }

  async function init() {
    bindEvents();
    state.lang = state.lang === "kg" ? "kg" : "ru";
    applyLanguage();
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("PWA service worker:", error));
    }
    await restoreSession();
  }

  init().catch((error) => {
    console.error("AZA BIZ PRO initialization error:", error);
    showAuth();
    setMessage(error.message || "Не удалось запустить приложение.");
  });
})();
