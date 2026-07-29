import {
  AnimationSpec,
  AnimationType,
  DuplicateIdWarning,
  ExportJson,
  PluginToUiMessage,
  SelectionInfo,
  UiToPluginMessage,
} from "./types";
import { getEffectiveMoveMode } from "./move";
import { getEffectiveResizeMode } from "./resize";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

function send(message: UiToPluginMessage) {
  parent.postMessage({ pluginMessage: message }, "*");
}

let currentSelection: SelectionInfo[] = [];
let latestExportJson: ExportJson | null = null;
let editingAnimId: string | null = null;

// ---------- Tabs ----------
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab-btn"));
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ---------- Error banner ----------
function showError(message: string) {
  const banner = $("error-banner");
  banner.textContent = message;
  banner.style.display = "block";
  window.setTimeout(() => {
    banner.style.display = "none";
  }, 4000);
}

// ---------- Easing UI ----------
const easingSelect = $("anim-easing") as HTMLSelectElement;
const customEasingField = $("custom-easing-field");
easingSelect.addEventListener("change", () => {
  customEasingField.style.display = easingSelect.value === "custom" ? "block" : "none";
});

function getSelectedEasing(): string {
  if (easingSelect.value === "custom") {
    return (($("anim-easing-custom") as HTMLInputElement).value || "linear").trim();
  }
  return easingSelect.value;
}

// ---------- Anim type UI (show/hide move fields) ----------
const animTypeSelect = $("anim-type") as HTMLSelectElement;
const moveFields = $("move-fields");
const moveModeSelect = $("move-mode") as HTMLSelectElement;
const moveAbsoluteRow = $("move-absolute-row");
const moveDeltaRow = $("move-delta-row");

function updateMoveModeRows() {
  const isAbsolute = moveModeSelect.value === "absolute";
  // move-absolute-row wraps two separate .row divs (X and Y), stacked vertically —
  // "block", not "flex" (which would put the X/Y rows side by side instead).
  moveAbsoluteRow.style.display = isAbsolute ? "block" : "none";
  moveDeltaRow.style.display = isAbsolute ? "none" : "flex";
}

// Absolute coordinates are specific to whichever part is selected, so refill them
// (unlike duration/delay/easing/dx/dy, which intentionally persist across selections).
// Both from and to default to the selected layer's own current position, so the
// animation is a no-op move until the user adjusts either end.
function prefillAbsoluteMoveDefaults() {
  if (currentSelection.length !== 1) return;
  const sel = currentSelection[0];
  const x = String(Math.round(sel.x));
  const y = String(Math.round(sel.y));
  (($("move-from-x") as HTMLInputElement)).value = x;
  (($("move-from-y") as HTMLInputElement)).value = y;
  (($("move-to-x") as HTMLInputElement)).value = x;
  (($("move-to-y") as HTMLInputElement)).value = y;
}

moveModeSelect.addEventListener("change", () => {
  updateMoveModeRows();
  if (moveModeSelect.value === "absolute") prefillAbsoluteMoveDefaults();
});

// ---------- Anim type UI (show/hide resize fields) ----------
const resizeFields = $("resize-fields");
const resizeModeSelect = $("resize-mode") as HTMLSelectElement;
const resizePercentageRow = $("resize-percentage-row");
const resizeAbsoluteRow = $("resize-absolute-row");

function updateResizeModeRows() {
  const isPercentage = resizeModeSelect.value === "percentage";
  resizePercentageRow.style.display = isPercentage ? "flex" : "none";
  // resize-absolute-row wraps two .field divs (width and height), stacked vertically —
  // "block", not "flex" (which would put them side by side instead).
  resizeAbsoluteRow.style.display = isPercentage ? "none" : "block";
}

// Absolute width/height are specific to whichever part is selected, so refill them.
// Both from and to default to the selected layer's own current size, so the
// animation is a no-op resize until the user adjusts either end.
function prefillAbsoluteResizeDefaults() {
  if (currentSelection.length !== 1) return;
  const sel = currentSelection[0];
  const w = String(Math.round(sel.width));
  const h = String(Math.round(sel.height));
  (($("resize-from-width") as HTMLInputElement)).value = w;
  (($("resize-to-width") as HTMLInputElement)).value = w;
  (($("resize-from-height") as HTMLInputElement)).value = h;
  (($("resize-to-height") as HTMLInputElement)).value = h;
}

resizeModeSelect.addEventListener("change", () => {
  updateResizeModeRows();
  if (resizeModeSelect.value === "absolute") prefillAbsoluteResizeDefaults();
});

