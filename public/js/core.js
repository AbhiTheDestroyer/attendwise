'use strict';
/* ══════════════════════ AttendWise core: DOM, API, UI kit ═══════════════════ */
window.App = window.App || {};

(function (App) {
  /* ------------------------------ state ------------------------------ */
  const savedTheme = localStorage.getItem('ams_theme');
  App.state = {
    user: null, csrf: null, settings: {}, meta: null,
    // Session token mirror (survives cookie-blocked environments such as a
    // cross-site iframe preview). Sent as Authorization: Bearer on API calls.
    token: (() => { try { return sessionStorage.getItem('ams_token'); } catch { return null; } })(),
    theme: savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    sidebarOpen: false,
  };
  App.setToken = (t) => {
    App.state.token = t || null;
    try { t ? sessionStorage.setItem('ams_token', t) : sessionStorage.removeItem('ams_token'); } catch { }
  };
  document.documentElement.dataset.theme = App.state.theme;
  App.toggleTheme = () => {
    App.state.theme = App.state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('ams_theme', App.state.theme);
    document.documentElement.dataset.theme = App.state.theme;
    const btn = document.querySelector('#theme-btn');
    if (btn) btn.innerHTML = icon(App.state.theme === 'dark' ? 'sun' : 'moon');
  };

  /* --------------------------- DOM helpers ---------------------------- */
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = String(v);
      else if (k === 'html') e.innerHTML = v; // trusted internal content only
      else if (k === 'style') e.setAttribute('style', v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(e.dataset, v);
      else if (k === 'attrs' && typeof v === 'object') { for (const [ak, av] of Object.entries(v)) e.setAttribute(ak, av); }
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, String(v));
    }
    const append = (kid) => {
      if (kid === null || kid === undefined || kid === false || kid === '') return;
      if (Array.isArray(kid)) return kid.forEach(append);
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    };
    kids.forEach(append);
    return e;
  }
  App.h = h;
  // Shared root mount: every page module renders into #app. Must live in core —
  // page files used to crash with 'mount is not defined' when it only existed
  // privately inside pages1.js.
  const mount = (node) => {
    const root = document.getElementById('app');
    root.className = '';
    root.replaceChildren(node);
  };
  App.mount = mount;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  App.esc = esc;
  App.debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /* ------------------------------- API -------------------------------- */
  async function api(rawPath, { method = 'GET', body, formData } = {}) {
    const headers = {};
    // Build-stamped URL: bypasses any intermediary cache poisoned with stale
    // entries for these API URLs (HTTP 401 is cacheable-by-default), without
    // changing behavior server-side.
    const path = rawPath.includes('?') ? rawPath + '&_b=3' : rawPath + '?_b=3';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (App.state.csrf && method !== 'GET') headers['x-csrf-token'] = App.state.csrf;
    if (App.state.token) {
      headers['Authorization'] = 'Bearer ' + App.state.token;
      // Custom header too: survives intermediaries that strip Authorization.
      headers['x-session-token'] = App.state.token;
    }
    let res;
    try {
      res = await fetch(path, {
        method, headers,
        body: formData !== undefined ? formData : (body !== undefined ? JSON.stringify(body) : undefined),
      });
    } catch (netErr) {
      // Network-level failure: the request never reached the server. Called out
      // plainly so it is never confused with an auth problem.
      const e = Object.assign(new Error(`Cannot reach the server (${rawPath}). It may still be starting — wait a few seconds and try again.`), { status: 0 });
      throw e;
    }
    if (res.status === 401 && !rawPath.endsWith('/auth/login')) {
      App.state.user = null; App.state.csrf = null; App.setToken(null);
      if (location.pathname !== '/login') { history.pushState({}, '', '/login'); App.route(); }
      throw Object.assign(new Error(`Session expired — please log in again (${rawPath})`), { status: 401 });
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    if (!res.ok) {
      const msg = data?.error?.message || `Request failed (HTTP ${res.status})`;
      throw Object.assign(new Error(msg), { status: res.status, code: data?.error?.code, details: data?.error?.details });
    }
    return data;
  }
  App.api = api;

  api.download = async (path, fallbackName = 'export.csv') => {
    const res = await fetch(path, { headers: {} });
    if (!res.ok) {
      let msg = `Download failed (HTTP ${res.status})`;
      try { msg = (await res.json()).error.message || msg; } catch { }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename="?([^";]+)"?/.exec(cd);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : fallbackName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  };

  /* ---------------------------- formatting ---------------------------- */
  const tz = () => App.state.settings.timezone || 'Asia/Kolkata';
  App.fmtPct = (bp) => {
    if (bp === null || bp === undefined) return '—';
    const whole = Math.floor(bp / 100), frac = bp % 100;
    if (frac === 0) return `${whole}%`;
    if (frac % 10 === 0) return `${whole}.${frac / 10}%`;
    return `${whole}.${String(frac).padStart(2, '0')}%`;
  };
  App.fmtDate = (iso) => {
    if (!iso) return '—';
    try { return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: tz() }).format(new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso)); }
    catch { return iso; }
  };
  App.fmtDateTime = (iso) => {
    if (!iso) return '—';
    try { return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: tz() }).format(new Date(iso)); }
    catch { return iso; }
  };
  App.todayLocal = () => {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const g = (t) => p.find((x) => x.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  };
  App.pctClass = (bp, threshold) => {
    if (bp === null || bp === undefined) return 'grey';
    if (bp < threshold * 100) return 'red';
    if (bp < (threshold + 5) * 100) return 'amber';
    return 'green';
  };
  App.threshold = () => Number(App.state.settings.threshold || 75);
  const STATUS_META = {
    P: { label: 'Present', cls: 'green' }, A: { label: 'Absent', cls: 'red' },
    E: { label: 'Excused', cls: 'amber' }, H: { label: 'Holiday', cls: 'blue' }, C: { label: 'Cancelled', cls: 'grey' },
  };
  App.statusBadge = (st) => h('span', { class: `badge ${STATUS_META[st]?.cls || 'grey'}` }, STATUS_META[st]?.label || st);
  const NOTIF_META = {
    sent: { label: 'sent', cls: 'green' }, failed: { label: 'failed', cls: 'red' },
    skipped: { label: 'skipped', cls: 'grey' }, pending: { label: 'pending', cls: 'amber' },
    dry_run: { label: 'dry run', cls: 'blue' },
  };
  App.notifStatusBadge = (e) => h('span', { class: `badge ${NOTIF_META[e && e.status]?.cls || 'grey'}` }, NOTIF_META[e && e.status]?.label || (e && e.status) || '—');
  App.pctBadge = (bp) => {
    const cls = App.pctClass(bp, App.threshold());
    return h('span', { class: `badge att-pill ${cls}` }, App.fmtPct(bp));
  };
  App.pctBar = (bp) => {
    const cls = App.pctClass(bp, App.threshold());
    const w = bp === null ? 0 : Math.min(100, Math.max(2, bp / 100));
    const colors = { green: 'var(--green)', amber: 'var(--amber)', red: 'var(--red)', grey: 'var(--text-3)' };
    return h('div', { class: 'pct-bar', attrs: { role: 'img', 'aria-label': `Attendance ${App.fmtPct(bp)}` } },
      h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${w}%;background:${colors[cls]}` })),
      h('span', { class: 'val' }, App.fmtPct(bp)));
  };

  /* ------------------------------- toast ------------------------------- */
  App.toast = (title, msg = '', type = 'info', ms = 5000) => {
    const root = document.getElementById('toast-root');
    const t = h('div', { class: `toast ${type}`, role: 'alert' },
      h('div', {},
        h('div', { class: 't-title' }, title),
        msg ? h('div', { class: 't-msg' }, msg) : null),
      h('button', { class: 't-close', 'aria-label': 'Dismiss', onClick: () => t.remove() }, '×'));
    root.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
  };

  /* ------------------------------- modal ------------------------------- */
  App.modal = (title, bodyNode, buttons = [], { wide = false } = {}) => {
    const root = document.getElementById('modal-root');
    const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const foot = buttons.length
      ? h('div', { class: 'm-foot' }, buttons.map((b) => h('button', {
        class: `btn ${b.kind || 'secondary'}`,
        disabled: b.disabled,
        onClick: async (ev) => { const r = await b.onClick(ev); if (r !== false) close(); },
      }, b.spinner ? h('span', { class: 'spinner' }) : null, b.label)))
      : null;
    const backdrop = h('div', { class: 'modal-backdrop', onClick: (e) => { if (e.target === backdrop) close(); } },
      h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'm-head' },
          h('h3', {}, title),
          h('button', { class: 'icon-btn m-close', 'aria-label': 'Close', onClick: close, html: icon('x') })),
        h('div', { class: 'm-body' }, bodyNode),
        foot));
    root.appendChild(backdrop);
    document.addEventListener('keydown', onKey);
    const firstInput = backdrop.querySelector('input,select,textarea,button.btn');
    if (firstInput) setTimeout(() => firstInput.focus(), 60);
    return { close, el: backdrop };
  };
  App.confirm = (title, messageNode, confirmLabel = 'Confirm', kind = 'primary') =>
    new Promise((resolve) => {
      const m = App.modal(title, typeof messageNode === 'string' ? App.h('p', { style: 'margin:0' }, messageNode) : messageNode, [
        { label: 'Cancel', kind: 'secondary', onClick: () => { resolve(false); } },
        { label: confirmLabel, kind, onClick: () => { resolve(true); } },
      ]);
    });

  /* ---------------------------- components ---------------------------- */
  App.loading = (msg = 'Loading…') => h('div', { class: 'loading-row' }, h('span', { class: 'spinner small' }), msg);
  App.empty = (title, msg, iconChar = '—') => h('div', { class: 'empty-state' },
    h('div', { class: 'e-icon' }, iconChar),
    h('div', { class: 'e-title' }, title),
    h('div', {}, msg || ''));
  App.errorBanner = (msg) => h('div', { class: 'error-banner', role: 'alert' }, msg);

  App.table = (columns, rows, { rowClass, onRow, ariaLabel } = {}) =>
    h('div', { class: 'table-wrap' },
      h('table', { class: 'tbl', attrs: ariaLabel ? { 'aria-label': ariaLabel } : {} },
        h('thead', {}, h('tr', {}, columns.map((c) => h('th', { scope: 'col', class: c && c.num ? 'num' : '' }, typeof c === 'string' ? c : (c && c.nodeType ? c : c && c.label))))),
        h('tbody', {}, rows.map((r) => {
          const tr = h('tr', { class: `${rowClass ? rowClass(r) : ''} ${onRow ? 'clickable' : ''}` },
            r.__cells.map((cell, i) => h('td', { class: columns[i] && columns[i].num ? 'num' : '' }, cell)));
          if (onRow) {
            tr.addEventListener('click', () => onRow(r));
            tr.tabIndex = 0;
            tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') onRow(r); });
          }
          tr.__data = r;
          return tr;
        }))));

  App.pagination = ({ total, page, size, onPage }) => {
    const pages = Math.max(1, Math.ceil(total / size));
    const btn = (label, p, opts = {}) => h('button', {
      class: 'btn small secondary', disabled: opts.disabled, 'aria-current': opts.current ? 'page' : null,
      onClick: () => onPage(p),
    }, label);
    const nums = [];
    const around = [page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages);
    if (!around.includes(1)) { nums.push(btn('1', 1)); if (!around.includes(2)) nums.push(h('span', { class: 'text-3' }, '…')); }
    around.forEach((p) => nums.push(h('button', {
      class: `btn small ${p === page ? 'primary' : 'secondary'}`,
      onClick: () => onPage(p), 'aria-current': p === page ? 'page' : null,
    }, String(p))));
    if (!around.includes(pages)) { if (!around.includes(pages - 1)) nums.push(h('span', { class: 'text-3' }, '…')); nums.push(btn(String(pages), pages)); }
    return h('div', { class: 'pagination' },
      h('span', { class: 'pg-info' }, `${total.toLocaleString('en-IN')} result(s) · page ${page} of ${pages}`),
      btn('‹ Prev', page - 1, { disabled: page <= 1 }), nums,
      btn('Next ›', page + 1, { disabled: page >= pages }));
  };

  App.field = (label, input, { hint, required } = {}) =>
    h('div', { class: 'field' },
      h('label', {}, label, required ? h('span', { class: 'req', text: ' *' }) : null),
      input,
      hint ? h('div', { class: 'hint' }, hint) : null);

  App.select = (options, { value, onChange, placeholder, attrs } = {}) => {
    const sel = h('select', { class: 'f-select', attrs: attrs || {}, onChange: (e) => onChange && onChange(e.target.value) });
    if (placeholder !== undefined) sel.append(h('option', { value: '' }, placeholder));
    for (const o of options) {
      const opt = h('option', { value: o.value }, o.label);
      if (String(o.value) === String(value)) opt.selected = true;
      sel.append(opt);
    }
    return sel;
  };

  /* ------------------------------- charts ------------------------------ */
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

  App.barChart = (data, { height = 190, format = (v) => v, accentFn } = {}) => {
    if (!data.length) return App.empty('No data');
    const W = 560, H = height, padB = 44, padT = 14, padL = 34;
    const max = Math.max(...data.map((d) => d.value), 1);
    const bw = (W - padL) / data.length;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%', role: 'img', 'aria-label': 'Bar chart' });
    for (let i = 0; i <= 3; i++) {
      const y = padT + ((H - padB - padT) * i) / 3;
      svg.append(el('line', { x1: padL, y1: y, x2: W, y2: y, stroke: 'var(--border)', 'stroke-width': 1 }));
      const lbl = el('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--text-3)' });
      lbl.textContent = format(Math.round(max * (1 - i / 3)));
      svg.append(lbl);
    }
    data.forEach((d, i) => {
      const bh = Math.max(2, ((H - padB - padT) * d.value) / max);
      const rect = el('rect', {
        x: padL + i * bw + bw * 0.16, y: H - padB - bh, width: bw * 0.68, height: bh, rx: 4,
        fill: accentFn ? accentFn(d) : 'var(--primary)',
      });
      const title = el('title', {}); title.textContent = `${d.label}: ${format(d.value)}`;
      rect.append(title);
      svg.append(rect);
      const v = el('text', { x: padL + i * bw + bw / 2, y: H - padB - bh - 5, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 700, fill: 'var(--text-2)' });
      v.textContent = format(d.value);
      svg.append(v);
      const l = el('text', { x: padL + i * bw + bw / 2, y: H - padB + 14, 'text-anchor': 'middle', 'font-size': 9.8, fill: 'var(--text-2)' });
      l.textContent = d.label.length > 12 ? d.label.slice(0, 11) + '…' : d.label;
      svg.append(l);
      if (d.label.length > 12) {
        const l2 = el('text', { x: padL + i * bw + bw / 2, y: H - padB + 26, 'text-anchor': 'middle', 'font-size': 9.2, fill: 'var(--text-3)' });
        l2.textContent = d.full || '';
        svg.append(l2);
      }
    });
    return svg;
  };

  App.lineChart = (points, { height = 180, format = (v) => v, baseline } = {}) => {
    if (points.length < 2) return App.empty('Not enough data yet');
    const W = 560, H = height, padL = 44, padB = 26, padT = 12;
    const vals = points.map((p) => p.value);
    const min = Math.min(...vals, baseline ?? 0);
    const max = Math.max(...vals, 100);
    const X = (i) => padL + ((W - padL - 8) * i) / (points.length - 1);
    const Y = (v) => padT + ((H - padB - padT) * (max - v)) / (max - min || 1);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%', role: 'img', 'aria-label': 'Trend chart' });
    for (let i = 0; i <= 3; i++) {
      const y = padT + ((H - padB - padT) * i) / 3;
      svg.append(el('line', { x1: padL, y1: y, x2: W, y2: y, stroke: 'var(--border)' }));
      const lbl = el('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--text-3)' });
      lbl.textContent = format(max - ((max - min) * i) / 3);
      svg.append(lbl);
    }
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
    const area = `${path} L${X(points.length - 1).toFixed(1)},${H - padB} L${X(0).toFixed(1)},${H - padB} Z`;
    svg.append(el('path', { d: area, fill: 'var(--primary)', opacity: 0.10 }));
    svg.append(el('path', { d: path, fill: 'none', stroke: 'var(--primary)', 'stroke-width': 2.4, 'stroke-linejoin': 'round' }));
    points.forEach((p, i) => {
      const c = el('circle', { cx: X(i), cy: Y(p.value), r: 3.2, fill: 'var(--primary)' });
      const t = el('title', {}); t.textContent = `${p.label}: ${format(p.value)}`;
      c.append(t); svg.append(c);
      if (i % Math.ceil(points.length / 8) === 0 || i === points.length - 1) {
        const l = el('text', { x: X(i), y: H - padB + 15, 'text-anchor': 'middle', 'font-size': 9.5, fill: 'var(--text-3)' });
        l.textContent = p.label;
        svg.append(l);
      }
    });
    return svg;
  };

  /* ------------------------------- icons ------------------------------- */
  const ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    users: '<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c.7-3.4 3.2-5.2 6.2-5.2s5.5 1.8 6.2 5.2"/><circle cx="17.2" cy="9" r="2.6"/><path d="M16 15c2.7.3 4.6 1.9 5.2 4.5"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5V5.5"/><path d="M8 7.5h8M8 11h5"/>',
    check: '<path d="M4.5 12.5l5 5 10-11"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2"/><path d="M9 11l2.2 2.2L15.5 9"/>',
    list: '<path d="M8.5 6h12M8.5 12h12M8.5 18h12"/><circle cx="4" cy="6" r="1.2"/><circle cx="4" cy="12" r="1.2"/><circle cx="4" cy="18" r="1.2"/>',
    upload: '<path d="M12 16V4m0 0L6.5 9.5M12 4l5.5 5.5"/><path d="M4 16v3.2A1.8 1.8 0 0 0 5.8 21h12.4a1.8 1.8 0 0 0 1.8-1.8V16"/>',
    alert: '<path d="M12 3.2 2.6 19.5h18.8z"/><path d="M12 9.5v4.4"/><circle cx="12" cy="16.8" r=".9" fill="currentColor" stroke="none"/>',
    bell: '<path d="M18 15.5v-4.8a6 6 0 0 0-12 0v4.8l-1.7 2.8h15.4z"/><path d="M10 21a2.2 2.2 0 0 0 4 0"/>',
    report: '<path d="M6 2.5h8L20 8.5V21a.8.8 0 0 1-.8.8H6a.8.8 0 0 1-.8-.8V3.3A.8.8 0 0 1 6 2.5z"/><path d="M13.5 2.5v6.5H20"/><path d="M9 13h7M9 16.5h7"/>',
    shield: '<path d="M12 2.5 4.5 5.6v5.7c0 4.6 3.1 8 7.5 9.9 4.4-1.9 7.5-5.3 7.5-9.9V5.6z"/><path d="M8.8 11.8l2.3 2.3 4.2-4.4"/>',
    gear: '<circle cx="12" cy="12" r="3.1"/><path d="M12 2.8v2.5M12 18.7v2.5M2.8 12h2.5M18.7 12h2.5M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
    moon: '<path d="M20.5 13.6A8.2 8.2 0 0 1 10.4 3.5a8.2 8.2 0 1 0 10.1 10.1z"/>',
    logout: '<path d="M14 3.5H6.8A1.3 1.3 0 0 0 5.5 4.8v14.4a1.3 1.3 0 0 0 1.3 1.3H14"/><path d="M10 12h10.5M17 8l4 4-4 4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    download: '<path d="M12 4v12m0 0 5.5-5.5M12 16l-5.5-5.5"/><path d="M4 17v2.3A1.7 1.7 0 0 0 5.7 21h12.6a1.7 1.7 0 0 0 1.7-1.7V17"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M14.5 4.8 19.2 9.5 8.3 20.4l-5 .8.8-5z"/><path d="M12.8 6.6l4.6 4.6"/>',
    send: '<path d="M21 3 10.5 13.5M21 3l-6.8 18-3.7-7.5L3 9.8z"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 9.5h17M8 2.8V6M16 2.8V6"/>',
    hamburger: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  };
  function icon(name, size = 17) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }
  App.icon = icon;

  /* ------------------------ global error surface ------------------------ */
  window.addEventListener('error', (e) => {
    console.error(e.error || e.message);
  });
})(window.App);
