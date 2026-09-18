// AMD Dash — frontend logic. No page reloads; all updates are in-place.

"use strict";

const board = document.getElementById("board");
const searchBox = document.getElementById("searchBox");
const addBtn = document.getElementById("addBtn");
const viewModal = document.getElementById("viewModal");
const viewModalBody = document.getElementById("viewModalBody");
const modal = document.getElementById("modal");
const delModal = document.getElementById("delModal");
const toast = document.getElementById("toast");
const benchForm = document.getElementById("benchForm");

const ACC_ORDER = { good: 0, unreliable: 1, bad: 2, untested: 3 };
const ACC_ICON = { good: "🟢", unreliable: "🟡", bad: "🔴", untested: "⚪" };

let entries = [];       // all benchmarks (unsorted, as returned by server)
let rendered = [];      // currently displayed (ranked + filtered)
let pendingDelete = null;

// ---------------------------------------------------------------------------
// Ranking: quality first, then generation speed, then prompt speed.
// ---------------------------------------------------------------------------
function rank(a, b) {
  const acc = ACC_ORDER[a.mmproj_accuracy] - ACC_ORDER[b.mmproj_accuracy];
  if (acc !== 0) return acc;
  const gen = Number(b.generation_speed) - Number(a.generation_speed);
  if (gen !== 0) return gen;
  return Number(b.prompt_speed) - Number(a.prompt_speed);
}

function matches(e, q) {
  if (!q) return true;
  q = q.toLowerCase();
  const hay = [
    e.name,
    e.model_url || "",
    e.local_command || "",
    e.notes || "",
  ].join("\n").toLowerCase();
  return hay.indexOf(q) !== -1;
}

function matchesFilters(e) {
  const mm = document.getElementById("filterMmproj").value;
  if (mm && e.mmproj_accuracy !== mm) return false;
  const tk = document.getElementById("filterTask").value;
  if (tk && (e.task_accuracy || "untested") !== tk) return false;
  const p = document.getElementById("filterParam").value.trim().toLowerCase();
  if (p && !String(e.parameter_info || "").toLowerCase().includes(p)) return false;
  const g = Number(document.getElementById("filterGen").value) || 0;
  if (g > 0 && !(Number(e.generation_speed) >= g)) return false;
  const m = Number(document.getElementById("filterMtp").value) || 0;
  if (m > 0 && !(Number(e.mtp_generation_speed) >= m)) return false;
  return true;
}