animTypeSelect.addEventListener("change", () => {
  moveFields.style.display = animTypeSelect.value === "move" ? "block" : "none";
  resizeFields.style.display = animTypeSelect.value === "resize" ? "block" : "none";
  if (animTypeSelect.value === "move" && moveModeSelect.value === "absolute") {
    prefillAbsoluteMoveDefaults();
  }
  if (animTypeSelect.value === "resize" && resizeModeSelect.value === "absolute") {
    prefillAbsoluteResizeDefaults();
  }
});

// ---------- Edit existing animation ----------
function enterEditMode(anim: AnimationSpec) {
  editingAnimId = anim.animId;

  animTypeSelect.value = anim.type;
  moveFields.style.display = anim.type === "move" ? "block" : "none";
  resizeFields.style.display = anim.type === "resize" ? "block" : "none";

  (($("anim-id-input") as HTMLInputElement)).value = anim.id;
  (($("anim-duration") as HTMLInputElement)).value = String(anim.duration);
  (($("anim-delay") as HTMLInputElement)).value = String(anim.delay);

  const presetValues = Array.from(easingSelect.options)
    .map((o) => o.value)
    .filter((v) => v !== "custom");
  if (presetValues.includes(anim.easing)) {
    easingSelect.value = anim.easing;
    customEasingField.style.display = "none";
  } else {
    easingSelect.value = "custom";
    customEasingField.style.display = "block";
    (($("anim-easing-custom") as HTMLInputElement)).value = anim.easing;
  }

  if (anim.type === "move") {
    const mode = getEffectiveMoveMode(anim);
    moveModeSelect.value = mode;
    updateMoveModeRows();
    if (mode === "absolute" && anim.position) {
      (($("move-from-x") as HTMLInputElement)).value = String(anim.position.from.x);
      (($("move-from-y") as HTMLInputElement)).value = String(anim.position.from.y);
      (($("move-to-x") as HTMLInputElement)).value = String(anim.position.to.x);
      (($("move-to-y") as HTMLInputElement)).value = String(anim.position.to.y);
    } else if (anim.offset) {
      (($("anim-dx") as HTMLInputElement)).value = String(anim.offset.dx);
      (($("anim-dy") as HTMLInputElement)).value = String(anim.offset.dy);
    }
  }

  if (anim.type === "resize") {
    const mode = getEffectiveResizeMode(anim);
    resizeModeSelect.value = mode;
    updateResizeModeRows();
    if (mode === "absolute" && anim.size) {
      (($("resize-from-width") as HTMLInputElement)).value = String(anim.size.from.width);
      (($("resize-to-width") as HTMLInputElement)).value = String(anim.size.to.width);
      (($("resize-from-height") as HTMLInputElement)).value = String(anim.size.from.height);
      (($("resize-to-height") as HTMLInputElement)).value = String(anim.size.to.height);
    } else if (anim.scale) {
      (($("resize-scale-x") as HTMLInputElement)).value = String(anim.scale.x);
      (($("resize-scale-y") as HTMLInputElement)).value = String(anim.scale.y);
    }
  }

  $("anim-form-title").textContent = "アニメーションを編集";
  const note = $("editing-note");
  note.textContent = `「${animTypeLabel(anim.type)}」を編集中です。保存すると上書きされます。`;
  note.style.display = "block";
  (($("add-anim-btn") as HTMLButtonElement)).textContent = "変更を保存";
  (($("cancel-edit-btn") as HTMLButtonElement)).style.display = "inline-block";
}

function exitEditMode() {
  editingAnimId = null;
  $("anim-form-title").textContent = "アニメーションを追加";
  $("editing-note").style.display = "none";
  (($("add-anim-btn") as HTMLButtonElement)).textContent = "+ アニメーションを追加";
  (($("cancel-edit-btn") as HTMLButtonElement)).style.display = "none";
}

$("cancel-edit-btn").addEventListener("click", () => {
  exitEditMode();
});

