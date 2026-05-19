"use strict";

const STORAGE_KEY = "book-inventory:v1";
const HISTORY_LIMIT = 80;
const LOW_STOCK_LIMIT = 2;
const DUPLICATE_SCAN_GAP_MS = 1800;
const APP_VERSION = "20260519f";
const JINA_READER_PREFIX = "https://r.jina.ai/http://r.jina.ai/http://";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const els = {
  statKinds: $("#statKinds"),
  statTotal: $("#statTotal"),
  statLow: $("#statLow"),
  secureState: $("#secureState"),
  preview: $("#preview"),
  cameraHint: $("#cameraHint"),
  startScan: $("#startScan"),
  stopScan: $("#stopScan"),
  torchButton: $("#torchButton"),
  scanStatus: $("#scanStatus"),
  photoInput: $("#photoInput"),
  manualForm: $("#manualForm"),
  manualIsbn: $("#manualIsbn"),
  manualTitleInput: $("#manualTitleInput"),
  manualDelta: $("#manualDelta"),
  manualCategory: $("#manualCategory"),
  manualShelf: $("#manualShelf"),
  manualLocation: $("#manualLocation"),
  manualCoverUrl: $("#manualCoverUrl"),
  manualPrice: $("#manualPrice"),
  manualPublishedDate: $("#manualPublishedDate"),
  manualEdition: $("#manualEdition"),
  manualNote: $("#manualNote"),
  continuousScan: $("#continuousScan"),
  searchInput: $("#searchInput"),
  inventoryList: $("#inventoryList"),
  historyList: $("#historyList"),
  clearAll: $("#clearAll"),
  exportButton: $("#exportButton"),
  exportAuditButton: $("#exportAuditButton"),
  importInput: $("#importInput"),
  roleSelect: $("#roleSelect"),
  resetAuditButton: $("#resetAuditButton"),
  auditSummary: $("#auditSummary"),
  auditList: $("#auditList"),
  installButton: $("#installButton"),
  storageNote: $("#storageNote"),
  cloudState: $("#cloudState"),
  cloudStatus: $("#cloudStatus"),
  authForm: $("#authForm"),
  authEmail: $("#authEmail"),
  authPassword: $("#authPassword"),
  signInButton: $("#signInButton"),
  signedInCard: $("#signedInCard"),
  signedInEmail: $("#signedInEmail"),
  signOutButton: $("#signOutButton"),
  syncButton: $("#syncButton"),
  pushLocalButton: $("#pushLocalButton"),
  bookRowTemplate: $("#bookRowTemplate"),
};

const state = {
  books: {},
  history: [],
  mode: "in",
  scanner: null,
  scanControls: null,
  activeStream: null,
  torchOn: false,
  deferredInstallPrompt: null,
  lastCode: "",
  lastCodeAt: 0,
  busyCodes: new Set(),
  scanLocked: false,
  supabase: null,
  user: null,
  cloudReady: false,
  syncBusy: false,
  role: "admin",
  audit: {
    active: false,
    scanned: {},
    extras: {},
  },
};

function loadStore() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.books = normalizeStoredBooks(stored.books || {});
    state.history = normalizeStoredHistory(stored.history || []);
    state.role = stored.role || "admin";
    state.audit = normalizeStoredAudit(stored.audit || {});
  } catch {
    state.books = {};
    state.history = [];
    state.role = "admin";
    state.audit = { active: false, scanned: {}, extras: {} };
  }
}

function saveStore() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      books: state.books,
      history: state.history.slice(0, HISTORY_LIMIT),
      role: state.role,
      audit: state.audit,
      savedAt: new Date().toISOString(),
    }),
  );
}

function getSupabaseConfig() {
  const config = window.BOOK_INVENTORY_SUPABASE || {};
  const url = String(config.url || "").trim();
  const anonKey = String(config.anonKey || "").trim();
  if (!url || !anonKey || url.includes("YOUR_") || anonKey.includes("YOUR_")) return null;
  return { url, anonKey };
}

function setCloudStatus(message, type = "") {
  els.cloudStatus.textContent = message;
  els.cloudStatus.className = `status-card compact ${type}`.trim();
}

function isSchemaColumnError(error) {
  return /does not exist|schema cache|Could not find|42703/i.test(error?.message || error?.details || error?.code || "");
}

function updateCloudUi() {
  const configured = Boolean(state.supabase);
  const signedIn = Boolean(state.user);
  els.cloudState.textContent = signedIn ? "云端同步" : configured ? "待登录" : "本机模式";
  els.cloudState.classList.toggle("warning", !signedIn);
  els.storageNote.textContent = signedIn
    ? `已登录 ${state.user.email || "Supabase"}，库存会同步到云端。`
    : "Safari 摄像头直扫 ISBN，默认本机保存；登录后云端同步。";
  els.authForm.hidden = signedIn;
  els.signedInCard.hidden = !signedIn;
  els.signedInEmail.textContent = state.user?.email || "Supabase";
  els.authEmail.disabled = !configured || signedIn;
  els.authPassword.disabled = !configured || signedIn;
  els.signInButton.disabled = !configured || signedIn;
  els.syncButton.disabled = !signedIn || state.syncBusy;
  els.pushLocalButton.disabled = !signedIn || state.syncBusy;
}

async function initCloud() {
  const config = getSupabaseConfig();
  if (!config || !window.supabase?.createClient) {
    state.supabase = null;
    setCloudStatus("未配置 Supabase：当前使用本机存储。创建项目后把 URL 和 anon key 填入 supabase-config.js。");
    updateCloudUi();
    return;
  }

  state.supabase = window.supabase.createClient(config.url, config.anonKey);
  const { data, error } = await state.supabase.auth.getSession();
  if (error) {
    setCloudStatus(`云端会话读取失败：${error.message}`, "error");
  }
  state.user = data?.session?.user || null;
  updateCloudUi();

  state.supabase.auth.onAuthStateChange((_event, session) => {
    state.user = session?.user || null;
    updateCloudUi();
    if (state.user) syncFromCloud().catch((syncError) => setCloudStatus(`云端同步失败：${syncError.message}`, "error"));
  });

  if (state.user) {
    await syncFromCloud();
  } else {
    setCloudStatus("Supabase 已配置。登录后库存会与云端同步。", "success");
  }
}

function cloudBookPayload(book) {
  const timestamp = book.updatedAt || new Date().toISOString();
  return {
    isbn: book.isbn,
    title: book.title || "",
    authors: book.authors || "",
    publisher: book.publisher || "",
    source: book.source || "",
    cover_url: book.coverUrl || "",
    price: book.price || "",
    published_date: book.publishedDate || "",
    edition: book.edition || "",
    created_at: book.createdAt || timestamp,
    updated_at: timestamp,
  };
}

function basicCloudBookPayload(book) {
  const timestamp = book.updatedAt || new Date().toISOString();
  return {
    isbn: book.isbn,
    title: book.title || "",
    authors: book.authors || "",
    publisher: book.publisher || "",
    source: book.source || "",
    created_at: book.createdAt || timestamp,
    updated_at: timestamp,
  };
}

