// The labelling studio's workbench (ADR-0036, SIB2-126): one full-viewport screen — app bar, page
// canvas with drag/resize/draw editing, and a side sheet with the region inspector and review list.
// An indah ES-module custom component (indah ADR-0039): indah's own ImageOverlay is display-only.
//
// Design: the Claude artifact "Labelling studio workbench" (FvVtSayCX5jUdRkkFnZWMR). Material 3
// roles come from the app Theme (m3_theme.py) as indah tokens (--bg, --surface, --primary ...) and
// `--x-*` extras; every value has a fallback so the component still draws without them. Kind is a
// colour AND a name; review status is a PATTERN (dashed = unreviewed, solid = reviewed, hatched =
// ignore), never hue alone.
//
// Props:  src (data: URI of the transient page raster) · boxes ([{id, kind, status, x, y, w, h,
//   system?}], x/y/w/h FRACTIONS of the page) · selected (id) · kinds · statuses · info ({file, pdfs,
//   page, count, state, dirty, busy, empty}) · toast ({id, text, action?: {label, value}}) · alt.
// Events: change {value: boxes} · select {value: id} · commit · nav {pdf?, page?, mode} ·
//   confirm-all · reset · action {value}.
// All text is set with textContent: a prop is data, not markup.

const STYLES = `
  :host { position: fixed; inset: 0; z-index: 50; display: block; color: var(--text, #1b1b1f); background: var(--bg, #fefbff);
    font-family: var(--font-body, system-ui, sans-serif); font-size: 14px; line-height: 20px;
    --s-low: var(--surface, #f5f3f7); --s-cont: var(--surface-2, #efedf1); --s-high: var(--x-high, #eae7ec); --s-top: var(--surface-3, #e4e1e6);
    --on-sv: var(--muted, #45464f); --ol: var(--outline, #767680); --ov: var(--outline-soft, #c6c5d0); --sv: var(--x-sv, #e2e1ec);
    --pri: var(--primary, #3d58b4); --on-pri: var(--on-primary, #fff);
    --sec-c: var(--secondary-container, #dee1f9); --on-sec-c: var(--on-secondary-container, #161b2c);
    --danger: var(--err, #ba1a1a);
    --inv: var(--x-inv, #303034); --on-inv: var(--x-on-inv, #f2f0f4); --inv-pri: var(--x-inv-primary, #b6c4ff);
    --canvas: var(--x-canvas, #dcd9e0); --paper: var(--x-paper, #fff);
    --mono: ui-monospace, "IBM Plex Mono", SFMono-Regular, Menlo, monospace; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:focus-visible, .scroll:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--pri); outline-offset: 2px; }
  .wb { height: 100%; display: flex; flex-direction: column; }

  /* state layers: 8% hover, 12% focus / press (M3) */
  .btn { position: relative; border: 0; background: transparent; }
  .btn::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: currentColor; opacity: 0; pointer-events: none; }
  .btn:hover::after { opacity: .08; } .btn:focus-visible::after, .btn:active::after { opacity: .12; }
  .btn[disabled] { opacity: .38; cursor: default; } .btn[disabled]::after { display: none; }
  .icon { width: 40px; height: 40px; border-radius: 50%; display: inline-grid; place-items: center; color: var(--on-sv); flex: none; }
  .icon svg { width: 20px; height: 20px; }

  .bar { flex: none; height: 56px; display: flex; align-items: center; gap: 8px; padding: 0 16px 0 20px; background: var(--s-cont); border-bottom: 1px solid var(--ov); }
  .file { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 8px 0 4px; border-radius: 8px; font-size: 16px; font-weight: 600; max-width: 40ch; }
  .file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--pri); flex: none; }
  .pager { display: flex; align-items: center; gap: 2px; margin-left: 8px; }
  .pager .n { min-width: 88px; text-align: center; }
  .chip { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px 0 8px; border: 1px solid var(--ol); border-radius: 8px; font-size: 13px; font-weight: 500; }
  .ring { width: 14px; height: 14px; border-radius: 50%; border: 2px dashed var(--pri); }
  .ring.done { border-style: solid; }
  .quiet { font-size: 13px; color: var(--on-sv); }
  .spacer { flex: 1; }
  .filled { height: 40px; padding: 0 24px; border-radius: 20px; background: var(--pri); color: var(--on-pri); font-size: 14px; font-weight: 500; display: inline-flex; align-items: center; gap: 8px; }
  .keycap { font-family: var(--mono); font-size: 11px; padding: 0 4px; border: 1px solid currentColor; border-radius: 4px; opacity: .8; line-height: 16px; }
  .tonal { height: 40px; padding: 0 20px; border-radius: 20px; background: var(--sec-c); color: var(--on-sec-c); font-weight: 500; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
  .text { height: 40px; padding: 0 16px; border-radius: 20px; font-weight: 500; color: var(--pri); }
  .text.danger { color: var(--danger); }

  .progress { position: relative; flex: none; height: 3px; background: transparent; overflow: hidden; }
  .progress.on { background: var(--sv); }
  .progress.on::after { content: ""; position: absolute; top: 0; bottom: 0; width: 40%; background: var(--pri); animation: slide 1.1s ease-in-out infinite; }
  @keyframes slide { from { left: -40%; } to { left: 100%; } }
  @media (prefers-reduced-motion: reduce) { .progress.on::after { animation: none; width: 100%; opacity: .5; } }

  .body { flex: 1; min-height: 0; display: flex; }
  .canvas { position: relative; flex: 1; min-width: 0; background: var(--canvas); overflow: hidden; }
  .scroll { position: absolute; inset: 0; overflow: auto; padding: 24px; outline-offset: -2px; }
  .stage { position: relative; margin: 0 auto; background: var(--paper); box-shadow: 0 1px 3px rgba(0,0,0,.28), 0 4px 14px rgba(0,0,0,.14); touch-action: none; user-select: none; }
  .stage img { display: block; width: 100%; height: auto; pointer-events: none; -webkit-user-drag: none; }
  .layer { position: absolute; inset: 0; cursor: crosshair; }
  .scroll.busy .stage { opacity: .5; }
  .empty { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; padding: 24px; color: var(--on-sv); }

  .box { position: absolute; border: 2px dashed var(--c); background: color-mix(in srgb, var(--c) 11%, transparent); min-width: 7px; min-height: 7px; cursor: move; }
  .box.thin { border-width: 1.5px; }
  .box.ok { border-style: solid; background: color-mix(in srgb, var(--c) 7%, transparent); }
  .box.ign { border-style: solid; border-color: var(--ol); background: repeating-linear-gradient(45deg, rgba(120,120,130,.4) 0 4px, transparent 4px 8px); }
  .box.sel { border-width: 3px; box-shadow: 0 0 0 2px rgba(255,255,255,.85); z-index: 2; }
  .tag { position: absolute; left: -3px; bottom: calc(100% + 2px); height: 20px; padding: 0 8px; border-radius: 4px; background: var(--c); color: var(--on-pri); font-size: 12px; font-weight: 500; line-height: 20px; white-space: nowrap; pointer-events: none; }
  .h { position: absolute; width: 10px; height: 10px; background: #fff; border: 2px solid var(--c); }
  .draft { position: absolute; border: 2px dashed #111; background: #1112; pointer-events: none; }

  .toolbar { position: absolute; left: 20px; bottom: 20px; height: 48px; display: flex; align-items: center; gap: 4px; padding: 0 8px; border-radius: 24px; background: var(--s-high); box-shadow: 0 1px 2px rgba(0,0,0,.3), 0 2px 6px 2px rgba(0,0,0,.15); font-size: 13px; }
  .toolbar .icon { width: 36px; height: 36px; }
  .toolbar .zoom { min-width: 48px; text-align: center; font-weight: 500; }
  .toolbar .sep { width: 1px; height: 24px; background: var(--ov); margin: 0 4px; }
  .pill { height: 32px; padding: 0 12px; border-radius: 16px; font-size: 13px; font-weight: 500; color: var(--on-sv); }
  .pill.on { background: var(--sec-c); color: var(--on-sec-c); }
  .select { height: 32px; padding: 0 8px 0 8px; border: 1px solid var(--ol); border-radius: 8px; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; }
  .sw { width: 10px; height: 10px; border-radius: 2px; background: var(--c); flex: none; }
  .hints { position: absolute; right: 20px; bottom: 24px; height: 32px; display: flex; align-items: center; gap: 14px; padding: 0 14px; border-radius: 8px; background: var(--inv); color: var(--on-inv); font-size: 12px; opacity: .94; }
  kbd { font-family: var(--mono); font-size: 11px; padding: 1px 5px; border-radius: 4px; border: 1px solid rgba(128,128,140,.6); }

  .sheet { flex: none; width: clamp(300px, 25vw, 360px); display: flex; flex-direction: column; background: var(--s-low); border-left: 1px solid var(--ov); min-height: 0; }
  .insp { padding: 20px 20px 16px; border-bottom: 1px solid var(--ov); flex: none; }
  .row { display: flex; align-items: center; gap: 10px; }
  .title { font-size: 16px; font-weight: 600; }
  .mono { font-family: var(--mono); font-size: 12px; color: var(--on-sv); }
  .lbl { margin-top: 16px; font-size: 12px; font-weight: 500; color: var(--on-sv); }
  .chips { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; }
  .kchip { height: 32px; padding: 0 10px 0 6px; border: 1px solid var(--ol); border-radius: 8px; font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; }
  .kchip.on { background: var(--sec-c); color: var(--on-sec-c); border-color: transparent; }
  .kchip .k { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 4px; background: var(--sv); color: var(--on-sv); font-family: var(--mono); font-size: 11px; }
  .seg { margin-top: 8px; display: flex; height: 40px; border: 1px solid var(--ol); border-radius: 20px; overflow: hidden; font-size: 13px; font-weight: 500; }
  .seg button { flex: 1; }
  .seg button + button { border-left: 1px solid var(--ol); }
  .seg button.on { background: var(--sec-c); color: var(--on-sec-c); }
  .actions { margin-top: 16px; display: flex; gap: 8px; }
  .actions .tonal { flex: 1; }
  .listhead { flex: none; padding: 16px 20px 8px; }
  .meter { margin-top: 8px; height: 4px; border-radius: 2px; background: var(--sv); overflow: hidden; }
  .meter div { height: 100%; background: var(--pri); }
  .list { flex: 1; min-height: 0; overflow: auto; padding: 0 8px 8px; }
  .gh { height: 32px; display: flex; align-items: flex-end; padding: 0 12px 4px; font-size: 11px; font-weight: 600; letter-spacing: .04em; color: var(--on-sv); }
  .li { width: 100%; height: 36px; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-radius: 8px; text-align: left; }
  .li.on { background: var(--sec-c); color: var(--on-sec-c); }
  .li .nm { flex: 1; font-size: 14px; }
  .li svg { width: 18px; height: 18px; flex: none; }

  .snack { position: absolute; left: 50%; bottom: 92px; transform: translateX(-50%); min-width: 344px; max-width: 80%; min-height: 48px; display: flex; align-items: center; gap: 16px; padding: 4px 8px 4px 16px; border-radius: 4px; background: var(--inv); color: var(--on-inv); box-shadow: 0 3px 8px rgba(0,0,0,.3); }
  .snack .grow { flex: 1; }
  .snack .act { height: 36px; padding: 0 12px; border-radius: 18px; color: var(--inv-pri); font-weight: 500; }

  .menu { position: fixed; z-index: 70; min-width: 200px; max-height: 60vh; overflow: auto; padding: 8px 0; border-radius: 4px; background: var(--s-high); box-shadow: 0 2px 6px 2px rgba(0,0,0,.2), 0 1px 2px rgba(0,0,0,.3); }
  .menu button { width: 100%; height: 40px; padding: 0 16px; display: flex; align-items: center; gap: 12px; text-align: left; }
  .scrim { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.32); display: grid; place-items: center; }
  .dialog { width: min(560px, calc(100vw - 48px)); max-height: 80vh; overflow: auto; padding: 24px; border-radius: 28px; background: var(--s-high); }
  .dialog h2 { margin: 0 0 16px; font-size: 24px; line-height: 32px; font-weight: 400; }
  .dialog p { margin: 0 0 24px; color: var(--on-sv); }
  .dialog .acts { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
  .keys { margin: 0 0 24px; border: 1px solid var(--ov); border-radius: 12px; overflow: hidden; }
  .keys div { display: flex; gap: 14px; align-items: center; padding: 8px 12px; }
  .keys div + div { border-top: 1px solid var(--ov); }
  .keys kbd { min-width: 120px; text-align: center; background: var(--sv); color: var(--on-sv); border: 0; padding: 2px 8px; }
  @media (max-width: 1100px) { .hints { display: none; } .file { max-width: 22ch; } }
`;