// ---------- Selected layer rendering ----------
function renderSelected() {
  const noSelection = $("no-selection");
  const content = $("selected-content");

  if (currentSelection.length !== 1) {
    noSelection.style.display = "block";
    content.style.display = "none";
    noSelection.textContent =
      currentSelection.length === 0
        ? "Figma上でレイヤーを選択してください"
        : "複数選択中です。1つだけ選択してください";
    return;
  }

  noSelection.style.display = "none";
  content.style.display = "block";

  const sel = currentSelection[0];
  (($("layer-name") as HTMLInputElement)).value = sel.name;
  const idInput = $("tag-id-input") as HTMLInputElement;
  idInput.value = sel.tag ? sel.tag.id : "";

  // Absolute move coordinates / resize dimensions are specific to whichever part is
  // selected — refresh them for the newly selected part so stale values from a
  // different part never get submitted by accident. Skipped while editing, since
  // enterEditMode already set them.
  if (!editingAnimId && animTypeSelect.value === "move" && moveModeSelect.value === "absolute") {
    prefillAbsoluteMoveDefaults();
  }
  if (!editingAnimId && animTypeSelect.value === "resize" && resizeModeSelect.value === "absolute") {
    prefillAbsoluteResizeDefaults();
  }

  const deleteBtn = $("delete-tag-btn") as HTMLButtonElement;
  const animPanel = $("animations-panel");
  const animList = $("anim-list");

  // The animation panel is always available — a part's ID is optional, so you don't
  // need to save one before adding animations (see add-anim-btn below).
  deleteBtn.style.display = sel.tag ? "inline-block" : "none";
  animPanel.style.display = "block";

  const animations = sel.tag ? sel.tag.animations : [];
  animList.innerHTML = "";
  if (animations.length === 0) {
    animList.innerHTML = '<div class="empty">アニメーション未設定</div>';
  } else {
    animations.forEach((anim) => {
      const item = document.createElement("div");
      item.className = "anim-item";
      const label = animTypeLabel(anim.type);
      let detail = "";
      if (anim.type === "move") detail = ` ${moveDetailText(anim)}`;
      else if (anim.type === "resize") detail = ` ${resizeDetailText(anim)}`;

      const infoSpan = document.createElement("span");
      const badge = document.createElement("span");
      badge.className = "anim-badge";
      badge.textContent = label;
      infoSpan.appendChild(badge);

      if (anim.id) {
        const idBadge = document.createElement("span");
        idBadge.className = "anim-id-badge";
        idBadge.textContent = anim.id;
        infoSpan.appendChild(idBadge);
      }

      infoSpan.appendChild(
        document.createTextNode(`${anim.duration}ms / delay ${anim.delay}ms / ${anim.easing}${detail}`),
      );

      const editBtn = document.createElement("button");
      editBtn.className = "secondary icon-btn";
      editBtn.textContent = "✎";
      editBtn.title = "このアニメーションを編集";
      editBtn.addEventListener("click", () => {
        enterEditMode(anim);
      });

      const delBtn = document.createElement("button");
      delBtn.className = "danger icon-btn";
      delBtn.textContent = "×";
      delBtn.title = "このアニメーションを削除";
      delBtn.addEventListener("click", () => {
        if (editingAnimId === anim.animId) exitEditMode();
        send({ type: "delete-animation", nodeId: sel.nodeId, animId: anim.animId });
      });

      const actions = document.createElement("div");
      actions.className = "anim-item-actions";
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      item.appendChild(infoSpan);
      item.appendChild(actions);
      animList.appendChild(item);
    });
  }
}

function animTypeLabel(type: AnimationType): string {
  if (type === "fadeIn") return "フェードイン";
  if (type === "fadeOut") return "フェードアウト";
  if (type === "resize") return "サイズ変更";
  return "ムーブ";
}

function moveDetailText(anim: AnimationSpec): string {
  if (getEffectiveMoveMode(anim) === "absolute" && anim.position) {
    const { from, to } = anim.position;
    return `(${from.x}, ${from.y}) → (${to.x}, ${to.y})`;
  }
  if (anim.offset) {
    return `dx:${anim.offset.dx} dy:${anim.offset.dy}`;
  }
  return "";
}

function resizeDetailText(anim: AnimationSpec): string {
  if (getEffectiveResizeMode(anim) === "absolute" && anim.size) {
    const { from, to } = anim.size;
    return `${from.width}×${from.height} → ${to.width}×${to.height}`;
  }
  if (anim.scale) {
    return `x:${anim.scale.x}% y:${anim.scale.y}%`;
  }
  return "";
}

// ---------- JSON preview rendering ----------
function renderJsonPreview() {
  const emptyEl = $("all-empty");
  const previewEl = $("json-preview");

  if (!latestExportJson || latestExportJson.elements.length === 0) {
    emptyEl.style.display = "block";
    previewEl.style.display = "none";
    return;
  }
  emptyEl.style.display = "none";
  previewEl.style.display = "block";
  previewEl.textContent = JSON.stringify(latestExportJson, null, 2);
}