function cloudInventoryPayload(book) {
  const timestamp = book.updatedAt || new Date().toISOString();
  return {
    user_id: state.user.id,
    isbn: book.isbn,
    count: Math.max(0, Number(book.count || 0)),
    category: book.category || "",
    shelf: book.shelf || "",
    location: book.location || "",
    note: book.note || "",
    created_at: book.createdAt || timestamp,
    updated_at: timestamp,
  };
}

function basicCloudInventoryPayload(book) {
  const timestamp = book.updatedAt || new Date().toISOString();
  return {
    user_id: state.user.id,
    isbn: book.isbn,
    count: Math.max(0, Number(book.count || 0)),
    created_at: book.createdAt || timestamp,
    updated_at: timestamp,
  };
}

async function upsertCloudBooks(books) {
  const { error } = await state.supabase.from("books").upsert(books.map(cloudBookPayload), { onConflict: "isbn" });
  if (!error) return;
  if (!isSchemaColumnError(error)) throw error;
  const retry = await state.supabase.from("books").upsert(books.map(basicCloudBookPayload), { onConflict: "isbn" });
  if (retry.error) throw retry.error;
  setCloudStatus("云端基础同步成功。若要同步封面/版次/定价，请在 Supabase 运行升级 SQL。", "success");
}

async function upsertCloudInventory(books) {
  const { error } = await state.supabase.from("inventory").upsert(books.map(cloudInventoryPayload), { onConflict: "user_id,isbn" });
  if (!error) return;
  if (!isSchemaColumnError(error)) throw error;
  const retry = await state.supabase.from("inventory").upsert(books.map(basicCloudInventoryPayload), { onConflict: "user_id,isbn" });
  if (retry.error) throw retry.error;
}

function fromCloudRows(inventoryRows = [], movementRows = []) {
  const books = {};
  inventoryRows.forEach((row) => {
    const isbn = normalizeIsbn(row.isbn);
    if (!isbn) return;
    const book = row.books || {};
    books[isbn] = {
      isbn,
      title: book.title || "",
      authors: book.authors || "",
      publisher: book.publisher || "",
      source: book.source || "",
      coverUrl: book.cover_url || "",
      price: book.price || "",
      publishedDate: book.published_date || "",
      edition: book.edition || "",
      category: row.category || "",
      shelf: row.shelf || "",
      location: row.location || "",
      note: row.note || "",
      count: Math.max(0, Number(row.count || 0)),
      createdAt: row.created_at || new Date().toISOString(),
      updatedAt: row.updated_at || book.updated_at || new Date().toISOString(),
      updatedLabel: nowLabel(row.updated_at ? new Date(row.updated_at) : new Date()),
    };
  });

  const history = movementRows
    .map((row) => ({
      isbn: normalizeIsbn(row.isbn) || cleanIsbn(row.isbn),
      title: row.title || row.books?.title || "",
      delta: Number(row.delta || 0),
      reason: row.reason || "扫码",
      label: nowLabel(row.created_at ? new Date(row.created_at) : new Date()),
      at: row.created_at || new Date().toISOString(),
    }))
    .filter((item) => item.isbn)
    .slice(0, HISTORY_LIMIT);

  return { books, history };
}

async function syncFromCloud() {
  if (!state.supabase || !state.user) return;
  state.syncBusy = true;
  updateCloudUi();
  try {
    let { data: inventoryRows, error: inventoryError } = await state.supabase
      .from("inventory")
      .select("isbn,count,category,shelf,location,note,created_at,updated_at,books(isbn,title,authors,publisher,source,cover_url,price,published_date,edition,updated_at)")
      .eq("user_id", state.user.id)
      .order("updated_at", { ascending: false });
    if (inventoryError && isSchemaColumnError(inventoryError)) {
      ({ data: inventoryRows, error: inventoryError } = await state.supabase
        .from("inventory")
        .select("isbn,count,created_at,updated_at,books(isbn,title,authors,publisher,source,updated_at)")
        .eq("user_id", state.user.id)
        .order("updated_at", { ascending: false }));
      if (!inventoryError) {
        setCloudStatus("云端已按旧表结构同步。运行升级 SQL 后可同步分类、库位和封面。", "success");
      }
    }
    if (inventoryError) throw inventoryError;

    const { data: movementRows, error: movementError } = await state.supabase
      .from("stock_movements")
      .select("isbn,title,delta,reason,created_at")
      .eq("user_id", state.user.id)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (movementError) throw movementError;

    const cloudStore = fromCloudRows(inventoryRows || [], movementRows || []);
    state.books = normalizeStoredBooks({ ...cloudStore.books, ...state.books });
    state.history = normalizeStoredHistory([...cloudStore.history, ...state.history]).slice(0, HISTORY_LIMIT);
    saveStore();
    renderAll();
    setCloudStatus(`已同步云端：${Object.keys(cloudStore.books).length} 种书。`, "success");
  } finally {
    state.syncBusy = false;
    updateCloudUi();
  }
}

async function pushLocalToCloud() {
  if (!state.supabase || !state.user) return;
  state.syncBusy = true;
  updateCloudUi();
  try {
    const books = Object.values(state.books);
    if (books.length) {
      await upsertCloudBooks(books);
      await upsertCloudInventory(books);
    }
    setCloudStatus(`已上传本机库存：${books.length} 种书。`, "success");
  } finally {
    state.syncBusy = false;
    updateCloudUi();
  }
}

async function saveBookToCloud(book, effectiveDelta, reason) {
  if (!state.supabase || !state.user) return;
  await upsertCloudBooks([book]);
  await upsertCloudInventory([book]);

  if (effectiveDelta !== 0) {
    const { error: movementError } = await state.supabase.from("stock_movements").insert({
      user_id: state.user.id,
      isbn: book.isbn,
      title: book.title || "",
      delta: effectiveDelta,
      reason,
    });
    if (movementError) throw movementError;
  }
}

function normalizeLookupCacheBook(data, isbn) {
  if (!data?.title) return null;
  return {
    isbn,
    title: data.title,
    authors: data.authors || "",
    publisher: data.publisher || "",
    source: data.source || "云端书目缓存",
    coverUrl: data.cover_url || "",
    price: data.price || "",
    publishedDate: data.published_date || "",
    edition: data.edition || "",
  };
}

async function lookupCachedBook(isbn) {
  if (!state.supabase || !state.user) return null;
  let { data, error } = await state.supabase
    .from("lookup_cache")
    .select("title,authors,publisher,source,cover_url,price,published_date,edition")
    .eq("isbn", isbn)
    .maybeSingle();
  if (error && isSchemaColumnError(error)) {
    ({ data, error } = await state.supabase.from("lookup_cache").select("title,authors,publisher,source").eq("isbn", isbn).maybeSingle());
  }
  if (error) throw error;
  return normalizeLookupCacheBook(data, isbn);
}