let sheet = null;
try { sheet = new CSSStyleSheet(); sheet.replaceSync(STYLES); } catch (_) { sheet = null; }

const KIND_FALLBACK = {
  "lead-staff": "#3d58b4", "accompaniment-staff": "#8a4fa3", "drum-staff": "#b3541e", "chord-band": "#1f7a5a",
  "title": "#7a6a00", "rehearsal-mark": "#a0691a", "tempo": "#0d7c8a", "footer": "#6b6b74", "other": "#4a4a52", "barline": "#b3261e",
};
const kindVar = (kind) => `var(--x-k-${kind}, ${KIND_FALLBACK[kind] || "#444"})`;
const KEYED = ["lead-staff", "chord-band", "barline", "title", "drum-staff", "accompaniment-staff"]; // keys 1-6
const STATUS_SEG = [["structure-only", "Confirmed"], ["partial", "Partial"], ["transcribed", "Transcribed"], ["ignore", "Ignore"]];
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const MIN = 0.002;
const HANDLES = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };

const svg = (d, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const ICON = {
  left: svg('<path d="M15 6l-6 6 6 6"/>'), right: svg('<path d="M9 6l6 6-6 6"/>'),
  minus: svg('<path d="M5 12h14"/>'), plus: svg('<path d="M12 5v14M5 12h14"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1-1.5 2M12 17h.01"/>'),
  more: svg('<path d="M12 6h.01M12 12h.01M12 18h.01" stroke-width="3"/>'), down: svg('<path d="M7 10l5 5 5-5"/>'),
  staff: svg('<path d="M3 7h18M3 11h18M3 15h18M3 19h18M3 5v16"/>'),
  ok: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/>', 'stroke="var(--pri)" stroke-width="2.2" role="img" aria-label="reviewed"'),
  un: svg('<circle cx="12" cy="12" r="9"/>', 'stroke-dasharray="3 3" stroke="var(--ol)" role="img" aria-label="unreviewed"'),
  ign: svg('<circle cx="12" cy="12" r="9"/><path d="M6 18L18 6"/>', 'stroke="var(--ol)" role="img" aria-label="ignored"'),
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function iconButton(name, label, fn) {
  const b = el("button", "btn icon");
  b.type = "button"; b.setAttribute("aria-label", label); b.innerHTML = ICON[name]; // static markup, no data
  b.addEventListener("click", fn);
  return b;
}
function button(cls, text, fn) {
  const b = el("button", "btn " + cls, text);
  b.type = "button"; b.addEventListener("click", fn);
  return b;
}

export default class Workbench extends HTMLElement {
  #boxes = []; #sel = ""; #kinds = []; #info = {}; #toast = null; #alt = "";
  #hidden = new Set(); #drawKind = "lead-staff";
  #fit = "width"; #customWidth = 0;
  #undo = []; #redo = []; #drag = null; #shownToast = 0; #toastTimer = 0;
  #root; #bar; #canvas; #scroll; #stage; #img; #layer; #toolbar; #hints; #snack; #sheet; #overlay; #progress; #empty; #ro;

  constructor() {
    super();
    const root = (this.#root = this.attachShadow({ mode: "open" }));
    if (sheet) root.adoptedStyleSheets = [sheet];
    const wb = el("div", "wb");
    this.#bar = el("header", "bar");
    this.#progress = el("div", "progress");
    const body = el("div", "body");
    this.#canvas = el("main", "canvas");
    this.#scroll = el("div", "scroll"); this.#scroll.tabIndex = 0;
    this.#stage = el("div", "stage");
    this.#img = el("img"); this.#img.addEventListener("load", () => this.#layout());
    this.#layer = el("div", "layer");
    this.#stage.append(this.#img, this.#layer);
    this.#scroll.append(this.#stage);
    this.#empty = el("div", "empty"); this.#empty.hidden = true;
    this.#toolbar = el("div", "toolbar");
    this.#hints = el("div", "hints");
    this.#snack = el("div", "snack"); this.#snack.hidden = true;
    this.#canvas.append(this.#scroll, this.#empty, this.#toolbar, this.#hints, this.#snack);
    this.#sheet = el("aside", "sheet");
    body.append(this.#canvas, this.#sheet);
    this.#overlay = el("div"); // menus and dialogs
    wb.append(this.#bar, this.#progress, body);
    root.append(wb, this.#overlay);

    this.#layer.addEventListener("pointerdown", (e) => this.#down(e));
    this.#layer.addEventListener("pointermove", (e) => this.#move(e));
    this.#layer.addEventListener("pointerup", (e) => this.#up(e));
    this.#layer.addEventListener("pointercancel", (e) => this.#up(e, true));
    this.#scroll.addEventListener("keydown", (e) => this.#key(e));
    this.#scroll.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.#zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    this.#ro = new ResizeObserver(() => this.#layout());
    document.addEventListener("keydown", (e) => this.#globalKey(e));
  }

  // --- props ---
  set src(v) { const s = String(v ?? ""); if (this.#img.getAttribute("src") !== s) { if (s) this.#img.src = s; else this.#img.removeAttribute("src"); } }
  get src() { return this.#img.getAttribute("src") || ""; }
  set alt(v) { this.#alt = String(v ?? ""); this.#img.alt = this.#alt; }
  get alt() { return this.#alt; }
  set kinds(v) { this.#kinds = Array.isArray(v) ? v.map(String) : []; if (this.isConnected) this.#renderSheet(); }
  get kinds() { return this.#kinds; }
  set statuses(_v) { /* the status vocabulary is fixed in the segmented control */ }
  get statuses() { return []; }
  set info(v) { this.#info = v && typeof v === "object" ? v : {}; if (this.isConnected) this.#renderChrome(); }
  get info() { return this.#info; }
  set toast(v) { this.#toast = v && v.id ? v : null; this.#showToast(); }
  get toast() { return this.#toast; }
  set selected(v) { const s = String(v ?? ""); if (s === this.#sel) return; this.#sel = s; this.#renderAll(); }
  get selected() { return this.#sel; }
  set boxes(v) {
    const next = Array.isArray(v) ? v.map((b) => ({ ...b })) : [];
    if (JSON.stringify(next) === JSON.stringify(this.#boxes)) return; // the echo of our own `change`
    this.#undo.push(this.#boxes); this.#redo = [];
    this.#boxes = next;
    if (!next.some((b) => b.id === this.#sel)) this.#sel = "";
    this.#renderAll();
  }
  get boxes() { return this.#boxes.map((b) => ({ ...b })); }

  connectedCallback() {
    if (!sheet && !this.#root.querySelector("style")) {
      const style = document.createElement("style");
      style.setAttribute("nonce", this.cspNonce || ""); style.textContent = STYLES;
      this.#root.prepend(style);
    }
    this.#ro.observe(this.#scroll);
    this.#renderAll(); this.#renderHints();
  }
  disconnectedCallback() { this.#ro.disconnect(); }

  // --- derived ---
  // Reading order: system by system (chord band, staff, then barlines left to right), then anything
  // the person drew, top to bottom. The engine's own float noise must not put a barline before its staff.
  #ordered() {
    const rank = { "chord-band": 0, "lead-staff": 1, "accompaniment-staff": 1, "drum-staff": 1, "barline": 3 };
    const sys = (b) => (b.system == null ? 1e9 : b.system);
    return [...this.#boxes].sort((a, b) => sys(a) - sys(b) || (sys(a) === 1e9 ? a.y - b.y || a.x - b.x : (rank[a.kind] ?? 2) - (rank[b.kind] ?? 2) || a.x - b.x || a.y - b.y));
  }
  #unreviewed() { return this.#ordered().filter((b) => b.status === "pre-labelled"); }
  #selBox() { return this.#boxes.find((b) => b.id === this.#sel); }

  // --- rendering ---
  #renderAll() { this.#renderChrome(); this.#renderLayer(); this.#renderSheet(); }

  #renderChrome() {
    const i = this.#info, bar = this.#bar;
    this.#progress.className = "progress" + (i.busy ? " on" : "");
    this.#scroll.classList.toggle("busy", !!i.busy);
    bar.replaceChildren();
    const file = button("file", "", (e) => this.#fileMenu(e.currentTarget));
    file.innerHTML = ICON.staff;
    file.firstChild.style.cssText = "width:22px;height:22px;color:var(--pri);flex:none";
    file.append(el("span", "", i.file || "No PDF"), (() => { const d = el("span"); d.innerHTML = ICON.down; d.firstChild.style.cssText = "width:18px;height:18px"; return d; })());
    file.setAttribute("aria-haspopup", "menu"); file.title = "Switch PDF";
    bar.append(file);
    if (i.dirty) { const d = el("span", "dot"); d.title = "Uncommitted changes"; d.setAttribute("role", "img"); d.setAttribute("aria-label", "Uncommitted changes"); bar.append(d); }
    const pager = el("div", "pager");
    const prev = iconButton("left", "Previous page", () => this.#navigate({ delta: -1 }));
    const next = iconButton("right", "Next page", () => this.#navigate({ delta: 1 }));
    prev.disabled = !(i.page > 1) || !!i.busy; next.disabled = !(i.page < i.count) || !!i.busy;
    pager.append(prev, el("span", "n", i.count ? `Page ${i.page} of ${i.count}` : "No page"), next);
    bar.append(pager);
    const chip = el("span", "chip"); const ring = el("span", "ring" + (i.state === "corrected" ? " done" : ""));
    chip.append(ring, el("span", "", i.state ? i.state[0].toUpperCase() + i.state.slice(1) : "—"));
    bar.append(chip);
    const total = this.#boxes.length, rev = this.#boxes.filter((b) => b.status !== "pre-labelled").length;
    bar.append(el("span", "quiet", total ? `${rev} of ${total} reviewed` : "no regions"));
    bar.append(el("span", "spacer"));
    bar.append(iconButton("help", "Keyboard shortcuts", () => this.#shortcuts()));
    const more = iconButton("more", "More actions", (e) => this.#moreMenu(e.currentTarget));
    more.setAttribute("aria-haspopup", "menu"); bar.append(more);
    const commit = button("filled", "Commit page ", () => this.#emit("commit"));
    commit.append(el("span", "keycap", "Ctrl S")); commit.disabled = !!i.busy || !i.count;
    bar.append(commit);

    const none = !this.#img.getAttribute("src");
    this.#empty.hidden = !none;
    this.#empty.textContent = none ? (i.empty || (i.busy ? "Opening the page…" : "Open a PDF to start.")) : "";
    this.#stage.hidden = none;
    this.#renderToolbar();
  }

  #renderToolbar() {
    const t = this.#toolbar; t.replaceChildren();
    const width = this.#stageWidth(), nat = this.#img.naturalWidth || 1;
    t.append(iconButton("minus", "Zoom out", () => this.#zoomBy(1 / 1.25)));
    t.append(el("span", "zoom", `${Math.round((width / nat) * 100)}%`));
    t.append(iconButton("plus", "Zoom in", () => this.#zoomBy(1.25)));
    t.append(el("span", "sep"));
    const fw = button("pill" + (this.#fit === "width" ? " on" : ""), "Fit width", () => this.#setFit("width"));
    const fp = button("pill" + (this.#fit === "page" ? " on" : ""), "Fit page", () => this.#setFit("page"));
    t.append(fw, fp, el("span", "sep"), el("span", "quiet", "Draw as"));
    const sel = button("select", "", (e) => this.#kindMenu(e.currentTarget, (k) => { this.#drawKind = k; this.#renderToolbar(); }));
    const sw = el("span", "sw"); sw.style.setProperty("--c", kindVar(this.#drawKind));
    sel.append(sw, el("span", "", this.#drawKind)); const d = el("span"); d.innerHTML = ICON.down; d.firstChild.style.cssText = "width:16px;height:16px"; sel.append(d);
    t.append(sel);
  }

  #renderHints() {
    const h = this.#hints; h.replaceChildren();
    const item = (keys, text) => { const s = el("span"); keys.forEach((k, n) => { if (n) s.append("–"); s.append(el("kbd", "", k)); }); s.append(" " + text); return s; };
    h.append(item(["Tab"], "next unreviewed"), item(["Enter"], "confirm"), item(["1", "6"], "kind"), item(["Del"], "remove"));
  }

  #renderLayer() {
    const layer = this.#layer;
    layer.replaceChildren();
    for (const b of this.#boxes) {
      if (this.#hidden.has(b.kind)) continue;
      const e = el("div", "box" + (b.kind === "barline" ? " thin" : "") + (b.status === "ignore" ? " ign" : b.status === "pre-labelled" ? "" : " ok") + (b.id === this.#sel ? " sel" : ""));
      e.dataset.id = b.id;
      e.style.setProperty("--c", kindVar(b.kind));
      this.#place(e, b);
      e.title = `${b.kind} · ${b.status === "pre-labelled" ? "unreviewed" : b.status}`;
      if (b.id === this.#sel) {
        e.append(el("span", "tag", `${b.kind} · ${b.status === "pre-labelled" ? "unreviewed" : b.status}`));
        for (const [name, [fx, fy]] of Object.entries(HANDLES)) {
          const h = el("span", "h"); h.dataset.handle = name;
          h.style.left = `calc(${fx * 100}% - 6px)`; h.style.top = `calc(${fy * 100}% - 6px)`; h.style.cursor = `${name}-resize`;
          e.append(h);
        }
      }
      layer.append(e);
    }
  }
  #place(e, b) { e.style.left = `${b.x * 100}%`; e.style.top = `${b.y * 100}%`; e.style.width = `${b.w * 100}%`; e.style.height = `${b.h * 100}%`; }

  #renderSheet() {
    const sheetEl = this.#sheet; sheetEl.replaceChildren();
    const b = this.#selBox();
    const insp = el("section", "insp");
    if (b) {
      const r1 = el("div", "row"); const sw = el("span", "sw"); sw.style.setProperty("--c", kindVar(b.kind)); sw.style.cssText += ";width:12px;height:12px;border-radius:3px";
      r1.append(sw, el("span", "title", b.kind), el("span", "spacer"), el("span", "mono", b.system != null ? `${b.id} · system ${b.system + 1}` : b.id));
      insp.append(r1, Object.assign(el("div", "quiet"), { textContent: b.status === "pre-labelled" ? "Unreviewed. The engine drew it; nobody has checked it." : `Reviewed · ${b.status}` }));
      insp.append(el("div", "lbl", "Kind"));
      const chips = el("div", "chips");
      const shown = KEYED.filter((k) => this.#kinds.includes(k) || !this.#kinds.length);
      if (!shown.includes(b.kind)) shown.push(b.kind);
      shown.forEach((k) => {
        const c = el("button", "btn kchip" + (k === b.kind ? " on" : "")); c.type = "button";
        const n = KEYED.indexOf(k); if (n >= 0) c.append(el("span", "k", String(n + 1)));
        const sw2 = el("span", "sw"); sw2.style.setProperty("--c", kindVar(k)); c.append(sw2, document.createTextNode(k));
        c.addEventListener("click", () => this.#setKind(k)); chips.append(c);
      });
      const more = button("kchip", "More…", (e) => this.#kindMenu(e.currentTarget, (k) => this.#setKind(k), true)); more.style.color = "var(--on-sv)";
      chips.append(more); insp.append(chips);
      insp.append(el("div", "lbl", "Status"));
      const seg = el("div", "seg"); seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Status");
      STATUS_SEG.forEach(([val, label]) => { const s = button(val === b.status ? "on" : "", label, () => this.#setStatus(val)); s.setAttribute("aria-pressed", String(val === b.status)); seg.append(s); });
      insp.append(seg);
      const acts = el("div", "actions");
      const conf = button("tonal", "Confirm region ", () => this.#confirmAndAdvance()); conf.append(el("span", "keycap", "Enter"));
      acts.append(conf, button("text danger", "Delete", () => this.#remove())); insp.append(acts);
    } else {
      insp.append(el("div", "title", this.#boxes.length ? "Nothing selected" : "No regions yet"));
      const un = this.#unreviewed().length;
      insp.append(Object.assign(el("div", "quiet"), { style: "margin-top:6px;font-size:14px;line-height:20px", textContent: !this.#boxes.length ? "Drag across the page to draw a region." : un ? `Click a region on the page, or press Tab to jump to the next of ${un} unreviewed. Drag across empty paper to draw one.` : "Every region on this page is reviewed. Commit the page, or fix anything that looks wrong." }));
      const acts = el("div", "actions");
      if (un) { const n = button("tonal", "Next unreviewed ", () => this.#jump(1)); n.append(el("span", "keycap", "Tab")); acts.append(n); }
      else if (this.#info.count && this.#info.page < this.#info.count) acts.append(button("tonal", "Next page", () => this.#navigate({ delta: 1 })));
      insp.append(acts);
    }
    sheetEl.append(insp);

    const head = el("div", "listhead");
    const rev = this.#boxes.filter((x) => x.status !== "pre-labelled").length, total = this.#boxes.length;
    const hr = el("div", "row"); hr.append(el("span", "", "Regions"), el("span", "spacer"), el("span", "quiet", `${rev} of ${total} reviewed`));
    hr.firstChild.style.cssText = "font-size:14px;font-weight:600";
    const meter = el("div", "meter"); const fill = el("div"); fill.style.width = total ? `${Math.round((100 * rev) / total)}%` : "0%"; meter.append(fill);
    head.append(hr, meter); sheetEl.append(head);

    const list = el("div", "list");
    const groups = new Map();
    for (const x of this.#ordered()) { const g = x.system == null ? -1 : x.system; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
    for (const g of [...groups.keys()].sort((a, c) => (a === -1) - (c === -1) || a - c)) {
      list.append(el("div", "gh", g === -1 ? "ADDED BY YOU" : `SYSTEM ${g + 1}`));
      for (const x of groups.get(g)) {
        const li = el("button", "btn li" + (x.id === this.#sel ? " on" : "")); li.type = "button"; li.dataset.row = x.id;
        const sw = el("span", "sw"); sw.style.setProperty("--c", kindVar(x.kind));
        const ic = el("span"); ic.innerHTML = x.status === "ignore" ? ICON.ign : x.status === "pre-labelled" ? ICON.un : ICON.ok;
        li.append(sw, el("span", "nm", x.kind), el("span", "mono", x.id), ic.firstChild);
        li.addEventListener("click", () => { this.#selectBox(x.id, true); this.#scroll.focus({ preventScroll: true }); });
        list.append(li);
      }
    }
    sheetEl.append(list);
  }

  // --- zoom / layout ---
  #stageWidth() {
    const s = this.#scroll, nat = this.#img.naturalWidth || 1, natH = this.#img.naturalHeight || 1.4;
    const availW = Math.max(200, s.clientWidth - 48), availH = Math.max(200, s.clientHeight - 48);
    if (this.#fit === "page") return Math.min(availW, availH * (nat / natH));
    if (this.#fit === "width") return availW;
    return this.#customWidth || availW;
  }
  #layout() { this.#stage.style.width = `${this.#stageWidth()}px`; this.#renderToolbar(); }
  #setFit(f) { this.#fit = f; this.#layout(); }
  #zoomBy(f) {
    const cur = this.#stageWidth(); this.#fit = "custom";
    this.#customWidth = Math.max(300, Math.min(cur * f, (this.#img.naturalWidth || 2000) * 3));
    this.#layout();
  }

  // --- selection / edits ---
  #emit(name, detail = {}) { this.dispatchEvent(new CustomEvent(name, { detail })); }
  #changed(selected = this.#sel) {
    const sc = selected !== this.#sel; this.#sel = selected;
    this.#renderAll();
    this.#emit("change", { value: this.boxes });
    if (sc) this.#emit("select", { value: this.#sel });
  }
  #commitBoxes(next, selected = this.#sel) { this.#undo.push(this.#boxes); this.#redo = []; this.#boxes = next; this.#changed(selected); }
  #selectBox(id, scroll = false) {
    if (id !== this.#sel) { this.#sel = id; this.#emit("select", { value: id }); }
    this.#renderAll();
    if (scroll && id) this.#reveal(id);
  }
  #reveal(id) {
    const b = this.#boxes.find((x) => x.id === id); if (!b) return;
    const r = this.#stage.getBoundingClientRect(), s = this.#scroll.getBoundingClientRect();
    const cx = r.left - s.left + this.#scroll.scrollLeft + (b.x + b.w / 2) * r.width;
    const cy = r.top - s.top + this.#scroll.scrollTop + (b.y + b.h / 2) * r.height;
    this.#scroll.scrollTo({ left: cx - s.width / 2, top: cy - s.height / 2, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  #setKind(k) { const b = this.#selBox(); if (b && b.kind !== k) this.#commitBoxes(this.#boxes.map((x) => (x.id === b.id ? { ...x, kind: k } : x))); }
  #setStatus(s) { const b = this.#selBox(); if (b && b.status !== s) this.#commitBoxes(this.#boxes.map((x) => (x.id === b.id ? { ...x, status: s } : x))); }
  #remove() { const b = this.#selBox(); if (b) this.#commitBoxes(this.#boxes.filter((x) => x.id !== b.id), ""); }
  #jump(dir) {
    const un = this.#unreviewed(); if (!un.length) return;
    const order = this.#ordered(); const cur = order.findIndex((x) => x.id === this.#sel);
    const cand = dir > 0 ? [...order.slice(cur + 1), ...order.slice(0, cur + 1)] : [...order.slice(0, Math.max(cur, 0)).reverse(), ...order.slice(Math.max(cur, 0)).reverse()];
    const next = cand.find((x) => x.status === "pre-labelled");
    if (next) this.#selectBox(next.id, true);
  }
  #confirmAndAdvance() {
    const b = this.#selBox(); if (!b) return;
    const order = this.#ordered(); const idx = order.findIndex((x) => x.id === b.id);
    const after = [...order.slice(idx + 1), ...order.slice(0, idx)].find((x) => x.status === "pre-labelled");
    const next = b.status === "pre-labelled" ? this.#boxes.map((x) => (x.id === b.id ? { ...x, status: "structure-only" } : x)) : this.#boxes;
    if (next !== this.#boxes) { this.#undo.push(this.#boxes); this.#redo = []; this.#boxes = next; this.#emit("change", { value: this.boxes }); }
    if (after) this.#selectBox(after.id, true); else { this.#selectBox(b.id); this.#renderAll(); }
  }

  // --- pointer ---
  #pt(e) { const r = this.#layer.getBoundingClientRect(); return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }; }
  #down(e) {
    if (e.button !== 0) return;
    this.#scroll.focus({ preventScroll: true });
    const p = this.#pt(e), handle = e.target.dataset?.handle, boxEl = e.target.closest?.(".box");
    this.#layer.setPointerCapture(e.pointerId);
    if (boxEl) {
      const id = boxEl.dataset.id; this.#selectBox(id);
      const b = this.#boxes.find((x) => x.id === id);
      this.#drag = { mode: handle ? "resize" : "move", handle, id, start: p, orig: { ...b }, moved: false, el: this.#layer.querySelector(`[data-id="${id.replace(/"/g, "")}"]`) };
    } else this.#drag = { mode: "draw", start: p, cur: p, draft: null };
  }
  #move(e) {
    const d = this.#drag; if (!d) return;
    const p = this.#pt(e), dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (d.mode === "draw") {
      d.cur = p;
      if (!d.draft) { d.draft = el("div", "draft"); this.#layer.append(d.draft); }
      Object.assign(d.draft.style, { left: `${Math.min(d.start.x, p.x) * 100}%`, top: `${Math.min(d.start.y, p.y) * 100}%`, width: `${Math.abs(p.x - d.start.x) * 100}%`, height: `${Math.abs(p.y - d.start.y) * 100}%` });
      return;
    }
    const o = d.orig; let { x, y, w, h } = o;
    if (d.mode === "move") { x = Math.max(0, Math.min(1 - o.w, o.x + dx)); y = Math.max(0, Math.min(1 - o.h, o.y + dy)); }
    else {
      let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
      if (d.handle.includes("w")) x1 = clamp01(o.x + dx);
      if (d.handle.includes("e")) x2 = clamp01(o.x + o.w + dx);
      if (d.handle.includes("n")) y1 = clamp01(o.y + dy);
      if (d.handle.includes("s")) y2 = clamp01(o.y + o.h + dy);
      x = Math.min(x1, x2); w = Math.abs(x2 - x1); y = Math.min(y1, y2); h = Math.abs(y2 - y1);
    }
    d.moved = d.moved || Math.abs(dx) > 0.0005 || Math.abs(dy) > 0.0005;
    d.live = { x, y, w, h };
    if (d.el) this.#place(d.el, d.live);
  }
  #up(e, cancelled = false) {
    const d = this.#drag; this.#drag = null; if (!d) return;
    try { this.#layer.releasePointerCapture(e.pointerId); } catch (_) { /* released */ }
    if (cancelled) { this.#renderLayer(); return; }
    if (d.mode === "draw") {
      d.draft?.remove();
      const w = Math.abs(d.cur.x - d.start.x), h = Math.abs(d.cur.y - d.start.y);
      if (w < MIN || h < MIN) { this.#selectBox(""); return; }
      const id = "h" + (crypto.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10));
      this.#commitBoxes([...this.#boxes, { id, kind: this.#drawKind, status: "structure-only", x: Math.min(d.start.x, d.cur.x), y: Math.min(d.start.y, d.cur.y), w, h }], id);
      return;
    }
    if (!d.moved || !d.live) { this.#renderLayer(); return; }
    this.#commitBoxes(this.#boxes.map((b) => (b.id === d.id ? { ...b, ...d.live } : b)));
  }

  // --- keyboard ---
  #globalKey(e) {
    if (e.key === "s" && (e.ctrlKey || e.metaKey) && this.isConnected) { e.preventDefault(); if (!this.#info.busy && this.#info.count) this.#emit("commit"); }
    if (e.key === "Escape") this.#closeOverlay();
  }
  #key(e) {
    const mod = e.ctrlKey || e.metaKey, k = e.key;
    if (mod && k.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.#step(this.#redo, this.#undo) : this.#step(this.#undo, this.#redo); return; }
    if (mod && k.toLowerCase() === "y") { e.preventDefault(); this.#step(this.#redo, this.#undo); return; }
    if (mod) return;
    if (k === "Tab") { if (this.#unreviewed().length) { e.preventDefault(); this.#jump(e.shiftKey ? -1 : 1); } return; }
    if (k === "?") { this.#shortcuts(); return; }
    if (k === "w" || k === "W") { this.#setFit("width"); return; }
    if (k === "f" || k === "F") { this.#setFit("page"); return; }
    if (k === "Escape") { this.#selectBox(""); return; }
    const b = this.#selBox(); if (!b) return;
    if (k === "Enter") { e.preventDefault(); this.#confirmAndAdvance(); return; }
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); this.#remove(); return; }
    if (/^[1-6]$/.test(k)) { const kind = KEYED[Number(k) - 1]; if (!this.#kinds.length || this.#kinds.includes(kind)) this.#setKind(kind); return; }
    const a = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k];
    if (a) {
      e.preventDefault();
      const px = (e.shiftKey ? 10 : 1) / (this.#img.naturalWidth || 1000), py = (e.shiftKey ? 10 : 1) / (this.#img.naturalHeight || 1400);
      this.#commitBoxes(this.#boxes.map((x) => (x.id === b.id ? { ...x, x: Math.max(0, Math.min(1 - b.w, b.x + a[0] * px)), y: Math.max(0, Math.min(1 - b.h, b.y + a[1] * py)) } : x)));
    }
  }
  #step(from, to) {
    if (!from.length) return;
    to.push(this.#boxes); this.#boxes = from.pop();
    if (!this.#boxes.some((b) => b.id === this.#sel)) this.#sel = "";
    this.#renderAll(); this.#emit("change", { value: this.boxes }); this.#emit("select", { value: this.#sel });
  }

  // --- navigation, menus, dialogs, toast ---
  #navigate(target) {
    if (this.#info.busy) return;
    const go = (mode) => this.#emit("nav", { ...target, mode });
    if (!this.#info.dirty) { go("go"); return; }
    this.#dialog("Leave this page?", "You have corrections that are not committed. Commit them first, or discard them.", [
      { label: "Stay", cls: "text" }, { label: "Discard", cls: "text danger", fn: () => go("discard") }, { label: "Commit and go", cls: "filled", fn: () => go("commit") },
    ]);
  }
  #closeOverlay() { this.#overlay.replaceChildren(); }
  #menu(anchor, items) {
    this.#closeOverlay();
    const scrim = el("div"); scrim.style.cssText = "position:fixed;inset:0;z-index:65";
    scrim.addEventListener("click", () => this.#closeOverlay());
    const m = el("div", "menu"); m.setAttribute("role", "menu");
    const r = anchor.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 240))}px`;
    for (const it of items) {
      const b = el("button", "btn"); b.type = "button"; b.setAttribute("role", "menuitem");
      if (it.color) { const sw = el("span", "sw"); sw.style.setProperty("--c", it.color); b.append(sw); }
      b.append(document.createTextNode(it.label));
      if (it.disabled) b.disabled = true;
      b.addEventListener("click", () => { this.#closeOverlay(); it.fn(); }); m.append(b);
    }
    this.#overlay.append(scrim, m);
    const fromBottom = r.top > innerHeight / 2;
    if (fromBottom) m.style.bottom = `${innerHeight - r.top + 4}px`; else m.style.top = `${r.bottom + 4}px`;
    m.querySelector("button:not([disabled])")?.focus();
  }
  #fileMenu(anchor) { const pdfs = this.#info.pdfs || []; this.#menu(anchor, pdfs.map((p) => ({ label: p, fn: () => this.#navigate({ pdf: p, page: 1 }) }))); }
  #kindMenu(anchor, pick, onlyRest = false) {
    const kinds = (this.#kinds.length ? this.#kinds : Object.keys(KIND_FALLBACK)).filter((k) => !onlyRest || !KEYED.includes(k));
    this.#menu(anchor, kinds.map((k) => ({ label: k, color: kindVar(k), fn: () => pick(k) })));
  }
  #moreMenu(anchor) {
    const un = this.#boxes.filter((b) => b.status === "pre-labelled").length;
    this.#menu(anchor, [
      { label: `Confirm all unreviewed (${un})`, disabled: !un, fn: () => this.#dialog("Confirm everything unreviewed?", `This marks ${un} engine guesses as reviewed without checking them one by one. Unreviewed regions are kept out of training; confirmed ones are used.`, [{ label: "Cancel", cls: "text" }, { label: "Confirm all", cls: "filled", fn: () => this.#emit("confirm-all") }]) },
      { label: "Reset to engine pre-label", fn: () => this.#dialog("Reset this page?", "This discards your corrections to this page and brings back the engine's guesses. Committed labels are not touched until you commit again.", [{ label: "Cancel", cls: "text" }, { label: "Reset", cls: "text danger", fn: () => this.#emit("reset") }]) },
      { label: "Keyboard shortcuts", fn: () => this.#shortcuts() },
    ]);
  }
  #dialog(title, body, actions) {
    this.#closeOverlay();
    const scrim = el("div", "scrim"); const d = el("div", "dialog"); d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.setAttribute("aria-label", title);
    d.append(el("h2", "", title)); if (body) d.append(el("p", "", body));
    const acts = el("div", "acts");
    for (const a of actions) acts.append(button(a.cls, a.label, () => { this.#closeOverlay(); a.fn?.(); }));
    d.append(acts); scrim.append(d);
    scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) this.#closeOverlay(); });
    this.#overlay.append(scrim); acts.querySelector("button:last-child")?.focus();
  }
  #shortcuts() {
    this.#closeOverlay();
    const scrim = el("div", "scrim"); const d = el("div", "dialog"); d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.setAttribute("aria-label", "Keyboard shortcuts");
    d.append(el("h2", "", "Keyboard shortcuts"));
    const keys = el("div", "keys");
    for (const [k, t] of [["Tab / Shift Tab", "Next / previous unreviewed region"], ["Enter", "Confirm the selected region and select the next unreviewed one"], ["1 – 6", "Set the kind: lead-staff, chord-band, barline, title, drum-staff, accompaniment-staff"], ["Delete", "Remove the selected region"], ["Arrows", "Nudge 1 px (Shift: 10 px)"], ["Ctrl Z / Ctrl Shift Z", "Undo and redo"], ["W / F", "Fit width / fit page"], ["Ctrl wheel", "Zoom"], ["Ctrl S", "Commit the page"], ["Esc", "Deselect"]]) {
      const row = el("div"); row.append(el("kbd", "", k), el("span", "", t)); keys.append(row);
    }
    d.append(keys); const acts = el("div", "acts"); acts.append(button("text", "Close", () => this.#closeOverlay())); d.append(acts); scrim.append(d);
    scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) this.#closeOverlay(); });
    this.#overlay.append(scrim); acts.firstChild.focus();
  }
  #showToast() {
    const t = this.#toast;
    if (!t || t.id === this.#shownToast) return;
    this.#shownToast = t.id;
    const s = this.#snack; s.replaceChildren(); s.hidden = false;
    s.setAttribute("role", "status");
    s.append(el("span", "grow", t.text));
    if (t.action) s.append(button("act", t.action.label, () => { s.hidden = true; this.#emit("action", { value: t.action.value }); }));
    clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => { s.hidden = true; }, t.action ? 8000 : 5000);
  }
}