function refresh() {
  const q = searchBox.value.trim();
  rendered = entries
    .filter((e) => matches(e, q) && matchesFilters(e))
    .sort(rank);
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function fmtSpeed(v) {
  const n = Number(v);
  if (Number.isInteger(n)) return n;
  return n;
}

// Build a command block: pre + copy button. `display` is what shows,
// `copyText` is what goes to clipboard (may differ on reorder).
// `idx`/`total` feed the toast so users know which command was copied.
function commandBlockHtml(display, copyText, idx, total) {
  const label = "command " + (idx + 1) + " of " + total;
  return `<div class="cmd-block">
    <pre>${esc(display)}</pre>
    <div class="cmd-foot"><button class="btn btn-sm" data-copy="${escAttr(copyText)}" data-copy-label="${escAttr(label)}">Copy</button></div>
  </div>`;
}

// Commands section shared by card and view modal. The header button copies
// ALL commands at once ("Copy all"); shown only when there are 2+ commands,
// since with one command the per-block button already covers it.
function commandsSectionHtml(e) {
  const cmds = e.local_commands || [];
  if (!cmds.length) return "";
  const copyAll = cmds.length > 1
    ? ` <button class="btn btn-sm btn-copy" data-copy="${escAttr(cmds.join("\n"))}" data-copy-label="all ${cmds.length} commands">Copy all</button>`
    : "";
  return `<div class="cmd-header">
         <span class="field-label">Commands (${cmds.length})</span>${copyAll}
       </div>
       <div class="commands">
       ${cmds.map((c, i) => commandBlockHtml(c, c, i, cmds.length)).join("")}
       </div>`;
}

function cardHTML(e) {
  const acc = e.mmproj_accuracy;
  const taskAcc = e.task_accuracy || "untested";
  const gen = fmtSpeed(e.generation_speed);
  const prompt = fmtSpeed(e.prompt_speed);

  let urlHtml = "";
  if (e.model_url) {
    urlHtml = `<div class="field-label">Model URL</div>
      <div class="url"><a href="${escAttr(e.model_url)}" target="_blank" rel="noopener">${esc(e.model_url)}</a></div>`;
  }

  const cmdHtml = commandsSectionHtml(e);

  const notesHtml = e.notes
    ? `<div class="field-label">Notes</div><div class="notes">${esc(e.notes)}</div>`
    : "";
    
  // Add parameter info if present
  const paramInfoHtml = e.parameter_info
    ? `<div class="field-label">Parameter Info</div><div class="param-info param-info-strong">${esc(e.parameter_info)}</div>`
    : "";
    
  // Add MTP generation speed if speculative decoding is enabled and MTP speed is present
  let mtpSpeedHtml = "";
  if (e.speculative_decoding && e.mtp_generation_speed > 0) {
    const mtpGen = fmtSpeed(e.mtp_generation_speed);
    mtpSpeedHtml = `
      <div class="speed-block">
        <div class="speed-label">MTP Generation</div>
        <div class="speed-value">${mtpGen} <small>tok/s</small></div>
      </div>`;
  }

  return `
    <div class="card" data-id="${escAttr(e.id)}">
      <h2>${esc(e.name)}</h2>
      <div class="card-body">
        ${paramInfoHtml}
        <div>
          <span class="acc ${escAttr(acc)}">${ACC_ICON[acc]} MMProj: ${esc(acc)}</span>
          <span class="acc ${escAttr(taskAcc)}">${ACC_ICON[taskAcc]} Task: ${esc(taskAcc)}</span>
        </div>
        <div class="speeds">
          <div class="speed-block">
            <div class="speed-label">Generation</div>
            <div class="speed-value">${gen} <small>tok/s</small></div>
          </div>
          <div class="speed-block">
            <div class="speed-label">Prompt</div>
            <div class="speed-value">${prompt} <small>tok/s</small></div>
          </div>
          ${mtpSpeedHtml}
        </div>
        ${urlHtml}
        ${cmdHtml}
        ${notesHtml}
      </div>
      <div class="card-actions">
        <button class="btn" data-view="${escAttr(e.id)}">View</button>
        <button class="btn" data-edit="${escAttr(e.id)}">Edit</button>
        <button class="btn btn-danger" data-del="${escAttr(e.id)}">Delete</button>
      </div>
    </div>`;
}

function render() {
  if (rendered.length === 0) {
    board.innerHTML = `
      <div class="empty">
        <h3>No benchmarks yet.</h3>
        <p>Add your first local LLM benchmark.</p>
        <button class="btn btn-primary" data-add>+ Add Benchmark</button>
      </div>`;
    return;
  }
  board.innerHTML = rendered.map(cardHTML).join("");
}

// ---------------------------------------------------------------------------
// Escape helpers (XSS-safe rendering)
// ---------------------------------------------------------------------------
function esc(s) {
  const r = String(s == null ? "" : s);
  const dq = String.fromCharCode(34); // double quote
  const qEnt = "&" + "quot;";
  return r
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(new RegExp(dq, "g"), qEnt)
    .replace(/'/g, "&#39;");
}
function escAttr(s) {
  return esc(s);
}

// ---------------------------------------------------------------------------
// Modal (add / edit)
// ---------------------------------------------------------------------------
function openModal(entry) {
  document.getElementById("modalTitle").textContent = entry ? "Edit Benchmark" : "Add Benchmark";
  document.getElementById("f_id").value = entry ? entry.id : "";
  document.getElementById("f_name").value = entry ? entry.name : "";
  document.getElementById("f_url").value = entry ? (entry.model_url || "") : "";
  loadCommandsIntoForm(entry ? entry.local_commands : [""]);
  document.getElementById("f_acc").value = entry ? entry.mmproj_accuracy : "untested";
  document.getElementById("f_task_acc").value = entry ? (entry.task_accuracy || "untested") : "untested";
  document.getElementById("f_prompt").value = entry ? entry.prompt_speed : "";
  document.getElementById("f_gen").value = entry ? entry.generation_speed : "";
  document.getElementById("f_notes").value = entry ? (entry.notes || "") : "";
  
  // Handle new fields
  const speculativeDecoding = entry ? entry.speculative_decoding : false;
  document.getElementById("f_speculative_decoding").checked = speculativeDecoding;
  
  const mtpGenerationSpeed = entry ? entry.mtp_generation_speed : 0;
  document.getElementById("f_mtp_gen").value = mtpGenerationSpeed > 0 ? mtpGenerationSpeed : "";
  
  const parameterInfo = entry ? (entry.parameter_info || "") : "";
  document.getElementById("f_param_info").value = parameterInfo;
  
  // Show/hide MTP speed container based on speculative decoding checkbox
  const mtpSpeedContainer = document.getElementById("mtp_speed_container");
  if (speculativeDecoding) {
    mtpSpeedContainer.style.display = "block";
  } else {
    mtpSpeedContainer.style.display = "none";
  }
  
  modal.classList.remove("hidden");
  document.getElementById("f_name").focus();
}
function closeModal() {
  modal.classList.add("hidden");
  benchForm.reset();
}

// ---------------------------------------------------------------------------
// Multi-command manager (edit form). Rows are reorderable (drag the ⋮⋮ handle
// or use the ↑/↓ buttons), each has its own remove button.
// ---------------------------------------------------------------------------
// The row currently being dragged. Must live OUTSIDE makeCommandRow: the
// drop handler runs on the target row and needs to see the source row set
// by the source row's dragstart — per-row state can never see it.
let activeDragRow = null;

function makeCommandRow(text = "") {
  const row = document.createElement("div");
  row.className = "cmd-row";
  row.innerHTML = `
    <div class="cmd-row-controls">
      <button type="button" class="btn btn-grip" title="Drag or move up/down">⋮⋮</button>
    </div>
    <div class="cmd-row-body">
      <textarea class="mono cmd-row-input" placeholder="e.g. llama-server -m model.gguf -ngl 999">${esc(text)}</textarea>
      <div class="cmd-row-foot"><button type="button" class="btn btn-danger" data-remove title="Remove command">Remove</button></div>
    </div>`;
  const textarea = row.querySelector(".cmd-row-input");
  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
  });

  // Grip handle is the drag source. Click it to move the row down, double-click
  // to move up. Drag-and-drop can leave the browser firing a stray `click` on
  // the drop target, which would undo the reorder — the `suppressNextClick`
  // latch swallows exactly that one click. It works regardless of whether
  // `dragend` fires before or after the click, because mousedown clears the
  // latch for the next ordinary (non-drag) click.
  const grip = row.querySelector(".btn-grip");
  let dragging = false;
  let suppressNextClick = false;

  const move = (dir) => {
    const prev = row.previousElementSibling;
    const next = row.nextElementSibling;
    if (dir === "up" && prev) row.parentNode.insertBefore(row, prev);
    // insertBefore(row, next) is a no-op when row is already before next;
    // to move down we must insert BEFORE the row after next.
    if (dir === "down" && next) {
      if (next.nextElementSibling) row.parentNode.insertBefore(row, next.nextElementSibling);
      else row.parentNode.appendChild(row);
    }
  };

  grip.addEventListener("mousedown", () => { suppressNextClick = false; });
  grip.addEventListener("click", (e) => {
    if (dragging || suppressNextClick) {
      e.stopImmediatePropagation();
      dragging = false;
      suppressNextClick = false;
      return;
    }
    move("down");
  });
  grip.addEventListener("dblclick", (e) => {
    if (dragging || suppressNextClick) {
      e.stopImmediatePropagation();
      dragging = false;
      suppressNextClick = false;
      return;
    }
    move("up");
  });

  row.querySelector("[data-remove]").addEventListener("click", () => row.remove());

  // Drag-and-drop reorder: the grip is the drag source, the whole row is the
  // drop zone. Note dragstart fires on the nearest draggable element, so the
  // grip itself must be draggable and row must NOT be (otherwise dragstart
  // fires on the row and text selection in the textarea breaks).
  row.draggable = false;
  grip.draggable = true;
  grip.style.cursor = "grab";

  row.addEventListener("dragstart", (e) => {
    if (e.target !== grip) {
      e.preventDefault();
      return;
    }
    activeDragRow = row;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "grip");
    dragging = true;
    suppressNextClick = false;
  });
  row.addEventListener("dragover", (e) => {
    if (!activeDragRow || activeDragRow === row) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    if (activeDragRow && activeDragRow !== row) {
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      if (before) row.parentNode.insertBefore(activeDragRow, row);
      else if (row.nextElementSibling) row.parentNode.insertBefore(activeDragRow, row.nextElementSibling);
      else row.parentNode.appendChild(activeDragRow);
    }
    activeDragRow = null;
  });
  grip.addEventListener("dragend", () => {
    dragging = false;
    suppressNextClick = true;
    activeDragRow = null;
  });

  return row;
}

