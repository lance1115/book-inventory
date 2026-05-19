"use strict";

const STORAGE_KEY = "book-inventory:v1";
const HISTORY_LIMIT = 80;
const LOW_STOCK_LIMIT = 2;
const DUPLICATE_SCAN_GAP_MS = 1800;
const APP_VERSION = "20260520o";
const JINA_READER_PREFIX = "https://r.jina.ai/";
const FAST_LOOKUP_TIMEOUT_MS = 5200;
const DEEP_LOOKUP_TIMEOUT_MS = 7600;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const els = {
  statKinds: $("#statKinds"),
  statTotal: $("#statTotal"),
  statLow: $("#statLow"),
  secureState: $("#secureState"),
  scanStage: $("#scanStage"),
  scanStagePlaceholder: $("#scanStagePlaceholder"),
  preview: $("#preview"),
  cameraHint: $("#cameraHint"),
  startScan: $("#startScan"),
  stopScan: $("#stopScan"),
  torchButton: $("#torchButton"),
  scanStatus: $("#scanStatus"),
  manualForm: $("#manualForm"),
  manualIsbn: $("#manualIsbn"),
  manualTitleInput: $("#manualTitleInput"),
  manualDelta: $("#manualDelta"),
  manualCategory: $("#manualCategory"),
  manualShelf: $("#manualShelf"),
  manualCoverUrl: $("#manualCoverUrl"),
  manualPrice: $("#manualPrice"),
  manualEdition: $("#manualEdition"),
  manualNote: $("#manualNote"),
  searchInput: $("#searchInput"),
  inventoryFilter: $("#inventoryFilter"),
  inventorySort: $("#inventorySort"),
  inventorySummary: $("#inventorySummary"),
  inventoryList: $("#inventoryList"),
  historyList: $("#historyList"),
  exportButton: $("#exportButton"),
  importInput: $("#importInput"),
  roleSelect: $("#roleSelect"),
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
  clearCloudInventoryButton: $("#clearCloudInventoryButton"),
  pendingActionCard: $("#pendingActionCard"),
  pendingBookTitle: $("#pendingBookTitle"),
  pendingBookMeta: $("#pendingBookMeta"),
  pendingShelfMeta: $("#pendingShelfMeta"),
  pendingShelfSelect: $("#pendingShelfSelect"),
  assignShelfButton: $("#assignShelfButton"),
  removeShelfButton: $("#removeShelfButton"),
  confirmInButton: $("#confirmInButton"),
  confirmOutButton: $("#confirmOutButton"),
  cancelPendingButton: $("#cancelPendingButton"),
  shelfForm: $("#shelfForm"),
  shelfNameInput: $("#shelfNameInput"),
  shelfList: $("#shelfList"),
  clearActiveShelfButton: $("#clearActiveShelfButton"),
  activeShelfName: $("#activeShelfName"),
  activeShelfMeta: $("#activeShelfMeta"),
  renameShelfButton: $("#renameShelfButton"),
  deleteShelfButton: $("#deleteShelfButton"),
  shelfBooksList: $("#shelfBooksList"),
  bookRowTemplate: $("#bookRowTemplate"),
};

const state = {
  books: {},
  history: [],
  scanner: null,
  scanControls: null,
  activeStream: null,
  torchOn: false,
  deferredInstallPrompt: null,
  lastCode: "",
  lastCodeAt: 0,
  busyCodes: new Set(),
  scanLocked: false,
  autoScan: true,
  scannerStarting: false,
  supabase: null,
  user: null,
  cloudReady: false,
  syncBusy: false,
  pendingBook: null,
  pendingShelfId: "",
  shelves: [],
  activeShelfId: "",
  shelfTableMissing: false,
  role: "admin",
  lastMovementDelta: 1,
  previewSticky: false,
  previewStickyFrame: 0,
  previewAnchorTop: 0,
};

function loadStore() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.books = {};
    state.history = [];
    state.role = stored.role || "admin";
    state.activeShelfId = stored.activeShelfId || "";
    state.lastMovementDelta = stored.lastMovementDelta === -1 ? -1 : 1;
  } catch {
    state.books = {};
    state.history = [];
    state.role = "admin";
    state.lastMovementDelta = 1;
  }
}

function saveStore() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      books: state.books,
      role: state.role,
      activeShelfId: state.activeShelfId,
      lastMovementDelta: state.lastMovementDelta,
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

function isOnline() {
  return navigator.onLine !== false;
}

function updateNetworkStatus() {
  if (!isOnline()) {
    els.secureState.textContent = "网络离线";
    els.secureState.classList.add("warning");
    setCloudStatus("当前网络离线。扫码可以识别，但确认出入库需要恢复网络后写入云端。", "error");
    return;
  }
  updateSecureState();
  if (state.user && !state.syncBusy) {
    setCloudStatus("网络已恢复，可继续同步云端库存。", "success");
  }
}

function isSchemaColumnError(error) {
  return /does not exist|schema cache|Could not find|42703/i.test(error?.message || error?.details || error?.code || "");
}

function updateCloudUi() {
  const configured = Boolean(state.supabase);
  const signedIn = Boolean(state.user);
  els.cloudStatus.hidden = signedIn && !state.syncBusy;
  document.querySelector(".cloud-panel")?.classList.toggle("is-signed-in", signedIn);
  els.cloudState.textContent = signedIn ? "云端库存" : configured ? "待登录" : "未配置";
  els.cloudState.classList.toggle("warning", !signedIn);
  els.storageNote.textContent = signedIn
    ? `已登录 ${state.user.email || "Supabase"}，扫码确认后立即写入云端库存。`
    : "请先登录 Supabase；本页面只使用云端库存。";
  els.authForm.hidden = signedIn;
  els.signedInCard.hidden = !signedIn;
  els.signedInEmail.textContent = state.user?.email || "Supabase";
  els.authEmail.disabled = !configured || signedIn;
  els.authPassword.disabled = !configured || signedIn;
  els.signInButton.disabled = !configured || signedIn;
  els.syncButton.disabled = !signedIn || state.syncBusy;
  els.clearCloudInventoryButton.disabled = !signedIn || state.syncBusy || state.role !== "admin";
  updatePendingActionUi();
}

