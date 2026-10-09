// Small DOM helpers: toasts, progress, downloads.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { esc };

/**
 * Show a toast. opts: { kind: 'info'|'warn'|'error', detail, list: [..] (collapsible), actions: [{label, onClick}], timeout }
 * Returns a close function.
 */
export function toast(message, opts = {}) {
  const host = $('#toasts');
  if (opts.key) for (const old of host.querySelectorAll(`[data-key="${opts.key}"]`)) old.remove();
  const el = document.createElement('div');
  if (opts.key) el.dataset.key = opts.key;
  el.className = 'toast ' + (opts.kind || 'info');
  el.setAttribute('role', opts.kind === 'error' ? 'alert' : 'status');
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.innerHTML = esc(message) + (opts.detail ? `<small>${esc(opts.detail)}</small>` : '');
  if (opts.list && opts.list.length) {
    const d = document.createElement('details');
    d.innerHTML = `<summary>${esc(opts.listTitle || 'Details')}</summary><ul>${opts.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    msg.appendChild(d);
  }
  el.appendChild(msg);
  for (const a of opts.actions || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn sm';
    b.textContent = a.label;
    b.addEventListener('click', () => { a.onClick(); close(); });
    el.appendChild(b);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'btn icon sm';
  x.setAttribute('aria-label', 'Dismiss');
  x.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-close"/></svg>';
  x.addEventListener('click', () => close());
  el.appendChild(x);
  host.appendChild(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  let timer = null;
  const close = () => { clearTimeout(timer); el.remove(); };
  const t = opts.timeout ?? (opts.kind === 'error' ? 12000 : opts.list ? 10000 : 5000);
  if (t > 0) {
    timer = setTimeout(close, t);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('focusin', () => clearTimeout(timer));
  }
  return close;
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function readFileAsArrayBuffer(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(file); });
}

export const storage = {
  get(k, def = null) { try { const v = localStorage.getItem(k); return v === null ? def : v; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
