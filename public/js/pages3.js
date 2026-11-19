'use strict';
/* ═══ Pages 3: notifications, reports, audit, settings + router/boot ═══ */
(function (App) {
  const { h, api, icon, fmtPct, fmtDate, fmtDateTime, statusBadge, mount } = App;

  /* ------------------------------ notifications --------------------------- */
  const POLICY_LABELS = {
    first_crossing: 'First crossing — once when a student first drops below the threshold (re-arms on recovery)',
    on_decrease: 'On decrease — on first crossing, then every time the percentage falls further below',
    daily: 'Daily digest — at most one alert per student per day while below',
    weekly: 'Weekly digest — at most one alert per student per week while below',
    manual: 'Manual only — no automatic alerts; send by hand from Defaulters',
  };
  const TEMPLATE_PLACEHOLDERS = '[Student Name], [Roll No], [Enrollment No], [Subject], [Attendance %], [Present Classes], [Total Classes], [Threshold], [Institution Name]';

  /** Honest label + color for a channel's actual delivery path. */
  function providerBadge(p, style = {}) {
    const MAP = {
      twilio: ['Twilio', 'blue'], meta: ['WhatsApp Cloud API (Meta)', 'blue'],
      sendgrid: ['SendGrid', 'blue'], webhook: ['webhook configured', 'blue'],
      log: ['log provider (dev/demo)', 'amber'], none: ['nothing configured — set provider env', 'grey'],
    };
    const key = p && p.provider ? p.provider : 'none';
    const [label, cls] = MAP[key] || [key, 'blue'];
    return h('span', { class: `badge ${cls}`, style }, label);
  }

  App.pages.notifications = async () => {
    const { root, content } = App.shell('/notifications', 'Notifications', 'Delivery log, alert policy and message template — every state shown honestly', []);
    mount(root);
    const tab = new URLSearchParams(location.search).get('tab') || 'log';
    const tabs = h('div', { class: 'seg', style: 'margin-bottom:14px' },
      [['log', 'Delivery log'], ['policy', 'Alert policy'], ['template', 'Message template']].map(([k, v]) =>
        h('button', { class: tab === k ? 'on-P' : '', onClick: () => { history.replaceState({}, '', `?tab=${k}`); App.route(); } }, v)));
    content.append(tabs);
    const box = h('div', {});
    content.append(box);
    if (tab === 'policy') return renderPolicy(box);
    if (tab === 'template') return renderTemplateTab(box);
    return renderLog(box);

    async function renderLog(box2) {
      const filters = { status: '', channel: '', q: '', page: 1 };
      const search = h('input', { class: 'f-input', placeholder: 'Student / roll / title…', onInput: App.debounce((e) => { filters.q = e.target.value; filters.page = 1; load(); }, 350) });
      const stSel = App.select(['pending', 'sent', 'delivered', 'failed', 'skipped'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })), { placeholder: 'Any status', onChange: (v) => { filters.status = v; filters.page = 1; load(); } });
      const chSel = App.select([{ value: 'email', label: 'Email' }, { value: 'sms', label: 'SMS' }, { value: 'whatsapp', label: 'WhatsApp' }], { placeholder: 'Any channel', onChange: (v) => { filters.channel = v; filters.page = 1; load(); } });
      const tbl = h('div', { class: 'card' });
      box2.replaceChildren(h('div', { class: 'filter-bar' },
        h('div', { class: 'field grow' }, h('label', {}, 'Search'), search),
        h('div', { class: 'field' }, h('label', {}, 'Channel'), chSel),
        h('div', { class: 'field' }, h('label', {}, 'Status'), stSel)), tbl);
      async function load() {
        tbl.replaceChildren(App.loading());
        const p = new URLSearchParams();
        Object.entries(filters).forEach(([k, v]) => { if (v) p.set(k, v); });
        p.set('page_size', '25');
        let r;
        try { r = await api(`/api/notifications?${p}`); } catch (e) { tbl.replaceChildren(App.errorBanner(e.message)); return; }
        if (!r.rows.length) { tbl.replaceChildren(App.empty('No notifications', 'Alerts trigger automatically when attendance is marked below the threshold.')); return; }
        const chips = r.counts ? h('div', { class: 'flex wrap', style: 'gap:6px;padding:10px 14px;border-bottom:1px solid var(--border)' },
          Object.entries(r.counts).map(([k, v]) => h('span', { class: 'badge outline' }, `${k}: ${v}`))) : null;
        tbl.replaceChildren(
          chips,
          App.table(['When', 'Student', 'Type / Rule', 'Channel', 'Recipient', 'At %', 'Message', 'Status', ''], r.rows.map((n) => ({
            __cells: [
              h('span', { class: 'sub-text' }, fmtDateTime(n.created_at)),
              h('a', { href: `/students/${n.student_id}`, onClick: (e) => { e.preventDefault(); App.navigate(`/students/${n.student_id}`); } },
                h('b', {}, n.roll_no || '—'), ' ', n.student_name || ''),
              h('span', {}, h('span', { class: 'badge blue' }, n.type), h('div', { class: 'sub-text' }, n.rule)),
              h('span', { class: 'badge outline' }, n.channel),
              h('span', { class: 'sub-text mono', style: 'max-width:160px;overflow:hidden;text-overflow:ellipsis;display:block' }, n.recipient || '—'),
              h('span', { class: 'mono' }, fmtPct(n.attendance_bp)),
              h('span', { class: 'msg-preview', title: n.message || '' }, n.message || ''),
              h('div', {}, App.notifStatusBadge(n), n.error ? h('div', { class: 'sub-text', style: 'max-width:220px' }, String(n.error)) : null),
              n.status === 'failed' ? h('button', {
                class: 'btn small secondary', onClick: async () => {
                  try { await api(`/api/notifications/${n.id}/retry`, { method: 'POST' }); App.toast('Retried', 'A new notification record was created.', 'success'); load(); }
                  catch (e2) { App.toast('Retry failed', e2.message, 'error'); }
                },
              }, 'Retry') : null],
          }))),
          App.pagination({ total: r.total, page: r.page, size: r.size, onPage: (p2) => { filters.page = p2; load(); } }));
      }
      await load();
    }

    async function renderPolicy(box2) {
      box2.replaceChildren(App.loading());
      const isAdmin = App.state.user.role === 'admin';
      let providers, settingsAll = null;
      try {
        providers = (await api('/api/notifications/providers'));
        if (isAdmin) settingsAll = (await api('/api/settings')).settings;
      } catch (e) { box2.replaceChildren(App.errorBanner(e.message)); return; }
      const policy = settingsAll ? (settingsAll.notification_policy || 'first_crossing') : providers.settings.policy;
      const threshold = providers.settings.threshold;
      const channels = settingsAll?.notification_channels ? JSON.parse(settingsAll.notification_channels) : null;

      const polSel = App.select(Object.entries(POLICY_LABELS).map(([v, l]) => ({ value: v, label: l.split(' — ')[0] })), { value: policy });
      polSel.disabled = !isAdmin;
      const chBoxes = ['email', 'sms', 'whatsapp'].map((c) => {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = channels ? !!channels[c] : !!providers.providers[c]?.enabled;
        cb.disabled = !isAdmin;
        return h('label', { class: 'badge outline', style: 'gap:6px;cursor:pointer;padding:7px 12px' }, cb, c.toUpperCase(),
          h('span', { class: 'sub-text' }, ['sms', 'whatsapp'].includes(c) && providers.providers[c]?.provider === 'log' ? '· demo (log)' : `· ${providers.providers[c]?.provider || 'unavailable'}`));
      });
      box2.replaceChildren(
        h('div', { class: 'card mb' }, h('div', { class: 'card-head' }, h('h3', {}, 'Automatic alert policy')),
          h('div', { class: 'card-body' },
            App.field('Threshold', h('div', { class: 'strong' }, `${threshold}%`),
              { hint: 'Changed in Settings → Alert threshold; per-subject overrides are not supported in this build.' }),
            App.field('When to alert', polSel, { hint: POLICY_LABELS[polSel.value] }),
            h('div', { id: 'policy-hint', class: 'sub-text mb', style: 'margin-top:-6px' }, POLICY_LABELS[polSel.value]),
            App.field('Deliver via', h('div', { class: 'flex wrap' }, chBoxes),
              { hint: 'Events are deduplicated per student × subject: state changes only — saves, restarts and recalcs never re-fire.' }),
            isAdmin ? h('button', {
              class: 'btn primary', onClick: async () => {
                try {
                  const ch = {};
                  ['email', 'sms', 'whatsapp'].forEach((c, i) => { ch[c] = chBoxes[i].querySelector('input').checked; });
                  await api('/api/settings', { method: 'PUT', body: { notification_policy: polSel.value, notification_channels: ch } });
                  App.toast('Alert policy saved', '', 'success'); renderPolicy(box2);
                } catch (e) { App.toast('Save failed', e.message, 'error'); }
              },
            }, 'Save policy') : h('div', { class: 'sub-text' }, 'Only admins can change the alert policy.'))),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Delivery channels')),
          h('div', { class: 'card-body flush' }, App.table(['Channel', 'Enabled', 'Delivery path', 'Honesty note'],
            Object.entries(providers.providers).map(([ch, p]) => {
              const badge = (label, cls) => h('span', { class: `badge ${cls}` }, label);
              return {
                __cells: [
                  h('b', {}, ch.toUpperCase()),
                  p.enabled ? badge('enabled', 'green') : badge('disabled', 'grey'),
                  p.provider !== 'none' && p.provider !== 'log' ? badge(`${p.provider} configured`, 'blue')
                    : p.provider === 'log' ? badge('log provider (dev/demo)', 'amber')
                      : badge('nothing configured', 'red'),
                  h('span', { class: 'sub-text' },
                    p.provider === 'log' ? `Sends are written to data/notifications.log and marked simulated — nothing leaves the server (demo).`
                      : p.provider === 'webhook' ? 'Sends POST to the webhook URL from .env.'
                        : 'Sends would fail with a clear error row; the system never pretends to send.'),
                ],
              };
            })))));
      polSel.addEventListener('change', () => {
        const hint = box2.querySelector('#policy-hint'); if (hint) hint.textContent = POLICY_LABELS[polSel.value];
      });
    }

    async function renderTemplateTab(box2) {
      box2.replaceChildren(App.loading());
      const isAdmin = App.state.user.role === 'admin';
      let tpl = '';
      try {
        if (isAdmin) tpl = (await api('/api/settings')).settings.message_template || '';
        else {
          const p = await api('/api/notifications/providers');
          tpl = ''; // teachers: server never exposes the template; show honestly below
        }
      } catch (e) { box2.replaceChildren(App.errorBanner(e.message)); return; }
      const ta = h('textarea', { class: 'f-textarea', style: 'min-height:220px' }, tpl);
      ta.disabled = !isAdmin;
      const preview = h('div', { class: 'details-box mono', style: 'white-space:pre-wrap;font-size:12px' });
      const vars = {
        'student name': 'Aarav Mehta', 'roll no': '14', 'enrollment no': 'CSE2024A-014',
        'subject': 'Data Structures (CS301)', 'attendance %': '62.5%', 'present classes': '10',
        'total classes': '16', 'threshold': '75', 'institution name': App.state.settings.institution_name || 'Institution',
      };
      const renderPrev = () => {
        preview.textContent = ta.value.replace(/\[([^\]]+)\]/g, (m, k) => vars[k.trim().toLowerCase()] ?? m);
      };
      ta.addEventListener('input', renderPrev);
      box2.replaceChildren(h('div', { class: 'grid two' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Message template'),
          isAdmin ? h('button', {
            class: 'btn primary small', onClick: async () => {
              try { await api('/api/settings', { method: 'PUT', body: { message_template: ta.value } }); App.toast('Template saved', '', 'success'); }
              catch (e) { App.toast('Save failed', e.message, 'error'); }
            },
          }, 'Save') : null),
          h('div', { class: 'card-body' },
            isAdmin ? App.field('Template (one for all channels)', ta)
              : h('div', { class: 'warn-banner' }, 'Message templates are visible to admins only (Settings).'),
            h('div', { class: 'sub-text', style: 'font-size:11.6px' }, `Placeholders: ${TEMPLATE_PLACEHOLDERS}`))),
        isAdmin ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Preview (sample data)')),
          h('div', { class: 'card-body' }, preview)) : null));
      renderPrev();
    }
  };

  /* -------------------------------- reports ------------------------------- */
  App.pages.reports = async () => {
    const { root, content } = App.shell('/reports', 'Reports & Exports', 'Every report is a CSV file you can open in Excel', []);
    mount(root);
    let subjects = [];
    try { subjects = (await api('/api/subjects?page_size=500')).rows; } catch { }
    const isAdmin = App.state.user.role === 'admin';

    function dl(url, name) { return async () => { try { await api.download(url, name); App.toast('Report downloaded', name, 'success'); } catch (e) { App.toast('Export failed', e.message, 'error'); } }; }

    function qp(obj) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null) p.set(k, v);
      const s = p.toString();
      return s ? '?' + s : '';
    }

    const secSel = App.select(App.sectionOptions(), { placeholder: 'All sections' });
    const subSel = App.select(subjects.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` })), { placeholder: 'All subjects' });
    const repSub = App.select(subjects.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` })), { placeholder: 'Choose subject' });
    const fromI = h('input', { class: 'f-input', type: 'date', value: App.todayLocal().slice(0, 8) + '01' });
    const toI = h('input', { class: 'f-input', type: 'date', value: App.todayLocal() });
    const defSub = App.select(subjects.map((s) => ({ value: s.id, label: `${s.code}` })), { placeholder: 'All subjects' });
    const defBand = App.select([{ value: '', label: 'All below threshold' }, { value: 'critical', label: 'Critical (<50%)' }, { value: '50to60', label: '50–60%' }, { value: '60to75', label: '60–75%' }]);

    const cards = [
      card('Monthly attendance report', 'Per-month totals — present/absent/excused, class days and attendance % per month.',
        h('div', {}, App.field('Subject (optional)', subSel), App.field('Section (optional)', secSel)),
        h('button', { class: 'btn primary', html: icon('download', 15) + ' Download CSV',
          onClick: () => dl('/api/reports/monthly' + qp({ subject_id: subSel.value, section_id: secSel.value }), 'monthly.csv')() })),
      card('Attendance register', 'Every marked attendance event — the full day-by-day register for a subject and date range.',
        h('div', {}, App.field('Subject (optional)', repSub), h('div', { class: 'form-grid' }, App.field('From', fromI), App.field('To', toI))),
        h('button', { class: 'btn primary', html: icon('download', 15) + ' Download CSV',
          onClick: () => dl('/api/reports/attendance' + qp({ subject_id: repSub.value, from: fromI.value, to: toI.value }), 'attendance-register.csv')() })),
      card('Defaulters report', 'Same maths as the Defaulters page — students under the threshold, with totals, bands and guardian contacts.',
        h('div', {}, App.field('Subject (optional)', defSub), App.field('Band', defBand)),
        h('div', { class: 'flex' },
          h('button', { class: 'btn primary', html: icon('download', 15) + ' CSV',
            onClick: () => dl('/api/reports/defaulters' + qp({ subject_id: defSub.value, band: defBand.value }), 'defaulters.csv')() }),
          h('button', { class: 'btn secondary', html: icon('download', 15) + ' XLSX',
            onClick: () => dl('/api/reports/defaulters' + qp({ subject_id: defSub.value, band: defBand.value, format: 'xlsx' }), 'defaulters.xlsx')() }))),
    ];
    if (isAdmin) cards.push(card('Student master list', 'The full active roster with guardian contacts.',
      null,
      h('button', { class: 'btn primary', html: icon('download', 15) + ' Download CSV',
        onClick: () => dl('/api/students-export.csv', 'students.csv')() })));
    try { content.append(h('div', { class: 'grid two' }, cards)); } catch (e) { content.append(App.errorBanner(e.message || 'Render failed')); }

    function card(title, desc, body, actions) {
      return h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, title)),
        h('div', { class: 'card-body' },
          h('p', { class: 'text-2', style: 'margin-top:0' }, desc),
          body || null, actions ? h('div', { class: 'mt' }, actions) : null));
    }
  };

  /* ------------------------------- audit logs ----------------------------- */
  App.pages.auditLogs = async () => {
    const { root, content } = App.shell('/audit-logs', 'Audit Logs', 'Every mutation: who, what, when, changed fields, IP', []);
    mount(root);
    const filters = { action: '', entity: '', q: '', from: '', to: '', page: 1 };
    const search = h('input', { class: 'f-input', placeholder: 'Action prefix (e.g. attendance., import., notification.)…', onInput: App.debounce((e) => { filters.action = e.target.value; filters.page = 1; load(); }, 350) });
    const entSel = App.select(['students', 'subjects', 'sections', 'departments', 'courses', 'attendance_records', 'imports', 'notification_events', 'users', 'settings', 'auth'].map((a) => ({ value: a, label: a })), { placeholder: 'Any entity', onChange: (v) => { filters.entity = v; filters.page = 1; load(); } });
    const fromI = h('input', { class: 'f-input', type: 'date', onChange: (e) => { filters.from = e.target.value; filters.page = 1; load(); } });
    const toI = h('input', { class: 'f-input', type: 'date', onChange: (e) => { filters.to = e.target.value; filters.page = 1; load(); } });
    const tbl = h('div', { class: 'card' });
    content.append(
      h('div', { class: 'filter-bar' },
        h('div', { class: 'field grow' }, h('label', {}, 'Action (prefix search)'), search),
        h('div', { class: 'field' }, h('label', {}, 'Entity'), entSel),
        h('div', { class: 'field' }, h('label', {}, 'From'), fromI),
        h('div', { class: 'field' }, h('label', {}, 'To'), toI),
        h('button', { class: 'btn secondary', onClick: () => App.navigate('/audit-logs') }, 'Clear')),
      tbl);
    async function load() {
      tbl.replaceChildren(App.loading());
      const p = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v) p.set(k, v); });
      p.set('page_size', '30');
      let r;
      try { r = await api(`/api/audit-logs?${p}`); } catch (e) { tbl.replaceChildren(App.errorBanner(e.message)); return; }
      if (!r.rows.length) { tbl.replaceChildren(App.empty('No log entries match')); return; }
      const parseVal = (v) => { if (!v) return null; try { return JSON.parse(v); } catch { return v; } };
      tbl.replaceChildren(
        App.table(['When', 'User', 'Action', 'Entity', 'Change', 'IP'], r.rows.map((a) => {
          const oc = parseVal(a.old_value), nc = parseVal(a.new_value);
          const kv = (obj, color) => obj && typeof obj === 'object'
            ? Object.entries(obj).slice(0, 3).map(([k, v]) => `${k}: ${trunc(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(', ')
            : (obj != null ? trunc(obj) : '');
          return {
            __cells: [
              h('span', { class: 'sub-text mono' }, fmtDateTime(a.created_at)),
              h('span', {}, a.user_name || h('span', { class: 'text-3' }, 'system'), a.user_email ? h('div', { class: 'sub-text' }, a.user_email) : null),
              h('span', { class: 'badge outline' }, a.action),
              h('span', { class: 'sub-text' }, `${a.entity || ''}${a.entity_id ? ' #' + a.entity_id : ''}`),
              (oc || nc)
                ? h('span', { class: 'sub-text diff', style: 'max-width:320px;white-space:pre-wrap' },
                  (oc ? `${kv(oc)}` : ''), (oc && nc ? ' → ' : ''), (nc ? kv(nc) : ''))
                : h('span', { class: 'text-3' }, '—'),
              h('span', { class: 'mono sub-text' }, a.ip || '—')],
          };
        })),
        App.pagination({ total: r.total, page: r.page, size: r.size, onPage: (p2) => { filters.page = p2; load(); } }));
    }
    function trunc(v) { v = String(v); return v.length > 26 ? v.slice(0, 26) + '…' : v; }
    await load();
  };

  /* -------------------------------- settings ------------------------------ */
  App.pages.settings = async () => {
    const isAdmin = App.state.user.role === 'admin';
    const { root, content } = App.shell('/settings', 'Settings', isAdmin ? 'Institution, attendance rules, users and notification channels' : 'Your institution', []);
    mount(root);
    content.append(App.loading());
    const s = App.state.settings;
    let all = null;
    if (isAdmin) {
      try { all = (await api('/api/settings')).settings; } catch (e) { content.replaceChildren(App.errorBanner(e.message)); return; }
    }
    content.replaceChildren();

    // institution card
    const instName = h('input', { class: 'f-input', value: s.institution_name || '' });
    const year = h('input', { class: 'f-input', value: (all?.academic_year ?? s.academic_year) || '' });
    const tz = h('input', { class: 'f-input', value: s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
    const thVal = h('input', { class: 'f-input', type: 'number', min: 1, max: 100, step: '1', value: all?.threshold ?? s.threshold ?? 75 });
    const excused = h('input', { type: 'checkbox' });
    excused.checked = (all?.count_excused_as_applicable ?? '0') === '1';
    const maxMB = h('input', { class: 'f-input', type: 'number', min: 1, max: 50, value: all?.upload_max_mb ?? 5 });
    if (!isAdmin) [instName, year, tz, thVal, maxMB].forEach((i) => { i.disabled = true; });
    excused.disabled = !isAdmin;

    content.append(h('div', { class: 'grid two' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Institution')),
        h('div', { class: 'card-body' },
          App.field('Institution name', instName),
          App.field('Academic year', year),
          App.field('Timezone (IANA)', tz),
          App.field('Maximum upload size (MB)', maxMB),
          isAdmin ? h('button', {
            class: 'btn primary', onClick: async () => {
              try {
                await api('/api/settings', { method: 'PUT', body: { institution_name: instName.value, academic_year: year.value, timezone: tz.value, upload_max_mb: Number(maxMB.value) } });
                App.state.settings.institution_name = instName.value; App.state.settings.academic_year = year.value;
                App.toast('Settings saved', '', 'success');
              } catch (e) { App.toast('Save failed', e.message, 'error'); }
            },
          }, 'Save institution') : h('div', { class: 'sub-text' }, 'Only admins can change institution settings.'))),

      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Attendance rules')),
        h('div', { class: 'card-body' },
          App.field('Alert threshold (%)', thVal, { required: true, hint: 'Students strictly below this percentage are flagged as defaulters. Exactly at the threshold is compliant (75.0 is NOT below 75).' }),
          h('label', { class: 'badge outline', style: 'gap:8px;cursor:pointer;padding:9px 12px' }, excused, 'Count “Excused” classes as applicable',
            h('span', { class: 'sub-text' }, '(off → excused neither helps nor hurts the percentage)')),
          h('div', { class: 'confirm-note' }, 'Parent-notification policy and delivery channels live under Notifications → Alert policy.'),
          isAdmin ? h('button', {
            class: 'btn primary', onClick: async () => {
              try {
                await api('/api/settings', { method: 'PUT', body: { threshold: Number(thVal.value), count_excused_as_applicable: excused.checked } });
                App.state.settings.threshold = Number(thVal.value);
                App.toast('Attendance rules saved', `Threshold is now ${thVal.value}%. All percentages recompute instantly.`, 'success');
              } catch (e) { App.toast('Save failed', e.message, 'error'); }
            },
          }, 'Save attendance rules') : null)),
    ));

    if (isAdmin) content.append(h('div', { class: 'grid two', style: 'margin-top:2px' }, usersCard(), providersCard()));
    else content.append(h('div', { class: 'info-banner', style: 'margin-top:2px' },
      'Notification policy, user management and audit logs are admin-only areas. Use the top-right menu to change your own password.'));

    function usersCard() {
      const box = h('div', { class: 'card' }, h('div', { class: 'card-head' },
        h('h3', {}, 'User accounts & access'),
        h('button', { class: 'btn primary small', onClick: () => userDialog(null), html: icon('plus', 14) + ' Add user' })),
        h('div', { class: 'card-body flush' }, App.loading()));
      loadUsers();
      async function loadUsers() {
        try {
          const r = await api('/api/users?page_size=100');
          box.querySelector('.card-body').replaceChildren(App.table(['Name', 'Email', 'Role', 'Status', ''], r.rows.map((u) => ({
            __cells: [
              h('span', { class: 'strong' }, u.name),
              h('span', { class: 'sub-text mono' }, u.email),
              h('span', { class: 'role-pill' }, u.role),
              h('span', { class: `badge ${u.active ? 'green' : 'red'}` }, u.active ? 'active' : 'disabled'),
              h('div', { class: 'flex' }, h('button', { class: 'btn small secondary', onClick: () => userDialog(u) }, 'Edit'))],
          }))));
        } catch (e) { box.querySelector('.card-body').replaceChildren(App.errorBanner(e.message)); }
      }
      function userDialog(existing) {
        const u = existing || { active: 1 };
        const name = h('input', { class: 'f-input', value: u.name || '' });
        const email = h('input', { class: 'f-input', type: 'email', value: u.email || '' });
        const role = App.select([{ value: 'teacher', label: 'Teacher' }, { value: 'admin', label: 'Admin' }], { value: u.role || 'teacher' });
        const act = h('input', { type: 'checkbox' });
        act.checked = !!u.active;
        const pw = h('input', { class: 'f-input', type: 'password', autocomplete: 'new-password', placeholder: existing ? 'leave blank to keep current' : 'min 8 chars, letters + numbers' });
        const err = h('div', { class: 'error-banner', style: 'display:none' });
        App.modal(existing ? `Edit user — ${u.name}` : 'Add user', h('div', {},
          h('div', { class: 'form-grid' },
            App.field('Full name', name, { required: true }),
            App.field(`Email (login)${existing ? ' — cannot be changed' : ''}`, email, { required: true }),
            App.field('Role', role, { hint: 'Teachers only see the subjects (and students in those sections) assigned to them.' })),
          h('label', { class: 'badge outline', style: 'gap:8px;cursor:pointer;padding:9px 12px;margin-bottom:12px' }, act, 'Account active'),
          App.field(existing ? 'Reset password (optional)' : 'Temporary password', pw, { required: !existing }),
          err), [
          { label: 'Cancel', kind: 'secondary', onClick: () => { } },
          {
            label: existing ? 'Save' : 'Create user', kind: 'primary', onClick: async () => {
              err.style.display = 'none';
              try {
                if (existing) {
                  const body = { name: name.value, role: role.value, active: act.checked };
                  if (pw.value) body.password = pw.value;
                  await api(`/api/users/${u.id}`, { method: 'PUT', body });
                } else {
                  await api('/api/users', { method: 'POST', body: { name: name.value, email: email.value, role: role.value, password: pw.value } });
                }
                App.toast('User saved', email.value, 'success'); loadUsers();
              } catch (e) { err.textContent = e.message; err.style.display = 'block'; return false; }
            },
          },
        ]);
        if (existing) email.disabled = true;
      }
      return box;
    }

    function providersCard() {
      const box = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Notification delivery')),
        h('div', { class: 'card-body flush' }, App.loading()));
      (async () => {
        try {
          const r = await api('/api/notifications/providers');
          box.querySelector('.card-body').replaceChildren(
            App.table(['Channel', 'Enabled', 'Delivery path', 'Notes'], Object.entries(r.providers).map(([ch, p]) => ({
              __cells: [
                h('b', {}, ch.toUpperCase()),
                p.enabled ? h('span', { class: 'badge green' }, 'enabled') : h('span', { class: 'badge grey' }, 'disabled'),
                p.provider !== 'none' && p.provider !== 'log' ? h('span', { class: 'badge blue' }, `${p.provider} configured`)
                  : p.provider === 'log' ? h('span', { class: 'badge amber' }, 'log provider (demo)')
                    : h('span', { class: 'badge red' }, 'none'),
                h('span', { class: 'sub-text', style: 'max-width:260px' },
                  p.provider === 'webhook' ? 'POSTs to the webhook URL from .env.'
                    : p.provider === 'log' ? 'Writes to data/notifications.log, flagged simulated — nothing leaves the server.'
                      : 'Sends will fail honestly with the reason recorded. Configure webhook URLs in .env (see .env.example).')],
            }))),
            h('div', { class: 'confirm-note', style: 'margin:12px' },
              `Alert policy: ${r.settings?.policy || 'first_crossing'} · Threshold: ${r.settings?.threshold || 75}%. Change both under Notifications → Alert policy.`));
        } catch (e) { box.querySelector('.card-body').replaceChildren(App.errorBanner(e.message)); }
      })();
      return box;
    }
  };

  /* ══════════════════════════════ router & boot ══════════════════════════ */
  App.routes = [
    { re: /^\/login$/, page: 'login', public: true },
    { re: /^\/reset$/, page: 'reset', public: true },
    { re: /^\/(dashboard)?$/, page: 'dashboard' },
    { re: /^\/students$/, page: 'students' },
    { re: /^\/students\/(\d+)$/, page: 'studentProfile', args: (m) => [Number(m[1])] },
    { re: /^\/subjects$/, page: 'subjects' },
    { re: /^\/attendance$/, page: 'attendanceRecords' },
    { re: /^\/attendance\/take$/, page: 'takeAttendance' },
    { re: /^\/attendance\/import$/, page: 'importUpload' },
    { re: /^\/attendance\/import\/(\d+)\/review$/, page: 'importReview', args: (m) => [Number(m[1])] },
    { re: /^\/defaulters$/, page: 'defaulters' },
    { re: /^\/notifications$/, page: 'notifications' },
    { re: /^\/reports$/, page: 'reports' },
    { re: /^\/audit-logs$/, page: 'auditLogs', admin: true },
    { re: /^\/settings$/, page: 'settings' },  { re: /^\/students\/new$/, page: 'students' },];

  App.route = async function () {
    const path = location.pathname;
    const match = App.routes.find((r) => r.re.test(path));
    // not logged in → login
    let user = App.state.user;
    if (!match || !match.public) {
      if (!user) {
        try { const me = await api('/api/auth/me'); user = me.user; App.state.user = user; App.state.csrf = me.csrf; App.state.settings = { ...App.state.settings, ...me.settings }; if (me.token) App.setToken(me.token); await App.loadMeta(); }
        catch { App.state.user = null; }
      }
      if (!App.state.user) {
        if (path !== '/login' && path !== '/reset') history.replaceState({}, '', '/login');
        return App.pages.login();
      }
    } else if (App.state.user && match.public && match.page === 'login') {
      // already logged in hitting /login → dashboard
      history.replaceState({}, '', '/dashboard');
      return App.pages.dashboard();
    }
    if (!match) {
      App.mount(h('div', { class: 'empty-state', style: 'min-height:100vh' },
        h('div', { class: 'empty-icon' }, '🧭'),
        h('div', { class: 'empty-title' }, 'Page not found'),
        h('button', { class: 'btn primary', onClick: () => App.navigate('/dashboard') }, 'Back to Dashboard')));
      return;
    }
    if (match.admin && App.state.user.role !== 'admin') {
      App.toast('Not allowed', 'Admins only.', 'error');
      history.replaceState({}, '', '/dashboard');
      return App.pages.dashboard();
    }
    window.scrollTo(0, 0);
    try {
      const args = match.args ? match.args(path.match(match.re)) : [];
      await App.pages[match.page](...args);
    } catch (e) {
      App.mount(App.errorBanner(e.message || 'Something went wrong rendering this page.'));
    }
  };

  window.addEventListener('popstate', App.route);
  document.addEventListener('DOMContentLoaded', () => {
    App.state.theme = localStorage.getItem('ams_theme') || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = App.state.theme;
    App.route();
  });
})(window.App);
