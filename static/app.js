// AMD Dash — frontend logic. No page reloads; all updates are in-place.

"use strict";

const board = document.getElementById("board");
const searchBox = document.getElementById("searchBox");
const addBtn = document.getElementById("addBtn");
const modal = document.getElementById("modal");
const delModal = document.getElementById("delModal");
const toast = document.getElementById("toast");
const benchForm = document.getElementById("benchForm");

const ACC_ORDER = { good: 0, unreliable: 1, bad: 2 };
const ACC_ICON = { good: "🟢", unreliable: "🟡", bad: "🔴" };

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

function refresh() {
  const q = searchBox.value.trim();
  rendered = entries.filter((e) => matches(e, q)).sort(rank);
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

function cardHTML(e) {
  const acc = e.mmproj_accuracy;
  const gen = fmtSpeed(e.generation_speed);
  const prompt = fmtSpeed(e.prompt_speed);

  let urlHtml = "";
  if (e.model_url) {
    urlHtml = `<div class="field-label">Model URL</div>
      <div class="url"><a href="${escAttr(e.model_url)}" target="_blank" rel="noopener">${esc(e.model_url)}</a></div>`;
  }

  const cmdHtml = e.local_command
    ? `<div class="field-label">Local Command</div>
       <div class="cmd-block">
         <pre>${esc(e.local_command)}</pre>
         <div class="cmd-foot"><button class="btn" data-copy="${escAttr(e.id)}">Copy Command</button></div>
       </div>`
    : "";

  const notesHtml = e.notes
    ? `<div class="field-label">Notes</div><div class="notes">${esc(e.notes)}</div>`
    : "";

  return `
    <div class="card" data-id="${escAttr(e.id)}">
      <h2>${esc(e.name)}</h2>
      <div>
        <span class="acc ${escAttr(acc)}">${ACC_ICON[acc]} ${esc(acc)}</span>
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
      </div>
      ${urlHtml}
      ${cmdHtml}
      ${notesHtml}
      <div class="card-actions">
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
  document.getElementById("f_cmd").value = entry ? (entry.local_command || "") : "";
  document.getElementById("f_acc").value = entry ? entry.mmproj_accuracy : "good";
  document.getElementById("f_prompt").value = entry ? entry.prompt_speed : "";
  document.getElementById("f_gen").value = entry ? entry.generation_speed : "";
  document.getElementById("f_notes").value = entry ? (entry.notes || "") : "";
  modal.classList.remove("hidden");
  document.getElementById("f_name").focus();
}
function closeModal() {
  modal.classList.add("hidden");
  benchForm.reset();
}

benchForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const id = document.getElementById("f_id").value;
  const payload = {
    id: id || undefined,
    name: document.getElementById("f_name").value,
    model_url: document.getElementById("f_url").value,
    local_command: document.getElementById("f_cmd").value,
    mmproj_accuracy: document.getElementById("f_acc").value,
    prompt_speed: document.getElementById("f_prompt").value,
    generation_speed: document.getElementById("f_gen").value,
    notes: document.getElementById("f_notes").value,
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
document.getElementById("cancelBtn").addEventListener("click", closeModal);
modal.addEventListener("click", (ev) => {
  if (ev.target === modal) closeModal();
});

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
// Delegated clicks (cards)
// ---------------------------------------------------------------------------
board.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button");
  if (!btn) return;
  const card = btn.closest(".card");
  if (btn.dataset.add) { openModal(null); return; }
  if (!card) return;
  const id = card.dataset.id;
  if (btn.dataset.copy) {
    copyCommand(id);
  } else if (btn.dataset.edit) {
    const e = entries.find((x) => x.id === id);
    if (e) openModal(e);
  } else if (btn.dataset.del) {
    openDelete(id);
  }
});

async function copyCommand(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  const cmd = e.local_command || "";
  try {
    await navigator.clipboard.writeText(cmd);
    showToast("Copied!", false);
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
    showToast("Copied!", false);
  }
}

// ---------------------------------------------------------------------------
// Search (instant rerank while typing)
// ---------------------------------------------------------------------------
searchBox.addEventListener("input", refresh);

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
