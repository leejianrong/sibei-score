// The labelling studio's region editor (ADR-0036): an image with draggable, resizable, drawable
// boxes. indah's ImageOverlay is display-only (interactive annotation is its unbuilt ADR-0020 step
// two), so this is an indah ES-module custom component (indah ADR-0039) — one finished file, no build.
//
// Props (as properties): `src` (data: URI of the transient page raster), `boxes` ([{id, kind, status,
// x, y, w, h}], x/y/w/h as FRACTIONS of the image so they hold at any zoom), `kinds` (names, in
// legend order), `selected` (an id or ""), `newKind` (the kind a freshly drawn box gets), `alt`.
// Events: `change` {value: boxes} after each finished edit (written back to the bound signal) and
// `select` {value: id}. Text is set with textContent, never innerHTML: a prop is data, not markup.
//
// Keys (click the page first): Delete/Backspace remove · arrows nudge 1px (shift: 10px) ·
// Ctrl-Z / Ctrl-Shift-Z undo / redo · Esc deselect · Ctrl-wheel zoom. Drag empty space to draw.

const STYLES = `
  :host { display: block; font-family: var(--font-body, system-ui, sans-serif); color: var(--text, #222); }
  .bar { display: flex; flex-wrap: wrap; gap: 0.35rem 0.9rem; align-items: center; margin-bottom: 0.4rem; font-size: 0.85rem; }
  .bar button { font: inherit; cursor: pointer; padding: 0.15rem 0.6rem; border: 1px solid var(--outline, #999);
    border-radius: var(--radius-control, 999px); background: var(--surface, #fff); color: inherit; }
  .bar label { display: inline-flex; align-items: center; gap: 0.25rem; cursor: pointer; }
  .sw { width: 0.8rem; height: 0.8rem; border-radius: 2px; display: inline-block; }
  .scroll { overflow: auto; max-height: 78vh; border: 1px solid var(--outline, #999); background: var(--surface, #fff); outline: none; }
  .stage { position: relative; touch-action: none; user-select: none; }
  img { display: block; width: 100%; height: auto; pointer-events: none; -webkit-user-drag: none; }
  .layer { position: absolute; inset: 0; cursor: crosshair; }
  .box { position: absolute; box-sizing: border-box; min-width: 7px; min-height: 7px; border: 2px solid var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); cursor: move; }
  .box.pre { border-style: dashed; }
  .box.ign { border-color: #888; background: repeating-linear-gradient(45deg, #8884 0 4px, transparent 4px 8px); }
  .box.sel { border-width: 3px; box-shadow: 0 0 0 2px #fff9; }
  .tag { position: absolute; left: -2px; bottom: 100%; margin-bottom: 1px; padding: 0 0.3rem; font-size: 11px; line-height: 15px;
    background: var(--c); color: #fff; white-space: nowrap; pointer-events: none; border-radius: 2px; }
  .h { position: absolute; width: 9px; height: 9px; background: #fff; border: 2px solid var(--c); box-sizing: border-box; }
  .draft { position: absolute; border: 2px dashed #111; background: #1112; pointer-events: none; }
`;

let sheet = null;
try {
  sheet = new CSSStyleSheet(); // constructable: needs no inline <style>, so no CSP nonce
  sheet.replaceSync(STYLES);
} catch (_) {
  sheet = null;
}

const COLORS = {
  "lead-staff": "#2f6fe0",
  "accompaniment-staff": "#7a4fd6",
  "drum-staff": "#d6704f",
  "chord-band": "#12a150",
  "title": "#a12fd0",
  "rehearsal-mark": "#c28a00",
  "tempo": "#0f8f9a",
  "footer": "#7b7b7b",
  "other": "#555555",
  "barline": "#e0533a",
};
const colorOf = (kind) => COLORS[kind] || "#444";
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const MIN = 0.002; // a drawn box smaller than this (in either axis) was a click, not a box
const HANDLES = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };

export default class RegionEditor extends HTMLElement {
  #boxes = [];
  #sel = "";
  #kinds = [];
  #newKind = "lead-staff";
  #alt = "";
  #hidden = new Set();
  #zoom = 1;
  #undo = [];
  #redo = [];
  #drag = null;
  #root; #bar; #scroll; #stage; #img; #layer;

