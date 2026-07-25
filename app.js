const DB_NAME = "sakeLogDB";
const STORE_NAME = "records";
const DB_VERSION = 2;

const ICON_IMAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      const store = event.oldVersion < 1
        ? db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true })
        : tx.objectStore(STORE_NAME);

      if (store.indexNames.contains("name")) store.deleteIndex("name");
      if (!store.indexNames.contains("brand")) store.createIndex("brand", "brand");

      // 旧スキーマ({photoBlob, name, place})から新スキーマへの移行
      if (event.oldVersion > 0 && event.oldVersion < 2) {
        store.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          const r = cursor.value;
          if (r.photoBlob && !r.photoFrontBlob) {
            const migrated = {
              id: r.id,
              photoFrontBlob: r.photoBlob,
              photoBackBlob: r.photoBackBlob || null,
              brand: r.name || r.brand || "",
              brewery: r.brewery || "",
              seimai: r.seimai || "",
              sakemai: r.sakemai || "",
              nihonshudo: r.nihonshudo || "",
              date: r.date || "",
              place: r.place || "",
              memo: r.memo || "",
            };
            cursor.update(migrated);
          }
          cursor.continue();
        };
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function addRecord(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).add(record);
    req.onsuccess = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function putRecord(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result.reverse());
    req.onerror = () => reject(req.error);
  });
}

async function deleteRecord(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 写真をリサイズ・圧縮してから保存する（IndexedDBの肥大化と一覧表示の重さを防ぐため）
function resizeImage(file, maxSize = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxSize || height > maxSize) {
        if (width > height) {
          height = Math.round(height * (maxSize / width));
          width = maxSize;
        } else {
          width = Math.round(width * (maxSize / height));
          height = maxSize;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(objectUrl);
          resolve(blob);
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = reject;
    img.src = objectUrl;
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// カタカナ→ひらがな正規化+小文字化しての部分一致検索用
function toHiragana(str) {
  return (str || "")
    .split("")
    .map((c) => {
      const code = c.charCodeAt(0);
      return code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : c;
    })
    .join("")
    .toLowerCase();
}

// --- OCRテキストからの項目抽出 ---
const RICE_VARIETIES = [
  "山田錦", "五百万石", "美山錦", "雄町", "八反錦", "出羽燦々", "越淡麗",
  "亀の尾", "神力", "ひとごこち", "たかね錦", "愛山", "雄山錦", "華吟", "越神楽",
];

function extractSeimai(text) {
  const m = text.match(/精米歩合[^0-9]{0,6}(\d{1,3})/) || text.match(/(\d{1,3})\s*%/);
  return m ? `${m[1]}%` : "";
}

function extractNihonshudo(text) {
  const m = text.match(/日本酒度[^+\-±0-9]{0,6}([+\-±]?\d{1,2}(?:\.\d)?)/);
  if (m) return m[1];
  const m2 = text.match(/(?:^|[^\w])([+\-±]\d{1,2}(?:\.\d)?)(?:[^\w]|$)/);
  return m2 ? m2[1] : "";
}

function extractSakemai(text) {
  return RICE_VARIETIES.find((v) => text.includes(v)) || "";
}

function extractBrandGuess(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 2 && l.length <= 20 && !/^\d+$/.test(l));
  return lines[0] || "";
}

function extractBreweryGuess(text, brandGuess) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 2 && l.length <= 20 && !/^\d+$/.test(l) && l !== brandGuess);
  return lines[0] || "";
}

// OCR用に高解像度化+グレースケール化+コントラスト強調してから読み取る
// (保存用の写真は容量を抑えるため縮小しているが、小さい文字を読み取るにはそれでは解像度が足りないため別処理にしている)
function preprocessForOcr(blob, maxSize = 2000) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxSize || height > maxSize) {
        if (width > height) {
          height = Math.round(height * (maxSize / width));
          width = maxSize;
        } else {
          width = Math.round(width * (maxSize / height));
          height = maxSize;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);

      const imageData = ctx.getImageData(0, 0, width, height);
      const d = imageData.data;
      const contrast = 1.4;
      const intercept = 128 * (1 - contrast);
      for (let i = 0; i < d.length; i += 4) {
        const gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        const v = Math.min(255, Math.max(0, gray * contrast + intercept));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(imageData, 0, 0);

      URL.revokeObjectURL(objectUrl);
      canvas.toBlob(resolve, "image/png");
    };
    img.onerror = reject;
    img.src = objectUrl;
  });
}

