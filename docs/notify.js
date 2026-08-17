// notify.js -- bottom-right toast notifications, shared by the API and map demos.
//
// One live "status" toast reflects the current status line and updates IN PLACE,
// so a rapid progress stream ("Decoding 2/5..." -> "Rendering...") never floods
// the corner with dozens of boxes. When a step finishes it turns into a green
// check; an error stays pinned with a close button. notify() adds discrete
// one-off toasts for anything that isn't part of that single status stream.
//
// Theming rides the demos' existing tokens -- var(--card), var(--border),
// var(--destructive) all carry light+dark values and follow the page's `.dark`
// class automatically -- so the only colour defined here is the success green.
// The module injects its own <style> and container the first time it is used and
// is a no-op when there is no DOM (so importing it under Node never throws).

const STYLE_ID = 'notify-style';
const STACK_ID = 'notify-stack';

const CSS = `
:root { --notify-ok: oklch(0.60 0.16 150); }
.dark { --notify-ok: oklch(0.75 0.16 150); }
#${STACK_ID} {
  position: fixed; right: 16px; bottom: 16px; z-index: 99999;
  display: flex; flex-direction: column-reverse; gap: 10px;
  max-width: min(360px, calc(100vw - 32px)); pointer-events: none;
}
#${STACK_ID} .notify {
  pointer-events: auto;
  display: flex; align-items: flex-start; gap: 10px;
  background: var(--card, #fff); color: var(--foreground, #111);
  border: 1px solid var(--border, #ddd);
  border-left: 3px solid var(--muted-foreground, #888);
  border-radius: 10px; padding: 10px 12px;
  box-shadow: 0 6px 22px rgba(0, 0, 0, .18);
  font: 500 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif;
  opacity: 1;
  animation: notify-in .18s ease;
}
#${STACK_ID} .notify.out {
  opacity: 0; transform: translateY(6px);
  transition: opacity .18s ease, transform .18s ease;
}
/* Slide only -- opacity stays a static 1 so the box is visible even if the
   entrance animation is throttled (background tab) or never runs. */
@keyframes notify-in { from { transform: translateY(6px); } to { transform: none; } }
#${STACK_ID} .notify.ok    { border-left-color: var(--notify-ok); }
#${STACK_ID} .notify.error { border-left-color: var(--destructive, #d33); }
#${STACK_ID} .notify.warn  { border-left-color: oklch(0.75 0.15 80); }
#${STACK_ID} .notify .ni { flex: none; width: 18px; height: 18px; margin-top: 1px; }
#${STACK_ID} .notify.ok    .ni { color: var(--notify-ok); }
#${STACK_ID} .notify.error .ni { color: var(--destructive, #d33); }
#${STACK_ID} .notify.warn  .ni { color: oklch(0.72 0.15 80); }
#${STACK_ID} .notify .nmsg { flex: 1 1 auto; word-break: break-word; }
#${STACK_ID} .notify .nx {
  flex: none; margin: -2px -4px 0 2px; padding: 2px 5px;
  background: none; border: 0; cursor: pointer;
  color: var(--muted-foreground, #888); font-size: 15px; line-height: 1;
}
#${STACK_ID} .notify .nx:hover { color: var(--foreground, #111); }
@keyframes notify-spin { to { transform: rotate(360deg); } }
#${STACK_ID} .notify.busy .ni { animation: notify-spin .9s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  #${STACK_ID} .notify { animation: none; }
  #${STACK_ID} .notify.out { transition: none; }
  #${STACK_ID} .notify.busy .ni { animation: none; }
}
`;

// Static, message-free SVGs (safe to inject as innerHTML; the message itself is
// always set via textContent). The `ok` glyph is the green check the demos want.
const ICONS = {
  ok:    '<svg class="ni" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg>',
  error: '<svg class="ni" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M10 4.5v6.5"/><circle cx="10" cy="15" r=".7" fill="currentColor" stroke="none"/></svg>',
  warn:  '<svg class="ni" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3l8 14H2z"/><path d="M10 8v4"/></svg>',
  busy:  '<svg class="ni" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M10 2.5a7.5 7.5 0 1 1-7.5 7.5" opacity=".85"/></svg>',
  info:  '<svg class="ni" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M10 9v5"/><circle cx="10" cy="5.5" r=".7" fill="currentColor" stroke="none"/></svg>',
};

