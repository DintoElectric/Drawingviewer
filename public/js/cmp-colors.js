/* ------------------------------------------------------------------ *
 *  cmp-colors.js — the two overlay colors (Drawing A only / Drawing B only),
 *  shared by the Compare page and the sheet viewer.
 *
 *  The choice is a personal preference kept in this browser. It is applied
 *  through two CSS variables (--cmp-a, --cmp-b) used by cmp-colors.css, and
 *  read by the pages when they draw the print / export images.
 * ------------------------------------------------------------------ */

const KEY = "dh-cmp-colors";
const HEX = /^#[0-9a-f]{6}$/i;

export const DEFAULTS = { a: "#e5342a", b: "#00b7d9" };

export const PRESETS = [
  { name: "Red", hex: "#e5342a" },
  { name: "Orange", hex: "#f08c00" },
  { name: "Brown", hex: "#8b5a2b" },
  { name: "Pink", hex: "#ec4899" },
  { name: "Magenta", hex: "#c026d3" },
  { name: "Purple", hex: "#7c3aed" },
  { name: "Blue", hex: "#2563eb" },
  { name: "Cyan", hex: "#00b7d9" },
  { name: "Teal", hex: "#0d9488" },
  { name: "Green", hex: "#16a34a" },
  { name: "Lime", hex: "#65a30d" },
  { name: "Gray", hex: "#4b5563" },
];

let cur = { a: DEFAULTS.a, b: DEFAULTS.b };
let labels = { a: "Drawing A", b: "Drawing B" };
const listeners = [];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- storage + CSS variables ---------- */
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || "null");
    if (d && HEX.test(d.a) && HEX.test(d.b)) cur = { a: d.a.toLowerCase(), b: d.b.toLowerCase() };
  } catch (e) { /* ignore */ }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch (e) { /* ignore */ }
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function lum(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ink = (hex) => (lum(hex) > 0.35 ? "#0d0f1a" : "#ffffff");

function apply() {
  const s = document.documentElement.style;
  s.setProperty("--cmp-a", cur.a);
  s.setProperty("--cmp-b", cur.b);
  s.setProperty("--cmp-a-ink", ink(cur.a));
  s.setProperty("--cmp-b-ink", ink(cur.b));
}

/* ---------- public helpers ---------- */
export function init() { load(); apply(); }
export function get() { return { a: cur.a, b: cur.b }; }
export function onChange(fn) { listeners.push(fn); }

export function setLabels(next) {
  labels = { ...labels, ...next };
  refresh();
}

export function setColor(which, hex) {
  if (!HEX.test(hex || "") || (which !== "a" && which !== "b")) return;
  cur[which] = hex.toLowerCase();
  save(); apply(); refresh();
  listeners.forEach((fn) => fn(get()));
}

export function reset() {
  cur = { a: DEFAULTS.a, b: DEFAULTS.b };
  save(); apply(); refresh();
  listeners.forEach((fn) => fn(get()));
}

// Plain-English name for printouts: "red", or the hex code for a custom color.
export function name(which) {
  const hex = cur[which];
  const p = PRESETS.find((x) => x.hex === hex);
  return p ? p.name.toLowerCase() : hex.toUpperCase();
}

export function overlayText(la = "A", lb = "B") {
  return `Overlay: ${name("a")} = only in ${la}, ${name("b")} = only in ${lb}, dark = unchanged`;
}

// Warnings about combinations that make the overlay hard to read. Never blocks a choice.
export function problems() {
  const out = [];
  const la = lum(cur.a), lb = lum(cur.b);
  const tooLight = [];
  if (la > 0.55) tooLight.push(labels.a);
  if (lb > 0.55) tooLight.push(labels.b);
  if (tooLight.length) out.push(`${tooLight.join(" and ")}: that color is very light and will be hard to see on white paper.`);

  // Unchanged lines show as the two colors multiplied together. They should come out much
  // darker than either color, which only happens with colors far apart on the color wheel.
  if (!tooLight.length) {
    const [ra, ga, ba] = rgb(cur.a), [rb, gb, bb] = rgb(cur.b);
    const p = "#" + [ra * rb, ga * gb, ba * bb].map((v) => Math.round(v / 255).toString(16).padStart(2, "0")).join("");
    if (lum(p) > 0.5 * Math.min(la, lb)) {
      out.push("These two colors are too close. Unchanged lines won't turn dark, so they'll be hard to tell apart from changes. Try opposite colors, like red and cyan.");
    }
  }
  return out;
}

// HTML for a tappable color dot (used in legends). Bind with bindLegend().
export function swatchBtn(which) {
  const who = which === "a" ? labels.a : labels.b;
  return `<button type="button" class="sw-btn" data-color="${which}" aria-label="Change the color for ${who}" title="Tap to change colors"><i class="sw sw-${which}"></i></button>`;
}

// Makes the dots inside a legend open the picker. Taps must not start a pan on the drawing underneath.
export function bindLegend(root) {
  if (!root) return;
  root.addEventListener("pointerdown", (e) => { if (e.target.closest("[data-color]")) e.stopPropagation(); });
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-color]");
    if (b) togglePicker(b, b.dataset.color);
  });
}