async function runOcr(blob) {
  const ocrImage = await preprocessForOcr(blob);
  const worker = await Tesseract.createWorker(["jpn", "jpn_vert", "eng"]);
  await worker.setParameters({ tessedit_pageseg_mode: "11" }); // 11 = まばらな文字(縦書き・散らばったレイアウト向け)
  const { data } = await worker.recognize(ocrImage);
  await worker.terminate();
  return data.text || "";
}

// --- アプリの状態 ---
const state = {
  screen: "collection",
  returnScreen: "collection",
  registerStep: "photos",
  pendingFrontBlob: null,
  pendingBackBlob: null,
  pendingBackRawFile: null,
  draft: emptyDraft(),
  ocrFields: {},
  allRecords: [],
  selectedIndex: 0,
  editing: false,
  collectionQuery: "",
  searchQuery: "",
};

function emptyDraft() {
  return {
    brand: "",
    brewery: "",
    seimai: "",
    sakemai: "",
    nihonshudo: "",
    date: new Date().toISOString().slice(0, 10),
    place: "",
    memo: "",
  };
}

// --- オブジェクトURL管理 ---
let liveObjectUrls = [];
function trackUrl(url) {
  liveObjectUrls.push(url);
  return url;
}
function revokeLiveUrls() {
  liveObjectUrls.forEach((u) => URL.revokeObjectURL(u));
  liveObjectUrls = [];
}

// --- 画面遷移 ---
const SCREEN_TITLES = {
  collection: "記録一覧",
  register: null, // ステップごとにタイトルが変わる
  search: "検索",
  detail: "記録の詳細",
};

const STEP_TITLES = {
  photos: "ラベルを撮る",
  scanning: "解析中",
  review: "内容を確認",
};

function showScreen(name, { fromScreen } = {}) {
  if (fromScreen) state.returnScreen = fromScreen;
  state.screen = name;

  document.querySelectorAll(".screen").forEach((el) => {
    el.hidden = el.id !== `screen-${name}`;
  });

  document.querySelectorAll(".tab-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.screen === name);
  });

  const backBtn = document.getElementById("back-btn");
  const headerAction = document.getElementById("header-action");
  const title = document.getElementById("header-title");

  backBtn.hidden = !(name === "register" || name === "detail");
  headerAction.hidden = name !== "detail";

  if (name === "register") {
    title.textContent = STEP_TITLES[state.registerStep];
  } else {
    title.textContent = SCREEN_TITLES[name];
  }

  if (name === "collection") renderGallery();
  if (name === "search") renderSearchResults();
  if (name === "detail") renderDetail();
}

document.getElementById("back-btn").addEventListener("click", () => {
  showScreen(state.returnScreen || "collection");
});

document.querySelectorAll(".tab-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.screen;
    if (target === "register" && state.screen !== "register" && state.screen !== "detail") {
      state.returnScreen = state.screen;
    }
    showScreen(target);
  });
});