// Auto-dismiss delay per type, in ms. 0 means pinned. busy is pinned because the
// next status update replaces it; error is pinned and gets a close button.
const DISMISS_MS = { ok: 2600, warn: 4200, info: 3400, error: 0, busy: 0 };

function ensureStack() {
  if (typeof document === 'undefined' || !document.body) return null;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  let stack = document.getElementById(STACK_ID);
  if (!stack) {
    stack = document.createElement('div');
    stack.id = STACK_ID;
    stack.setAttribute('aria-live', 'polite');
    stack.setAttribute('aria-atomic', 'false');
    document.body.appendChild(stack);
  }
  return stack;
}

function remove(el) {
  if (!el || el._removing) return;
  el._removing = true;
  clearTimeout(el._timer);
  el.classList.add('out');
  setTimeout(() => el.remove(), 200);
}

function scheduleDismiss(el, type) {
  clearTimeout(el._timer);
  const ms = DISMISS_MS[type] ?? 3000;
  if (ms > 0) el._timer = setTimeout(() => remove(el), ms);
}

// Paint a box. Reuses the node; only rebuilds internals when the type changes so
// a same-type text update (busy -> busy) keeps the spinner spinning smoothly.
function paint(el, message, type) {
  if (el.dataset.ntype === type) {
    el.querySelector('.nmsg').textContent = message;
    return;
  }
  el.dataset.ntype = type;
  el.className = `notify ${type}`;
  el.innerHTML = `${ICONS[type] || ICONS.info}<span class="nmsg"></span>`;
  el.querySelector('.nmsg').textContent = message;
  if (type === 'error') {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'nx';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '×';
    x.addEventListener('click', () => remove(el));
    el.appendChild(x);
  }
}

/**
 * Show a discrete one-off toast. Returns a small handle so a caller can update
 * or dismiss it (e.g. a long task that later resolves).
 * @param {string} message
 * @param {{type?: 'info'|'ok'|'error'|'warn'|'busy', duration?: number}} [opts]
 */
export function notify(message, { type = 'info', duration } = {}) {
  const stack = ensureStack();
  if (!stack) return { update() {}, dismiss() {} };
  const el = document.createElement('div');
  stack.appendChild(el);
  paint(el, message, type);
  if (duration != null) {
    clearTimeout(el._timer);
    if (duration > 0) el._timer = setTimeout(() => remove(el), duration);
  } else {
    scheduleDismiss(el, type);
  }
  return {
    update(m, t = type) { paint(el, m, t); scheduleDismiss(el, t); },
    dismiss() { remove(el); },
  };
}

// The single live status toast, updated in place across a status stream.
let statusEl = null;

/**
 * Mirror a status line into one persistent bottom-right toast. Maps the demos'
 * status classes onto toast types; an empty/muted class clears the toast.
 * @param {string} message
 * @param {''|'muted'|'busy'|'ok'|'error'|'warn'} [cls]
 */
export function notifyStatus(message, cls = '') {
  const stack = ensureStack();
  if (!stack) return;
  const type =
    cls === 'busy'  ? 'busy'  :
    cls === 'ok'    ? 'ok'    :
    cls === 'error' ? 'error' :
    cls === 'warn'  ? 'warn'  :
    cls === '' || cls === 'muted' ? null : 'info';

  if (type === null) {                       // nothing to say -> clear the toast
    if (statusEl) { remove(statusEl); statusEl = null; }
    return;
  }
  if (!statusEl || !statusEl.isConnected) {
    statusEl = document.createElement('div');
    stack.appendChild(statusEl);
  }
  const el = statusEl;
  paint(el, message, type);
  clearTimeout(el._timer);
  const ms = DISMISS_MS[type];
  if (ms > 0) {
    // Terminal state: let it linger, then drop the reference so the next status
    // opens a fresh toast rather than reviving a removed node.
    el._timer = setTimeout(() => { remove(el); if (statusEl === el) statusEl = null; }, ms);
  }
}