  constructor() {
    super();
    const root = (this.#root = this.attachShadow({ mode: "open" }));
    if (sheet) root.adoptedStyleSheets = [sheet];
    this.#bar = document.createElement("div");
    this.#bar.className = "bar";
    this.#scroll = document.createElement("div");
    this.#scroll.className = "scroll";
    this.#scroll.tabIndex = 0;
    this.#stage = document.createElement("div");
    this.#stage.className = "stage";
    this.#img = document.createElement("img");
    this.#layer = document.createElement("div");
    this.#layer.className = "layer";
    this.#stage.append(this.#img, this.#layer);
    this.#scroll.append(this.#stage);
    root.append(this.#bar, this.#scroll);

    this.#layer.addEventListener("pointerdown", (e) => this.#down(e));
    this.#layer.addEventListener("pointermove", (e) => this.#move(e));
    this.#layer.addEventListener("pointerup", (e) => this.#up(e));
    this.#layer.addEventListener("pointercancel", (e) => this.#up(e, true));
    this.#scroll.addEventListener("keydown", (e) => this.#key(e));
    this.#scroll.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.#setZoom(this.#zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      },
      { passive: false },
    );
  }

  // --- props ---
  set src(v) { const s = String(v ?? ""); if (this.#img.getAttribute("src") !== s) this.#img.src = s; }
  get src() { return this.#img.getAttribute("src") || ""; }
  set alt(v) { this.#alt = String(v ?? ""); this.#img.alt = this.#alt; }
  get alt() { return this.#alt; }
  set kinds(v) { this.#kinds = Array.isArray(v) ? v.map(String) : []; this.#renderBar(); }
  get kinds() { return this.#kinds; }
  set newKind(v) { this.#newKind = String(v || "lead-staff"); }
  get newKind() { return this.#newKind; }
  set selected(v) {
    const s = String(v ?? "");
    if (s === this.#sel) return;
    this.#sel = s;
    this.#render();
  }
  get selected() { return this.#sel; }
  set boxes(v) {
    const next = Array.isArray(v) ? v.map((b) => ({ ...b })) : [];
    if (JSON.stringify(next) === JSON.stringify(this.#boxes)) return; // the echo of our own `change`
    // A different list from Python (a kind picker, a new page): undoable, but never re-emitted.
    this.#undo.push(this.#boxes);
    this.#redo = [];
    this.#boxes = next;
    if (!next.some((b) => b.id === this.#sel)) this.#sel = "";
    this.#render();
  }
  get boxes() { return this.#boxes.map((b) => ({ ...b })); }

  connectedCallback() {
    if (!sheet && !this.#root.querySelector("style")) {
      const style = document.createElement("style");
      style.setAttribute("nonce", this.cspNonce || "");
      style.textContent = STYLES;
      this.#root.prepend(style);
    }
    this.#renderBar();
    this.#render();
  }

  // --- view ---
  #setZoom(z) {
    this.#zoom = Math.max(1, Math.min(8, z));
    this.#stage.style.width = this.#zoom === 1 ? "100%" : `${this.#zoom * 100}%`;
  }

  #renderBar() {
    const bar = this.#bar;
    bar.replaceChildren();
    const btn = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", fn);
      bar.append(b);
    };
    btn("−", () => this.#setZoom(this.#zoom / 1.3));
    btn("+", () => this.#setZoom(this.#zoom * 1.3));
    btn("fit", () => this.#setZoom(1));
    for (const kind of this.#kinds) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !this.#hidden.has(kind);
      cb.addEventListener("change", () => {
        if (cb.checked) this.#hidden.delete(kind); else this.#hidden.add(kind);
        this.#render();
      });
      const sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = colorOf(kind);
      label.append(cb, sw, document.createTextNode(kind));
      bar.append(label);
    }
  }

  #render() {
    const layer = this.#layer;
    layer.replaceChildren();
    for (const b of this.#boxes) {
      if (this.#hidden.has(b.kind)) continue;
      const el = document.createElement("div");
      el.className = "box" + (b.status === "pre-labelled" ? " pre" : "") + (b.status === "ignore" ? " ign" : "") + (b.id === this.#sel ? " sel" : "");
      el.dataset.id = b.id;
      el.style.setProperty("--c", colorOf(b.kind));
      this.#place(el, b);
      if (b.id === this.#sel || (b.kind !== "barline" && b.w > 0.04)) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = b.id === this.#sel ? `${b.kind} · ${b.status}` : b.kind;
        el.append(tag);
      }
      if (b.id === this.#sel) {
        for (const [name, [fx, fy]] of Object.entries(HANDLES)) {
          const h = document.createElement("span");
          h.className = "h";
          h.dataset.handle = name;
          h.style.left = `calc(${fx * 100}% - 6px)`;
          h.style.top = `calc(${fy * 100}% - 6px)`;
          h.style.cursor = `${name}-resize`;
          el.append(h);
        }
      }
      layer.append(el);
    }
  }

  #place(el, b) {
    el.style.left = `${b.x * 100}%`;
    el.style.top = `${b.y * 100}%`;
    el.style.width = `${b.w * 100}%`;
    el.style.height = `${b.h * 100}%`;
  }

  // --- edits ---
  #commit(next, selected = this.#sel) {
    this.#undo.push(this.#boxes);
    this.#redo = [];
    this.#boxes = next;
    this.#emit(selected);
  }

  #emit(selected) {
    const selChanged = selected !== this.#sel;
    this.#sel = selected;
    this.#render();
    this.dispatchEvent(new CustomEvent("change", { detail: { value: this.boxes } }));
    if (selChanged) this.dispatchEvent(new CustomEvent("select", { detail: { value: this.#sel } }));
  }

  #select(id) {
    if (id === this.#sel) return;
    this.#sel = id;
    this.#render();
    this.dispatchEvent(new CustomEvent("select", { detail: { value: id } }));
  }

  #pt(e) {
    const r = this.#layer.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }

  #down(e) {
    if (e.button !== 0) return;
    this.#scroll.focus({ preventScroll: true });
    const p = this.#pt(e);
    const handle = e.target.dataset?.handle;
    const boxEl = e.target.closest?.(".box");
    this.#layer.setPointerCapture(e.pointerId);
    if (boxEl) {
      const id = boxEl.dataset.id;
      this.#select(id);
      const b = this.#boxes.find((x) => x.id === id);
      this.#drag = { mode: handle ? "resize" : "move", handle, id, start: p, orig: { ...b }, moved: false, el: this.#layer.querySelector(`[data-id="${CSS_escape(id)}"]`) };
    } else {
      this.#drag = { mode: "draw", start: p, cur: p, draft: null };
    }
  }

  #move(e) {
    const d = this.#drag;
    if (!d) return;
    const p = this.#pt(e);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    if (d.mode === "draw") {
      d.cur = p;
      if (!d.draft) {
        d.draft = document.createElement("div");
        d.draft.className = "draft";
        this.#layer.append(d.draft);
      }
      Object.assign(d.draft.style, { left: `${Math.min(d.start.x, p.x) * 100}%`, top: `${Math.min(d.start.y, p.y) * 100}%`, width: `${Math.abs(p.x - d.start.x) * 100}%`, height: `${Math.abs(p.y - d.start.y) * 100}%` });
      return;
    }
    const o = d.orig;
    let { x, y, w, h } = o;
    if (d.mode === "move") {
      x = Math.max(0, Math.min(1 - o.w, o.x + dx));
      y = Math.max(0, Math.min(1 - o.h, o.y + dy));
    } else {
      let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
      if (d.handle.includes("w")) x1 = clamp01(o.x + dx);
      if (d.handle.includes("e")) x2 = clamp01(o.x + o.w + dx);
      if (d.handle.includes("n")) y1 = clamp01(o.y + dy);
      if (d.handle.includes("s")) y2 = clamp01(o.y + o.h + dy);
      x = Math.min(x1, x2); w = Math.abs(x2 - x1);
      y = Math.min(y1, y2); h = Math.abs(y2 - y1);
    }
    d.moved = d.moved || Math.abs(dx) > 0.0005 || Math.abs(dy) > 0.0005;
    d.live = { x, y, w, h };
    if (d.el) this.#place(d.el, d.live);
  }

  #up(e, cancelled = false) {
    const d = this.#drag;
    this.#drag = null;
    if (!d) return;
    try { this.#layer.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    if (cancelled) { this.#render(); return; }
    if (d.mode === "draw") {
      d.draft?.remove();
      const w = Math.abs(d.cur.x - d.start.x);
      const h = Math.abs(d.cur.y - d.start.y);
      if (w < MIN || h < MIN) { this.#select(""); return; }
      const id = "h" + (crypto.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10));
      const box = { id, kind: this.#newKind, status: "structure-only", x: Math.min(d.start.x, d.cur.x), y: Math.min(d.start.y, d.cur.y), w, h };
      this.#commit([...this.#boxes, box], id);
      return;
    }
    if (!d.moved || !d.live) { this.#render(); return; }
    this.#commit(this.#boxes.map((b) => (b.id === d.id ? { ...b, ...d.live } : b)));
  }

  #key(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? this.#step(this.#redo, this.#undo) : this.#step(this.#undo, this.#redo);
      return;
    }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); this.#step(this.#redo, this.#undo); return; }
    if (e.key === "Escape") { this.#select(""); return; }
    const b = this.#boxes.find((x) => x.id === this.#sel);
    if (!b) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.#commit(this.#boxes.filter((x) => x.id !== b.id), "");
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (arrows) {
      e.preventDefault();
      const px = (e.shiftKey ? 10 : 1) / (this.#img.naturalWidth || 1000);
      const py = (e.shiftKey ? 10 : 1) / (this.#img.naturalHeight || 1400);
      const nx = Math.max(0, Math.min(1 - b.w, b.x + arrows[0] * px));
      const ny = Math.max(0, Math.min(1 - b.h, b.y + arrows[1] * py));
      this.#commit(this.#boxes.map((x) => (x.id === b.id ? { ...x, x: nx, y: ny } : x)));
    }
  }

  #step(from, to) {
    if (!from.length) return;
    to.push(this.#boxes);
    this.#boxes = from.pop();
    if (!this.#boxes.some((b) => b.id === this.#sel)) this.#sel = "";
    this.#render();
    this.dispatchEvent(new CustomEvent("change", { detail: { value: this.boxes } }));
    this.dispatchEvent(new CustomEvent("select", { detail: { value: this.#sel } }));
  }
}

// An id like "r12" or "h3fa9c1d2" is selector-safe; escape anyway rather than trust it.
function CSS_escape(s) {
  return CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, "\\$&");
}