async function cacheLookupBook(book) {
  if (!state.supabase || !state.user || !book?.title) return;
  const { error } = await state.supabase.from("lookup_cache").upsert(
    {
      isbn: book.isbn,
      title: book.title || "",
      authors: book.authors || "",
      publisher: book.publisher || "",
      source: book.source || "",
      cover_url: book.coverUrl || "",
      price: book.price || "",
      published_date: book.publishedDate || "",
      edition: book.edition || "",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "isbn" },
  );
  if (!error) return;
  if (!isSchemaColumnError(error)) throw error;
  await state.supabase.from("lookup_cache").upsert(
    {
      isbn: book.isbn,
      title: book.title || "",
      authors: book.authors || "",
      publisher: book.publisher || "",
      source: book.source || "",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "isbn" },
  );
}

function cleanIsbn(value) {
  return String(value || "").replace(/[^\dXx]/g, "").toUpperCase();
}

function isbn13CheckDigit(first12) {
  const sum = first12
    .split("")
    .reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return String((10 - (sum % 10)) % 10);
}

function isValidIsbn13(value) {
  return /^\d{13}$/.test(value) && /^(978|979)/.test(value) && isbn13CheckDigit(value.slice(0, 12)) === value[12];
}

function isValidIsbn10(value) {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  const sum = value.split("").reduce((total, digit, index) => {
    const number = digit === "X" ? 10 : Number(digit);
    return total + number * (10 - index);
  }, 0);
  return sum % 11 === 0;
}

function isbn10To13(value) {
  const first12 = `978${value.slice(0, 9)}`;
  return `${first12}${isbn13CheckDigit(first12)}`;
}

function normalizeIsbn(value) {
  const cleaned = cleanIsbn(value);
  if (isValidIsbn13(cleaned)) return cleaned;
  if (isValidIsbn10(cleaned)) return isbn10To13(cleaned);
  return "";
}

function formatIsbn13(isbn) {
  const cleaned = normalizeIsbn(isbn);
  if (!cleaned || cleaned.length !== 13) return cleaned;
  return `${cleaned.slice(0, 3)}-${cleaned[3]}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 12)}-${cleaned[12]}`;
}

function isLikelyBookCode(code) {
  return Boolean(normalizeIsbn(code));
}

function normalizeStoredBooks(books) {
  const normalized = {};
  Object.entries(books).forEach(([key, book]) => {
    const isbn = normalizeIsbn(book?.isbn || key);
    if (!isbn) return;

    const count = Math.max(0, Number(book?.count || 0));
    const existing = normalized[isbn];
    const next = {
      isbn,
      title: book?.title || existing?.title || "",
      authors: book?.authors || existing?.authors || "",
      publisher: book?.publisher || existing?.publisher || "",
      source: book?.source || existing?.source || "",
      coverUrl: book?.coverUrl || existing?.coverUrl || "",
      price: book?.price || existing?.price || "",
      publishedDate: book?.publishedDate || existing?.publishedDate || "",
      edition: book?.edition || existing?.edition || "",
      category: book?.category || existing?.category || "",
      shelf: book?.shelf || existing?.shelf || "",
      location: book?.location || existing?.location || "",
      note: book?.note || existing?.note || "",
      count: existing ? Number(existing.count || 0) + count : count,
      createdAt: existing?.createdAt || book?.createdAt || new Date().toISOString(),
      updatedAt: book?.updatedAt || existing?.updatedAt || new Date().toISOString(),
      updatedLabel: book?.updatedLabel || existing?.updatedLabel || "",
    };
    normalized[isbn] = next;
  });
  return normalized;
}

function normalizeStoredAudit(audit) {
  return {
    active: Boolean(audit?.active),
    scanned: Object.fromEntries(
      Object.entries(audit?.scanned || {})
        .map(([isbn, count]) => [normalizeIsbn(isbn), Math.max(0, Number(count || 0))])
        .filter(([isbn]) => isbn),
    ),
    extras: Object.fromEntries(
      Object.entries(audit?.extras || {})
        .map(([isbn, count]) => [normalizeIsbn(isbn), Math.max(0, Number(count || 0))])
        .filter(([isbn]) => isbn),
    ),
  };
}

function normalizeStoredHistory(history) {
  return history
    .map((item) => ({
      ...item,
      isbn: normalizeIsbn(item?.isbn) || cleanIsbn(item?.isbn),
    }))
    .filter((item) => item.isbn)
    .slice(0, HISTORY_LIMIT);
}

function nowLabel(date = new Date()) {
  const safeDate = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(safeDate);
}

function setStatus(message, type = "") {
  els.scanStatus.textContent = message;
  els.scanStatus.className = `status-card ${type}`.trim();
}

function updateSecureState() {
  const isSecure = window.isSecureContext;
  const hasCameraApi = Boolean(navigator.mediaDevices?.getUserMedia);
  els.secureState.textContent = isSecure && hasCameraApi ? "摄像头可用" : "需要 HTTPS";
  els.secureState.classList.toggle("warning", !isSecure || !hasCameraApi);

  if (!isSecure) {
    setStatus("iPhone Safari 调用摄像头必须使用 HTTPS 或 localhost。请使用我给出的 HTTPS 网址打开。", "error");
  } else if (!hasCameraApi) {
    setStatus("当前浏览器没有开放网页摄像头接口。请用 iPhone 自带 Safari 打开 HTTPS 网址。", "error");
  }
}

function getBookTitle(book) {
  if (!book) return "未命名图书";
  return book.title || `未识别书名 (${book.isbn})`;
}

function renderStats() {
  const books = Object.values(state.books);
  const stocked = books.filter((book) => book.count > 0);
  const total = books.reduce((sum, book) => sum + Math.max(0, Number(book.count) || 0), 0);
  const low = stocked.filter((book) => book.count <= LOW_STOCK_LIMIT).length;

  els.statKinds.textContent = stocked.length;
  els.statTotal.textContent = total;
  els.statLow.textContent = low;
}