function loadCommandsIntoForm(cmds) {
  const container = document.getElementById("f_cmd_container");
  const rows = Array.isArray(cmds) ? cmds : (cmds ? [cmds] : []);
  container.innerHTML = "";
  rows.forEach((c) => container.appendChild(makeCommandRow(c)));
}

function collectCommandsFromForm() {
  const inputs = document.querySelectorAll("#f_cmd_container .cmd-row-input");
  return Array.from(inputs).map((i) => i.value.trim()).filter((v) => v.length > 0);
}

benchForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const id = document.getElementById("f_id").value;
  const speculativeDecoding = document.getElementById("f_speculative_decoding").checked;
  const mtpGenerationSpeed = document.getElementById("f_mtp_gen").value;
  
  const payload = {
    id: id || undefined,
    name: document.getElementById("f_name").value,
    model_url: document.getElementById("f_url").value,
    local_commands: collectCommandsFromForm(),
    mmproj_accuracy: document.getElementById("f_acc").value,
    task_accuracy: document.getElementById("f_task_acc").value,
    prompt_speed: document.getElementById("f_prompt").value,
    generation_speed: document.getElementById("f_gen").value,
    notes: document.getElementById("f_notes").value,
    speculative_decoding: speculativeDecoding,
    mtp_generation_speed: speculativeDecoding ? (mtpGenerationSpeed || 0) : 0,
    parameter_info: document.getElementById("f_param_info").value,
  };

  try {
    const url = id ? `/api/benchmarks/${encodeURIComponent(id)}` : "/api/benchmarks";
    const method = id ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || "Could not save benchmark.", true);
      return;
    }
    // Instant in-place update (no reload):
    if (id) {
      const i = entries.findIndex((e) => e.id === id);
      if (i >= 0) entries[i] = data;
    } else {
      entries.push(data);
    }
    refresh();
    closeModal();
    showToast(id ? "Benchmark updated." : "Benchmark added.", false);
  } catch (err) {
    showToast("Could not save benchmark.", true);
  }
});

