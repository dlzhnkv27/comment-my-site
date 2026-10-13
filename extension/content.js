// Comment My Site — in-page UI: Figma-style comment pins, toolbar and full-page export.
// Injected on demand by background.js; re-injection calls activate() on the live instance.

(() => {
  'use strict';

  if (window.__commentMySite) {
    window.__commentMySite.activate();
    return;
  }

  // After the extension is reloaded the old content script loses its connection to it;
  // drop whatever UI it left behind.
  document.querySelectorAll('comment-my-site').forEach((el) => el.remove());

  const PIN = 30;
  const STORAGE_PREFIX = 'cms:page:';
  const TOOLBAR_POS_KEY = 'cms:toolbar';
  const MAX_CAPTURE_HEIGHT = 50000; // CSS px, guards against infinite feeds
  const MAX_CANVAS_SIDE = 32767; // Chrome canvas limits
  const MAX_CANVAS_AREA = 250e6;
  const CHUNK_CHARS = 8 * 1024 * 1024; // base64 chunk per message, multiple of 4
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';
  const ACCENT = '#0d99ff';

  // ---------------------------------------------------------------------------
  // State

  let markers = []; // { id, x, y, text, created, draft?, moved? } — x/y are document px of the pin tip
  let openId = null; // marker whose composer is open
  let visible = false;
  let loaded = false;
  let capturing = false;
  let pageKey = keyFor(location.href);
  let toolbarPos = null;
  let clearTimer = null;
  let toastTimer = null;

  // ---------------------------------------------------------------------------
  // DOM helpers. Elements are built with createElement (no innerHTML) so the UI also
  // works on pages that enforce Trusted Types.

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child != null) el.append(child);
    return el;
  }

  const ICONS = {
    comment: [['path', { d: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z' }], ['path', { d: 'M8 12h8' }], ['path', { d: 'M12 8v8' }]],
    download: [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['path', { d: 'm7 10 5 5 5-5' }], ['path', { d: 'M12 15V3' }]],
    trash: [['path', { d: 'M3 6h18' }], ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }], ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }]],
    x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
    move: [['path', { d: 'm5 9-3 3 3 3' }], ['path', { d: 'm9 5 3-3 3 3' }], ['path', { d: 'm15 19-3 3-3-3' }], ['path', { d: 'm19 9 3 3-3 3' }], ['path', { d: 'M2 12h20' }], ['path', { d: 'M12 2v20' }]],
    grip: [9, 15].flatMap((cx) => [5, 12, 19].map((cy) => ['circle', { cx, cy, r: 1.3, fill: 'currentColor', stroke: 'none' }])),
    check: [['path', { d: 'M22 11.1V12a10 10 0 1 1-5.9-9.1' }], ['path', { d: 'M22 4 12 14l-3-3' }]],
    alert: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 8v4' }], ['path', { d: 'M12 16h.01' }]],
  };

  function icon(name, className = 'ic') {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: className,
    })) svg.setAttribute(k, v);
    for (const [tag, attrs] of ICONS[name]) {
      const node = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    return svg;
  }

  // ---------------------------------------------------------------------------
  // Styles (scoped by the shadow root)

  const CSS = `
:host { all: initial; }
[hidden] { display: none !important; }
* { box-sizing: border-box; }
.root {
  --accent: ${ACCENT}; --accent-hover: #0a88e3; --text: #1e1e1e; --muted: #8c8c8c;
  --danger: #d93036; --danger-bg: #feeced;
  --shadow-card: 0 0 0 .5px rgba(0,0,0,.12), 0 4px 8px rgba(0,0,0,.06), 0 16px 40px rgba(0,0,0,.18);
  font: 400 13px/1.4 ${FONT}; color: var(--text);
  -webkit-font-smoothing: antialiased; text-align: left; letter-spacing: normal;
}
.ic { width: 16px; height: 16px; flex: none; display: block; }
button { all: unset; box-sizing: border-box; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* Markers (document coordinates) */
.layer { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; }
.marker { position: absolute; width: 0; height: 0; }
.pin {
  position: absolute; left: 0; bottom: 0; width: ${PIN}px; height: ${PIN}px;
  border-radius: 15px 15px 15px 3px; background: var(--accent); border: 2px solid #fff;
  color: #fff; font: 600 12px/1 ${FONT}; display: grid; place-items: center;
  box-shadow: 0 1px 2px rgba(0,0,0,.2), 0 4px 12px rgba(0,0,0,.18);
  cursor: grab; pointer-events: auto; touch-action: none; transform-origin: 0 100%;
  transition: transform .15s cubic-bezier(.2,.9,.3,1.3), box-shadow .15s;
}
.pin:hover { transform: scale(1.1); }
.marker.open .pin { box-shadow: 0 0 0 3px rgba(13,153,255,.35), 0 4px 12px rgba(0,0,0,.18); }
.marker.dragging .pin { cursor: grabbing; transform: scale(1.15); box-shadow: 0 10px 24px rgba(0,0,0,.28); }
.marker.new .pin { animation: pin-drop .45s cubic-bezier(.2,.9,.3,1.3); }
.marker.unplaced .pin::after {
  content: ''; position: absolute; inset: -9px; border-radius: 50%;
  border: 2px solid var(--accent); animation: ping 1.4s ease-out infinite; pointer-events: none;
}
@keyframes pin-drop { from { transform: translateY(-28px) scale(.6); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes ping { from { opacity: .8; transform: scale(.7); } to { opacity: 0; transform: scale(1.5); } }

.preview {
  position: absolute; left: ${PIN + 8}px; bottom: -2px; width: max-content; max-width: 260px;
  padding: 8px 11px; background: #fff; color: var(--text); border-radius: 10px;
  font: 400 13px/1.45 ${FONT}; white-space: pre-wrap; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 8; overflow: hidden;
  box-shadow: var(--shadow-card); opacity: 0; transform: translateX(-4px);
  transition: opacity .12s, transform .12s; pointer-events: none;
}
.marker.flip .preview { left: auto; right: 8px; transform: translateX(4px); }
.marker:hover .preview { opacity: 1; transform: none; }
.marker.open .preview, .marker.dragging .preview { display: none; }

/* Composer */
.composer {
  position: absolute; width: 300px; background: #fff; border-radius: 12px;
  box-shadow: var(--shadow-card); pointer-events: auto; animation: pop .16s ease-out;
}
.c-head {
  display: flex; align-items: center; gap: 7px; height: 38px; padding: 0 6px 0 12px;
  color: var(--muted); font-size: 12px; font-weight: 500; cursor: grab; user-select: none; touch-action: none;
}
.c-head .ic { width: 14px; height: 14px; }
.c-head.dragging { cursor: grabbing; }
.c-title { color: var(--text); font-weight: 600; }
.c-x { margin-left: auto; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px; color: var(--muted); }
.c-x:hover { background: #f2f2f2; color: var(--text); }
.c-hint {
  display: flex; gap: 7px; align-items: center; margin: 0 10px 6px; padding: 7px 9px;
  border-radius: 8px; background: #eaf5ff; color: #0a6dc2; font-size: 12px; line-height: 1.35;
}
.c-hint .ic { width: 14px; height: 14px; }
textarea {
  all: unset; box-sizing: border-box; display: block; width: 100%; min-height: 42px; max-height: 220px;
  overflow-y: auto; padding: 4px 12px 6px; font: 400 14px/1.45 ${FONT}; color: var(--text);
  white-space: pre-wrap; overflow-wrap: anywhere; cursor: text;
}
textarea::placeholder { color: #a8a8a8; }
.c-foot { display: flex; align-items: center; gap: 6px; padding: 4px 8px 8px 6px; }
.c-del {
  display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 8px; border-radius: 7px;
  color: var(--muted); font: 500 12px/1 ${FONT};
}
.c-del .ic { width: 14px; height: 14px; }
.c-del:hover { background: var(--danger-bg); color: var(--danger); }
.c-kbd { margin-left: auto; color: #b0b0b0; font-size: 11.5px; white-space: nowrap; }
.c-done {
  height: 28px; padding: 0 12px; border-radius: 7px; background: var(--accent); color: #fff;
  font: 600 12.5px/28px ${FONT};
}
.c-done:hover { background: var(--accent-hover); }
.c-done:disabled { background: #cfe8fb; cursor: default; }

/* Toolbar */
.toolbar {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 2px; padding: 5px; background: #fff; border-radius: 14px;
  box-shadow: 0 0 0 .5px rgba(0,0,0,.14), 0 2px 4px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.16);
  pointer-events: auto; user-select: none; animation: rise .22s cubic-bezier(.2,.9,.3,1.2);
}
.toolbar.custom { bottom: auto; transform: none; animation: none; }
.grip { width: 18px; height: 34px; display: grid; place-items: center; color: #b8b8b8; cursor: grab; border-radius: 6px; touch-action: none; }
.grip:hover { color: var(--muted); background: #f3f3f3; }
.grip .ic { width: 14px; height: 14px; }
.tb {
  height: 34px; padding: 0 12px; border-radius: 9px; display: inline-flex; align-items: center; gap: 7px;
  font: 500 13px/1 ${FONT}; color: var(--text); white-space: nowrap; transition: background .12s, color .12s;
}
.tb:hover { background: #f2f2f2; }
.tb.primary { background: var(--accent); color: #fff; padding: 0 9px 0 11px; }
.tb.primary:hover { background: var(--accent-hover); }
.tb kbd { font: 600 10.5px/1 ${FONT}; padding: 3px 5px; border-radius: 5px; background: rgba(255,255,255,.24); }
.tb.icon { width: 34px; padding: 0; justify-content: center; }
.tb:disabled { opacity: .4; cursor: default; pointer-events: none; }
.tb.danger:hover, .tb.danger.armed { background: var(--danger-bg); color: var(--danger); }
.tb.armed .lbl-wide { display: inline; }
.count { font: 500 12px/1 ${FONT}; color: var(--muted); padding: 0 6px 0 8px; white-space: nowrap; }
.sep { width: 1px; height: 20px; background: #ebebeb; margin: 0 4px; flex: none; }
.root.busy .tb[data-act="export"] { pointer-events: none; opacity: .55; }

/* Toast */
.toast {
  position: fixed; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
  width: max-content; max-width: min(520px, calc(100vw - 32px)); padding: 9px 9px 9px 13px;
  background: #1e1e1e; color: #fff; border-radius: 11px; font: 500 13px/1.35 ${FONT};
  box-shadow: 0 10px 30px rgba(0,0,0,.28); pointer-events: auto; animation: rise .18s ease-out;
}
.toast .ic { width: 16px; height: 16px; }
.toast .ic.ok { color: #4ade80; }
.toast .ic.err { color: #ff6b6b; }
.t-text { min-width: 0; padding-right: 4px; }
.t-sub { color: #a8a8a8; font-weight: 400; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-act { flex: none; height: 28px; padding: 0 10px; border-radius: 7px; background: rgba(255,255,255,.12); color: #fff; font: 600 12.5px/28px ${FONT}; }
.t-act:hover { background: rgba(255,255,255,.2); }
.spinner { width: 14px; height: 14px; flex: none; border: 2px solid rgba(255,255,255,.25); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }

/* Capture mode: our UI disappears, a transparent shield blocks input */
.blocker { display: none; }
.root.capturing .layer, .root.capturing .toolbar, .root.capturing .toast { display: none !important; }
.root.capturing .blocker { display: block; position: fixed; inset: 0; cursor: progress; pointer-events: auto; background: transparent; }

@keyframes pop { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: none; } }
@keyframes rise { from { opacity: 0; translate: 0 8px; } to { opacity: 1; translate: 0 0; } }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 560px) { .tb .lbl-wide, .tb kbd, .count { display: none; } }
@media (prefers-reduced-motion: reduce) { *, *::after { animation: none !important; transition: none !important; } }
`;

  // ---------------------------------------------------------------------------
  // Build UI

  const host = document.createElement('comment-my-site');
  host.style.cssText = [
    'all: initial', 'position: absolute', 'top: 0', 'left: 0', 'width: 0', 'height: 0',
    'margin: 0', 'padding: 0', 'border: 0', 'display: block', 'z-index: 2147483647', 'pointer-events: none',
  ].map((rule) => `${rule} !important`).join(';');
  const shadow = host.attachShadow({ mode: 'open' });

  const markerEls = new Map(); // id -> { el, num, preview }

  // Composer
  const cTitle = h('span', { class: 'c-title' });
  const cClose = h('button', { class: 'c-x', type: 'button', title: 'Закрыть (Esc)', 'aria-label': 'Закрыть' }, icon('x'));
  const cHead = h('div', { class: 'c-head', title: 'Потяните, чтобы передвинуть маркер' }, icon('move'), cTitle, cClose);
  const cHint = h('div', { class: 'c-hint' }, icon('move'), 'Перетащите маркер туда, где нужен комментарий');
  const textarea = h('textarea', { rows: '1', placeholder: 'Напишите комментарий…', 'aria-label': 'Комментарий' });
  const cDelete = h('button', { class: 'c-del', type: 'button', title: 'Удалить комментарий' }, icon('trash'), 'Удалить');
  const cDone = h('button', { class: 'c-done', type: 'button', disabled: true, text: 'Готово' });
  const composer = h(
    'div',
    { class: 'composer', hidden: true },
    cHead, cHint, textarea,
    h('div', { class: 'c-foot' }, cDelete, h('span', { class: 'c-kbd', text: 'Enter — готово' }), cDone),
  );
  const layer = h('div', { class: 'layer' }, composer);

  // Toolbar
  const grip = h('div', { class: 'grip', title: 'Перетащить панель (двойной клик — вернуть на место)' }, icon('grip'));
  const addBtn = h(
    'button',
    { class: 'tb primary', type: 'button', 'data-act': 'add', title: 'Новый комментарий (C)' },
    icon('comment'), h('span', { class: 'lbl-wide', text: 'Комментарий' }), h('kbd', { text: 'C' }),
  );
  const countEl = h('span', { class: 'count' });
  const exportBtn = h(
    'button',
    { class: 'tb', type: 'button', 'data-act': 'export', title: 'Скриншот всей страницы со всеми комментариями' },
    icon('download'), h('span', { class: 'lbl-wide', text: 'Экспорт PNG' }),
  );
  const clearLabel = h('span', { class: 'lbl-wide', text: 'Очистить' });
  const clearBtn = h(
    'button',
    { class: 'tb danger', type: 'button', 'data-act': 'clear', title: 'Удалить все комментарии на этой странице' },
    icon('trash'), clearLabel,
  );
  const closeBtn = h(
    'button',
    { class: 'tb icon', type: 'button', 'data-act': 'close', title: 'Скрыть панель (комментарии сохранятся)' },
    icon('x'),
  );
  const toolbar = h(
    'div',
    { class: 'toolbar', role: 'toolbar', 'aria-label': 'Comment My Site' },
    grip, addBtn, countEl, h('div', { class: 'sep' }), exportBtn, clearBtn, h('div', { class: 'sep' }), closeBtn,
  );

  const toastEl = h('div', { class: 'toast', role: 'status', hidden: true });
  const blocker = h('div', { class: 'blocker' });
  const rootEl = h('div', { class: 'root' }, layer, toolbar, toastEl, blocker);

  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  shadow.append(styleEl, rootEl);

  // Keep page handlers (hotkeys, focus traps, outside-click logic) away from our UI.
  for (const type of [
    'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'copy', 'cut',
    'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup',
    'touchstart', 'touchend', 'focusin', 'focusout',
  ]) {
    rootEl.addEventListener(type, (e) => e.stopPropagation());
  }

  // ---------------------------------------------------------------------------
  // Utils

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  const byId = (id) => markers.find((m) => m.id === id);
  const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  function nextFrame() {
    // rAF does not fire in background tabs, so never wait on it alone.
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 120);
    });
  }

  function keyFor(href) {
    const url = new URL(href);
    // Keep hash-router paths (#/route, #!/route), drop plain anchors.
    const hash = /^#[!/]/.test(url.hash) ? url.hash : '';
    return url.origin + url.pathname + url.search + hash;
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  }

  function plural(n, one, few, many) {
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
    return many;
  }

  // Document position of the host element (normally 0,0) — marker coordinates are
  // stored relative to the document and converted on render.
  function origin() {
    const r = host.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY };
  }

  // Layout viewport without scrollbars — what position: fixed and our placement work against.
  const viewportW = () => (document.compatMode === 'CSS1Compat' ? document.documentElement.clientWidth : innerWidth);
  const viewportH = () => (document.compatMode === 'CSS1Compat' ? document.documentElement.clientHeight : innerHeight);

  async function send(message) {
    const res = await chrome.runtime.sendMessage(message);
    if (res?.error) throw new Error(res.error);
    return res;
  }

  // ---------------------------------------------------------------------------
  // Persistence (per page, in chrome.storage.local)

  async function loadMarkers() {
    const key = STORAGE_PREFIX + pageKey;
    try {
      const data = await chrome.storage.local.get([key, TOOLBAR_POS_KEY]);
      markers = (data[key]?.markers || [])
        .filter((m) => m && m.text)
        .map((m) => ({ id: m.id, x: m.x, y: m.y, text: m.text, created: m.created }));
      toolbarPos = data[TOOLBAR_POS_KEY] || null;
    } catch {
      markers = [];
    }
    loaded = true;
  }

  function persist() {
    const key = STORAGE_PREFIX + pageKey;
    const saved = markers
      .filter((m) => !m.draft && m.text)
      .map(({ id, x, y, text, created }) => ({ id, x, y, text, created }));
    const op = saved.length
      ? chrome.storage.local.set({ [key]: { url: location.href, title: document.title, markers: saved, updated: Date.now() } })
      : chrome.storage.local.remove(key);
    op.catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Rendering

  function render() {
    const o = origin();
    for (const [id, ref] of markerEls) {
      if (!byId(id)) {
        ref.el.remove();
        markerEls.delete(id);
      }
    }
    markers.forEach((m, i) => {
      let ref = markerEls.get(m.id);
      if (!ref) {
        ref = createMarkerEl(m.id);
        markerEls.set(m.id, ref);
        layer.insertBefore(ref.el, composer);
      }
      ref.num.textContent = String(i + 1);
      ref.preview.textContent = m.text || '';
      ref.el.classList.toggle('open', m.id === openId);
      ref.el.classList.toggle('unplaced', !!m.draft && !m.moved);
      positionMarker(m, ref.el, o);
    });
    if (openId) cTitle.textContent = `Комментарий ${markers.findIndex((m) => m.id === openId) + 1}`;
    updateToolbar();
  }

  function positionMarker(m, el = markerEls.get(m.id)?.el, o = origin()) {
    if (!el) return;
    el.style.left = `${m.x - o.x}px`;
    el.style.top = `${m.y - o.y}px`;
    el.classList.toggle('flip', m.x + PIN + 8 + 270 > scrollX + viewportW());
  }

  function createMarkerEl(id) {
    const num = h('span');
    const pin = h('button', { class: 'pin', type: 'button', title: 'Нажмите, чтобы открыть, или перетащите' }, num);
    const preview = h('div', { class: 'preview' });
    const el = h('div', { class: 'marker' }, pin, preview);
    pin.addEventListener('pointerdown', (e) => startDrag(e, id, () => toggleComposer(id)));
    // Keyboard activation (Enter/Space) produces a click with detail 0.
    pin.addEventListener('click', (e) => { if (e.detail === 0) toggleComposer(id); });
    return { el, num, preview };
  }

  function updateToolbar() {
    const n = markers.filter((m) => m.text).length;
    countEl.textContent = n ? `${n} ${plural(n, 'комментарий', 'комментария', 'комментариев')}` : '';
    countEl.hidden = !n;
    clearBtn.disabled = !n;
    if (!n) disarmClear();
  }

  // ---------------------------------------------------------------------------
  // Markers & composer

  function addMarker() {
    if (capturing) return;
    closeComposer();
    // New pins appear in the middle of the visible area.
    let x = Math.round(scrollX + viewportW() / 2 - PIN / 2);
    let y = Math.round(scrollY + viewportH() / 2 + PIN / 2);
    while (markers.some((m) => Math.abs(m.x - x) < 14 && Math.abs(m.y - y) < 14)) {
      x += 26;
      y += 26;
    }
    const m = { id: uid(), x, y, text: '', created: Date.now(), draft: true, moved: false };
    markers.push(m);
    render();
    const el = markerEls.get(m.id).el;
    el.classList.add('new');
    setTimeout(() => el.classList.remove('new'), 500);
    openComposer(m.id);
  }

  function toggleComposer(id) {
    if (openId === id) closeComposer();
    else openComposer(id);
  }

  function openComposer(id) {
    if (openId && openId !== id) closeComposer();
    const m = byId(id);
    if (!m) return;
    openId = id;
    textarea.value = m.text || '';
    cHint.hidden = !(m.draft && !m.moved);
    composer.hidden = false;
    render();
    syncComposer();
    placeComposer();
    requestAnimationFrame(() => {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }

  // Closing keeps typed text, drops an empty new marker, and leaves an existing
  // comment untouched if its text was erased (use "Удалить" to remove it).
  function closeComposer() {
    if (!openId) return;
    const m = byId(openId);
    openId = null;
    if (shadow.activeElement === textarea) textarea.blur();
    composer.hidden = true;
    if (m) {
      const text = textarea.value.trim();
      if (text) {
        m.text = text;
        m.draft = false;
      } else if (m.draft || !m.text) {
        markers = markers.filter((x) => x !== m);
      }
    }
    textarea.value = '';
    render();
    persist();
  }

  function deleteOpenMarker() {
    const id = openId;
    openId = null;
    if (shadow.activeElement === textarea) textarea.blur();
    composer.hidden = true;
    textarea.value = '';
    markers = markers.filter((m) => m.id !== id);
    render();
    persist();
  }

  function syncComposer() {
    cDone.disabled = !textarea.value.trim();
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }

  function placeComposer() {
    const m = byId(openId);
    if (!m) return;
    const o = origin();
    const w = composer.offsetWidth || 300;
    const hgt = composer.offsetHeight || 160;
    const viewLeft = scrollX + 12;
    const viewRight = scrollX + viewportW() - 12;
    const tb = toolbar.getBoundingClientRect();
    const viewBottom = scrollY + (tb.top > viewportH() / 2 ? tb.top - 10 : viewportH() - 12);

    let left = m.x + PIN + 10;
    let top = m.y - PIN - 4;
    if (left + w > viewRight) {
      if (m.x - 10 - w >= viewLeft) {
        left = m.x - 10 - w;
      } else {
        // Narrow window: no room on either side, so put it under the pin (or above).
        left = clamp(m.x + PIN / 2 - w / 2, viewLeft, Math.max(viewLeft, viewRight - w));
        top = m.y + 10;
        if (top + hgt > viewBottom) top = m.y - PIN - 10 - hgt;
      }
    }
    if (top + hgt > viewBottom) top = viewBottom - hgt;
    top = Math.max(top, scrollY + 12);

    composer.style.left = `${left - o.x}px`;
    composer.style.top = `${top - o.y}px`;
  }

  // Drag a marker by its pin or by the composer header. A press without movement is a click.
  function startDrag(e, id, onClick) {
    if (e.button !== 0 || capturing) return;
    const m = byId(id);
    if (!m) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const el = markerEls.get(id)?.el;
    const grabX = e.clientX + scrollX - m.x;
    const grabY = e.clientY + scrollY - m.y;
    const startX = e.clientX;
    const startY = e.clientY;
    let lastX = startX;
    let lastY = startY;
    let moved = false;

    const update = () => {
      const maxX = Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth) - PIN;
      m.x = Math.round(clamp(lastX + scrollX - grabX, 0, maxX));
      m.y = Math.round(Math.max(PIN, lastY + scrollY - grabY));
      positionMarker(m, el);
      if (openId === id) placeComposer();
    };
    const onMove = (ev) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (!moved) {
        if (Math.hypot(lastX - startX, lastY - startY) < 4) return;
        moved = true;
        m.moved = true;
        el?.classList.add('dragging');
        el?.classList.remove('unplaced');
        handle.classList.add('dragging');
        if (openId === id && !cHint.hidden) cHint.hidden = true;
      }
      update();
    };
    const onScroll = () => { if (moved) update(); };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      window.removeEventListener('scroll', onScroll, true);
      el?.classList.remove('dragging');
      handle.classList.remove('dragging');
      if (moved) {
        if (openId === id) {
          placeComposer();
          textarea.focus({ preventScroll: true });
        }
        persist();
      } else {
        onClick?.();
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    window.addEventListener('scroll', onScroll, true);
  }

  cHead.addEventListener('pointerdown', (e) => {
    if (e.target.closest?.('.c-x')) return;
    if (openId) startDrag(e, openId);
  });
  cClose.addEventListener('click', () => closeComposer());
  cDelete.addEventListener('click', () => deleteOpenMarker());
  cDone.addEventListener('click', () => closeComposer());
  textarea.addEventListener('input', () => {
    syncComposer();
    placeComposer();
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (textarea.value.trim()) closeComposer();
    }
  });

  // ---------------------------------------------------------------------------
  // Toolbar

  addBtn.addEventListener('click', () => addMarker());
  exportBtn.addEventListener('click', () => exportImage());
  closeBtn.addEventListener('click', () => hide());
  clearBtn.addEventListener('click', () => {
    // Two-step: the first click asks for confirmation, the second one clears.
    if (!clearTimer) {
      clearBtn.classList.add('armed');
      clearLabel.textContent = 'Удалить все?';
      clearTimer = setTimeout(disarmClear, 3000);
      return;
    }
    disarmClear();
    closeComposer();
    const backup = markers;
    const n = backup.length;
    markers = [];
    render();
    persist();
    toast(`Удалено: ${n} ${plural(n, 'комментарий', 'комментария', 'комментариев')}`, {
      // Comments added after clearing are kept on undo.
      action: { label: 'Вернуть', run: () => { markers = [...backup, ...markers]; render(); persist(); } },
      duration: 6000,
    });
  });

  function disarmClear() {
    clearTimeout(clearTimer);
    clearTimer = null;
    clearBtn.classList.remove('armed');
    clearLabel.textContent = 'Очистить';
  }

  function applyToolbarPos() {
    if (!toolbarPos) {
      toolbar.classList.remove('custom');
      toolbar.style.left = toolbar.style.top = '';
      return;
    }
    toolbar.classList.add('custom');
    const r = toolbar.getBoundingClientRect();
    toolbar.style.left = `${clamp(toolbarPos.x, 8, viewportW() - r.width - 8)}px`;
    toolbar.style.top = `${clamp(toolbarPos.y, 8, viewportH() - r.height - 8)}px`;
  }

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const r = toolbar.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const onMove = (ev) => {
      toolbarPos = { x: ev.clientX - dx, y: ev.clientY - dy };
      applyToolbarPos();
      positionToast();
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      if (toolbarPos) chrome.storage.local.set({ [TOOLBAR_POS_KEY]: toolbarPos }).catch(() => {});
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });
  grip.addEventListener('dblclick', () => {
    toolbarPos = null;
    applyToolbarPos();
    positionToast();
    chrome.storage.local.remove(TOOLBAR_POS_KEY).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // Toast

  function toast(text, { sub, kind = 'info', action, duration = 4500 } = {}) {
    clearTimeout(toastTimer);
    toastEl.replaceChildren();
    if (kind === 'progress') toastEl.append(h('span', { class: 'spinner' }));
    if (kind === 'success') toastEl.append(icon('check', 'ic ok'));
    if (kind === 'error') toastEl.append(icon('alert', 'ic err'));
    toastEl.append(h('div', { class: 't-text' }, h('div', { text }), sub ? h('div', { class: 't-sub', text: sub, title: sub }) : null));
    if (action) {
      toastEl.append(h('button', {
        class: 't-act', type: 'button', text: action.label,
        onclick: () => { hideToast(); action.run(); },
      }));
    }
    toastEl.hidden = false;
    // Restart the entrance animation.
    toastEl.style.animation = 'none';
    void toastEl.offsetWidth;
    toastEl.style.animation = '';
    positionToast();
    if (duration) toastTimer = setTimeout(hideToast, duration);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.hidden = true;
  }

  function positionToast() {
    if (toastEl.hidden) return;
    const r = toolbar.getBoundingClientRect();
    const w = toastEl.offsetWidth;
    toastEl.style.left = `${clamp(r.left + r.width / 2, 16 + w / 2, viewportW() - 16 - w / 2)}px`;
    if (r.top > viewportH() / 2) {
      toastEl.style.top = '';
      toastEl.style.bottom = `${viewportH() - r.top + 10}px`;
    } else {
      toastEl.style.bottom = '';
      toastEl.style.top = `${r.bottom + 10}px`;
    }
  }

  // ---------------------------------------------------------------------------
  // Show / hide

  async function show() {
    if (!loaded) await loadMarkers();
    if (!host.isConnected) document.documentElement.append(host);
    visible = true;
    applyToolbarPos();
    render();
  }

  function hide() {
    if (capturing) return;
    closeComposer();
    disarmClear();
    hideToast();
    visible = false;
    host.remove();
  }

  async function activate() {
    if (capturing) return;
    await show();
    addMarker();
  }

  // Frameworks sometimes prune unknown children of <html>; put the UI back.
  new MutationObserver(() => {
    if (visible && !host.isConnected) document.documentElement.append(host);
  }).observe(document.documentElement, { childList: true });

  // ---------------------------------------------------------------------------
  // Global listeners

  window.addEventListener('keydown', (e) => {
    if (!visible) return;
    if (capturing) {
      // Keyboard scrolling would break the stitched screenshot.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape' && openId) {
      e.preventDefault();
      e.stopPropagation();
      closeComposer();
      return;
    }
    if (e.code === 'KeyC' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat
        && !isEditable(e.composedPath()[0])) {
      e.preventDefault();
      e.stopPropagation();
      addMarker();
    }
  }, true);

  // Click outside the composer closes it (Figma behaviour).
  document.addEventListener('pointerdown', (e) => {
    if (!visible || !openId || e.composedPath().includes(host)) return;
    closeComposer();
  }, true);

  blocker.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  blocker.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  window.addEventListener('resize', () => {
    if (!visible) return;
    applyToolbarPos();
    render();
    if (openId) placeComposer();
    positionToast();
  });

  // Single-page apps: switch the comment set when the URL changes.
  setInterval(() => {
    const next = keyFor(location.href);
    if (next === pageKey || capturing) return;
    closeComposer();
    pageKey = next;
    loaded = false;
    if (visible) loadMarkers().then(() => { applyToolbarPos(); render(); });
  }, 1000);

  // ---------------------------------------------------------------------------
  // Export

  async function exportImage() {
    if (capturing) return;
    closeComposer();
    disarmClear();
    hideToast();
    const list = markers.filter((m) => m.text);
    capturing = true;
    rootEl.classList.add('busy');

    let shot;
    try {
      shot = await capturePage();
    } catch (err) {
      capturing = false;
      rootEl.classList.remove('busy');
      toast('Не удалось снять страницу', { kind: 'error', sub: describeError(err), duration: 9000 });
      return;
    }

    toast('Сохраняю изображение…', { kind: 'progress', duration: 0 });
    try {
      drawAnnotations(shot.canvas, shot.scale, list);
      const blob = await new Promise((resolve, reject) => {
        shot.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось закодировать PNG'))), 'image/png');
      });
      shot.canvas.width = shot.canvas.height = 0; // release memory early
      const result = await saveImage(blob, makeFilename());
      if (result?.canceled) {
        toast('Сохранение отменено', { duration: 3000 });
      } else if (result?.mode === 'native') {
        toast('Сохранено на рабочий стол', {
          kind: 'success', sub: result.path.split('/').pop(), duration: 9000,
          action: { label: 'Показать в Finder', run: () => send({ type: 'reveal', path: result.path }).catch(() => {}) },
        });
      } else {
        toast('Изображение сохранено', {
          kind: 'success', sub: result?.path, duration: 9000,
          action: { label: 'Показать', run: () => send({ type: 'reveal', downloadId: result.downloadId }).catch(() => {}) },
        });
      }
    } catch (err) {
      toast('Не удалось сохранить изображение', { kind: 'error', sub: describeError(err), duration: 9000 });
    } finally {
      capturing = false;
      rootEl.classList.remove('busy');
    }
  }

  function describeError(err) {
    const msg = String(err?.message || err);
    if (msg === 'tab-inactive') return 'Во время экспорта вкладка должна оставаться открытой';
    if (/context invalidated/i.test(msg)) return 'Расширение обновилось — перезагрузите страницу';
    if (/activeTab|permission|Cannot access|cannot be scripted/i.test(msg)) {
      return 'Нет доступа к вкладке: нажмите на иконку расширения и повторите экспорт';
    }
    return msg;
  }

  function makeFilename() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
    const site = (location.hostname || 'page').replace(/^www\./, '');
    return `${site} comments ${stamp}.png`;
  }

  async function saveImage(blob, filename) {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const id = uid();
    await send({ type: 'save-begin', id, filename, mime: 'image/png' });
    for (let i = 0; i < base64.length; i += CHUNK_CHARS) {
      await send({ type: 'save-chunk', id, data: base64.slice(i, i + CHUNK_CHARS) });
    }
    return send({ type: 'save-end', id });
  }

  // Scroll through the page, capture each viewport and stitch them into one canvas.
  async function capturePage() {
    const docEl = document.documentElement;
    const viewW = viewportW();
    const viewH = viewportH();
    const docHeight = () => Math.min(MAX_CAPTURE_HEIGHT, Math.max(docEl.scrollHeight, document.body?.scrollHeight || 0));
    const startX = scrollX;
    const startY = scrollY;
    const env = prepareCapture();

    try {
      await nextFrame();

      // Pass 1: run through the page so lazy images and scroll-reveal content load.
      let height = docHeight();
      for (let y = viewH; y < height; y += viewH) {
        scrollTo(0, y);
        await sleep(70);
        height = docHeight();
      }
      scrollTo(0, 0);
      await sleep(height > viewH ? 400 : 50);

      // Pass 2: capture.
      const totalH = docHeight();
      const total = Math.max(1, Math.ceil(totalH / viewH));
      let canvas = null;
      let ctx = null;
      let k = 1; // device px per CSS px in the captured frames
      let scale = 1; // output px per CSS px
      let drawnTo = 0;
      let prevY = -1;
      let index = 0;
      let y = 0;

      while (drawnTo < totalH && index < total + 5) {
        scrollTo(0, y);
        await nextFrame();
        // Fixed headers, chat widgets, cookie bars: keep them only in the first frame.
        if (index > 0) env.hideFixed();
        await sleep(index === 0 ? 120 : 80);
        await nextFrame();
        const atY = scrollY;
        const frame = await captureFrame(index + 1, total);

        if (!canvas) {
          k = frame.width / innerWidth;
          scale = Math.min(
            k,
            MAX_CANVAS_SIDE / totalH,
            MAX_CANVAS_SIDE / viewW,
            Math.sqrt(MAX_CANVAS_AREA / (viewW * totalH)),
          );
          canvas = document.createElement('canvas');
          canvas.width = Math.round(viewW * scale);
          canvas.height = Math.round(totalH * scale);
          ctx = canvas.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        // Only draw the part of this frame that is not on the canvas yet.
        const from = Math.max(drawnTo, atY);
        const to = Math.min(atY + viewH, totalH);
        if (to > from) {
          ctx.drawImage(
            frame,
            0, (from - atY) * k, viewW * k, (to - from) * k,
            0, from * scale, viewW * scale, (to - from) * scale,
          );
          drawnTo = to;
        }
        frame.close();
        index++;

        if (atY <= prevY) break; // the page stopped scrolling
        prevY = atY;
        y = atY + viewH;
      }

      // The page turned out shorter than measured: trim the empty tail.
      if (drawnTo < totalH) {
        const trimmed = document.createElement('canvas');
        trimmed.width = canvas.width;
        trimmed.height = Math.max(1, Math.round(drawnTo * scale));
        trimmed.getContext('2d').drawImage(canvas, 0, 0);
        canvas.width = canvas.height = 0;
        canvas = trimmed;
      }

      return { canvas, scale };
    } finally {
      scrollTo(startX, startY);
      env.restore();
      chrome.runtime.sendMessage({ type: 'capture-done' }).catch(() => {});
    }
  }

  async function captureFrame(index, total) {
    const res = await send({ type: 'capture', progress: { index, total } });
    // Decode by hand: loading a data: URL could be blocked by the page's CSP.
    const b64 = res.dataUrl.slice(res.dataUrl.indexOf(',') + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  }

  function prepareCapture() {
    const undo = [];
    const set = (el, prop, value) => {
      const prev = el.style.getPropertyValue(prop);
      const prio = el.style.getPropertyPriority(prop);
      el.style.setProperty(prop, value, 'important');
      undo.push(() => (prev ? el.style.setProperty(prop, prev, prio) : el.style.removeProperty(prop)));
    };
    const allElements = () => (document.body ? document.body.querySelectorAll('*') : []);

    rootEl.classList.add('capturing');
    set(document.documentElement, 'scroll-behavior', 'auto');
    if (document.body) set(document.body, 'scroll-behavior', 'auto');
    // Overlay scrollbars (macOS) flash while we scroll and would land in every frame.
    // Classic scrollbars take layout space and are cropped out anyway — hiding them would reflow the page.
    if (innerWidth === document.documentElement.clientWidth) set(document.documentElement, 'scrollbar-width', 'none');

    // Sticky elements would repeat in every frame; render them where they sit in the flow.
    for (const el of allElements()) {
      if (getComputedStyle(el).position === 'sticky') {
        set(el, 'position', 'relative');
        for (const side of ['top', 'right', 'bottom', 'left']) set(el, side, 'auto');
      }
    }

    const hidden = new WeakSet();
    const viewportArea = innerWidth * innerHeight;
    const hideFixed = () => {
      for (const el of allElements()) {
        if (hidden.has(el) || getComputedStyle(el).position !== 'fixed') continue;
        const r = el.getBoundingClientRect();
        // Full-screen fixed layers are usually backgrounds or app shells — keep them.
        if (r.width * r.height > viewportArea * 0.6) continue;
        set(el, 'transition', 'none');
        set(el, 'opacity', '0');
        hidden.add(el);
      }
    };

    return {
      hideFixed,
      restore() {
        while (undo.length) undo.pop()();
        rootEl.classList.remove('capturing');
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Annotations on the exported image: numbered pins plus a comment card next to each.

  function drawAnnotations(canvas, scale, list) {
    if (!list.length) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width / scale;
    const H = canvas.height / scale;
    const LINE = 19;
    const PAD_X = 12;
    const PAD_Y = 9;
    const BADGE = 18;
    const TEXT_X = PAD_X + BADGE + 8; // card text starts after the number badge
    const MAX_W = 290;
    const GAP = 10;
    const MARGIN = 8;

    ctx.save();
    ctx.scale(scale, scale);
    ctx.font = `400 13px ${FONT}`;
    ctx.textBaseline = 'alphabetic';

    const items = list.map((m, i) => ({ m, n: i + 1, pin: { x: m.x, y: m.y - PIN, w: PIN, h: PIN } }));
    const placed = [];
    for (const it of [...items].sort((a, b) => a.m.y - b.m.y || a.m.x - b.m.x)) {
      const lines = wrapText(ctx, it.m.text, MAX_W - TEXT_X - PAD_X);
      const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const w = Math.ceil(TEXT_X + textW + PAD_X);
      const hgt = lines.length * LINE + PAD_Y * 2 - 2;
      const naturalY = clamp(it.m.y - PIN, MARGIN, Math.max(MARGIN, H - MARGIN - hgt));
      const obstacles = [...placed, ...items.filter((o) => o !== it).map((o) => o.pin)];

      // Try right of the pin, then left; push down past other cards/pins and keep the
      // side that needed the least shifting (ties go to the right).
      let xs = [it.m.x + PIN + GAP, it.m.x - GAP - w].filter((x) => x >= MARGIN && x + w <= W - MARGIN);
      if (!xs.length) xs = [clamp(it.m.x + PIN + GAP, MARGIN, Math.max(MARGIN, W - MARGIN - w))];
      let best = null;
      xs.forEach((x, side) => {
        let y = naturalY;
        for (let guard = 0; guard < 80; guard++) {
          const hit = obstacles.find((r) => overlaps({ x, y, w, h: hgt }, r, 6));
          if (!hit) break;
          y = hit.y + hit.h + 6;
        }
        const cost = y - naturalY + side;
        if (!best || cost < best.cost) best = { x, y, cost };
      });
      const x = best.x;
      const y = best.y + hgt > H - MARGIN ? Math.max(MARGIN, H - MARGIN - hgt) : best.y;

      it.card = { x, y, w, h: hgt, lines };
      placed.push({ x, y, w, h: hgt });
    }

    // Leader lines from pin to card.
    ctx.strokeStyle = 'rgba(13,153,255,0.55)';
    ctx.lineWidth = 1.25;
    for (const it of items) {
      const c = it.card;
      const ax = it.m.x + PIN / 2;
      const ay = it.m.y - PIN / 2;
      const bx = c.x + c.w / 2 < ax ? c.x + c.w : c.x;
      const by = clamp(ay, c.y + 10, c.y + c.h - 10);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    // Cards.
    for (const it of items) {
      const c = it.card;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.20)';
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 4;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.roundRect(c.x, c.y, c.w, c.h, 10);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(0,0,0,0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1, 9.5);
      ctx.stroke();
      // Number badge, so a card can be matched to its pin even in a crowded spot.
      const bx = c.x + PAD_X + BADGE / 2;
      const by = c.y + PAD_Y + 8.5;
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.arc(bx, by, BADGE / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `700 10.5px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(it.n), bx, by + 0.5);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';

      ctx.fillStyle = '#1e1e1e';
      ctx.font = `400 13px ${FONT}`;
      c.lines.forEach((line, i) => ctx.fillText(line, c.x + TEXT_X, c.y + PAD_Y + 13 + i * LINE));
    }

    // Pins on top.
    for (const it of items) {
      const { x, y } = it.pin;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.28)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.roundRect(x, y, PIN, PIN, [15, 15, 15, 3]);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.roundRect(x + 2, y + 2, PIN - 4, PIN - 4, [13, 13, 13, 1.5]);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `600 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(it.n), x + PIN / 2, y + PIN / 2 + 0.5);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }

    ctx.restore();
  }

  function overlaps(a, b, pad = 0) {
    return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
  }

  function wrapText(ctx, text, maxW) {
    const out = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word;
        if (ctx.measureText(candidate).width <= maxW) {
          line = candidate;
          continue;
        }
        if (line) out.push(line);
        // A single word wider than the card (URLs): hard-break it.
        let rest = word;
        while (ctx.measureText(rest).width > maxW) {
          let cut = rest.length - 1;
          while (cut > 1 && ctx.measureText(rest.slice(0, cut)).width > maxW) cut--;
          out.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      out.push(line);
    }
    return out;
  }

  // ---------------------------------------------------------------------------

  window.__commentMySite = { activate };
  activate();
})();