function renderInventory() {
  const term = els.searchInput.value.trim().toLowerCase();
  const books = Object.values(state.books)
    .filter((book) => {
      if (!term) return true;
      return `${book.title || ""} ${book.isbn} ${book.authors || ""} ${book.publisher || ""} ${book.category || ""} ${book.shelf || ""} ${book.location || ""}`
        .toLowerCase()
        .includes(term);
    })
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  els.inventoryList.replaceChildren();

  if (!books.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = term ? "没有匹配的库存记录。" : "还没有库存。先扫一本书，我们从第一本开始。";
    els.inventoryList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  books.forEach((book) => {
    const node = els.bookRowTemplate.content.firstElementChild.cloneNode(true);
    const cover = node.querySelector(".book-cover");
    if (book.coverUrl) {
      cover.src = book.coverUrl;
      cover.alt = `${getBookTitle(book)} 封面`;
      cover.hidden = false;
    } else {
      cover.hidden = true;
    }
    node.querySelector(".book-title").textContent = getBookTitle(book);
    node.querySelector(".book-meta").textContent = `${book.isbn} · ${book.authors || "作者未知"} · ${book.publisher || "出版社未知"}`;
    node.querySelector(".book-place").textContent = [book.category, book.shelf, book.location, book.edition, book.price && `定价 ${book.price}`]
      .filter(Boolean)
      .join(" · ");
    node.querySelector(".book-count").textContent = book.count;
    node.querySelector(".minus").addEventListener("click", () => changeInventory(book.isbn, -1, "手动调整"));
    node.querySelector(".plus").addEventListener("click", () => changeInventory(book.isbn, 1, "手动调整"));
    node.querySelector(".edit").addEventListener("click", () => fillManualForm(book));
    fragment.append(node);
  });
  els.inventoryList.append(fragment);
}

function renderAudit() {
  const scannedTotal = Object.values(state.audit.scanned).reduce((sum, count) => sum + Number(count || 0), 0);
  const missing = Object.values(state.books).filter((book) => Math.max(0, Number(book.count || 0)) > Number(state.audit.scanned[book.isbn] || 0));
  const extraCount = Object.values(state.audit.extras).reduce((sum, count) => sum + Number(count || 0), 0);
  els.auditSummary.replaceChildren();
  ["已扫", "缺失", "多出"].forEach((label, index) => {
    const span = document.createElement("span");
    span.textContent = `${label} ${index === 0 ? scannedTotal : index === 1 ? missing.length : extraCount} 本`;
    els.auditSummary.append(span);
  });
  els.auditList.replaceChildren();
  const rows = [
    ...missing.slice(0, 8).map((book) => ({ title: getBookTitle(book), meta: `${book.isbn} · 应有 ${book.count} / 已扫 ${state.audit.scanned[book.isbn] || 0}`, tag: "缺失" })),
    ...Object.entries(state.audit.extras)
      .slice(0, 8)
      .map(([isbn, count]) => ({ title: state.books[isbn]?.title || `库存外图书 (${isbn})`, meta: `${isbn} · ${count} 本`, tag: "多出" })),
  ];
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.audit.active ? "盘点中，暂未发现差异。" : "切换到盘点模式后开始扫码。";
    els.auditList.append(empty);
    return;
  }
  rows.forEach((row) => {
    const item = document.createElement("article");
    item.className = "audit-item";
    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = row.title;
    const meta = document.createElement("span");
    meta.textContent = row.meta;
    const tag = document.createElement("b");
    tag.textContent = row.tag;
    text.append(title, meta);
    item.append(text, tag);
    els.auditList.append(item);
  });
}

function renderHistory() {
  els.historyList.replaceChildren();

  if (!state.history.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无出入库记录。";
    els.historyList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.history.slice(0, 12).forEach((item) => {
    const row = document.createElement("article");
    row.className = "history-item";

    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = item.title || `未识别书名 (${item.isbn})`;
    const meta = document.createElement("span");
    meta.textContent = `${item.isbn} · ${item.reason} · ${item.label}`;
    text.append(title, meta);

    const delta = document.createElement("div");
    delta.className = `history-delta ${item.delta < 0 ? "out" : ""}`;
    delta.textContent = item.delta > 0 ? `+${item.delta}` : String(item.delta);

    row.append(text, delta);
    fragment.append(row);
  });
  els.historyList.append(fragment);
}

function renderAll() {
  renderStats();
  renderInventory();
  renderHistory();
  renderAudit();
}

function upsertBook(book, delta, reason) {
  const isbn = normalizeIsbn(book.isbn);
  if (!isbn) throw new Error("ISBN 无效");

  const existing = state.books[isbn] || {
    isbn,
    title: "",
    authors: "",
    publisher: "",
    count: 0,
    createdAt: new Date().toISOString(),
  };
  if (state.role === "staff" && reason !== "扫码" && reason !== "照片识别") {
    setStatus("员工模式只能扫码出入库，不能手动调整资料。", "error");
    return existing;
  }

  const currentCount = Number(existing.count || 0);
  const nextCount = Math.max(0, currentCount + Number(delta || 0));
  const effectiveDelta = nextCount - currentCount;
  const updated = {
    ...existing,
    ...book,
    isbn,
    title: book.title || existing.title,
    authors: book.authors || existing.authors,
    publisher: book.publisher || existing.publisher,
    source: book.source || existing.source,
    coverUrl: book.coverUrl || existing.coverUrl || "",
    price: book.price || existing.price || "",
    publishedDate: book.publishedDate || existing.publishedDate || "",
    edition: book.edition || existing.edition || "",
    category: book.category || existing.category || "",
    shelf: book.shelf || existing.shelf || "",
    location: book.location || existing.location || "",
    note: book.note || existing.note || "",
    count: nextCount,
    updatedAt: new Date().toISOString(),
    updatedLabel: nowLabel(),
  };

  state.books[isbn] = updated;

  if (effectiveDelta !== 0) {
    state.history.unshift({
      isbn,
      title: updated.title,
      delta: effectiveDelta,
      reason,
      label: nowLabel(),
      at: new Date().toISOString(),
    });
    state.history = state.history.slice(0, HISTORY_LIMIT);
  }

  saveStore();
  renderAll();
  saveBookToCloud(updated, effectiveDelta, reason).catch((error) => {
    setCloudStatus(`本机已保存，云端同步失败：${error.message || "网络异常"}`, "error");
  });
  return updated;
}

function fillManualForm(book) {
  els.manualIsbn.value = book.isbn || "";
  els.manualTitleInput.value = book.title || "";
  els.manualDelta.value = "0";
  els.manualCategory.value = book.category || "";
  els.manualShelf.value = book.shelf || "";
  els.manualLocation.value = book.location || "";
  els.manualCoverUrl.value = book.coverUrl || "";
  els.manualPrice.value = book.price || "";
  els.manualPublishedDate.value = book.publishedDate || "";
  els.manualEdition.value = book.edition || "";
  els.manualNote.value = book.note || "";
  els.manualTitleInput.focus({ preventScroll: true });
}

function changeInventory(isbn, delta, reason = "扫码") {
  const book = state.books[normalizeIsbn(isbn)];
  if (!book) return null;
  const updated = upsertBook(book, delta, reason);
  setStatus(`${getBookTitle(updated)}：库存 ${updated.count} 本`, "success");
  return updated;
}

async function fetchJson(url, timeout = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeout = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function fetchJsonp(url, timeout = 6500) {
  return new Promise((resolve, reject) => {
    const callbackName = `__bookInventoryJsonp${Date.now()}${Math.random().toString(16).slice(2)}`;
    const script = document.createElement("script");
    const separator = url.includes("?") ? "&" : "?";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("ISBN 数据源超时"));
    }, timeout);

    function cleanup() {
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
    }

    window[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("ISBN 数据源不可用"));
    };

    script.src = `${url}${separator}callback=${encodeURIComponent(callbackName)}`;
    document.head.append(script);
  });
}

function namedList(items) {
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => (typeof item === "string" ? item : item?.name))
    .filter(Boolean)
    .join("、");
}