// --- 一覧画面 ---
async function renderGallery() {
  state.allRecords = await getAllRecords();
  const gallery = document.getElementById("gallery");
  const query = toHiragana(state.collectionQuery.trim());

  const brandCounts = {};
  state.allRecords.forEach((r) => {
    brandCounts[r.brand] = (brandCounts[r.brand] || 0) + 1;
  });

  const records = state.allRecords.filter(
    (r) => !query || toHiragana(r.brand).includes(query) || toHiragana(r.brewery).includes(query)
  );

  revokeLiveUrls();
  gallery.innerHTML = "";

  if (records.length === 0) {
    gallery.innerHTML = '<p class="empty">記録がありません</p>';
    return;
  }

  for (const record of records) {
    const card = document.createElement("div");
    card.className = "shot-card";

    const photo = document.createElement("div");
    photo.className = "shot-photo";
    if (record.photoFrontBlob) {
      const img = document.createElement("img");
      img.src = trackUrl(URL.createObjectURL(record.photoFrontBlob));
      photo.appendChild(img);
    } else {
      photo.innerHTML = ICON_IMAGE;
    }
    card.appendChild(photo);

    const meta = document.createElement("div");
    meta.className = "shot-meta";
    const placePart = record.place ? `・${escapeHtml(record.place)}` : "";
    meta.innerHTML = `
      <div class="shot-name">${escapeHtml(record.brand)}</div>
      <div class="shot-sub">${escapeHtml(record.date)}${placePart}</div>
      ${brandCounts[record.brand] > 1 ? '<div class="shot-again">前にも記録あり</div>' : ""}
    `;
    card.appendChild(meta);

    card.addEventListener("click", () => openDetailByRecord(record, "collection"));
    gallery.appendChild(card);
  }
}

document.getElementById("collection-search").addEventListener("input", (e) => {
  state.collectionQuery = e.target.value;
  renderGallery();
});