async function initCloud() {
  const config = getSupabaseConfig();
  if (!config || !window.supabase?.createClient) {
    state.supabase = null;
    state.books = {};
    state.history = [];
    state.shelves = [];
    state.activeShelfId = "";
    setCloudStatus("未配置 Supabase：请先配置云端项目，本页面只使用云端库存。", "error");
    renderAll();
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
    state.books = {};
    state.history = [];
    state.shelves = [];
    state.activeShelfId = "";
    renderAll();
    setCloudStatus("Supabase 已配置。登录后读取云端库存。", "success");
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

function normalizeShelfRow(row) {
  if (!row) return null;
  return {
    id: row.id || "",
    name: row.name || "",
    virtual: false,
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || row.created_at || new Date().toISOString(),
  };
}

function legacyShelfId(name) {
  return `legacy:${encodeURIComponent(name)}`;
}

function mergeShelvesWithInventoryShelves(shelfRows = []) {
  const byName = new Map();
  shelfRows.forEach((shelf) => {
    const name = String(shelf?.name || "").trim();
    if (!name) return;
    byName.set(name, { ...shelf, name });
  });

  Object.values(state.books).forEach((book) => {
    const name = String(book?.shelf || "").trim();
    if (!name || byName.has(name)) return;
    byName.set(name, {
      id: legacyShelfId(name),
      name,
      virtual: true,
      createdAt: book.createdAt || new Date().toISOString(),
      updatedAt: book.updatedAt || new Date().toISOString(),
    });
  });

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function setShelves(shelfRows = []) {
  state.shelves = mergeShelvesWithInventoryShelves(shelfRows);
  if (state.activeShelfId && !state.shelves.some((shelf) => shelf.id === state.activeShelfId)) {
    state.activeShelfId = "";
  }
  if (state.pendingShelfId && !state.shelves.some((shelf) => shelf.id === state.pendingShelfId)) {
    state.pendingShelfId = "";
  }
}

async function fetchShelvesFromCloud() {
  if (!state.supabase || !state.user) return [];
  const { data, error } = await state.supabase.from("shelves").select("id,name,created_at,updated_at").eq("user_id", state.user.id).order("name", { ascending: true });
  if (error) {
    if (/relation .*shelves.* does not exist|Could not find|schema cache|42P01/i.test(error.message || error.details || error.code || "")) {
      state.shelfTableMissing = true;
      setCloudStatus("书架表尚未创建。请在 Supabase 运行书架升级 SQL。", "error");
      return [];
    }
    throw error;
  }
  state.shelfTableMissing = false;
  return (data || []).map(normalizeShelfRow).filter((shelf) => shelf?.id && shelf.name);
}

async function refreshShelvesFromCloud() {
  setShelves(await fetchShelvesFromCloud());
  saveStore();
  renderShelves();
  updatePendingActionUi();
}

async function createShelf(name) {
  if (!state.supabase || !state.user) {
    setStatus("请先登录，再新增书架。", "error");
    return;
  }
  const trimmed = name.trim();
  if (!trimmed) {
    setStatus("请填写书架名称。", "error");
    return;
  }
  const { error } = await state.supabase.from("shelves").insert({ user_id: state.user.id, name: trimmed });
  if (error) {
    if (error.code === "23505" || /duplicate key/i.test(error.message || "")) {
      setStatus("这个书架名称已经存在。", "error");
      return;
    }
    if (/relation .*shelves.* does not exist|Could not find|schema cache|42P01/i.test(error.message || error.details || error.code || "")) {
      state.shelfTableMissing = true;
      setStatus("书架表还没有创建。请先在 Supabase 运行书架升级 SQL。", "error");
      return;
    }
    throw error;
  }
  els.shelfNameInput.value = "";
  await refreshShelvesFromCloud();
  const created = state.shelves.find((shelf) => shelf.name === trimmed);
  if (created) {
    state.activeShelfId = created.id;
    state.pendingShelfId = created.id;
  }
  saveStore();
  renderShelves();
  setStatus(`已新增书架：${trimmed}`, "success");
}

async function renameShelf(shelf, nextName) {
  if (!state.supabase || !state.user) {
    setStatus("请先登录，再重命名书架。", "error");
    return;
  }
  if (!shelf) return;
  if (shelf.virtual) {
    setStatus("这个书架来自旧库存备注。请先新增同名书架后再重命名。", "error");
    return;
  }

  const trimmed = String(nextName || "").trim();
  if (!trimmed) {
    setStatus("书架名称不能为空。", "error");
    return;
  }
  if (trimmed === shelf.name) return;
  if (state.shelves.some((item) => item.name === trimmed && item.id !== shelf.id)) {
    setStatus("这个书架名称已经存在。", "error");
    return;
  }

  const booksToMove = booksOnShelf(shelf.name).map((book) => ({
    ...book,
    shelf: trimmed,
    updatedAt: new Date().toISOString(),
    updatedLabel: nowLabel(),
  }));

  state.syncBusy = true;
  updateCloudUi();
  renderShelves();
  try {
    const { error } = await state.supabase.from("shelves").update({ name: trimmed, updated_at: new Date().toISOString() }).eq("id", shelf.id).eq("user_id", state.user.id);
    if (error) {
      if (error.code === "23505" || /duplicate key/i.test(error.message || "")) {
        setStatus("这个书架名称已经存在。", "error");
        return;
      }
      throw error;
    }

    if (booksToMove.length) {
      await upsertCloudBooks(booksToMove);
      await upsertCloudInventory(booksToMove);
      booksToMove.forEach((book) => {
        state.books[book.isbn] = book;
      });
    }

    state.activeShelfId = shelf.id;
    state.pendingShelfId = state.pendingShelfId === shelf.id ? shelf.id : state.pendingShelfId;
    await refreshShelvesFromCloud();
    saveStore();
    renderAll();
    setStatus(`书架已重命名为：${trimmed}`, "success");
  } catch (error) {
    setStatus(`重命名书架失败：${error.message || "网络异常"}`, "error");
  } finally {
    state.syncBusy = false;
    updateCloudUi();
    renderAll();
  }
}

async function deleteShelf(shelf) {
  if (!state.supabase || !state.user) {
    setStatus("请先登录，再删除书架。", "error");
    return;
  }
  if (!shelf) return;
  if (shelf.virtual) {
    setStatus("这个书架来自旧库存备注。请先把其中图书移出后它会自动消失。", "error");
    return;
  }

  const shelfBooks = booksOnShelf(shelf.name);
  const firstConfirm = window.confirm(`第一次确认：确定删除书架“${shelf.name}”吗？${shelfBooks.length ? "书架里的图书会保留库存，只移出这个书架。" : "这个书架没有图书。"}`);
  if (!firstConfirm) return;
  const secondConfirm = window.confirm(`第二次确认：真的删除书架“${shelf.name}”？`);
  if (!secondConfirm) return;

  const booksToUpdate = shelfBooks.map((book) => ({
    ...book,
    shelf: "",
    updatedAt: new Date().toISOString(),
    updatedLabel: nowLabel(),
  }));

  state.syncBusy = true;
  updateCloudUi();
  renderShelves();
  try {
    if (booksToUpdate.length) {
      await upsertCloudBooks(booksToUpdate);
      await upsertCloudInventory(booksToUpdate);
      booksToUpdate.forEach((book) => {
        state.books[book.isbn] = book;
      });
    }

    const { error } = await state.supabase.from("shelves").delete().eq("id", shelf.id).eq("user_id", state.user.id);
    if (error) throw error;

    if (state.activeShelfId === shelf.id) state.activeShelfId = "";
    if (state.pendingShelfId === shelf.id) state.pendingShelfId = "";
    if (state.pendingBook && findBookShelf(state.pendingBook) === shelf.name) {
      state.pendingBook = { ...state.pendingBook, shelf: "" };
    }

    await refreshShelvesFromCloud();
    saveStore();
    renderAll();
    setStatus(`已删除书架：${shelf.name}`, "success");
  } catch (error) {
    setStatus(`删除书架失败：${error.message || "网络异常"}`, "error");
  } finally {
    state.syncBusy = false;
    updateCloudUi();
    renderAll();
  }
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
    state.books = normalizeStoredBooks(cloudStore.books);
    state.history = normalizeStoredHistory(cloudStore.history).slice(0, HISTORY_LIMIT);
    setShelves(await fetchShelvesFromCloud());
    renderAll();
    if (state.shelfTableMissing) {
      setCloudStatus(`已同步云端：${Object.keys(cloudStore.books).length} 种书。要新增空书架，请先运行书架升级 SQL。`, "error");
    } else {
      setCloudStatus(`已同步云端：${Object.keys(cloudStore.books).length} 种书。`, "success");
    }
  } finally {
    state.syncBusy = false;
    updateCloudUi();
  }
}

async function clearCloudInventory() {
  if (!state.supabase || !state.user) {
    setCloudStatus("请先登录 Supabase，再编辑云端库存。", "error");
    return;
  }
  if (state.role !== "admin") {
    setCloudStatus("员工模式不能清空云端库存。", "error");
    return;
  }

  const firstConfirm = window.confirm("第一次确认：确定要清空当前账号的云端库存吗？这会删除所有库存数量和出入库记录。");
  if (!firstConfirm) return;
  const secondConfirm = window.confirm("第二次确认：清空后无法从网页撤销，只能依靠你自己之前导出的 CSV 恢复。继续清空？");
  if (!secondConfirm) return;
  const finalConfirm = window.confirm("第三次最终确认：真的立即清空云端库存？");
  if (!finalConfirm) return;

  state.syncBusy = true;
  updateCloudUi();
  try {
    const { error } = await state.supabase.from("inventory").delete().eq("user_id", state.user.id);
    if (error) throw error;
    state.books = {};
    state.history = [];
    setShelves(await fetchShelvesFromCloud());
    clearPendingBook();
    renderAll();
    setCloudStatus("云端库存已清空。", "success");
  } catch (error) {
    setCloudStatus(`清空云端库存失败：${error.message || "网络异常"}`, "error");
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
  if (!isOnline()) {
    els.secureState.textContent = "网络离线";
    els.secureState.classList.add("warning");
    return;
  }
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

function matchesInventoryFilter(book, filter) {
  if (filter === "stocked") return Number(book.count || 0) > 0;
  if (filter === "low") return Number(book.count || 0) > 0 && Number(book.count || 0) <= LOW_STOCK_LIMIT;
  if (filter === "no-shelf") return Number(book.count || 0) > 0 && !book.shelf;
  if (filter === "on-shelf") {
    const shelfName = getActiveShelf()?.name;
    return Boolean(state.activeShelfId && shelfName && book.shelf === shelfName);
  }
  return true;
}

function sortInventoryBooks(books, sortMode) {
  const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
  return books.sort((a, b) => {
    if (sortMode === "title") return collator.compare(getBookTitle(a), getBookTitle(b));
    if (sortMode === "count-desc") return Number(b.count || 0) - Number(a.count || 0) || collator.compare(getBookTitle(a), getBookTitle(b));
    if (sortMode === "count-asc") return Number(a.count || 0) - Number(b.count || 0) || collator.compare(getBookTitle(a), getBookTitle(b));
    if (sortMode === "shelf") return collator.compare(a.shelf || "未上架", b.shelf || "未上架") || collator.compare(getBookTitle(a), getBookTitle(b));
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || collator.compare(getBookTitle(a), getBookTitle(b));
  });
}

function renderInventory() {
  const term = els.searchInput.value.trim().toLowerCase();
  const filter = els.inventoryFilter.value;
  const sortMode = els.inventorySort.value;
  const allBooks = Object.values(state.books);
  const books = sortInventoryBooks(
    allBooks
    .filter((book) => {
      if (!matchesInventoryFilter(book, filter)) return false;
      if (!term) return true;
      return `${book.title || ""} ${book.isbn} ${book.authors || ""} ${book.publisher || ""} ${book.category || ""} ${book.shelf || ""} ${book.location || ""}`
        .toLowerCase()
        .includes(term);
    }),
    sortMode,
  );
  const totalCount = books.reduce((sum, book) => sum + Math.max(0, Number(book.count || 0)), 0);
  els.inventorySummary.textContent = `显示 ${books.length} 种 / ${totalCount} 本`;

  els.inventoryList.replaceChildren();

  if (!books.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = term || filter !== "all" ? "没有匹配的库存记录。" : "还没有库存。先扫一本书，我们从第一本开始。";
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
    node.querySelector(".minus").disabled = state.syncBusy || Number(book.count || 0) <= 0;
    node.querySelector(".plus").disabled = state.syncBusy;
    node.querySelector(".edit").disabled = state.syncBusy;
    node.querySelector(".minus").addEventListener("click", () => adjustInventoryFromList(book, -1));
    node.querySelector(".plus").addEventListener("click", () => adjustInventoryFromList(book, 1));
    node.querySelector(".edit").addEventListener("click", () => fillManualForm(book));
    fragment.append(node);
  });
  els.inventoryList.append(fragment);
}

function getActiveShelf() {
  return state.shelves.find((shelf) => shelf.id === state.activeShelfId) || null;
}

function getShelfById(id) {
  return state.shelves.find((shelf) => shelf.id === id) || null;
}

function getShelfIdByName(name) {
  return state.shelves.find((shelf) => shelf.name === name)?.id || "";
}

function getShelfLaneName(name) {
  const normalized = String(name || "").trim().toUpperCase();
  return normalized.startsWith("B") ? "B" : "A";
}

function getSelectedPendingShelf() {
  return getShelfById(state.pendingShelfId || els.pendingShelfSelect.value);
}

function booksOnShelf(shelfName) {
  return Object.values(state.books)
    .filter((book) => book.shelf === shelfName)
    .sort((a, b) => getBookTitle(a).localeCompare(getBookTitle(b), "zh-Hans-CN"));
}

function findBookShelf(book) {
  const isbn = normalizeIsbn(book?.isbn);
  const existing = state.books[isbn];
  return existing?.shelf || "";
}

function renderShelfSelectOptions() {
  const book = state.pendingBook;
  const currentShelfId = getShelfIdByName(findBookShelf(book));
  const selectedId = state.pendingShelfId || state.activeShelfId || currentShelfId || "";

  els.pendingShelfSelect.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = state.shelves.length ? "选择书架" : "暂无书架";
  els.pendingShelfSelect.append(empty);
  state.shelves.forEach((shelf) => {
    const option = document.createElement("option");
    option.value = shelf.id;
    option.textContent = shelf.name;
    els.pendingShelfSelect.append(option);
  });
  if (selectedId && state.shelves.some((shelf) => shelf.id === selectedId)) {
    els.pendingShelfSelect.value = selectedId;
    state.pendingShelfId = selectedId;
  } else {
    els.pendingShelfSelect.value = "";
    state.pendingShelfId = "";
  }
}

function renderShelves() {
  els.shelfList.replaceChildren();
  const activeShelf = getActiveShelf();

  if (!state.shelves.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.user ? "还没有书架。先新增一个书架。" : "登录后可以管理书架。";
    els.shelfList.append(empty);
  } else {
    const lanes = document.createElement("div");
    lanes.className = "shelf-lanes";
    const shelvesByLane = {
      A: state.shelves.filter((shelf) => getShelfLaneName(shelf.name) === "A"),
      B: state.shelves.filter((shelf) => getShelfLaneName(shelf.name) === "B"),
    };

    const createShelfButton = (shelf) => {
      const button = document.createElement("button");
      button.className = `shelf-chip ${shelf.id === state.activeShelfId ? "active" : ""}`;
      button.type = "button";
      button.textContent = `${shelf.name} · ${booksOnShelf(shelf.name).length}`;
      button.addEventListener("click", () => {
        state.activeShelfId = shelf.id;
        if (state.pendingBook && !findBookShelf(state.pendingBook)) state.pendingShelfId = shelf.id;
        saveStore();
        renderShelves();
        updatePendingActionUi();
        setStatus(`已进入书架：${shelf.name}。扫码识别后可放入这个书架或从书架移出。`, "success");
      });
      return button;
    };

    ["A", "B"].forEach((laneName) => {
      const lane = document.createElement("div");
      lane.className = "shelf-lane";
      const label = document.createElement("span");
      label.className = "shelf-lane-label";
      label.textContent = laneName;
      lane.append(label);
      if (shelvesByLane[laneName].length) {
        shelvesByLane[laneName].forEach((shelf) => lane.append(createShelfButton(shelf)));
      } else {
        const emptyLane = document.createElement("span");
        emptyLane.className = "shelf-lane-empty";
        emptyLane.textContent = `暂无 ${laneName} 排书架`;
        lane.append(emptyLane);
      }
      lanes.append(lane);
    });
    els.shelfList.append(lanes);
  }

  els.activeShelfName.textContent = activeShelf?.name || "未选择";
  els.activeShelfMeta.textContent = activeShelf
    ? `${booksOnShelf(activeShelf.name).length} 种书在这个书架上。扫码识别后可放入或移出。`
    : "选择一个书架后可查看其中图书。";
  els.clearActiveShelfButton.disabled = !state.activeShelfId;
  els.renameShelfButton.disabled = !activeShelf || activeShelf.virtual || state.syncBusy;
  els.deleteShelfButton.disabled = !activeShelf || activeShelf.virtual || state.syncBusy;

  els.shelfBooksList.replaceChildren();
  if (!activeShelf) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "未选择书架。";
    els.shelfBooksList.append(empty);
  } else {
    const shelfBooks = booksOnShelf(activeShelf.name);
    if (!shelfBooks.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "这个书架暂时没有图书。";
      els.shelfBooksList.append(empty);
    } else {
      shelfBooks.forEach((book) => {
        const item = document.createElement("article");
        item.className = "shelf-book-item";
        const text = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = getBookTitle(book);
        const meta = document.createElement("span");
        meta.textContent = `${book.isbn} · 库存 ${book.count} 本`;
        text.append(title, meta);
        const remove = document.createElement("button");
        remove.className = "small-button text-button minus";
        remove.type = "button";
        remove.textContent = "移出书架";
        remove.addEventListener("click", () => {
          const ok = window.confirm(`确定把《${getBookTitle(book)}》从书架“${activeShelf.name}”移出吗？库存数量不会减少。`);
          if (ok) assignBookToShelf(book, "");
        });
        item.append(text, remove);
        els.shelfBooksList.append(item);
      });
    }
  }

  renderShelfSelectOptions();
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
  renderShelves();
  requestPreviewStickyUpdate();
}

function getPreviewStickyTop() {
  const safeTop = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-top")) || 0;
  return Math.max(8, safeTop + 8);
}

function getPreviewAnchorTop() {
  const stage = els.scanStage;
  const placeholder = els.scanStagePlaceholder;
  const anchor = state.previewSticky ? placeholder : stage;
  if (!anchor) return 0;
  const rect = anchor.getBoundingClientRect();
  return rect.top + window.scrollY;
}

function updatePreviewStickyPosition() {
  const stage = els.scanStage;
  const placeholder = els.scanStagePlaceholder;
  if (!stage || !placeholder) return;

  const topOffset = getPreviewStickyTop();
  if (!state.previewSticky) {
    state.previewAnchorTop = getPreviewAnchorTop();
  }
  const anchorTop = state.previewAnchorTop || getPreviewAnchorTop();
  const shouldStick = window.scrollY > anchorTop - topOffset;

  if (shouldStick && !state.previewSticky) {
    const rect = stage.getBoundingClientRect();
    placeholder.style.height = `${rect.height}px`;
    placeholder.hidden = false;
    state.previewSticky = true;
    document.body.append(stage);
  } else if (!shouldStick && state.previewSticky) {
    state.previewSticky = false;
    placeholder.after(stage);
    stage.classList.remove("is-preview-sticky");
    placeholder.hidden = true;
    stage.style.removeProperty("--sticky-preview-left");
    stage.style.removeProperty("--sticky-preview-width");
    stage.style.removeProperty("--sticky-preview-height");
    state.previewAnchorTop = 0;
    return;
  }

  if (!state.previewSticky) return;

  const rect = placeholder.getBoundingClientRect();
  stage.style.setProperty("--sticky-preview-left", `${Math.max(12, rect.left)}px`);
  stage.style.setProperty("--sticky-preview-width", `${Math.max(0, Math.min(rect.width, window.innerWidth - 24))}px`);
  stage.style.setProperty("--sticky-preview-height", `${rect.height}px`);
  stage.classList.add("is-preview-sticky");
}

function requestPreviewStickyUpdate() {
  if (!window.requestAnimationFrame) {
    updatePreviewStickyPosition();
    return;
  }
  if (state.previewStickyFrame) return;
  state.previewStickyFrame = window.requestAnimationFrame(() => {
    state.previewStickyFrame = 0;
    updatePreviewStickyPosition();
  });
}

function updatePendingActionUi() {
  const book = state.pendingBook;
  els.pendingActionCard.hidden = !book;
  renderShelfSelectOptions();
  const currentShelf = findBookShelf(book);
  const selectedShelf = getSelectedPendingShelf();
  els.confirmInButton.disabled = !book || !state.user || state.syncBusy;
  els.confirmOutButton.disabled = !book || !state.user || state.syncBusy;
  els.cancelPendingButton.disabled = !book || state.syncBusy;
  els.assignShelfButton.disabled = !book || !state.user || state.syncBusy || !selectedShelf || selectedShelf.name === currentShelf;
  els.removeShelfButton.disabled = !book || !state.user || state.syncBusy || !currentShelf;
  if (!book) return;
  const existing = state.books[book.isbn];
  const currentCount = Number(existing?.count || 0);
  els.confirmInButton.classList.toggle("primary-button", state.lastMovementDelta !== -1);
  els.confirmInButton.classList.toggle("secondary-button", state.lastMovementDelta === -1);
  els.confirmOutButton.classList.toggle("primary-button", state.lastMovementDelta === -1);
  els.confirmOutButton.classList.toggle("secondary-button", state.lastMovementDelta !== -1);
  els.pendingBookTitle.textContent = getBookTitle(book);
  els.pendingBookMeta.textContent = `${book.isbn} · 当前库存 ${currentCount} 本 · 上次操作：${state.lastMovementDelta === -1 ? "出库" : "入库"}`;
  if (currentShelf && selectedShelf && selectedShelf.name !== currentShelf) {
    els.pendingShelfMeta.textContent = `这本书已在书架：${currentShelf}；可移动到：${selectedShelf.name}`;
  } else if (currentShelf) {
    els.pendingShelfMeta.textContent = `这本书已在书架：${currentShelf}`;
  } else if (selectedShelf) {
    els.pendingShelfMeta.textContent = `这本书尚未分配书架，可放入：${selectedShelf.name}`;
  } else {
    els.pendingShelfMeta.textContent = state.shelves.length ? "这本书尚未分配书架，请选择一个书架。" : "这本书尚未分配书架，请先新增书架。";
  }
}

function setPendingBook(book) {
  const isbn = normalizeIsbn(book.isbn);
  const currentShelfId = getShelfIdByName(state.books[isbn]?.shelf || "");
  state.pendingBook = {
    isbn,
    title: book.title || "",
    authors: book.authors || "",
    publisher: book.publisher || "",
    source: book.source || "",
    coverUrl: book.coverUrl || "",
    price: book.price || "",
    publishedDate: book.publishedDate || "",
    edition: book.edition || "",
  };
  state.pendingShelfId = state.activeShelfId || currentShelfId || "";
  updatePendingActionUi();
}

function clearPendingBook() {
  state.pendingBook = null;
  state.pendingShelfId = "";
  updatePendingActionUi();
}

function scrollToManualEditor() {
  els.manualForm.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => {
    els.manualTitleInput.focus({ preventScroll: true });
  }, 260);
}

async function adjustInventoryFromList(book, delta) {
  if (!book) return;
  if (!state.user) {
    setStatus("请先登录，库存调整会直接写入云端。", "error");
    return;
  }
  if (state.role === "staff") {
    setStatus("员工模式请通过扫码确认出入库，不能在列表里手动加减库存。", "error");
    return;
  }
  if (state.syncBusy) return;

  const currentCount = Number(state.books[book.isbn]?.count || 0);
  if (delta < 0 && currentCount <= 0) {
    setStatus(`${getBookTitle(book)} 当前库存为 0，不能出库。`, "error");
    return;
  }

  const label = delta > 0 ? "入库 +1" : "出库 -1";
  const ok = window.confirm(`确定将“${getBookTitle(book)}”${label} 吗？当前库存 ${currentCount} 本。`);
  if (!ok) return;

  state.syncBusy = true;
  updateCloudUi();
  renderInventory();
  try {
    const { updated, effectiveDelta } = buildUpdatedBook(book, delta);
    await saveBookToCloud(updated, effectiveDelta, "手动调整");
    applyBookUpdate(updated, effectiveDelta, "手动调整");
    setStatus(`${getBookTitle(updated)} 已${delta > 0 ? "入库" : "出库"}，云端库存 ${updated.count} 本。`, "success");
    setCloudStatus("云端库存已更新。", "success");
  } catch (error) {
    setStatus(`库存调整失败：${error.message || "网络异常"}`, "error");
  } finally {
    state.syncBusy = false;
    updateCloudUi();
    renderInventory();
  }
}

async function assignBookToShelf(book, shelfName) {
  if (!state.user) {
    setStatus("请先登录，再编辑书架。", "error");
    return;
  }
  const isbn = normalizeIsbn(book?.isbn);
  if (!isbn) return;
  const existing = state.books[isbn] || { ...book, isbn, count: 0 };
  const updated = {
    ...existing,
    shelf: shelfName || "",
    updatedAt: new Date().toISOString(),
    updatedLabel: nowLabel(),
  };

  state.syncBusy = true;
  updateCloudUi();
  try {
    await saveBookToCloud(updated, 0, shelfName ? "书架调整" : "移出书架");
    applyBookUpdate(updated, 0, shelfName ? "书架调整" : "移出书架");
    if (state.pendingBook?.isbn === isbn) {
      state.pendingBook = { ...state.pendingBook, shelf: shelfName || "" };
      state.pendingShelfId = shelfName ? getShelfIdByName(shelfName) || state.pendingShelfId : state.activeShelfId || "";
    }
    setShelves(state.shelves.filter((shelf) => !shelf.virtual));
    setStatus(shelfName ? `${getBookTitle(updated)} 已放入书架：${shelfName}` : `${getBookTitle(updated)} 已移出书架`, "success");
  } catch (error) {
    setStatus(`书架更新失败：${error.message || "网络异常"}`, "error");
  } finally {
    state.syncBusy = false;
    updateCloudUi();
    renderAll();
  }
}

function buildUpdatedBook(book, delta) {
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

  return { updated, effectiveDelta };
}

function applyBookUpdate(updated, effectiveDelta, reason) {
  const isbn = normalizeIsbn(updated.isbn);
  state.books[isbn] = updated;
  setShelves(state.shelves.filter((shelf) => !shelf.virtual));

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
}

function upsertBook(book, delta, reason, options = {}) {
  const shouldSync = options.sync !== false;
  if (state.role === "staff" && !["扫码", "确认入库", "确认出库"].includes(reason)) {
    setStatus("员工模式只能扫码确认出入库，不能手动调整资料。", "error");
    return state.books[normalizeIsbn(book.isbn)] || book;
  }

  const { updated, effectiveDelta } = buildUpdatedBook(book, delta);
  applyBookUpdate(updated, effectiveDelta, reason);
  if (shouldSync) {
    saveBookToCloud(updated, effectiveDelta, reason).catch((error) => {
      setCloudStatus(`云端同步失败：${error.message || "网络异常"}`, "error");
    });
  }
  return updated;
}

function fillManualForm(book) {
  els.manualIsbn.value = book.isbn || "";
  els.manualTitleInput.value = book.title || "";
  els.manualDelta.value = "0";
  if (els.manualCategory) els.manualCategory.value = book.category || "";
  els.manualShelf.value = book.shelf || "";
  els.manualCoverUrl.value = book.coverUrl || "";
  if (els.manualPrice) els.manualPrice.value = book.price || "";
  els.manualEdition.value = book.edition || "";
  els.manualNote.value = book.note || "";
  scrollToManualEditor();
  setStatus(`已打开《${getBookTitle(book)}》的资料编辑区，修改后点“保存资料”。`, "success");
}

async function confirmPendingMovement(delta) {
  const book = state.pendingBook;
  if (!book) return;
  if (!state.user) {
    setStatus("请先登录，确认后才能写入云端库存。", "error");
    return;
  }
  const existing = state.books[book.isbn];
  const currentCount = Number(existing?.count || 0);
  if (delta < 0 && currentCount <= 0) {
    setStatus(`${getBookTitle(book)} 当前库存为 0，不能出库。`, "error");
    return;
  }

  state.lastMovementDelta = delta > 0 ? 1 : -1;
  saveStore();
  state.syncBusy = true;
  updateCloudUi();
  try {
    const reason = delta > 0 ? "确认入库" : "确认出库";
    const selectedShelf = getSelectedPendingShelf();
    const currentShelf = findBookShelf(book);
    const shouldAssignShelf = delta > 0 && selectedShelf && !currentShelf;
    const bookPayload = shouldAssignShelf ? { ...book, shelf: selectedShelf.name } : book;
    const { updated, effectiveDelta } = buildUpdatedBook(bookPayload, delta);
    await saveBookToCloud(updated, effectiveDelta, reason);
    applyBookUpdate(updated, effectiveDelta, reason);
    clearPendingBook();
    const shelfText = shouldAssignShelf ? `，已放入书架：${selectedShelf.name}` : "";
    setStatus(`${getBookTitle(updated)} ${delta > 0 ? "入库" : "出库"}成功，云端库存 ${updated.count} 本${shelfText}。`, "success");
    setCloudStatus("云端库存已更新。", "success");
    scheduleAutoScan();
  } catch (error) {
    setStatus(`云端库存更新失败：${error.message || "网络异常"}`, "error");
  } finally {
    state.syncBusy = false;
    updateCloudUi();
  }
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

function isUsefulLookupResult(book) {
  return Boolean(book?.isbn && book?.title);
}

function withLookupTimeout(task, timeout = FAST_LOOKUP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      settled = true;
      resolve(null);
    }, timeout);

    Promise.resolve()
      .then(task)
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(isUsefulLookupResult(result) ? result : null);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      });
  });
}

