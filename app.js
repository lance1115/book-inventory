"use strict";

const STORAGE_KEY = "book-inventory:v1";
const HISTORY_LIMIT = 80;
const LOW_STOCK_LIMIT = 2;
const DUPLICATE_SCAN_GAP_MS = 1800;
const APP_VERSION = "20260518c";
const KNOWN_BOOKS = {
  9787040560039: {
    title: "数学史概论（第四版）",
    authors: "李文林",
    publisher: "高等教育出版社",
    source: "本地中文书目",
  },
};

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
  searchInput: $("#searchInput"),
  inventoryList: $("#inventoryList"),
  historyList: $("#historyList"),
  clearAll: $("#clearAll"),
  exportButton: $("#exportButton"),
  installButton: $("#installButton"),
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
};

function loadStore() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.books = normalizeStoredBooks(stored.books || {});
    state.history = normalizeStoredHistory(stored.history || []);
  } catch {
    state.books = {};
    state.history = [];
  }
}

function saveStore() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      books: state.books,
      history: state.history.slice(0, HISTORY_LIMIT),
      savedAt: new Date().toISOString(),
    }),
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
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
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
      return `${book.title || ""} ${book.isbn} ${book.authors || ""}`.toLowerCase().includes(term);
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
    node.querySelector(".book-title").textContent = getBookTitle(book);
    node.querySelector(".book-meta").textContent = `${book.isbn} · ${book.authors || "作者未知"} · ${book.updatedLabel || "刚刚"}`;
    node.querySelector(".book-count").textContent = book.count;
    node.querySelector(".minus").addEventListener("click", () => changeInventory(book.isbn, -1, "手动调整"));
    node.querySelector(".plus").addEventListener("click", () => changeInventory(book.isbn, 1, "手动调整"));
    fragment.append(node);
  });
  els.inventoryList.append(fragment);
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
  return updated;
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
  return {
    isbn,
    title: info.title,
    authors: Array.isArray(info.authors) ? info.authors.join("、") : "",
    publisher: info.publisher || "",
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

function normalizeKnownBook(book, isbn) {
  if (!book?.title) return null;
  return {
    isbn,
    title: book.title,
    authors: book.authors || "",
    publisher: book.publisher || "",
    source: book.source || "本地书目",
  };
}

function normalizeHepSearchBook(markdown, isbn) {
  const lines = String(markdown || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const titleLine = lines.find((line) => /^### \[.+\]\(https:\/\/xuanshu\.hep\.com\.cn\/front\/book\/findBookDetails\?bookId=/.test(line));
  if (!titleLine) return null;

  const title = titleLine.match(/^### \[(.+?)\]/)?.[1]?.trim();
  const titleIndex = lines.indexOf(titleLine);
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
  const formatted = encodeURIComponent(formatIsbn13(isbn));
  const target = `https://xuanshu.hep.com.cn/front/book/bookSearch?wd=${formatted}&searchType=book`;
  const markdown = await fetchText(`https://r.jina.ai/http://r.jina.ai/http://${target}`, 12000);
  return normalizeHepSearchBook(markdown, isbn);
}

async function lookupBook(isbn) {
  const cleaned = normalizeIsbn(isbn);
  const cached = state.books[cleaned];
  if (cached?.title) return cached;
  const known = normalizeKnownBook(KNOWN_BOOKS[cleaned], cleaned);
  if (known) return known;

  const lookups = [
    async () => lookupHepBook(cleaned),
    async () => normalizeOpenBdBook(await fetchJson(`https://api.openbd.jp/v1/get?isbn=${cleaned}`), cleaned),
    async () =>
      normalizeOpenLibraryBook(
        await fetchJsonp(
          `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(cleaned)}&jscmd=data&format=javascript`,
        ),
        cleaned,
      ),
    async () => normalizeGoogleBook(await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${cleaned}`), cleaned),
  ];

  for (const lookup of lookups) {
    try {
      const found = await lookup();
      if (found?.title) return found;
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
  setStatus(`已扫到 ${isbn}，正在自动查询书名...`);

  try {
    const book = await lookupBook(isbn);
    const delta = getDeltaForMode();
    const currentCount = Number(state.books[isbn]?.count || 0);

    if (state.mode === "lookup") {
      if (state.books[isbn] && book.title && !state.books[isbn].title) {
        upsertBook(book, 0, "书名更新");
      }

      const stockedBook = state.books[isbn];
      pulseSuccess();
      if (stockedBook) {
        setStatus(`${getBookTitle(stockedBook)}：当前库存 ${stockedBook.count} 本`, "success");
      } else if (book.title) {
        setStatus(`${getBookTitle(book)}：库存中暂无记录`, "success");
      } else {
        els.manualIsbn.value = isbn;
        setStatus(`库存中没有 ${isbn}，公共 ISBN 数据库也暂未返回书名。`, "error");
      }
      return;
    }

    if (delta < 0 && currentCount <= 0) {
      pulseSuccess();
      setStatus(`${getBookTitle(book)} 当前库存为 0，不能继续出库。`, "error");
      return;
    }

    const updated = upsertBook(book, delta, reason);
    pulseSuccess();

    if (!updated.title) {
      els.manualIsbn.value = isbn;
      els.manualTitleInput.focus({ preventScroll: true });
      setStatus(`已记录 ${isbn}，但公共 ISBN 数据库暂未返回书名。请在“补录”里填一次书名，之后同一本会自动识别。`, "error");
      return;
    }

    setStatus(`${getBookTitle(updated)} ${delta > 0 ? "入库" : "出库"}成功，当前库存 ${updated.count} 本`, "success");
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

    setStatus("摄像头已开启。把条形码放进框里，保持 1 秒即可自动识别。");
  } catch (error) {
    updateScanButtons(false);
    stopTracks();
    setStatus(`无法开启摄像头：${error.message || "请检查 Safari 摄像头权限"}`, "error");
  }
}

function stopScanner() {
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
  const rows = [["ISBN", "书名", "作者", "出版社", "库存", "更新时间"]];
  Object.values(state.books)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .forEach((book) => {
      rows.push([
        book.isbn,
        book.title || "",
        book.authors || "",
        book.publisher || "",
        book.count,
        book.updatedAt || "",
      ]);
    });

  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `book-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  $$(".mode-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      $$(".mode-button").forEach((item) => item.classList.toggle("active", item === button));
      const label = state.mode === "in" ? "入库" : state.mode === "out" ? "出库" : "查询";
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

  els.manualForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const isbn = normalizeIsbn(els.manualIsbn.value);
    const title = els.manualTitleInput.value.trim();
    const delta = Number(els.manualDelta.value || 0);
    const existing = state.books[isbn];

    if (!isbn) {
      setStatus("请填写有效的 ISBN-10 或 978 / 979 开头的 ISBN-13。", "error");
      return;
    }

    if (!title && !existing?.title) {
      setStatus("请填写书名；同一本书之后会自动沿用这个书名。", "error");
      return;
    }

    const updated = upsertBook({ isbn, title: title || existing.title }, delta, "手动补录");
    els.manualForm.reset();
    els.manualDelta.value = "1";
    setStatus(`${getBookTitle(updated)} 已保存，当前库存 ${updated.count} 本`, "success");
  });

  els.clearAll.addEventListener("click", () => {
    const ok = window.confirm("确定清空本机全部库存和流水记录吗？此操作不能撤销。");
    if (!ok) return;
    state.books = {};
    state.history = [];
    saveStore();
    renderAll();
    setStatus("库存已清空。");
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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

loadStore();
bindEvents();
updateSecureState();
renderAll();