addBtn.addEventListener("click", () => openModal(null));
document.getElementById("addCmdBtn").addEventListener("click", () => {
  const container = document.getElementById("f_cmd_container");
  container.appendChild(makeCommandRow(""));
});
document.getElementById("cancelBtn").addEventListener("click", closeModal);
// Intentionally no click-outside-to-close here: clicking the backdrop must NOT
// discard unsaved form data. Only Cancel / Save (form submit) dismiss this modal.

// ---------------------------------------------------------------------------
// Delete confirmation
// ---------------------------------------------------------------------------
function openDelete(id) {
  pendingDelete = id;
  delModal.classList.remove("hidden");
}
function closeDelete() {
  pendingDelete = null;
  delModal.classList.add("hidden");
}
document.getElementById("delCancel").addEventListener("click", closeDelete);
delModal.addEventListener("click", (ev) => {
  if (ev.target === delModal) closeDelete();
});
document.getElementById("delConfirm").addEventListener("click", async () => {
  if (!pendingDelete) return;
  const id = pendingDelete;
  closeDelete();
  try {
    const res = await fetch(`/api/benchmarks/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      const d = await res.json();
      showToast(d.error || "Could not delete benchmark.", true);
      return;
    }
    entries = entries.filter((e) => e.id !== id); // instant removal
    refresh();
    showToast("Benchmark deleted.", false);
  } catch (err) {
    showToast("Could not delete benchmark.", true);
  }
});

// ---------------------------------------------------------------------------
// View a single card (read-only modal)
// ---------------------------------------------------------------------------
function openView(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  const acc = e.mmproj_accuracy;
  const taskAcc = e.task_accuracy || "untested";
  const gen = fmtSpeed(e.generation_speed);
  const prompt = fmtSpeed(e.prompt_speed);

  let urlHtml = "";
  if (e.model_url) {
    urlHtml = `<div class="field-label">Model URL</div>
      <div class="url"><a href="${escAttr(e.model_url)}" target="_blank" rel="noopener">${esc(e.model_url)}</a></div>`;
  }
  const cmdHtml = commandsSectionHtml(e);
  const notesHtml = e.notes
    ? `<div class="field-label">Notes</div><div class="notes">${esc(e.notes)}</div>`
    : "";
  const paramInfoHtml = e.parameter_info
    ? `<div class="field-label">Parameter Info</div><div class="param-info param-info-strong">${esc(e.parameter_info)}</div>`
    : "";
  let mtpSpeedHtml = "";
  if (e.speculative_decoding && e.mtp_generation_speed > 0) {
    const mtpGen = fmtSpeed(e.mtp_generation_speed);
    mtpSpeedHtml = `
      <div class="speed-block">
        <div class="speed-label">MTP Generation</div>
        <div class="speed-value">${mtpGen} <small>tok/s</small></div>
      </div>`;
  }

  viewModalBody.innerHTML = `
    <h2>${esc(e.name)}</h2>
    <div class="card-body">
      ${paramInfoHtml}
      <div>
        <span class="acc ${escAttr(acc)}">${ACC_ICON[acc]} MMProj: ${esc(acc)}</span>
        <span class="acc ${escAttr(taskAcc)}">${ACC_ICON[taskAcc]} Task: ${esc(taskAcc)}</span>
      </div>
      <div class="speeds">
        <div class="speed-block">
          <div class="speed-label">Generation</div>
          <div class="speed-value">${gen} <small>tok/s</small></div>
        </div>
        <div class="speed-block">
          <div class="speed-label">Prompt</div>
          <div class="speed-value">${prompt} <small>tok/s</small></div>
        </div>
        ${mtpSpeedHtml}
      </div>
      ${urlHtml}
      ${cmdHtml}
      ${notesHtml}
    </div>
  `;
  viewModal.classList.remove("hidden");
}
function closeView() {
  viewModal.classList.add("hidden");
}
document.getElementById("viewModalClose").addEventListener("click", closeView);
viewModal.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button");
  if (btn && btn.dataset.copy) { copyCommand(btn.dataset.copy, btn.dataset.copyLabel); return; }
  if (ev.target === viewModal) closeView();
});

// ---------------------------------------------------------------------------
// Global keyboard shortcuts
// ---------------------------------------------------------------------------
document.addEventListener("keydown", (ev) => {
  // Ignore shortcuts while typing in an input, textarea, or select.
  const tag = ev.target.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if (typing && ev.key !== "Escape") return;

  if (ev.key === "Escape") {
    if (!modal.classList.contains("hidden")) { closeModal(); }
    else if (!delModal.classList.contains("hidden")) { closeDelete(); }
    else if (!viewModal.classList.contains("hidden")) { closeView(); }
  } else if (!typing) {
    if (ev.key === "n" || ev.key === "a") { openModal(null); }
  }
});

// ---------------------------------------------------------------------------
// Delegated clicks (cards)
// ---------------------------------------------------------------------------
board.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button");
  if (!btn) return;
  const card = btn.closest(".card");
  if ("add" in btn.dataset) { openModal(null); return; }
  if (!card) return;
  const id = card.dataset.id;
  if (btn.dataset.copy) {
    copyCommand(btn.dataset.copy, btn.dataset.copyLabel);
  } else if (btn.dataset.view) {
    openView(id);
  } else if (btn.dataset.edit) {
    const e = entries.find((x) => x.id === id);
    if (e) openModal(e);
  } else if (btn.dataset.del) {
    openDelete(id);
  }
});

async function copyCommand(cmd, label) {
  if (!cmd) { showToast("Nothing to copy.", true); return; }
  const toast = () => showToast(label ? "Copied " + label : "Copied!", false);
  try {
    await navigator.clipboard.writeText(cmd);
    toast();
  } catch (err) {
    // fallback for older browsers / non-secure contexts
    const ta = document.createElement("textarea");
    ta.value = cmd;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e2) {}
    document.body.removeChild(ta);
    toast();
  }
}

searchBox.addEventListener("input", refresh);

document.getElementById("filterMmproj").addEventListener("change", refresh);
document.getElementById("filterTask").addEventListener("change", refresh);
document.getElementById("filterParam").addEventListener("input", refresh);
document.getElementById("filterGen").addEventListener("input", refresh);
document.getElementById("filterMtp").addEventListener("input", refresh);
document.getElementById("filterReset").addEventListener("click", () => {
  document.getElementById("filterMmproj").value = "";
  document.getElementById("filterTask").value = "";
  document.getElementById("filterParam").value = "";
  document.getElementById("filterGen").value = "";
  document.getElementById("filterMtp").value = "";
  refresh();
});

// ---------------------------------------------------------------------------
// Speculative decoding checkbox event listener
// ---------------------------------------------------------------------------
document.getElementById("f_speculative_decoding").addEventListener("change", function() {
  const mtpSpeedContainer = document.getElementById("mtp_speed_container");
  if (this.checked) {
    mtpSpeedContainer.style.display = "block";
  } else {
    mtpSpeedContainer.style.display = "none";
    // Clear the MTP generation speed field when hiding it
    document.getElementById("f_mtp_gen").value = "";
  }
});

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(msg, isError) {
  toast.textContent = msg;
  toast.classList.toggle("error", !!isError);
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2200);
}

// ---------------------------------------------------------------------------
// Load initial data
// ---------------------------------------------------------------------------
async function init() {
  try {
    const res = await fetch("/api/benchmarks");
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || "Could not load benchmarks.", true);
      return;
    }
    entries = data;
  } catch (err) {
    showToast("Could not load benchmarks.", true);
    entries = [];
  }
  refresh();
}

init();