function raceLookupTasks(tasks, timeout = FAST_LOOKUP_TIMEOUT_MS, onResult = null) {
  return new Promise((resolve) => {
    if (!tasks.length) {
      resolve(null);
      return;
    }

    let pending = tasks.length;
    let resolved = false;
    const timer = window.setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolve(null);
    }, timeout);

    tasks.forEach((task) => {
      withLookupTimeout(task.lookup, task.timeout || timeout).then((result) => {
        pending -= 1;
        if (isUsefulLookupResult(result)) onResult?.(result);
        if (resolved) return;
        if (isUsefulLookupResult(result)) {
          resolved = true;
          clearTimeout(timer);
          resolve(result);
          return;
        }
        if (pending === 0) {
          resolved = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
    });
  });
}

function cacheLookupInBackground(book) {
  if (isUsefulLookupResult(book)) {
    cacheLookupBook(book).catch(() => {});
  }
}

function runLookupGroup(tasks, timeout) {
  return raceLookupTasks(tasks, timeout, cacheLookupInBackground);
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
    .replace(/\s*[-_]\s*当当图书$/i, "")
    .replace(/\s*[-_]\s*孔夫子旧书网$/i, "")
    .replace(/\s*[-_]\s*中图网.*$/i, "")
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

function firstArrayItem(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeOpenLibraryAuthor(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.name || value.personal_name || "";
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

function normalizeOpenLibraryEditionBook(data, isbn) {
  if (!data?.title) return null;
  const imageLinks = data.covers || [];
  const coverId = Array.isArray(imageLinks) ? imageLinks[0] : "";
  return {
    isbn,
    title: [data.title, data.subtitle].filter(Boolean).join(": "),
    authors: Array.isArray(data.authors) ? data.authors.map(normalizeOpenLibraryAuthor).filter(Boolean).join("、") : "",
    publisher: Array.isArray(data.publishers) ? data.publishers.join("、") : "",
    publishedDate: data.publish_date || "",
    coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : "",
    source: "Open Library ISBN",
  };
}

function normalizeOpenLibrarySearchBook(data, isbn) {
  const doc = Array.isArray(data?.docs) ? data.docs[0] : null;
  if (!doc?.title) return null;
  return {
    isbn,
    title: doc.title,
    authors: Array.isArray(doc.author_name) ? doc.author_name.join("、") : "",
    publisher: Array.isArray(doc.publisher) ? doc.publisher[0] || "" : "",
    publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : "",
    coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "",
    source: "Open Library Search",
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

function normalizeHathiTrustBook(data, isbn) {
  const record = Object.values(data?.records || {})[0];
  if (!record?.titles?.length) return null;
  return {
    isbn,
    title: record.titles[0],
    authors: "",
    publisher: "",
    publishedDate: Array.isArray(record.publishDates) ? record.publishDates[0] || "" : "",
    source: "HathiTrust",
  };
}

function normalizeHathiTrustReaderBook(markdown, isbn) {
  const jsonStart = String(markdown || "").indexOf('{"records"');
  if (jsonStart < 0) return null;
  try {
    return normalizeHathiTrustBook(JSON.parse(String(markdown).slice(jsonStart)), isbn);
  } catch {
    return null;
  }
}

function extractImageUrl(markdown, altText = "") {
  const imageRegex = /!\[([^\]]*)]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  const text = String(markdown || "");
  let match = imageRegex.exec(text);
  while (match) {
    const [, alt, url] = match;
    if (!altText || cleanMarkdownText(alt).includes(altText) || altText.includes(cleanMarkdownText(alt))) {
      return url;
    }
    match = imageRegex.exec(text);
  }
  return "";
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
    coverUrl: extractImageUrl(markdown, title),
    source: "豆瓣读书",
  };
}

async function lookupDoubanBook(isbn, timeout = DEEP_LOOKUP_TIMEOUT_MS) {
  const target = `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(isbn)}&cat=1001`;
  const markdown = await fetchText(readerUrl(target), timeout);
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
    edition: extractCleanField(lines, "Edition"),
    coverUrl: extractImageUrl(markdown, title),
    source: "ISBN Search",
  };
}

async function lookupIsbnSearchBook(isbn, timeout = FAST_LOOKUP_TIMEOUT_MS) {
  const markdown = await fetchText(readerUrl(`https://www.isbnsearch.org/isbn/${encodeURIComponent(isbn)}`), timeout);
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

async function lookupHepBook(isbn, timeout = FAST_LOOKUP_TIMEOUT_MS) {
  const queries = Array.from(new Set([formatIsbn13(isbn), isbn].filter(Boolean)));
  for (const query of queries) {
    try {
      const target = `https://xuanshu.hep.com.cn/front/book/bookSearch?wd=${encodeURIComponent(query)}&searchType=book`;
      const markdown = await fetchText(readerUrl(target), timeout);
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
    .replace(/\s+(正版|现货|全新|速发|速开发票|优质售后|支持7天|七天无理由|团购优惠|正规发票|自营|新华书店).*$/i, "")
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

async function lookupDangdangBook(isbn, timeout = DEEP_LOOKUP_TIMEOUT_MS) {
  const target = `https://search.dangdang.com/?key=${encodeURIComponent(isbn)}&act=input`;
  const markdown = await fetchText(readerUrl(target), timeout);
  return normalizeDangdangBook(markdown, isbn);
}

function extractBooksTwFilterValue(lines, label) {
  const row = lines.map(cleanMarkdownText).find((line) => line.includes(`${label} _`) || line.startsWith(`${label} `));
  return row
    ? row
        .replace(new RegExp(`^\\|?\\s*${label}\\s*[^|]*\\|?\\s*`), "")
        .replace(/\(\d+\).*$/, "")
        .replace(/-\s*\[x]\s*.*/, "")
        .trim()
    : "";
}

function normalizeBooksTwSearchBook(markdown, isbn) {
  const lines = markdownLines(markdown);
  if (!lines.some((line) => line.includes(isbn))) return null;
  const titleIndex = lines.findIndex((line) => /^#{3,4}\s+/.test(line) && markdownLinkText(line, /^https:\/\/search\.books\.com\.tw\/redirect\/move\//));
  if (titleIndex < 0) return null;
  const title = cleanBookTitle(markdownLinkText(lines[titleIndex], /^https:\/\/search\.books\.com\.tw\/redirect\/move\//).replace(/^#+\s*/, ""), isbn);
  if (!title) return null;
  const authorLine = lines.slice(titleIndex + 1, titleIndex + 8).find((line) => markdownLinkText(line, /^https:\/\/search\.books\.com\.tw\/search\/query\//));
  return {
    isbn,
    title,
    authors: authorLine ? markdownLinkText(authorLine, /^https:\/\/search\.books\.com\.tw\/search\/query\//) : extractBooksTwFilterValue(lines, "作者"),
    publisher: extractBooksTwFilterValue(lines, "出版社"),
    coverUrl: extractImageUrl(markdown, title),
    source: "博客来公开搜索",
  };
}

function normalizeBooksTwProductBook(markdown, isbn) {
  const lines = markdownLines(markdown);
  if (!lines.some((line) => line.includes(isbn))) return null;
  const headingLine = lines.find((line) => /^#\s+/.test(line) && !/博客來|網站搜尋/.test(line));
  const title = cleanBookTitle(headingLine ? headingLine.replace(/^#\s+/, "") : "", isbn);
  if (!title) return null;

  const fieldValue = (label) => {
    const line = lines.find((item) => cleanMarkdownText(item).startsWith(`* ${label}：`) || cleanMarkdownText(item).startsWith(`${label}：`));
    return line ? cleanMarkdownText(line).replace(/^\*\s*/, "").replace(new RegExp(`^${label}：`), "").trim() : "";
  };

  return {
    isbn,
    title,
    authors: fieldValue("作者"),
    publisher: fieldValue("出版社"),
    publishedDate: fieldValue("出版日期"),
    coverUrl: extractImageUrl(markdown, title),
    source: "博客来商品页",
  };
}

async function lookupBooksTwBook(isbn, timeout = DEEP_LOOKUP_TIMEOUT_MS) {
  const searchTarget = `https://search.books.com.tw/search/query/key/${encodeURIComponent(isbn)}/cat/all`;
  const searchMarkdown = await fetchText(readerUrl(searchTarget), timeout);
  const searchResult = normalizeBooksTwSearchBook(searchMarkdown, isbn);
  if (searchResult?.title) {
    const productIdMatch = searchMarkdown.match(/item\/(CN\d+|001\d+|E\d+)/);
    if (productIdMatch) {
      try {
        const productMarkdown = await fetchText(readerUrl(`https://www.books.com.tw/products/${productIdMatch[1]}`), timeout);
        return normalizeBooksTwProductBook(productMarkdown, isbn) || searchResult;
      } catch {
        return searchResult;
      }
    }
  }
  return searchResult;
}

function cleanMarketplaceTitle(value, isbn) {
  return cleanBookTitle(value, isbn)
    .replace(/【[^】]*】/g, "")
    .replace(/\s+(正版|现货|全新|二手|旧书|速发|包邮|自营|旗舰店|专营店|新华书店|出版社直发|教材).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeJdBook(markdown, isbn) {
  if (/欢迎登录|登录页面|扫码安全登录/.test(markdown)) return null;
  const lines = markdownLines(markdown);
  const candidates = lines
    .map((line, index) => ({
      index,
      rawTitle: markdownLinkText(line, /^https:\/\/item\.jd\.com\/\d+\.html/),
    }))
    .filter((candidate) => candidate.rawTitle)
    .map((candidate) => {
      const title = cleanMarketplaceTitle(candidate.rawTitle, isbn);
      const score =
        (candidate.rawTitle.includes(isbn) ? 8 : 0) +
        (/（.+版）|\(.+版\)|第.+版/.test(candidate.rawTitle) ? 2 : 0) +
        (title.length >= 2 && title.length <= 70 ? 2 : 0) -
        (/专营店|旗舰店|店铺|购物车|登录|领券/.test(candidate.rawTitle) ? 5 : 0);
      return { ...candidate, title, score };
    })
    .filter((candidate) => candidate.title && !/京东|登录|购物车/.test(candidate.title));
  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const metaText = lines
    .slice(best.index + 1, best.index + 12)
    .map(cleanMarkdownText)
    .join(" / ");
  const parts = splitCreditLine(metaText);
  const publisher = parts.find(looksLikePublisher) || "";
  const authors = parts.find((part) => part && part !== publisher && !/^\d{4}|¥|￥|京东|店/.test(part)) || "";

  return {
    isbn,
    title: best.title,
    authors,
    publisher,
    coverUrl: extractImageUrl(markdown, best.title),
    source: "京东公开搜索",
  };
}

async function lookupJdBook(isbn, timeout = DEEP_LOOKUP_TIMEOUT_MS) {
  const target = `https://search.jd.com/Search?keyword=${encodeURIComponent(isbn)}&enc=utf-8`;
  const markdown = await fetchText(readerUrl(target), timeout);
  return normalizeJdBook(markdown, isbn);
}

function normalizeKongfzBook(markdown, isbn) {
  if (/验证码|访问受限|安全验证|Forbidden|403/i.test(markdown)) return null;
  const lines = markdownLines(markdown);
  const candidates = lines
    .map((line, index) => {
      const title =
        markdownLinkText(line, /^https:\/\/book\.kongfz\.com\/\d+\/\d+\/?$/) ||
        markdownLinkText(line, /^https:\/\/item\.kongfz\.com\/book\//) ||
        markdownLinkText(line, /^https:\/\/search\.kongfz\.com\/product_result\//);
      return { index, rawTitle: title };
    })
    .filter((candidate) => candidate.rawTitle)
    .map((candidate) => {
      const title = cleanMarketplaceTitle(candidate.rawTitle, isbn);
      const score =
        (candidate.rawTitle.includes(isbn) ? 8 : 0) +
        (title.length >= 2 && title.length <= 70 ? 2 : 0) -
        (/孔夫子|旧书网|店铺|拍卖|收藏|求购|登录/.test(candidate.rawTitle) ? 4 : 0);
      return { ...candidate, title, score };
    })
    .filter((candidate) => candidate.title);
  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const metaText = lines
    .slice(best.index + 1, best.index + 12)
    .map(cleanMarkdownText)
    .join(" / ");
  const parts = splitCreditLine(metaText);
  const publisher = parts.find(looksLikePublisher) || "";
  const authors = parts.find((part) => part && part !== publisher && !/^\d{4}|¥|￥|品相|店/.test(part)) || "";

  return {
    isbn,
    title: best.title,
    authors,
    publisher,
    coverUrl: extractImageUrl(markdown, best.title),
    source: "孔夫子旧书网公开搜索",
  };
}

async function lookupKongfzBook(isbn, timeout = DEEP_LOOKUP_TIMEOUT_MS) {
  const target = `https://search.kongfz.com/product_result/?key=${encodeURIComponent(isbn)}`;
  const markdown = await fetchText(readerUrl(target), timeout);
  return normalizeKongfzBook(markdown, isbn);
}

function xmlText(markdown, tagName) {
  const match = String(markdown || "").match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? cleanMarkdownText(match[1].replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1")) : "";
}

function normalizeNdlBook(xml, isbn) {
  const total = Number(xmlText(xml, "openSearch:totalResults") || 0);
  if (!total) return null;
  const itemMatch = String(xml || "").match(/<item>([\s\S]*?)<\/item>/i);
  const item = itemMatch ? itemMatch[1] : xml;
  const title = xmlText(item, "dc:title") || xmlText(item, "title");
  if (!title) return null;
  return {
    isbn,
    title,
    authors: xmlText(item, "dc:creator") || xmlText(item, "author"),
    publisher: xmlText(item, "dc:publisher"),
    publishedDate: xmlText(item, "dcterms:issued") || xmlText(item, "dc:date"),
    edition: xmlText(item, "dcndl:edition"),
    price: xmlText(item, "dcndl:price"),
    source: "日本国会图书馆",
  };
}

function normalizeNdlReaderBook(markdown, isbn) {
  const lines = markdownLines(markdown);
  const titleLine = lines.find((line) => /^#{2,4}\s+/.test(line) && markdownLinkText(line, /^https:\/\/ndlsearch\.ndl\.go\.jp\/books\//));
  const title = cleanBookTitle(markdownLinkText(titleLine || "", /^https:\/\/ndlsearch\.ndl\.go\.jp\/books\//).replace(/^#+\s*/, ""), isbn);
  if (!title) return null;
  return {
    isbn,
    title,
    authors: "",
    publisher: "",
    source: "日本国会图书馆",
  };
}

async function lookupNdlBook(isbn, timeout = DEEP_LOOKUP_TIMEOUT_MS) {
  const target = `https://ndlsearch.ndl.go.jp/api/opensearch?isbn=${encodeURIComponent(isbn)}`;
  const xml = await fetchText(target, timeout);
  return normalizeNdlBook(xml, isbn);
}

async function lookupNdlReaderBook(isbn, timeout = DEEP_LOOKUP_TIMEOUT_MS) {
  const target = `https://ndlsearch.ndl.go.jp/api/opensearch?isbn=${encodeURIComponent(isbn)}`;
  const markdown = await fetchText(readerUrl(target), timeout);
  return normalizeNdlReaderBook(markdown, isbn);
}

async function lookupBook(isbn) {
  const cleaned = normalizeIsbn(isbn);
  const cached = state.books[cleaned];
  if (cached?.title) return cached;

  const fastLookups = [
    {
      name: "云端书目缓存",
      timeout: 1600,
      lookup: () => lookupCachedBook(cleaned),
    },
    {
      name: "ISBN Search",
      timeout: FAST_LOOKUP_TIMEOUT_MS,
      lookup: () => lookupIsbnSearchBook(cleaned, FAST_LOOKUP_TIMEOUT_MS),
    },
    {
      name: "豆瓣读书",
      timeout: FAST_LOOKUP_TIMEOUT_MS,
      lookup: () => lookupDoubanBook(cleaned, FAST_LOOKUP_TIMEOUT_MS),
    },
    {
      name: "openBD",
      timeout: 3600,
      lookup: async () => normalizeOpenBdBook(await fetchJson(`https://api.openbd.jp/v1/get?isbn=${cleaned}`, 3600), cleaned),
    },
    {
      name: "Google Books",
      timeout: 4200,
      lookup: async () =>
        normalizeGoogleBook(await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${cleaned}`, 4200), cleaned),
    },
    {
      name: "Open Library",
      timeout: 4200,
      lookup: async () =>
        normalizeOpenLibraryBook(
          await fetchJsonp(
            `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(cleaned)}&jscmd=data&format=javascript`,
            4200,
          ),
          cleaned,
        ),
    },
    {
      name: "Open Library ISBN",
      timeout: 4200,
      lookup: async () =>
        normalizeOpenLibraryEditionBook(await fetchJson(`https://openlibrary.org/isbn/${encodeURIComponent(cleaned)}.json`, 4200), cleaned),
    },
    {
      name: "Open Library Search",
      timeout: 4200,
      lookup: async () =>
        normalizeOpenLibrarySearchBook(await fetchJson(`https://openlibrary.org/search.json?isbn=${encodeURIComponent(cleaned)}`, 4200), cleaned),
    },
    {
      name: "HathiTrust",
      timeout: 4200,
      lookup: async () =>
        normalizeHathiTrustBook(await fetchJson(`https://catalog.hathitrust.org/api/volumes/brief/isbn/${encodeURIComponent(cleaned)}.json`, 4200), cleaned),
    },
    {
      name: "HathiTrust Reader",
      timeout: 4200,
      lookup: async () =>
        normalizeHathiTrustReaderBook(
          await fetchText(readerUrl(`https://catalog.hathitrust.org/api/volumes/brief/isbn/${encodeURIComponent(cleaned)}.json`), 4200),
          cleaned,
        ),
    },
  ];
  const deepLookups = [
    {
      name: "博客来",
      timeout: DEEP_LOOKUP_TIMEOUT_MS,
      lookup: () => lookupBooksTwBook(cleaned, DEEP_LOOKUP_TIMEOUT_MS),
    },
    {
      name: "高教社",
      timeout: DEEP_LOOKUP_TIMEOUT_MS,
      lookup: () => lookupHepBook(cleaned, DEEP_LOOKUP_TIMEOUT_MS),
    },
    {
      name: "当当",
      timeout: DEEP_LOOKUP_TIMEOUT_MS,
      lookup: () => lookupDangdangBook(cleaned, DEEP_LOOKUP_TIMEOUT_MS),
    },
    {
      name: "京东",
      timeout: DEEP_LOOKUP_TIMEOUT_MS,
      lookup: () => lookupJdBook(cleaned, DEEP_LOOKUP_TIMEOUT_MS),
    },
    {
      name: "孔夫子旧书网",
      timeout: DEEP_LOOKUP_TIMEOUT_MS,
      lookup: () => lookupKongfzBook(cleaned, DEEP_LOOKUP_TIMEOUT_MS),
    },
    {
      name: "日本国会图书馆",
      timeout: DEEP_LOOKUP_TIMEOUT_MS,
      lookup: () => lookupNdlBook(cleaned, DEEP_LOOKUP_TIMEOUT_MS),
    },
    {
      name: "日本国会图书馆 Reader",
      timeout: DEEP_LOOKUP_TIMEOUT_MS,
      lookup: () => lookupNdlReaderBook(cleaned, DEEP_LOOKUP_TIMEOUT_MS),
    },
  ];

  const deepLookupPromise = runLookupGroup(deepLookups, DEEP_LOOKUP_TIMEOUT_MS);
  const fastFound = await runLookupGroup(fastLookups, FAST_LOOKUP_TIMEOUT_MS);
  if (fastFound?.title) return fastFound;

  const deepFound = await deepLookupPromise;
  if (deepFound?.title) return deepFound;

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
  const cameraScan = reason === "扫码";
  state.scanLocked = cameraScan;
  if (cameraScan) {
    stopScanner();
  }
  setStatus(`已扫到 ${isbn}，正在自动查询书名...`);

  try {
    const book = await lookupBook(isbn);
    setPendingBook(book);
    pulseSuccess();

    if (!book.title) {
      els.manualIsbn.value = isbn;
      els.manualTitleInput.focus({ preventScroll: true });
      setStatus(`已识别 ${isbn}，但公开书目源暂未返回书名。请先在“补录”里填书名，再确认入库或出库。`, "error");
      return;
    }

    const currentCount = Number(state.books[isbn]?.count || 0);
    setStatus(`已识别 ${getBookTitle(book)}，当前云端库存 ${currentCount} 本。请确认入库或出库。`, "success");
  } catch (error) {
    setStatus(`识别成功但查询失败：${error.message || "网络异常"}。可先补录书名，再确认写入云端库存。`, "error");
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
  requestPreviewStickyUpdate();
}

function scheduleAutoScan(delay = 700) {
  if (!state.autoScan || state.pendingBook || state.activeStream || state.scannerStarting) return;
  window.setTimeout(() => {
    if (!state.autoScan || state.pendingBook || state.activeStream || state.scannerStarting) return;
    startScanner({ auto: true });
  }, delay);
}

async function startScanner(options = {}) {
  const auto = Boolean(options.auto);
  if (state.activeStream || state.scannerStarting) return;
  if (!window.isSecureContext) {
    setStatus("当前页面不是安全环境。请使用 HTTPS 网址打开，否则 iPhone Safari 不会授权摄像头。", "error");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("当前浏览器没有开放网页摄像头接口。请用 iPhone 自带 Safari 打开 HTTPS 网址。", "error");
    return;
  }

  try {
    state.scannerStarting = true;
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
    setStatus(auto ? "正在自动启动摄像头..." : "正在请求摄像头权限...");

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

    setStatus("摄像头已开启。识别到书目后会暂停，确认入库或出库后自动继续扫码。");
  } catch (error) {
    updateScanButtons(false);
    stopTracks();
    setStatus(auto ? "浏览器阻止了自动开启摄像头，请点“重新启动扫码”授权。" : `无法开启摄像头：${error.message || "请检查 Safari 摄像头权限"}`, "error");
  } finally {
    state.scannerStarting = false;
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
  els.startScan.addEventListener("click", startScanner);
  els.stopScan.addEventListener("click", () => {
    stopScanner();
    setStatus("摄像头已停止。");
  });
  els.torchButton.addEventListener("click", toggleTorch);
  els.searchInput.addEventListener("input", renderInventory);
  els.inventoryFilter.addEventListener("change", renderInventory);
  els.inventorySort.addEventListener("change", renderInventory);
  els.exportButton.addEventListener("click", exportInventory);
  els.importInput.addEventListener("change", (event) => importInventoryFile(event.target.files[0]));
  els.roleSelect.value = state.role;
  els.roleSelect.addEventListener("change", () => {
    state.role = els.roleSelect.value;
    saveStore();
    updateCloudUi();
    setStatus(`已切换到${state.role === "admin" ? "管理员" : "员工"}模式。`);
  });
  els.authForm.addEventListener("submit", handleAuthSubmit);
  els.signOutButton.addEventListener("click", signOut);
  els.syncButton.addEventListener("click", () => {
    syncFromCloud().catch((error) => setCloudStatus(`云端同步失败：${error.message || "网络异常"}`, "error"));
  });
  els.clearCloudInventoryButton.addEventListener("click", clearCloudInventory);
  els.shelfForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await createShelf(els.shelfNameInput.value);
    } catch (error) {
      setStatus(`新增书架失败：${error.message || "网络异常"}`, "error");
    }
  });
  els.clearActiveShelfButton.addEventListener("click", () => {
    state.activeShelfId = "";
    saveStore();
    renderShelves();
    updatePendingActionUi();
    setStatus("已切回全部书架。");
  });
  els.renameShelfButton.addEventListener("click", () => {
    const activeShelf = getActiveShelf();
    if (!activeShelf) {
      setStatus("请先选择一个书架。", "error");
      return;
    }
    const nextName = window.prompt("输入新的书架名称", activeShelf.name);
    if (nextName === null) return;
    renameShelf(activeShelf, nextName);
  });
  els.deleteShelfButton.addEventListener("click", () => {
    const activeShelf = getActiveShelf();
    if (!activeShelf) {
      setStatus("请先选择一个书架。", "error");
      return;
    }
    deleteShelf(activeShelf);
  });
  els.pendingShelfSelect.addEventListener("change", () => {
    state.pendingShelfId = els.pendingShelfSelect.value;
    updatePendingActionUi();
  });
  els.assignShelfButton.addEventListener("click", () => {
    const selectedShelf = getSelectedPendingShelf();
    if (!selectedShelf) {
      setStatus("请先选择一个书架。", "error");
      return;
    }
    assignBookToShelf(state.pendingBook, selectedShelf.name);
  });
  els.removeShelfButton.addEventListener("click", () => assignBookToShelf(state.pendingBook, ""));
  els.confirmInButton.addEventListener("click", () => confirmPendingMovement(1));
  els.confirmOutButton.addEventListener("click", () => confirmPendingMovement(-1));
  els.cancelPendingButton.addEventListener("click", () => {
    clearPendingBook();
    setStatus("已取消本次扫码结果。");
    scheduleAutoScan();
  });

  els.manualForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.user) {
      setStatus("请先登录，手动补录会直接写入云端库存。", "error");
      return;
    }
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

    const bookPayload = {
      isbn,
      title: title || existing.title,
      authors: existing?.authors || "",
      publisher: existing?.publisher || "",
      source: title ? "手动补录" : existing?.source || "",
      category: els.manualCategory?.value.trim() || existing?.category || "",
      shelf: els.manualShelf.value.trim() || existing?.shelf || "",
      location: existing?.location || "",
      coverUrl: els.manualCoverUrl.value.trim() || existing?.coverUrl || "",
      price: els.manualPrice?.value.trim() || existing?.price || "",
      publishedDate: existing?.publishedDate || "",
      edition: els.manualEdition.value.trim() || existing?.edition || "",
      note: els.manualNote.value.trim() || existing?.note || "",
    };

    try {
      state.syncBusy = true;
      updateCloudUi();
      const { updated, effectiveDelta } = buildUpdatedBook(bookPayload, delta);
      await saveBookToCloud(updated, effectiveDelta, "手动补录");
      applyBookUpdate(updated, effectiveDelta, "手动补录");
      els.manualForm.reset();
      els.manualDelta.value = "0";
      [els.manualCategory, els.manualShelf, els.manualCoverUrl, els.manualPrice, els.manualEdition, els.manualNote].filter(Boolean).forEach((input) => {
        input.value = "";
      });
      setStatus(`${getBookTitle(updated)} 已保存到云端，当前库存 ${updated.count} 本`, "success");
    } catch (error) {
      setStatus(`云端保存失败：${error.message || "网络异常"}`, "error");
    } finally {
      state.syncBusy = false;
      updateCloudUi();
    }
  });

  window.addEventListener("beforeunload", stopScanner);
  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);
  window.addEventListener("scroll", requestPreviewStickyUpdate, { passive: true });
  window.addEventListener("resize", requestPreviewStickyUpdate);
  window.addEventListener("orientationchange", requestPreviewStickyUpdate);

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
    setCloudStatus("已登录。正在读取云端库存...", "success");
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
  const firstConfirm = window.confirm("第一次确认：确定要退出当前云端账号吗？退出后将无法查看和编辑云端库存。");
  if (!firstConfirm) return;
  const secondConfirm = window.confirm("第二次确认：退出会清空当前页面里显示的库存和书架，需要重新登录后再同步。继续退出？");
  if (!secondConfirm) return;
  const finalConfirm = window.confirm("第三次最终确认：真的退出当前账号？");
  if (!finalConfirm) return;

  try {
    await state.supabase.auth.signOut();
    state.user = null;
    state.books = {};
    state.history = [];
    state.shelves = [];
    state.activeShelfId = "";
    state.pendingShelfId = "";
    clearPendingBook();
    renderAll();
    setCloudStatus("已退出云端账号。登录后才能查看和编辑库存。");
  } catch (error) {
    setCloudStatus(`退出失败：${error.message || "网络异常"}`, "error");
  } finally {
    updateCloudUi();
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
    scheduleAutoScan(300);
  });
}

loadStore();
bindEvents();
updateSecureState();
updateNetworkStatus();
renderAll();
initCloud().catch((error) => setCloudStatus(`云端初始化失败：${error.message || "配置异常"}`, "error"));
scheduleAutoScan(900);