function renderDuplicateWarning(duplicateIds: DuplicateIdWarning[]) {
  const el = $("duplicate-warning");
  if (duplicateIds.length === 0) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }

  el.style.display = "block";
  el.innerHTML = "";

  const title = document.createElement("div");
  title.textContent =
    "⚠ IDが重複しています。Figma上でレイヤーを複製すると部品IDも複製されることがあります。「選択中」タブで該当レイヤーを選び、部品IDを付け直してください。";
  el.appendChild(title);

  const list = document.createElement("ul");
  list.style.margin = "6px 0 0 0";
  list.style.paddingLeft = "18px";
  duplicateIds.forEach((dup) => {
    const li = document.createElement("li");
    li.textContent = `"${dup.id}": ${dup.elements.map((e) => `${e.name} (${e.nodeId})`).join(", ")}`;
    list.appendChild(li);
  });
  el.appendChild(list);
}

// ---------- Event handlers ----------
$("save-tag-btn").addEventListener("click", () => {
  if (currentSelection.length !== 1) return;
  const id = (($("tag-id-input") as HTMLInputElement)).value;
  send({ type: "save-tag", nodeId: currentSelection[0].nodeId, id });
});

$("delete-tag-btn").addEventListener("click", () => {
  if (currentSelection.length !== 1) return;
  send({ type: "delete-tag", nodeId: currentSelection[0].nodeId });
});

$("add-anim-btn").addEventListener("click", () => {
  if (currentSelection.length !== 1) return;
  const type = animTypeSelect.value as AnimationType;
  const id = (($("anim-id-input") as HTMLInputElement)).value.trim();
  const duration = Number((($("anim-duration") as HTMLInputElement)).value) || 0;
  const delay = Number((($("anim-delay") as HTMLInputElement)).value) || 0;
  const easing = getSelectedEasing();

  const animation: AnimationSpec = {
    animId: editingAnimId ?? `anim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    id,
    type,
    duration,
    delay,
    easing,
  };

  if (type === "move") {
    const mode = moveModeSelect.value === "delta" ? "delta" : "absolute";
    animation.moveMode = mode;
    if (mode === "absolute") {
      const fromX = Number((($("move-from-x") as HTMLInputElement)).value) || 0;
      const fromY = Number((($("move-from-y") as HTMLInputElement)).value) || 0;
      const toX = Number((($("move-to-x") as HTMLInputElement)).value) || 0;
      const toY = Number((($("move-to-y") as HTMLInputElement)).value) || 0;
      animation.position = { from: { x: fromX, y: fromY }, to: { x: toX, y: toY } };
    } else {
      const dx = Number((($("anim-dx") as HTMLInputElement)).value) || 0;
      const dy = Number((($("anim-dy") as HTMLInputElement)).value) || 0;
      animation.offset = { dx, dy };
    }
  }

  if (type === "resize") {
    const mode = resizeModeSelect.value === "absolute" ? "absolute" : "percentage";
    animation.resizeMode = mode;
    if (mode === "absolute") {
      const fromWidth = Number((($("resize-from-width") as HTMLInputElement)).value) || 0;
      const fromHeight = Number((($("resize-from-height") as HTMLInputElement)).value) || 0;
      const toWidth = Number((($("resize-to-width") as HTMLInputElement)).value) || 0;
      const toHeight = Number((($("resize-to-height") as HTMLInputElement)).value) || 0;
      animation.size = {
        from: { width: fromWidth, height: fromHeight },
        to: { width: toWidth, height: toHeight },
      };
    } else {
      const scaleX = Number((($("resize-scale-x") as HTMLInputElement)).value) || 0;
      const scaleY = Number((($("resize-scale-y") as HTMLInputElement)).value) || 0;
      animation.scale = { x: scaleX, y: scaleY };
    }
  }

  // If this part isn't tagged yet, whatever is currently in the ID field (possibly
  // empty) is used to create the tag on the fly — no need to press "部品IDを追加" first.
  const partId = (($("tag-id-input") as HTMLInputElement)).value;
  send({ type: "save-animation", nodeId: currentSelection[0].nodeId, animation, id: partId });

  if (editingAnimId) exitEditMode();
});

$("export-btn").addEventListener("click", () => {
  if (latestExportJson) downloadJson(latestExportJson);
});

// ---------- Plugin -> UI messages ----------
window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data.pluginMessage as PluginToUiMessage;
  if (!msg) return;

  switch (msg.type) {
    case "selection-changed":
      // Editing state is tied to whichever node was selected when edit mode was
      // entered — always drop it on selection changes to avoid editing the wrong node.
      exitEditMode();
      currentSelection = msg.selection;
      renderSelected();
      break;
    case "export-preview":
      latestExportJson = msg.json;
      renderJsonPreview();
      renderDuplicateWarning(msg.duplicateIds);
      break;
    case "error":
      showError(msg.message);
      break;
  }
});

function downloadJson(json: ExportJson) {
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "motion-export.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

send({ type: "ui-ready" });