// --- 検索画面 ---
async function renderSearchResults() {
  state.allRecords = await getAllRecords();
  const container = document.getElementById("search-results");
  const emptyText = document.getElementById("search-empty-text");
  const noResultsText = document.getElementById("search-noresults-text");
  const query = state.searchQuery.trim();
  const q = toHiragana(query);

  container.innerHTML = "";
  revokeLiveUrls();

  if (!query) {
    emptyText.hidden = false;
    noResultsText.hidden = true;
    return;
  }
  emptyText.hidden = true;

  const results = state.allRecords.filter(
    (r) => toHiragana(r.brand).includes(q) || toHiragana(r.brewery).includes(q)
  );

  if (results.length === 0) {
    noResultsText.hidden = false;
    noResultsText.textContent = `「${query}」は記録の中に見つからなかった。まだ飲んだことがないかも。`;
    return;
  }
  noResultsText.hidden = true;

  for (const record of results) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "search-result-row";

    const thumb = document.createElement("div");
    thumb.className = "result-thumb";
    if (record.photoFrontBlob) {
      const img = document.createElement("img");
      img.src = trackUrl(URL.createObjectURL(record.photoFrontBlob));
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = ICON_IMAGE;
    }
    row.appendChild(thumb);

    const info = document.createElement("div");
    const idx = toHiragana(record.brand).indexOf(q);
    let nameHtml;
    if (idx >= 0) {
      const before = record.brand.slice(0, idx);
      const match = record.brand.slice(idx, idx + query.length);
      const after = record.brand.slice(idx + query.length);
      nameHtml = `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
    } else {
      nameHtml = escapeHtml(record.brand);
    }
    info.innerHTML = `
      <div class="result-name">${nameHtml}</div>
      <div class="result-sub">${escapeHtml(record.brewery)}・${escapeHtml(record.date)}</div>
    `;
    row.appendChild(info);

    row.addEventListener("click", () => openDetailByRecord(record, "search"));
    container.appendChild(row);
  }
}

document.getElementById("search-input").addEventListener("input", (e) => {
  state.searchQuery = e.target.value;
  renderSearchResults();
});

// --- 詳細画面 ---
function openDetailByRecord(record, fromScreen) {
  const idx = state.allRecords.findIndex((r) => r.id === record.id);
  state.selectedIndex = idx >= 0 ? idx : 0;
  state.editing = false;
  showScreen("detail", { fromScreen });
}

function renderDetail() {
  const records = state.allRecords;
  const record = records[state.selectedIndex];
  if (!record) return;

  revokeLiveUrls();

  document.getElementById("detail-position").textContent = `${state.selectedIndex + 1} / ${records.length}`;
  document.getElementById("detail-prev").style.opacity = state.selectedIndex <= 0 ? 0.35 : 1;
  document.getElementById("detail-next").style.opacity = state.selectedIndex >= records.length - 1 ? 0.35 : 1;

  const frontEl = document.getElementById("detail-photo-front");
  const backEl = document.getElementById("detail-photo-back");
  frontEl.innerHTML = record.photoFrontBlob
    ? `<img src="${trackUrl(URL.createObjectURL(record.photoFrontBlob))}" alt="表ラベル">`
    : ICON_IMAGE;
  backEl.innerHTML = record.photoBackBlob
    ? `<img src="${trackUrl(URL.createObjectURL(record.photoBackBlob))}" alt="裏ラベル">`
    : ICON_IMAGE;

  document.getElementById("detail-brand").textContent = record.brand;
  document.getElementById("detail-brewery").textContent = record.brewery;
  document.getElementById("detail-memo").textContent = record.memo || "";

  const grid = document.getElementById("detail-grid");
  grid.innerHTML = `
    <div><span class="label">精米歩合</span>${escapeHtml(record.seimai) || "-"}</div>
    <div><span class="label">酒米</span>${escapeHtml(record.sakemai) || "-"}</div>
    <div><span class="label">日本酒度</span>${escapeHtml(record.nihonshudo) || "-"}</div>
    <div><span class="label">飲んだ日付</span>${escapeHtml(record.date) || "-"}</div>
    <div class="full"><span class="label">飲んだ場所</span>${escapeHtml(record.place) || "-"}</div>
  `;

  setDetailEditing(false);
}

document.getElementById("detail-prev").addEventListener("click", () => {
  if (state.selectedIndex > 0) {
    state.selectedIndex -= 1;
    renderDetail();
  }
});
document.getElementById("detail-next").addEventListener("click", () => {
  if (state.selectedIndex < state.allRecords.length - 1) {
    state.selectedIndex += 1;
    renderDetail();
  }
});

function setDetailEditing(editing) {
  state.editing = editing;
  document.getElementById("detail-view").hidden = editing;
  document.getElementById("detail-edit").hidden = !editing;
  document.getElementById("delete-confirm").hidden = true;
  document.getElementById("header-action").textContent = editing ? "完了" : "編集する";

  if (editing) {
    const record = state.allRecords[state.selectedIndex];
    document.getElementById("e-brand").value = record.brand;
    document.getElementById("e-brewery").value = record.brewery;
    document.getElementById("e-seimai").value = record.seimai;
    document.getElementById("e-sakemai").value = record.sakemai;
    document.getElementById("e-nihonshudo").value = record.nihonshudo;
    document.getElementById("e-date").value = record.date;
    document.getElementById("e-place").value = record.place;
    document.getElementById("e-memo").value = record.memo;
  }
}

document.getElementById("header-action").addEventListener("click", () => {
  if (state.screen !== "detail") return;
  setDetailEditing(!state.editing);
});

document.getElementById("detail-edit").addEventListener("submit", async (e) => {
  e.preventDefault();
  const record = state.allRecords[state.selectedIndex];
  const updated = {
    ...record,
    brand: document.getElementById("e-brand").value.trim(),
    brewery: document.getElementById("e-brewery").value.trim(),
    seimai: document.getElementById("e-seimai").value.trim(),
    sakemai: document.getElementById("e-sakemai").value.trim(),
    nihonshudo: document.getElementById("e-nihonshudo").value.trim(),
    date: document.getElementById("e-date").value,
    place: document.getElementById("e-place").value.trim(),
    memo: document.getElementById("e-memo").value.trim(),
  };
  await putRecord(updated);
  state.allRecords = await getAllRecords();
  renderDetail();
});

document.getElementById("detail-delete-btn").addEventListener("click", () => {
  document.getElementById("delete-confirm").hidden = false;
});
document.getElementById("delete-cancel").addEventListener("click", () => {
  document.getElementById("delete-confirm").hidden = true;
});
document.getElementById("delete-confirm-btn").addEventListener("click", async () => {
  const record = state.allRecords[state.selectedIndex];
  await deleteRecord(record.id);
  showScreen(state.returnScreen || "collection");
});

// --- 登録画面: 写真選択 ---
function showPhoto(previewId, emptyId, loadingId, blob) {
  const preview = document.getElementById(previewId);
  preview.src = URL.createObjectURL(blob);
  preview.hidden = false;
  document.getElementById(emptyId).hidden = true;
  document.getElementById(loadingId).hidden = true;
}

function setPhotoLoading(loadingId, emptyId, isLoading) {
  document.getElementById(loadingId).hidden = !isLoading;
  document.getElementById(emptyId).hidden = isLoading;
}

function applyFrontPhoto(blob) {
  state.pendingFrontBlob = blob;
  showPhoto("front-preview", "front-empty", "front-loading", blob);
}

function applyBackPhoto(blob, rawFile) {
  state.pendingBackBlob = blob;
  state.pendingBackRawFile = rawFile || blob;
  showPhoto("back-preview", "back-empty", "back-loading", blob);
}

function setupPhotoSlot(inputId, onPickSingle) {
  const input = document.getElementById(inputId);

  input.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    if (files.length >= 2) {
      // 2枚まとめて選んだ場合は表・裏に自動で振り分ける
      setPhotoLoading("front-loading", "front-empty", true);
      setPhotoLoading("back-loading", "back-empty", true);
      const [frontBlob, backBlob] = await Promise.all([resizeImage(files[0]), resizeImage(files[1])]);
      applyFrontPhoto(frontBlob);
      applyBackPhoto(backBlob, files[1]);
      return;
    }

    const isFront = inputId === "front-photo";
    setPhotoLoading(isFront ? "front-loading" : "back-loading", isFront ? "front-empty" : "back-empty", true);
    const blob = await resizeImage(files[0]);
    onPickSingle(blob, files[0]);
  });
}

setupPhotoSlot("front-photo", applyFrontPhoto);
setupPhotoSlot("back-photo", applyBackPhoto);

function resetRegisterPhotos() {
  state.pendingFrontBlob = null;
  state.pendingBackBlob = null;
  state.pendingBackRawFile = null;
  document.getElementById("front-preview").hidden = true;
  document.getElementById("front-empty").hidden = false;
  document.getElementById("front-loading").hidden = true;
  document.getElementById("back-preview").hidden = true;
  document.getElementById("back-empty").hidden = false;
  document.getElementById("back-loading").hidden = true;
}

function setRegisterStep(step) {
  state.registerStep = step;
  document.getElementById("register-photos").hidden = step !== "photos";
  document.getElementById("register-scanning").hidden = step !== "scanning";
  document.getElementById("register-review").hidden = step !== "review";
  if (state.screen === "register") {
    document.getElementById("header-title").textContent = STEP_TITLES[step];
  }
}

document.getElementById("start-scan-btn").addEventListener("click", async () => {
  if (!state.pendingFrontBlob) return;

  if (!state.pendingBackBlob) {
    // 裏写真がない場合はOCRをスキップして手入力へ
    fillReviewForm(emptyDraft(), {});
    setRegisterStep("review");
    return;
  }

  setRegisterStep("scanning");
  try {
    const text = await runOcr(state.pendingBackRawFile || state.pendingBackBlob);
    const draft = emptyDraft();
    const ocrFields = {};

    const brand = extractBrandGuess(text);
    if (brand) { draft.brand = brand; ocrFields.brand = true; }
    const brewery = extractBreweryGuess(text, brand);
    if (brewery) { draft.brewery = brewery; ocrFields.brewery = true; }
    const seimai = extractSeimai(text);
    if (seimai) { draft.seimai = seimai; ocrFields.seimai = true; }
    const sakemai = extractSakemai(text);
    if (sakemai) { draft.sakemai = sakemai; ocrFields.sakemai = true; }
    const nihonshudo = extractNihonshudo(text);
    if (nihonshudo) { draft.nihonshudo = nihonshudo; ocrFields.nihonshudo = true; }

    fillReviewForm(draft, ocrFields);
  } catch (err) {
    console.error("OCR failed", err);
    fillReviewForm(emptyDraft(), {});
  }
  setRegisterStep("review");
});

function fillReviewForm(draft, ocrFields) {
  state.draft = draft;
  state.ocrFields = ocrFields;

  document.getElementById("f-brand").value = draft.brand;
  document.getElementById("f-brewery").value = draft.brewery;
  document.getElementById("f-seimai").value = draft.seimai;
  document.getElementById("f-sakemai").value = draft.sakemai;
  document.getElementById("f-nihonshudo").value = draft.nihonshudo;
  document.getElementById("f-date").value = draft.date;
  document.getElementById("f-place").value = draft.place;
  document.getElementById("f-memo").value = draft.memo;

  document.getElementById("tag-brand").hidden = !ocrFields.brand;
  document.getElementById("tag-brewery").hidden = !ocrFields.brewery;
  document.getElementById("tag-seimai").hidden = !ocrFields.seimai;
  document.getElementById("tag-sakemai").hidden = !ocrFields.sakemai;

  const nihonshudoTag = document.getElementById("tag-nihonshudo");
  if (ocrFields.nihonshudo) {
    nihonshudoTag.textContent = "OCR";
    nihonshudoTag.classList.remove("tag-outline");
  } else {
    nihonshudoTag.textContent = "要入力";
    nihonshudoTag.classList.add("tag-outline");
  }

  const hasAnyOcr = Object.keys(ocrFields).length > 0;
  document.getElementById("review-tag").textContent = hasAnyOcr
    ? "読み取り結果・内容を確認してください"
    : "自動で読み取れませんでした。内容を入力してください";

  document.getElementById("again-hint").hidden = true;
  checkAgainHint(draft.brand);
}

document.getElementById("retake-btn").addEventListener("click", () => {
  resetRegisterPhotos();
  setRegisterStep("photos");
});

document.getElementById("f-brand").addEventListener("input", (e) => {
  checkAgainHint(e.target.value.trim());
});

function checkAgainHint(brand) {
  const hint = document.getElementById("again-hint");
  if (!brand || brand.length < 2) {
    hint.hidden = true;
    return;
  }
  const q = brand.toLowerCase();
  const matches = state.allRecords.filter((r) => r.brand.toLowerCase().includes(q));
  if (matches.length === 0) {
    hint.hidden = true;
    return;
  }
  const latest = matches[0];
  const placePart = latest.place ? ` @ ${latest.place}` : "";
  hint.textContent = `以前にも記録があります（${matches.length}件） 前回: ${latest.date}${placePart}`;
  hint.hidden = false;
}

document.getElementById("register-review").addEventListener("submit", async (e) => {
  e.preventDefault();
  const record = {
    photoFrontBlob: state.pendingFrontBlob,
    photoBackBlob: state.pendingBackBlob,
    brand: document.getElementById("f-brand").value.trim(),
    brewery: document.getElementById("f-brewery").value.trim(),
    seimai: document.getElementById("f-seimai").value.trim(),
    sakemai: document.getElementById("f-sakemai").value.trim(),
    nihonshudo: document.getElementById("f-nihonshudo").value.trim(),
    date: document.getElementById("f-date").value,
    place: document.getElementById("f-place").value.trim(),
    memo: document.getElementById("f-memo").value.trim(),
  };
  if (!record.brand || !record.date) return;

  const id = await addRecord(record);

  resetRegisterPhotos();
  setRegisterStep("photos");
  state.returnScreen = "collection";

  state.allRecords = await getAllRecords();
  openDetailByRecord({ id }, "collection");
  showScreen("detail");
});

// --- 初期化 ---
(async function init() {
  document.getElementById("f-date").valueAsDate = new Date();
  state.allRecords = await getAllRecords();
  showScreen("collection");
})();
