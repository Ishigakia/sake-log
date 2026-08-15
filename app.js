const DB_NAME = "sakeLogDB";
const STORE_NAME = "records";
const DB_VERSION = 3;

// 他の端末とのGoogleドライブ同期に使う、このアプリ専用のOAuthクライアントID
const GOOGLE_CLIENT_ID = "404021395027-lkd61q4gn8288r4jiom4m50al86v4c8u.apps.googleusercontent.com";
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FILE_NAME = "sake-log-data.json";

// 裏ラベルOCR(Claude画像認識)の中継サーバー
const OCR_WORKER_URL = "https://flat-sky-7e67.mfgyoh.workers.dev";
const OCR_APP_SECRET = "sakelog2026xyz";

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

      // 複数端末での同期に備え、連番IDを世界で重複しないID(UUID)に振り直し、更新日時を付与する
      if (event.oldVersion > 0 && event.oldVersion < 3) {
        store.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          const r = cursor.value;
          if (typeof r.id === "number") {
            const oldId = r.id;
            const migrated = {
              ...r,
              id: crypto.randomUUID(),
              updatedAt: Date.now(),
            };
            cursor.delete();
            store.add(migrated);
          } else if (r.updatedAt === undefined) {
            cursor.update({ ...r, updatedAt: Date.now() });
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
  const withMeta = { ...record, id: record.id || crypto.randomUUID(), updatedAt: record.updatedAt || Date.now() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).add(withMeta);
    req.onsuccess = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function putRecord(record) {
  const db = await openDB();
  const withMeta = { ...record, updatedAt: Date.now() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(withMeta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 同期用に、複数端末とデータをやり取りしても壊れないよう更新日時を保持したまま保存する
async function putRecordAsIs(record) {
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
    req.onsuccess = () => {
      // 新しい日付が上に来るよう並べ替え(同じ日付は更新が新しい順)
      const records = req.result.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      resolve(records);
    };
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

// 他端末との同期用に、表ラベルの小さいサムネイルを作る(フル解像度の写真自体は同期しない)
function makeThumbnail(blob, maxSize = 200, quality = 0.7) {
  return resizeImage(blob, maxSize, quality);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function base64ToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

// 写真のExif情報から撮影日を読み取る(JPEG以外や情報が無い場合はnull)
function extractExifDate(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(parseExifDateFromBuffer(reader.result));
      } catch (err) {
        resolve(null);
      }
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file.slice(0, 128 * 1024)); // Exifはファイル冒頭にあるため先頭だけ読む
  });
}

function parseExifDateFromBuffer(buffer) {
  const view = new DataView(buffer);
  if (view.getUint16(0) !== 0xffd8) return null; // JPEG以外は非対応

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) break;
    const segmentLength = view.getUint16(offset + 2);
    if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966) {
      return readExifDateTags(view, offset + 10); // "Exif\0\0"の6バイト分進めてTIFF開始位置へ
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function readExifDateTags(view, tiffStart) {
  const little = view.getUint16(tiffStart) === 0x4949;
  const ifd0Offset = tiffStart + view.getUint32(tiffStart + 4, little);

  const exifIfdOffset = findExifTagValue(view, ifd0Offset, 0x8769, little);
  if (exifIfdOffset) {
    const original = readExifDateString(view, tiffStart + exifIfdOffset, tiffStart, 0x9003, little);
    if (original) return original;
  }
  return readExifDateString(view, ifd0Offset, tiffStart, 0x0132, little);
}

function findExifTagValue(view, ifdStart, tag, little) {
  const count = view.getUint16(ifdStart, little);
  for (let i = 0; i < count; i++) {
    const entry = ifdStart + 2 + i * 12;
    if (view.getUint16(entry, little) === tag) {
      return view.getUint32(entry + 8, little);
    }
  }
  return null;
}

function readExifDateString(view, ifdStart, tiffStart, tag, little) {
  const count = view.getUint16(ifdStart, little);
  for (let i = 0; i < count; i++) {
    const entry = ifdStart + 2 + i * 12;
    if (view.getUint16(entry, little) === tag) {
      const valueOffset = tiffStart + view.getUint32(entry + 8, little);
      let str = "";
      for (let j = 0; j < 19; j++) str += String.fromCharCode(view.getUint8(valueOffset + j));
      const m = str.match(/^(\d{4}):(\d{2}):(\d{2})/); // "YYYY:MM:DD HH:MM:SS"形式
      return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    }
  }
  return null;
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

// --- 裏ラベル写真の読み取り(Claude画像認識、中継サーバー経由) ---
async function runVisionOcr(blob) {
  const dataUrl = await blobToBase64(blob);
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) throw new Error("画像の変換に失敗しました");
  const [, mediaType, imageBase64] = match;

  const res = await fetch(OCR_WORKER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-App-Secret": OCR_APP_SECRET,
    },
    body: JSON.stringify({ imageBase64, mediaType }),
  });
  if (!res.ok) {
    throw new Error(`OCRサーバーエラー(${res.status})`);
  }
  return res.json(); // { brand, brewery, seimai, sakemai, nihonshudo }
}

// --- アプリの状態 ---
const state = {
  screen: "collection",
  returnScreen: "collection",
  registerStep: "photos",
  pendingFrontBlob: null,
  pendingBackBlob: null,
  pendingBackRawFile: null,
  pendingFrontExifPromise: null,
  pendingBackExifPromise: null,
  draft: emptyDraft(),
  ocrFields: {},
  allRecords: [],
  selectedIndex: 0,
  editing: false,
  collectionQuery: "",
  searchQuery: "",
};

function emptyDraft(date) {
  return {
    brand: "",
    brewery: "",
    seimai: "",
    sakemai: "",
    nihonshudo: "",
    date: date || new Date().toISOString().slice(0, 10),
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

function showScreen(name, { fromScreen, skipHistory } = {}) {
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
  headerAction.hidden = !(name === "detail" || name === "collection");
  if (name === "collection") headerAction.textContent = "同期";

  if (name === "register") {
    title.textContent = STEP_TITLES[state.registerStep];
  } else {
    title.textContent = SCREEN_TITLES[name];
  }

  // register・detailは「戻る」で1つ前に戻れるよう履歴を1つ積む。
  // collection・searchは並び替わりのタブなので、履歴は積まず置き換えるだけにする
  // (これにより端末の戻るジェスチャーで画面遷移せずアプリごと終了するのを防ぐ)
  if (!skipHistory) {
    if (name === "register" || name === "detail") {
      history.pushState({ screen: name }, "", location.href);
    } else {
      history.replaceState({ screen: name }, "", location.href);
    }
  }

  if (name === "collection") renderGallery();
  if (name === "search") renderSearchResults();
  if (name === "detail") renderDetail();
}

document.getElementById("back-btn").addEventListener("click", () => {
  history.back();
});

// スマホの横スワイプ(戻るジェスチャー)でアプリごと終了せず、アプリ内の一つ前の画面に戻すための処理
window.addEventListener("popstate", () => {
  showScreen(state.returnScreen || "collection", { skipHistory: true });
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
    const shotPhotoSrc = record.photoFrontBlob || record.photoThumbnail;
    if (shotPhotoSrc) {
      const img = document.createElement("img");
      img.src = trackUrl(URL.createObjectURL(shotPhotoSrc));
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
    const resultThumbSrc = record.photoFrontBlob || record.photoThumbnail;
    if (resultThumbSrc) {
      const img = document.createElement("img");
      img.src = trackUrl(URL.createObjectURL(resultThumbSrc));
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
  const detailFrontSrc = record.photoFrontBlob || record.photoThumbnail;
  frontEl.innerHTML = detailFrontSrc
    ? `<img src="${trackUrl(URL.createObjectURL(detailFrontSrc))}" alt="表ラベル">`
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
  if (state.screen === "detail") {
    setDetailEditing(!state.editing);
  } else if (state.screen === "collection") {
    handleSyncClick();
  }
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

function applyFrontPhoto(blob, rawFile) {
  state.pendingFrontBlob = blob;
  state.pendingFrontExifPromise = rawFile ? extractExifDate(rawFile) : Promise.resolve(null);
  showPhoto("front-preview", "front-empty", "front-loading", blob);
}

function applyBackPhoto(blob, rawFile) {
  state.pendingBackBlob = blob;
  state.pendingBackRawFile = rawFile || blob; // OCR送信時に、保存用より高画質な画像を作るための元ファイル
  state.pendingBackExifPromise = rawFile ? extractExifDate(rawFile) : Promise.resolve(null);
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
      applyFrontPhoto(frontBlob, files[0]);
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
  state.pendingFrontExifPromise = null;
  state.pendingBackExifPromise = null;
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

  const exifDate = (await state.pendingFrontExifPromise) || (await state.pendingBackExifPromise) || null;

  if (!state.pendingBackBlob) {
    // 裏写真がない場合はOCRをスキップして手入力へ
    fillReviewForm(emptyDraft(exifDate), { date: !!exifDate });
    setRegisterStep("review");
    return;
  }

  setRegisterStep("scanning");
  try {
    // 保存用(容量重視)より高画質な画像を、読み取り専用にその場で作る
    const ocrImage = await resizeImage(state.pendingBackRawFile || state.pendingBackBlob, 2000, 0.92);
    const result = await runVisionOcr(ocrImage);
    const draft = emptyDraft(exifDate);
    const ocrFields = { date: !!exifDate };

    if (result.brand) { draft.brand = result.brand; ocrFields.brand = true; }
    if (result.brewery) { draft.brewery = result.brewery; ocrFields.brewery = true; }
    if (result.seimai) { draft.seimai = result.seimai; ocrFields.seimai = true; }
    if (result.sakemai) { draft.sakemai = result.sakemai; ocrFields.sakemai = true; }
    if (result.nihonshudo) { draft.nihonshudo = result.nihonshudo; ocrFields.nihonshudo = true; }

    fillReviewForm(draft, ocrFields);
  } catch (err) {
    console.error("OCR failed", err);
    fillReviewForm(emptyDraft(exifDate), { date: !!exifDate });
    document.getElementById("review-tag").textContent =
      "解析中にエラーが発生しました(" + (err && err.message ? err.message : "詳細不明") + ")。内容は手入力してください";
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
  document.getElementById("tag-date").hidden = !ocrFields.date;

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
  const photoThumbnail = state.pendingFrontBlob ? await makeThumbnail(state.pendingFrontBlob) : null;
  const record = {
    photoFrontBlob: state.pendingFrontBlob,
    photoBackBlob: state.pendingBackBlob,
    photoThumbnail,
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

  await addRecord(record);

  resetRegisterPhotos();
  setRegisterStep("photos");

  state.allRecords = await getAllRecords();
  showScreen("collection");
});

// --- Googleドライブ同期 ---
let googleTokenClient = null;
let googleAccessToken = null;

function initGoogleAuth() {
  if (typeof google === "undefined" || !google.accounts) return;
  googleTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GOOGLE_DRIVE_SCOPE,
    callback: () => {}, // requestGoogleToken()内で都度差し替える
  });
}

function requestGoogleToken() {
  return new Promise((resolve, reject) => {
    if (!googleTokenClient) {
      reject(new Error("Google認証の準備ができていません"));
      return;
    }
    googleTokenClient.callback = (resp) => {
      if (resp.error) {
        reject(resp);
        return;
      }
      googleAccessToken = resp.access_token;
      resolve(googleAccessToken);
    };
    googleTokenClient.requestAccessToken({ prompt: "" });
  });
}

async function driveFindFileId(token) {
  const query = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error("ドライブのファイル検索に失敗しました");
  const data = await res.json();
  return data.files && data.files[0] ? data.files[0].id : null;
}

async function driveDownloadFile(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { records: [] };
  return res.json();
}

async function driveUploadFile(token, fileId, jsonData) {
  const boundary = "sakelog-boundary";
  const metadata = { name: DRIVE_FILE_NAME, mimeType: "application/json" };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${JSON.stringify(jsonData)}\r\n` +
    `--${boundary}--`;

  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

  const res = await fetch(url, {
    method: fileId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error("ドライブへの保存に失敗しました");
  return res.json();
}

// ローカルの記録をドライブ用のJSON形式に変換する(フル解像度写真は含めない、サムネイルのみ)
async function recordsToSyncPayload(records) {
  const out = [];
  for (const r of records) {
    const thumbSource = r.photoThumbnail || r.photoFrontBlob || null;
    out.push({
      id: r.id,
      brand: r.brand,
      brewery: r.brewery,
      seimai: r.seimai,
      sakemai: r.sakemai,
      nihonshudo: r.nihonshudo,
      date: r.date,
      place: r.place,
      memo: r.memo,
      updatedAt: r.updatedAt || 0,
      thumbnail: thumbSource ? await blobToBase64(thumbSource) : null,
    });
  }
  return { records: out };
}

// 端末内の記録とドライブ上の記録を、更新日時が新しい方を採用してマージする(いわゆる「後勝ち」方式)
async function mergeRemoteIntoLocal(localRecords, remoteRecords) {
  const localById = new Map(localRecords.map((r) => [r.id, r]));

  for (const remote of remoteRecords) {
    const local = localById.get(remote.id);

    if (!local) {
      // このデバイスにまだ無い記録 → 新規追加(サムネイルのみ、フル解像度写真は無し)
      const photoThumbnail = remote.thumbnail ? await base64ToBlob(remote.thumbnail) : null;
      await putRecordAsIs({
        id: remote.id,
        brand: remote.brand,
        brewery: remote.brewery,
        seimai: remote.seimai,
        sakemai: remote.sakemai,
        nihonshudo: remote.nihonshudo,
        date: remote.date,
        place: remote.place,
        memo: remote.memo,
        updatedAt: remote.updatedAt,
        photoFrontBlob: null,
        photoBackBlob: null,
        photoThumbnail,
      });
      continue;
    }

    if ((remote.updatedAt || 0) > (local.updatedAt || 0)) {
      // ドライブ側の方が新しい → 文字情報だけ上書き(このデバイスの写真はそのまま残す)
      const photoThumbnail = remote.thumbnail ? await base64ToBlob(remote.thumbnail) : local.photoThumbnail || null;
      await putRecordAsIs({
        ...local,
        brand: remote.brand,
        brewery: remote.brewery,
        seimai: remote.seimai,
        sakemai: remote.sakemai,
        nihonshudo: remote.nihonshudo,
        date: remote.date,
        place: remote.place,
        memo: remote.memo,
        updatedAt: remote.updatedAt,
        photoThumbnail: local.photoFrontBlob ? local.photoThumbnail : photoThumbnail,
      });
    }
  }
}

let syncInProgress = false;

async function handleSyncClick() {
  if (syncInProgress) return;
  syncInProgress = true;

  const headerAction = document.getElementById("header-action");
  const originalText = "同期";
  headerAction.textContent = "同期中…";

  try {
    if (!googleAccessToken) {
      await requestGoogleToken();
    }

    const token = googleAccessToken;
    const fileId = await driveFindFileId(token);
    console.log("[sync] fileId:", fileId);
    const remoteData = fileId ? await driveDownloadFile(token, fileId) : { records: [] };
    console.log("[sync] remote records:", (remoteData.records || []).length);

    const localRecords = await getAllRecords();
    console.log("[sync] local records before merge:", localRecords.length);
    await mergeRemoteIntoLocal(localRecords, remoteData.records || []);

    const mergedLocalRecords = await getAllRecords();
    console.log("[sync] local records after merge:", mergedLocalRecords.length);
    const payload = await recordsToSyncPayload(mergedLocalRecords);
    console.log("[sync] uploading payload with", payload.records.length, "records");
    const uploadResult = await driveUploadFile(token, fileId, payload);
    console.log("[sync] upload result:", uploadResult);

    state.allRecords = await getAllRecords();
    if (state.screen === "collection") renderGallery();

    headerAction.textContent = `✓ ${mergedLocalRecords.length}件`;
  } catch (err) {
    console.error("[sync] 同期に失敗しました", err);
    headerAction.textContent = `エラー: ${err.message || err}`;
    setTimeout(() => {
      if (state.screen === "collection") headerAction.textContent = originalText;
    }, 6000);
    syncInProgress = false;
    return;
  }

  syncInProgress = false;
  setTimeout(() => {
    if (state.screen === "collection") headerAction.textContent = originalText;
  }, 2500);
}

// --- 初期化 ---
(async function init() {
  initGoogleAuth();
  document.getElementById("f-date").valueAsDate = new Date();
  state.allRecords = await getAllRecords();
  showScreen("collection");
})();