function readerUrl(targetUrl) {
  return `${JINA_READER_PREFIX}${targetUrl}`;
}

function markdownLines(markdown) {
  return String(markdown || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function cleanMarkdownText(value) {
  return String(value || "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/[`*_>#]+/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanBookTitle(value, isbn = "") {
  return cleanMarkdownText(value)
    .replace(new RegExp(`\\b${isbn}\\b`, "g"), "")
    .replace(/^Title:\s*ISBN\s*\d{10,13}\s*-\s*/i, "")
    .replace(/\s+-\s*读书\s+-\s*豆瓣搜索$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownLinkText(line, urlPattern) {
  const linkRegex = /(!?)\[([^\]]+)]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match = linkRegex.exec(line);
  while (match) {
    const [, imageMark, text, url] = match;
    if (!imageMark && urlPattern.test(url)) {
      return cleanMarkdownText(text);
    }
    match = linkRegex.exec(line);
  }
  return "";
}

function extractCleanField(lines, label) {
  const prefix = `${label}:`;
  const line = lines.map(cleanMarkdownText).find((item) => item.toLowerCase().startsWith(prefix.toLowerCase()));
  return line ? line.slice(prefix.length).trim() : "";
}

function looksLikePublisher(value) {
  return /出版社|出版公司|书局|书店|Press|Publishing|Publisher|社$/i.test(value);
}

function splitCreditLine(value) {
  return cleanMarkdownText(value)
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeOpenLibraryBook(data, isbn) {
  const entry = data?.[`ISBN:${isbn}`];
  if (!entry?.title) return null;
  return {
    isbn,
    title: [entry.title, entry.subtitle].filter(Boolean).join(": "),
    authors: namedList(entry.authors),
    publisher: namedList(entry.publishers),
    source: "Open Library",
  };
}

function normalizeGoogleBook(data, isbn) {
  const info = data?.items?.[0]?.volumeInfo;
  if (!info?.title) return null;
  const imageLinks = info.imageLinks || {};
  return {
    isbn,
    title: info.title,
    authors: Array.isArray(info.authors) ? info.authors.join("、") : "",
    publisher: info.publisher || "",
    publishedDate: info.publishedDate || "",
    coverUrl: imageLinks.thumbnail || imageLinks.smallThumbnail || "",
    source: "Google Books",
  };
}

function normalizeOpenBdBook(data, isbn) {
  const summary = Array.isArray(data) ? data[0]?.summary : null;
  if (!summary?.title) return null;
  return {
    isbn,
    title: summary.title,
    authors: summary.author || "",
    publisher: summary.publisher || "",
    source: "openBD",
  };
}

function normalizeDoubanBook(markdown, isbn) {
  const lines = markdownLines(markdown);
  const titleIndex = lines.findIndex((line) =>
    markdownLinkText(line, /^https:\/\/book\.douban\.com\/subject\/\d+\/?$/),
  );
  if (titleIndex < 0) return null;

  const title = cleanBookTitle(markdownLinkText(lines[titleIndex], /^https:\/\/book\.douban\.com\/subject\/\d+\/?$/), isbn);
  if (!title || title.includes("添加书籍")) return null;

  const metaLine = lines
    .slice(titleIndex + 1, titleIndex + 8)
    .map(cleanMarkdownText)
    .find((line) => line.includes(" / ") && !line.includes("添加豆瓣没有的图书"));
  const parts = splitCreditLine(metaLine || "");
  const publisherIndex = parts.findIndex(looksLikePublisher);
  const publisher = publisherIndex >= 0 ? parts[publisherIndex] : parts[1] || "";
  const authors = publisherIndex > 0 ? parts.slice(0, publisherIndex).join("、") : parts[0] || "";

  return {
    isbn,
    title,
    authors,
    publisher,
    publishedDate: parts[publisherIndex + 1] || "",
    price: parts.find((part) => /元|¥/.test(part)) || "",
    source: "豆瓣读书",
  };
}

async function lookupDoubanBook(isbn) {
  const target = `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(isbn)}&cat=1001`;
  const markdown = await fetchText(readerUrl(target), 12000);
  return normalizeDoubanBook(markdown, isbn);
}

function normalizeIsbnSearchBook(markdown, isbn) {
  const lines = markdownLines(markdown);
  if (!lines.some((line) => line.includes(isbn))) return null;

  const headingLine = lines.find((line) => /^##\s+/.test(line) && !/Best Prices|Compare|ISBN Search/i.test(line));
  const docTitleLine = lines.find((line) => /^Title:\s*ISBN\s+\d{10,13}\s+-\s+/i.test(line));
  const title = cleanBookTitle(headingLine ? headingLine.replace(/^##\s+/, "") : docTitleLine || "", isbn);
  if (!title) return null;

  return {
    isbn,
    title,
    authors: extractCleanField(lines, "Author"),
    publisher: extractCleanField(lines, "Publisher"),
    publishedDate: extractCleanField(lines, "Published"),
    source: "ISBN Search",
  };
}

async function lookupIsbnSearchBook(isbn) {
  const markdown = await fetchText(readerUrl(`https://www.isbnsearch.org/isbn/${encodeURIComponent(isbn)}`), 12000);
  return normalizeIsbnSearchBook(markdown, isbn);
}

function normalizeHepSearchBook(markdown, isbn) {
  const lines = markdownLines(markdown);
  const titleIndex = lines.findIndex((line) =>
    markdownLinkText(line, /^https:\/\/xuanshu\.hep\.com\.cn\/front\/book\/findBookDetails\?bookId=/),
  );
  if (titleIndex < 0) return null;

  const title = cleanBookTitle(
    markdownLinkText(lines[titleIndex], /^https:\/\/xuanshu\.hep\.com\.cn\/front\/book\/findBookDetails\?bookId=/),
    isbn,
  );
  const authors = lines
    .slice(titleIndex + 1, titleIndex + 5)
    .find((line) => line.startsWith("#### "))
    ?.replace(/^####\s*/, "")
    .trim();

  if (!title) return null;
  return {
    isbn,
    title,
    authors: authors || "",
    publisher: "高等教育出版社",
    source: "高教社产品信息检索系统",
  };
}

async function lookupHepBook(isbn) {
  const queries = Array.from(new Set([formatIsbn13(isbn), isbn].filter(Boolean)));
  for (const query of queries) {
    try {
      const target = `https://xuanshu.hep.com.cn/front/book/bookSearch?wd=${encodeURIComponent(query)}&searchType=book`;
      const markdown = await fetchText(readerUrl(target), 12000);
      const found = normalizeHepSearchBook(markdown, isbn);
      if (found?.title) return found;
    } catch {
      // Try the next ISBN spelling; the site accepts both hyphenated and plain ISBNs inconsistently.
    }
  }
  return null;
}

function cleanDangdangTitle(value, isbn) {
  return cleanBookTitle(value, isbn)
    .replace(/【[^】]*】/g, "")
    .replace(/\s+(正版|现货|全新|速发|速开发票|优质售后|支持7天|七天无理由|团购优惠|正规发票).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDangdangBook(markdown, isbn) {
  const lines = markdownLines(markdown);
  const candidates = lines
    .map((line, index) => ({
      index,
      title: markdownLinkText(line, /^https:\/\/product\.dangdang\.com\/\d+\.html/),
    }))
    .filter((candidate) => candidate.title)
    .map((candidate) => {
      const title = cleanDangdangTitle(candidate.title, isbn);
      const score =
        (candidate.title.includes(isbn) ? 8 : 0) +
        (/（.+版）|\(.+版\)|第.+版/.test(candidate.title) ? 3 : 0) +
        (candidate.title.length <= 60 ? 2 : 0) -
        (/专营店|旗舰店|售后|发票|团购|包邮/.test(candidate.title) ? 4 : 0);
      return { ...candidate, title, score };
    })
    .filter((candidate) => candidate.title);
  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const metaLine = lines
    .slice(best.index + 1, best.index + 10)
    .map(cleanMarkdownText)
    .find((line) => line.includes("/") && line.split("/").some((part) => looksLikePublisher(part.trim())));
  const parts = splitCreditLine(metaLine || "");
  const publisher = parts.find(looksLikePublisher) || "";
  const authors = parts.find((part) => part !== publisher && !/^\d{4}/.test(part) && !/不详|佚名/.test(part)) || "";

  return {
    isbn,
    title: best.title,
    authors,
    publisher,
    source: "当当公开搜索",
  };
}

async function lookupDangdangBook(isbn) {
  const target = `https://search.dangdang.com/?key=${encodeURIComponent(isbn)}&act=input`;
  const markdown = await fetchText(readerUrl(target), 12000);
  return normalizeDangdangBook(markdown, isbn);
}

async function lookupBook(isbn) {
  const cleaned = normalizeIsbn(isbn);
  const cached = state.books[cleaned];
  if (cached?.title) return cached;

  const lookups = [
    async () => lookupCachedBook(cleaned),
    async () => lookupDoubanBook(cleaned),
    async () => lookupHepBook(cleaned),
    async () => lookupIsbnSearchBook(cleaned),
    async () => normalizeOpenBdBook(await fetchJson(`https://api.openbd.jp/v1/get?isbn=${cleaned}`), cleaned),
    async () =>
      normalizeOpenLibraryBook(
        await fetchJsonp(
          `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(cleaned)}&jscmd=data&format=javascript`,
        ),
        cleaned,
      ),
    async () => lookupDangdangBook(cleaned),
    async () => normalizeGoogleBook(await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${cleaned}`), cleaned),
  ];

  for (const lookup of lookups) {
    try {
      const found = await lookup();
      if (found?.title) {
        cacheLookupBook(found).catch(() => {});
        return found;
      }
    } catch {
      // Try the next public ISBN source. Some providers rate-limit or miss local titles.
    }
  }

  return {
    isbn: cleaned,
    title: "",
    authors: "",
    publisher: "",
    source: "manual",
  };
}

function pulseSuccess() {
  navigator.vibrate?.(35);
}

function getDeltaForMode() {
  if (state.mode === "in") return 1;
  if (state.mode === "out") return -1;
  return 0;
}

function auditBook(book) {
  const isbn = normalizeIsbn(book.isbn);
  if (!isbn) return;
  state.audit.active = true;
  if (state.books[isbn]) {
    state.audit.scanned[isbn] = Number(state.audit.scanned[isbn] || 0) + 1;
  } else {
    state.audit.extras[isbn] = Number(state.audit.extras[isbn] || 0) + 1;
    if (book.title) {
      state.books[isbn] = {
        isbn,
        title: book.title,
        authors: book.authors || "",
        publisher: book.publisher || "",
        source: book.source || "",
        count: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedLabel: nowLabel(),
      };
    }
  }
  saveStore();
  renderAll();
}

async function handleDetectedCode(rawCode, reason = "扫码") {
  const isbn = normalizeIsbn(rawCode);
  const displayedCode = cleanIsbn(rawCode) || rawCode;
  const now = Date.now();

  if (!isLikelyBookCode(rawCode)) {
    setStatus(`识别到 ${displayedCode}，但不是有效图书 ISBN。请对准 978 / 979 开头的书籍条形码。`, "error");
    return;
  }

  if (state.busyCodes.has(isbn)) return;
  if (state.lastCode === isbn && now - state.lastCodeAt < DUPLICATE_SCAN_GAP_MS) return;

  state.lastCode = isbn;
  state.lastCodeAt = now;
  state.busyCodes.add(isbn);
  const singleScan = reason === "扫码" && !els.continuousScan.checked;
  state.scanLocked = singleScan;
  if (singleScan) {
    stopScanner();
  }
  setStatus(`已扫到 ${isbn}，${singleScan ? "已停止扫码，" : ""}正在自动查询书名...`);

  try {
    const book = await lookupBook(isbn);
    if (state.mode === "audit") {
      auditBook(book);
      pulseSuccess();
      setStatus(`${getBookTitle(book)} 已计入盘点。${els.continuousScan.checked ? "可继续扫码。" : "扫下一本请再点“开始扫码”。"}`, "success");
      return;
    }
    const delta = getDeltaForMode();
    const currentCount = Number(state.books[isbn]?.count || 0);

    if (state.mode === "lookup") {
      if (state.books[isbn] && book.title && !state.books[isbn].title) {
        upsertBook(book, 0, "书名更新");
      }

      const stockedBook = state.books[isbn];
      pulseSuccess();
      if (stockedBook) {
        setStatus(`${getBookTitle(stockedBook)}：当前库存 ${stockedBook.count} 本。${els.continuousScan.checked ? "可继续扫码。" : "扫下一本请再点“开始扫码”。"}`, "success");
      } else if (book.title) {
        setStatus(`${getBookTitle(book)}：库存中暂无记录。${els.continuousScan.checked ? "可继续扫码。" : "扫下一本请再点“开始扫码”。"}`, "success");
      } else {
        els.manualIsbn.value = isbn;
        setStatus(`库存中没有 ${isbn}，多个公开书目源也暂未返回书名。`, "error");
      }
      return;
    }

    if (delta < 0 && currentCount <= 0) {
      pulseSuccess();
      setStatus(`${getBookTitle(book)} 当前库存为 0，不能继续出库。${els.continuousScan.checked ? "可继续扫码。" : "扫下一本请再点“开始扫码”。"}`, "error");
      return;
    }

    const updated = upsertBook(book, delta, reason);
    pulseSuccess();

    if (!updated.title) {
      els.manualIsbn.value = isbn;
      els.manualTitleInput.focus({ preventScroll: true });
      setStatus(`已记录 ${isbn}，但多个公开书目源暂未返回书名。请在“补录”里填一次书名，之后同一本会自动识别。`, "error");
      return;
    }

    setStatus(`${getBookTitle(updated)} ${delta > 0 ? "入库" : "出库"}成功，当前库存 ${updated.count} 本。${els.continuousScan.checked ? "可继续扫码。" : "扫下一本请再点“开始扫码”。"}`, "success");
  } catch (error) {
    setStatus(`识别成功但查询失败：${error.message || "网络异常"}。可先补录书名，库存仍会保存在本机。`, "error");
  } finally {
    state.busyCodes.delete(isbn);
  }
}

function ensureScanner() {
  if (!window.ZXingBrowser) {
    throw new Error("扫码库还没有加载完成，请刷新页面再试。");
  }

  if (!state.scanner) {
    state.scanner = new ZXingBrowser.BrowserMultiFormatReader(undefined, {
      delayBetweenScanAttempts: 90,
      delayBetweenScanSuccess: 850,
      tryPlayVideoTimeout: 6000,
    });
  }

  return state.scanner;
}

function stopTracks() {
  if (state.activeStream) {
    state.activeStream.getTracks().forEach((track) => track.stop());
    state.activeStream = null;
  }
  els.preview.srcObject = null;
}

function updateScanButtons(active) {
  els.startScan.disabled = active;
  els.stopScan.disabled = !active;
  els.cameraHint.hidden = active;
  els.preview.closest(".scan-stage")?.classList.toggle("is-scanning", active);
}

async function startScanner() {
  if (!window.isSecureContext) {
    setStatus("当前页面不是安全环境。请使用 HTTPS 网址打开，否则 iPhone Safari 不会授权摄像头。", "error");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("当前浏览器没有开放网页摄像头接口。请用 iPhone 自带 Safari 打开 HTTPS 网址。", "error");
    return;
  }

  try {
    const scanner = ensureScanner();
    stopScanner();
    state.scanLocked = false;

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    };

    updateScanButtons(true);
    setStatus("正在请求摄像头权限...");

    state.activeStream = await navigator.mediaDevices.getUserMedia(constraints);
    els.preview.srcObject = state.activeStream;
    await els.preview.play();

    const [track] = state.activeStream.getVideoTracks();
    const capabilities = track?.getCapabilities?.() || {};
    els.torchButton.hidden = !("torch" in capabilities);
    els.torchButton.textContent = "补光灯";

    state.scanControls = await scanner.decodeFromStream(state.activeStream, els.preview, (result, error) => {
      if (state.scanLocked) return;
      if (result) {
        handleDetectedCode(result.getText(), "扫码");
      } else if (error) {
        const errorName = error.name || error.constructor?.name;
        if (errorName && !["NotFoundException", "ChecksumException", "FormatException"].includes(errorName)) {
          console.debug(error);
        }
      }
    });

    if (state.scanControls?.switchTorch) {
      els.torchButton.hidden = false;
    }

    setStatus(els.continuousScan.checked ? "摄像头已开启。连续扫码模式下会持续识别，请快速移开已扫图书。" : "摄像头已开启。识别到一本后会自动停止；扫下一本请再点“开始扫码”。");
  } catch (error) {
    updateScanButtons(false);
    stopTracks();
    setStatus(`无法开启摄像头：${error.message || "请检查 Safari 摄像头权限"}`, "error");
  }
}

function stopScanner() {
  state.scanLocked = true;
  if (state.scanControls?.stop) {
    try {
      state.scanControls.stop();
    } catch {
      // The media tracks are also stopped below.
    }
  }
  state.scanControls = null;
  stopTracks();
  updateScanButtons(false);
  els.torchButton.hidden = true;
  state.torchOn = false;
}

async function toggleTorch() {
  const [track] = state.activeStream?.getVideoTracks?.() || [];
  if (!track?.applyConstraints) return;

  state.torchOn = !state.torchOn;
  try {
    if (state.scanControls?.switchTorch) {
      await state.scanControls.switchTorch(state.torchOn);
    } else {
      await track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
    }
    els.torchButton.textContent = state.torchOn ? "关灯" : "补光灯";
  } catch {
    state.torchOn = false;
    setStatus("这台设备或当前浏览器暂不支持网页补光灯控制。", "error");
  }
}

async function decodeImageFile(file) {
  if (!file) return;

  let imageUrl = "";
  try {
    const scanner = ensureScanner();
    imageUrl = URL.createObjectURL(file);
    setStatus("正在识别照片里的条形码...");
    const result = await scanner.decodeFromImageUrl(imageUrl);
    await handleDetectedCode(result.getText(), "照片识别");
  } catch {
    setStatus("照片里没有识别到清晰条形码。请让条形码更平、更亮，或直接使用摄像头扫码。", "error");
  } finally {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    els.photoInput.value = "";
  }
}

function exportInventory() {
  const rows = [["ISBN", "书名", "作者", "出版社", "分类", "书架", "库位", "库存", "封面", "定价", "出版日期", "版次", "备注", "更新时间"]];
  Object.values(state.books)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .forEach((book) => {
      rows.push([
        book.isbn,
        book.title || "",
        book.authors || "",
        book.publisher || "",
        book.category || "",
        book.shelf || "",
        book.location || "",
        book.count,
        book.coverUrl || "",
        book.price || "",
        book.publishedDate || "",
        book.edition || "",
        book.note || "",
        book.updatedAt || "",
      ]);
    });
  downloadCsv(rows, `book-inventory-${new Date().toISOString().slice(0, 10)}.csv`);
}

function downloadCsv(rows, filename) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportAudit() {
  const rows = [["ISBN", "书名", "应有", "实扫", "差异", "状态", "分类", "书架", "库位"]];
  Object.values(state.books).forEach((book) => {
    const expected = Number(book.count || 0);
    const actual = Number(state.audit.scanned[book.isbn] || 0);
    rows.push([book.isbn, getBookTitle(book), expected, actual, actual - expected, actual < expected ? "缺失" : actual > expected ? "多出" : "正常", book.category || "", book.shelf || "", book.location || ""]);
  });
  Object.entries(state.audit.extras).forEach(([isbn, count]) => {
    if (state.books[isbn]) return;
    rows.push([isbn, "", 0, count, count, "库存外", "", "", ""]);
  });
  downloadCsv(rows, `book-audit-${new Date().toISOString().slice(0, 10)}.csv`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted && char === '"' && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((item) => item.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((item) => item.trim())) rows.push(row);
  return rows;
}

async function importInventoryFile(file) {
  if (!file) return;
  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length < 2) {
    setStatus("导入文件为空或格式不正确。", "error");
    return;
  }
  const header = rows[0].map((item) => item.trim());
  const indexOf = (...names) => header.findIndex((item) => names.includes(item));
  const isbnIndex = indexOf("ISBN", "isbn", "条形码");
  const titleIndex = indexOf("书名", "title");
  const countIndex = indexOf("库存", "数量", "count");
  let imported = 0;
  rows.slice(1).forEach((row) => {
    const isbn = normalizeIsbn(row[isbnIndex]);
    if (!isbn) return;
    upsertBook(
      {
        isbn,
        title: row[titleIndex] || state.books[isbn]?.title || "",
        authors: row[indexOf("作者", "authors")] || "",
        publisher: row[indexOf("出版社", "publisher")] || "",
        category: row[indexOf("分类", "category")] || "",
        shelf: row[indexOf("书架", "shelf")] || "",
        location: row[indexOf("库位", "location")] || "",
        coverUrl: row[indexOf("封面", "coverUrl")] || "",
        price: row[indexOf("定价", "price")] || "",
        publishedDate: row[indexOf("出版日期", "publishedDate")] || "",
        edition: row[indexOf("版次", "edition")] || "",
        note: row[indexOf("备注", "note")] || "",
        source: "CSV导入",
      },
      Number(row[countIndex] || 0),
      "CSV导入",
    );
    imported += 1;
  });
  els.importInput.value = "";
  setStatus(`已导入 ${imported} 条库存记录。`, "success");
}

function bindEvents() {
  $$(".mode-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      $$(".mode-button").forEach((item) => item.classList.toggle("active", item === button));
      const label = state.mode === "in" ? "入库" : state.mode === "out" ? "出库" : state.mode === "audit" ? "盘点" : "查询";
      if (state.mode === "audit") state.audit.active = true;
      saveStore();
      setStatus(`已切换到${label}模式。下一次扫码会按这个模式处理。`);
    });
  });

  els.startScan.addEventListener("click", startScanner);
  els.stopScan.addEventListener("click", () => {
    stopScanner();
    setStatus("摄像头已停止。");
  });
  els.torchButton.addEventListener("click", toggleTorch);
  els.photoInput.addEventListener("change", (event) => decodeImageFile(event.target.files[0]));
  els.searchInput.addEventListener("input", renderInventory);
  els.exportButton.addEventListener("click", exportInventory);
  els.exportAuditButton.addEventListener("click", exportAudit);
  els.importInput.addEventListener("change", (event) => importInventoryFile(event.target.files[0]));
  els.resetAuditButton.addEventListener("click", () => {
    state.audit = { active: true, scanned: {}, extras: {} };
    saveStore();
    renderAudit();
    setStatus("已开始新盘点。切换到盘点模式后扫码。");
  });
  els.roleSelect.value = state.role;
  els.roleSelect.addEventListener("change", () => {
    state.role = els.roleSelect.value;
    saveStore();
    setStatus(`已切换到${state.role === "admin" ? "管理员" : "员工"}模式。`);
  });
  els.authForm.addEventListener("submit", handleAuthSubmit);
  els.signOutButton.addEventListener("click", signOut);
  els.syncButton.addEventListener("click", () => {
    syncFromCloud().catch((error) => setCloudStatus(`云端同步失败：${error.message || "网络异常"}`, "error"));
  });
  els.pushLocalButton.addEventListener("click", () => {
    pushLocalToCloud().catch((error) => setCloudStatus(`上传失败：${error.message || "网络异常"}`, "error"));
  });

  els.manualForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const isbn = normalizeIsbn(els.manualIsbn.value);
    const title = els.manualTitleInput.value.trim();
    const delta = Number(els.manualDelta.value || 0);
    const existing = state.books[isbn];
    if (state.role === "staff") {
      setStatus("员工模式不能手动补录或改资料，请切换管理员模式。", "error");
      return;
    }

    if (!isbn) {
      setStatus("请填写有效的 ISBN-10 或 978 / 979 开头的 ISBN-13。", "error");
      return;
    }

    if (!title && !existing?.title) {
      setStatus("请填写书名；同一本书之后会自动沿用这个书名。", "error");
      return;
    }

    const updated = upsertBook(
      {
        isbn,
        title: title || existing.title,
        authors: existing?.authors || "",
        publisher: existing?.publisher || "",
        source: title ? "手动补录" : existing?.source || "",
        category: els.manualCategory.value.trim() || existing?.category || "",
        shelf: els.manualShelf.value.trim() || existing?.shelf || "",
        location: els.manualLocation.value.trim() || existing?.location || "",
        coverUrl: els.manualCoverUrl.value.trim() || existing?.coverUrl || "",
        price: els.manualPrice.value.trim() || existing?.price || "",
        publishedDate: els.manualPublishedDate.value.trim() || existing?.publishedDate || "",
        edition: els.manualEdition.value.trim() || existing?.edition || "",
        note: els.manualNote.value.trim() || existing?.note || "",
      },
      delta,
      "手动补录",
    );
    els.manualForm.reset();
    els.manualDelta.value = "1";
    [els.manualCategory, els.manualShelf, els.manualLocation, els.manualCoverUrl, els.manualPrice, els.manualPublishedDate, els.manualEdition, els.manualNote].forEach((input) => {
      input.value = "";
    });
    setStatus(`${getBookTitle(updated)} 已保存，当前库存 ${updated.count} 本`, "success");
  });

  els.clearAll.addEventListener("click", () => {
    if (state.role !== "admin") {
      setStatus("员工模式不能清空库存。", "error");
      return;
    }
    const ok = window.confirm("确定清空本机全部库存和流水记录吗？此操作不能撤销。");
    if (!ok) return;
    state.books = {};
    state.history = [];
    saveStore();
    renderAll();
    setStatus("本机库存已清空。云端数据不会被这个按钮删除。");
  });

  window.addEventListener("beforeunload", stopScanner);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    els.installButton.hidden = false;
  });

  els.installButton.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    els.installButton.hidden = true;
  });
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (!state.supabase) {
    setCloudStatus("还没有配置 Supabase。请先填写 supabase-config.js。", "error");
    return;
  }

  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;
  if (!email || password.length < 6) {
    setCloudStatus("请填写邮箱和至少 6 位密码。", "error");
    return;
  }

  state.syncBusy = true;
  updateCloudUi();
  try {
    let { data, error } = await state.supabase.auth.signInWithPassword({ email, password });
    if (error && /Invalid login credentials/i.test(error.message || "")) {
      ({ data, error } = await state.supabase.auth.signUp({ email, password }));
    }
    if (error) throw error;
    state.user = data?.user || data?.session?.user || state.user;
    els.authPassword.value = "";
    if (!data?.session && data?.user && !state.user) {
      setCloudStatus("账号已创建，请先到邮箱点击 Supabase 确认邮件，再回来登录。", "success");
      return;
    }
    setCloudStatus("已登录。正在同步云端库存...", "success");
    await pushLocalToCloud();
    await syncFromCloud();
  } catch (error) {
    setCloudStatus(`登录/注册失败：${error.message || "请检查邮箱和密码"}`, "error");
  } finally {
    state.syncBusy = false;
    updateCloudUi();
  }
}

async function signOut() {
  if (!state.supabase) return;
  try {
    await state.supabase.auth.signOut();
    state.user = null;
    setCloudStatus("已退出云端账号，继续使用本机库存。");
  } catch (error) {
    setCloudStatus(`退出失败：${error.message || "网络异常"}`, "error");
  } finally {
    updateCloudUi();
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

loadStore();
bindEvents();
updateSecureState();
renderAll();
initCloud().catch((error) => setCloudStatus(`云端初始化失败：${error.message || "配置异常"}`, "error"));