// A normal toolbar button that opens the picker.
export function bindButton(btn) {
  if (btn) btn.addEventListener("click", () => togglePicker(btn, "a"));
}

/* ---------- the picker popover ---------- */
let pop = null, anchor = null, open = false;

function section(w) {
  const sw = PRESETS.map((p) =>
    `<button type="button" class="cpk-sw" data-hex="${p.hex}" style="--c:${p.hex}" title="${p.name}" aria-label="${p.name}" aria-pressed="false"></button>`).join("");
  return `<div class="cpk-sec" data-which="${w}">
    <div class="cpk-lbl">Only in <b data-lbl="${w}"></b></div>
    <div class="cpk-row">${sw}<label class="cpk-custom" title="Custom color"><i class="ph ph-eyedropper"></i><input type="color" data-custom="${w}" aria-label="Pick a custom color"></label></div>
  </div>`;
}

function build() {
  pop = document.createElement("div");
  pop.className = "cpk hidden";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Overlay colors");
  pop.innerHTML = `
    <div class="cpk-head"><span class="cpk-title">Overlay colors</span><button type="button" class="cpk-x" data-act="done" aria-label="Close"><i class="ph ph-x"></i></button></div>
    ${section("a")}${section("b")}
    <div class="cpk-warn hidden" id="cpkWarn" role="status"></div>
    <div class="cpk-foot"><button type="button" class="cpk-reset" data-act="reset">Reset to defaults</button><button type="button" class="btn btn-primary" data-act="done" style="min-height:40px">Done</button></div>`;
  document.body.appendChild(pop);

  pop.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (act) { if (act.dataset.act === "reset") reset(); else close(); return; }
    const sw = e.target.closest(".cpk-sw");
    if (sw) setColor(sw.closest(".cpk-sec").dataset.which, sw.dataset.hex);
  });
  pop.addEventListener("input", (e) => {
    const c = e.target.closest("[data-custom]");
    if (c) setColor(c.dataset.custom, c.value);
  });
  // taps inside the picker must never reach the drawing underneath
  pop.addEventListener("pointerdown", (e) => e.stopPropagation());

  document.addEventListener("pointerdown", (e) => {
    if (!open || pop.contains(e.target) || (anchor && anchor.contains(e.target))) return;
    close();
  });
  document.addEventListener("keydown", (e) => { if (open && e.key === "Escape") close(); });
  window.addEventListener("resize", () => { if (open) place(); });
}

function refresh() {
  if (!pop) return;
  pop.querySelectorAll(".cpk-sec").forEach((sec) => {
    const w = sec.dataset.which;
    sec.querySelector("[data-lbl]").textContent = labels[w];
    let preset = false;
    sec.querySelectorAll(".cpk-sw").forEach((b) => {
      const on = b.dataset.hex === cur[w];
      if (on) preset = true;
      b.setAttribute("aria-pressed", String(on));
    });
    const lab = sec.querySelector(".cpk-custom");
    const inp = lab.querySelector("input");
    lab.classList.toggle("on", !preset);
    lab.style.setProperty("--c", cur[w]);
    if (inp.value.toLowerCase() !== cur[w]) inp.value = cur[w];
  });
  const w = problems();
  const el = pop.querySelector("#cpkWarn");
  el.classList.toggle("hidden", !w.length);
  el.textContent = w.join(" ");
  if (open) place();
}

function place() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(332, vw - 16);
  pop.style.width = w + "px";
  const r = anchor ? anchor.getBoundingClientRect() : { left: vw / 2, width: 0, top: vh / 2, bottom: vh / 2 };
  const h = pop.offsetHeight;
  const left = clamp(r.left + r.width / 2 - w / 2, 8, Math.max(8, vw - w - 8));
  let top = r.bottom + 8;
  if (top + h > vh - 8) top = Math.max(8, r.top - h - 8);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
}

function togglePicker(el, which) {
  if (open && anchor === el) { close(); return; }
  if (!pop) build();
  anchor = el;
  open = true;
  pop.classList.remove("hidden");
  refresh();
  place();
}
function close() {
  open = false;
  if (pop) pop.classList.add("hidden");
}
