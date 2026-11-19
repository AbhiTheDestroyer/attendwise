'use strict';
/* ═══════════ Pages 1: boot, shell, login, dashboard, students ═══════════ */
(function (App) {
  const { h, api, icon, fmtPct, fmtDate, fmtDateTime, statusBadge, pctBar } = App;
  App.pages = App.pages || {};

  function mount(node) {
    const root = document.getElementById('app');
    root.className = '';
    root.replaceChildren(node);
  }
  App.mount = mount;
  App.navigate = (path) => { history.pushState({}, '', path); App.route(); };

  /* ------------------------------- shell ------------------------------- */
  const NAV = [
    ['OVERVIEW', [['/dashboard', 'Dashboard', 'dashboard']]],
    ['ACADEMIC', [['/students', 'Students', 'users'], ['/subjects', 'Subjects', 'book']]],
    ['ATTENDANCE', [
      ['/attendance/take', 'Take Attendance', 'check'],
      ['/attendance', 'Records', 'list'],
      ['/attendance/import', 'Import Sheet', 'upload'],
      ['/defaulters', 'Defaulters', 'alert'],
    ]],
    ['COMMUNICATION', [['/notifications', 'Notifications', 'bell']]],
    ['SYSTEM', [
      ['/reports', 'Reports', 'report'],
      ['/audit-logs', 'Audit Logs', 'shield', 'admin'],
      ['/settings', 'Settings', 'gear'],
    ]],
  ];

  App.shell = function (active, title, sub, actions = []) {
    const st = App.state;
    const role = st.user.role;
    const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' },
      h('div', { class: 'brand' },
        h('span', { html: `<svg width="26" height="26" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="var(--primary)"/><path d="M28 52l14 14 30-34" stroke="white" stroke-width="11" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>` }),
        h('span', {}, 'AttendWise'),
        st.settings.demo_mode ? h('span', { class: 'demo-flag', title: 'This deployment contains demonstration data' }, 'DEMO') : null),
      h('nav', { class: 'nav', 'aria-label': 'Primary' },
        NAV.map(([label, items]) => [
          h('div', { class: 'nav-label' }, label),
          items.filter(([, , , r]) => !r || r === role).map(([path, label2, ic]) =>
            h('a', {
              href: path, class: active === path ? 'active' : '',
              'aria-current': active === path ? 'page' : null,
              onClick: (e) => { e.preventDefault(); st.sidebarOpen = false; App.navigate(path); },
            }, h('span', { html: icon(ic) }), label2)),
        ])));

    // global search
    const resultsBox = h('div', { class: 'search-results', style: 'display:none' });
    const searchInput = h('input', {
      type: 'search', placeholder: 'Search student, roll no, subject, parent…',
      'aria-label': 'Global search', autocomplete: 'off',
      onInput: App.debounce(async (e) => {
        const q = e.target.value.trim();
        if (q.length < 2) { resultsBox.style.display = 'none'; return; }
        try {
          const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
          resultsBox.replaceChildren();
          const list = [];
          if (r.students.length) {
            list.push(h('div', { class: 'sr-cat' }, 'Students'));
            r.students.forEach((s) => list.push(h('div', {
              class: 'sr-item', role: 'option', tabindex: 0,
              onClick: () => { resultsBox.style.display = 'none'; App.navigate(`/students/${s.id}`); },
            },
              h('div', { class: 'avatar', style: 'width:28px;height:28px;font-size:11px' }, s.full_name.split(' ').map((x) => x[0]).slice(0, 2).join('')),
              h('div', {}, h('div', { class: 'strong' }, s.full_name), h('div', { class: 'sub-text' }, `Roll ${s.roll_no} · ${s.enrollment_no} · ${s.department_name} ${s.section_name}`)))));
          }
          if (r.subjects.length) {
            list.push(h('div', { class: 'sr-cat' }, 'Subjects'));
            r.subjects.forEach((s) => list.push(h('div', {
              class: 'sr-item',
              onClick: () => { resultsBox.style.display = 'none'; App.navigate(`/attendance?subject_id=${s.id}`); },
            },
              h('div', {}, h('div', { class: 'strong' }, `${s.code} — ${s.name}`), h('div', { class: 'sub-text' }, `Semester ${s.semester} · Section ${s.section_name}`)))));
          }
          resultsBox.append(...(list.length ? list : [h('div', { class: 'sr-item' }, `No matches for "${q}"`)]));
          resultsBox.style.display = 'block';
        } catch { /* ignore */ }
      }, 280),
    });
    document.addEventListener('click', (e) => { if (!resultsBox.contains(e.target) && e.target !== searchInput) resultsBox.style.display = 'none'; });

    // user menu
    const userMenu = h('div', { class: 'user-menu', style: 'display:none' },
      h('div', { class: 'um-head' },
        h('div', { class: 'strong' }, st.user.name),
        h('div', { class: 'sub-text' }, st.user.email),
        h('span', { class: 'role-pill', style: 'margin-top:5px;display:inline-block' }, role)),
      h('div', { class: 'um-item', onClick: () => { userMenu.style.display = 'none'; App.changePasswordDialog(); } }, h('span', { html: icon('shield', 15) }), 'Change password'),
      h('div', {
        class: 'um-item', onClick: async () => {
          try { await api('/api/auth/logout', { method: 'POST' }); } catch { }
          st.user = null; st.csrf = null; App.setToken(null); history.pushState({}, '', '/login'); App.route();
        },
      }, h('span', { html: icon('logout', 15) }), 'Log out'));
    document.addEventListener('click', (e) => { if (!userMenu.contains(e.target) && !e.target.closest('.user-chip')) userMenu.style.display = 'none'; });

    const topbar = h('header', { class: 'topbar' },
      h('button', {
        class: 'icon-btn hamburger', 'aria-label': 'Menu',
        onClick: () => { st.sidebarOpen = !st.sidebarOpen; document.getElementById('sidebar').classList.toggle('open', st.sidebarOpen); },
        html: icon('hamburger'),
      }),
      h('div', {},
        h('div', { class: 'page-title' }, title),
        sub ? h('div', { class: 'sub-text', style: 'font-size:11.8px' }, sub) : null),
      h('div', { class: 'spacer' }),
      h('div', { class: 'searchbox' }, h('span', { class: 's-icon', html: icon('search', 15) }), searchInput, resultsBox),
      h('button', { class: 'icon-btn', id: 'theme-btn', 'aria-label': 'Toggle dark mode', onClick: App.toggleTheme, html: icon(st.theme === 'dark' ? 'sun' : 'moon') }),
      h('div', {
        class: 'user-chip', tabindex: 0, role: 'button', 'aria-label': 'Account menu',
        onClick: () => { userMenu.style.display = userMenu.style.display === 'none' ? 'block' : 'none'; },
      },
        h('span', { class: 'avatar' }, st.user.name.split(' ').map((x) => x[0]).slice(0, 2).join('')),
        h('span', { class: 'strong', style: 'font-size:13px' }, st.user.name.split(' ').slice(0, 2).join(' '))));

    const content = h('div', { class: 'content' });
    const actionRow = actions.length
      ? h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), h('div', { class: 'actions' }, actions))
      : null;
    if (actionRow) content.append(actionRow);

    const root = h('div', { class: 'layout' }, sidebar, h('div', { class: 'main' }, topbar, userMenu, content));
    return { root, content };
  };

  App.changePasswordDialog = () => {
    const cur = h('input', { type: 'password', autocomplete: 'current-password', class: 'f-input', required: true });
    const next = h('input', { type: 'password', autocomplete: 'new-password', class: 'f-input', required: true });
    const err = h('div', { class: 'error-text', style: 'display:none' });
    App.modal('Change password', h('form', {
      onSubmit: async (e) => {
        e.preventDefault();
        err.style.display = 'none';
        try {
          const r = await api('/api/auth/password', { method: 'PUT', body: { current_password: cur.value, new_password: next.value } });
          if (r.csrf) App.state.csrf = r.csrf;
          if (r.token) App.setToken(r.token);
          App.toast('Password updated', 'Your password has been changed (all other sessions were closed).', 'success');
          document.querySelector('.modal-backdrop')?.remove();
        } catch (ex) { err.textContent = ex.message; err.style.display = 'block'; }
      },
    },
      App.field('Current password', cur, { required: true }),
      App.field('New password (8+ chars, letters + numbers)', next, { required: true }), err,
      h('div', { class: 'm-foot', style: 'border:none;padding:8px 0 0' }, h('button', { class: 'btn primary', type: 'submit' }, 'Update password'))));
  };

  /* ------------------------------- login ------------------------------- */
  App.pages.login = async () => {
    const email = h('input', { type: 'email', class: 'f-input', autocomplete: 'username', required: true, value: App.state.settings?.demo_mode ? 'admin@git.edu' : '' });
    const pass = h('input', { type: 'password', class: 'f-input', autocomplete: 'current-password', required: true, value: App.state.settings?.demo_mode ? 'Admin@123' : '' });
    const err = h('div', { class: 'error-banner', style: 'display:none' });
    const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'Sign in');
    const inst = App.state.settings.institution_name || 'Attendance Management System';

    const form = h('form', {
      onSubmit: async (e) => {
        e.preventDefault();
        err.style.display = 'none';
        btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner' }), 'Signing in…');
        try {
          const r = await api('/api/auth/login', { method: 'POST', body: { email: email.value.trim(), password: pass.value } });
          App.state.user = r.user; App.state.csrf = r.csrf; App.state.settings = { ...App.state.settings, ...r.settings };
          if (r.token) App.setToken(r.token);
          await App.loadMeta();
          history.pushState({}, '', '/dashboard');
          App.route();
          App.toast(`Welcome back, ${r.user.name.split(' ')[0]}`, '', 'success', 3000);
        } catch (ex) {
          err.textContent = ex.message; err.style.display = 'block';
          btn.disabled = false; btn.replaceChildren('Sign in');
        }
      },
    },
      App.field('Email address', email, { required: true }),
      App.field('Password', pass, { required: true }),
      err, btn,
      h('div', { style: 'text-align:center;margin-top:12px' },
        h('a', {
          href: '#', onClick: (e) => { e.preventDefault(); forgotDialog(); },
        }, 'Forgot password?')));

    const health = h('div', { class: 'sub-text', style: 'margin-top:10px;font-size:11.6px;text-align:center' }, 'Checking server\u2026');

    mount(h('div', { class: 'login-wrap' },
      h('div', { class: 'card login-card' },
        h('div', { class: 'brand-lg' },
          h('span', { html: `<svg width="34" height="34" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="var(--primary)"/><path d="M28 52l14 14 30-34" stroke="white" stroke-width="11" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>` }),
          h('b', {}, 'AttendWise')),
        h('div', { class: 'inst-name' }, inst),
        form,
        App.state.settings.demo_mode ? h('div', { class: 'demo-creds' },
          h('b', {}, 'Demo credentials (seeded demo data)'), h('br'),
          'Admin: admin@git.edu / Admin@123', h('br'),
          'Teacher: anil.verma@git.edu / Teacher@123') : null,
        h('div', { class: 'sub-text', style: 'margin-top:16px;font-size:11.6px;text-align:center' },
          'Student & parent data is confidential institutional data. Access is logged.'),
        h('div', { style: 'margin-top:14px;text-align:center' },
          h('a', { href: '/lookup.html', style: 'font-size:13px;color:var(--primary);text-decoration:none;font-weight:600' },
            '👪 Parent / student? Check attendance with roll number + date of birth →')),
        health)));

    fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).then(() => {
      health.replaceChildren('\u25CF Server online \u2014 logins are being accepted.');
      health.style.color = 'var(--green)';
    }).catch(() => {
      health.replaceChildren('\u25CF Server unreachable \u2014 the backend is (re)starting. Wait ~10 seconds, then refresh this panel.');
      health.style.color = 'var(--red)';
      const t = setInterval(() => {
        fetch('/api/health', { cache: 'no-store' }).then((r) => {
          if (!r.ok) throw new Error('not-ready');
          health.replaceChildren('\u25CF Server back online \u2014 you can log in now.');
          health.style.color = 'var(--green)';
          clearInterval(t);
        }).catch(() => { });
      }, 4000);
    });

    function forgotDialog() {
      const em = h('input', { type: 'email', class: 'f-input', placeholder: 'you@institution.edu', required: true });
      const done = h('div', { class: 'info-banner', style: 'display:none' });
      App.modal('Reset password', h('form', {
        onSubmit: async (e) => {
          e.preventDefault();
          try {
            const r = await api('/api/auth/forgot', { method: 'POST', body: { email: em.value.trim() } });
            done.textContent = r.message + (App.state.settings.demo_mode ? ' (Demo: check data/notifications.log on the server for the link.)' : '');
            done.style.display = 'block';
          } catch (ex) { done.textContent = ex.message; done.style.display = 'block'; }
        },
      },
        h('p', { class: 'text-2', style: 'margin-top:0' }, 'Enter your account email. If it exists, a reset link will be sent through the configured email provider.'),
        App.field('Email address', em, { required: true }), done,
        h('div', { class: 'm-foot', style: 'border:none;padding:8px 0 0' }, h('button', { class: 'btn primary', type: 'submit' }, 'Send reset link'))));
    }
  };

  App.pages.reset = async () => {
    const token = new URLSearchParams(location.search).get('token') || '';
    const pw = h('input', { type: 'password', class: 'f-input', required: true });
    const msg = h('div', { style: 'display:none' });
    mount(h('div', { class: 'login-wrap' }, h('div', { class: 'card login-card' },
      h('div', { class: 'brand-lg' }, h('b', {}, 'Set a new password')),
      !token ? App.errorBanner('Reset link is missing its token. Request a new one from the login page.')
        : h('form', {
          onSubmit: async (e) => {
            e.preventDefault();
            try {
              const r = await api('/api/auth/reset', { method: 'POST', body: { token, password: pw.value } });
              msg.className = 'info-banner'; msg.textContent = r.message; msg.style.display = 'block';
              setTimeout(() => App.navigate('/login'), 1800);
            } catch (ex) { msg.className = 'error-banner'; msg.textContent = ex.message; msg.style.display = 'block'; }
          },
        },
          App.field('New password', pw, { required: true }), msg,
          h('button', { class: 'btn primary', type: 'submit', style: 'margin-top:8px' }, 'Update password')))));
  };

  /* ----------------------------- data helpers --------------------------- */
  App.loadMeta = async () => {
    App.state.meta = await api('/api/meta');
    return App.state.meta;
  };
  App.sectionOptions = (departmentId) => (App.state.meta?.sections || [])
    .filter((s) => !departmentId || String(s.department_id) === String(departmentId))
    .map((s) => ({ value: s.id, label: `${s.department_name.split(' ')[0]} · Sem ${s.semester} · ${s.name}` }));
  App.departmentOptions = () => (App.state.meta?.departments || []).map((d) => ({ value: d.id, label: d.name }));
  App.subjectOptions = (filters = {}) => {
    const params = new URLSearchParams();
    if (filters.section_id) params.set('section_id', filters.section_id);
    if (filters.department_id) params.set('department_id', filters.department_id);
    return api(`/api/subjects?${params}&page_size=500`).then((r) => r.rows);
  };

  /* ------------------------------ dashboard ----------------------------- */
  App.pages.dashboard = async () => {
    const { root, content } = App.shell('/dashboard', 'Dashboard', App.state.settings.institution_name || '', []);
    mount(root);
    content.append(App.loading('Loading dashboard…'));
    let d;
    try { d = await api('/api/dashboard'); } catch (e) { content.replaceChildren(App.errorBanner(e.message)); return; }
    content.replaceChildren();
    const th = d.threshold;
    const stat = (label, value, note, accent, iconName, href) =>
      h('div', { class: `card stat-card ${accent || ''}`, role: href ? 'link' : null, style: href ? 'cursor:pointer' : '', onClick: href ? () => App.navigate(href) : null },
        h('div', { class: 's-label' }, iconName ? h('span', { html: icon(iconName, 14) }) : null, label),
        h('div', { class: 's-value' }, value),
        note ? h('div', { class: 's-note' }, note) : null);

    content.append(
      h('div', { class: 'grid stats' },
        stat('Total students', d.cards.students?.toLocaleString('en-IN') ?? '0', `${d.cards.teachers} teachers · ${d.cards.subjects} subjects`, '', 'users', '/students'),
        stat('Present today', d.cards.present_today?.toLocaleString('en-IN') ?? '0', `on ${fmtDate(d.today)}`, 'accent-green', 'check', `/attendance?date=${d.today}&status=P`),
        stat('Absent today', d.cards.absent_today?.toLocaleString('en-IN') ?? '0', `on ${fmtDate(d.today)}`, d.cards.absent_today ? 'accent-red' : '', 'x', `/attendance?date=${d.today}&status=A`),
        stat('Average attendance', fmtPct(d.cards.average_bp), 'institution-wide, weighted', App.pctClass(d.cards.average_bp, th) === 'green' ? 'accent-green' : 'accent-amber', 'clipboard'),
        stat(`Below ${th}% threshold`, d.cards.below_threshold?.toLocaleString('en-IN') ?? '0', 'students needing attention', d.cards.below_threshold ? 'accent-red' : '', 'alert', '/defaulters'),
        stat('Notifications sent', (d.cards.notifications_sent ?? 0).toLocaleString('en-IN'), `${d.cards.notifications_failed || 0} failed`, d.cards.notifications_failed ? 'accent-amber' : 'accent-blue', 'bell', '/notifications')),

      h('div', { class: 'grid charts' },
        chartCard('Attendance distribution', 'How many students sit in each band? Lower bands need action first.',
          App.barChart([
            { label: '<50%', value: d.distribution.b50 }, { label: '50–60', value: d.distribution.b60 },
            { label: '60–70', value: d.distribution.b70 }, { label: '70–75', value: d.distribution.b75 },
            { label: '75–80', value: d.distribution.b80 }, { label: '80–90', value: d.distribution.b90 },
            { label: '90–100', value: d.distribution.b100 },
          ], { accentFn: (b) => ({ '<50%': 'var(--red)', '50–60': 'var(--red)', '60–70': 'var(--amber)', '70–75': 'var(--amber)', '75–80': 'var(--blue)', '80–90': 'var(--green)', '90–100': 'var(--green)' })[b.label] })),
        chartCard('Daily presence — last 3 weeks', 'Are classes being attended better or worse lately?',
          App.lineChart(d.trend.map((t) => ({ label: t.date.slice(5), value: t.pct_bp === null ? 0 : t.pct_bp / 100 })), { format: (v) => `${Math.round(v)}%`, baseline: 40 })),
        chartCard('Department comparison', `Which departments fall below the ${th}% mark?`,
          App.barChart(d.departments.map((x) => ({
            label: x.name.split(' ').map((w) => w[0]).join(''), full: x.name, value: Math.round((x.pct_bp || 0) / 100), below: (x.pct_bp || 0) < th * 100,
          })), { format: (v) => `${v}%`, accentFn: (b) => (b.below ? 'var(--red)' : 'var(--green)') })),
        chartCard('Weakest subjects', 'Subjects with the lowest attendance right now.',
          App.barChart(d.subjects.map((x) => ({ label: x.code, full: x.name, value: Math.round((x.pct_bp || 0) / 100), below: (x.pct_bp || 0) < th * 100 })),
            { format: (v) => `${v}%`, accentFn: (b) => (b.below ? 'var(--red)' : 'var(--green)') })),
        chartCard('Monthly trend', 'Attendance percentage per month.',
          App.lineChart(d.monthly.map((m) => ({ label: m.month, value: (m.pct_bp || 0) / 100 })), { format: (v) => `${Math.round(v)}%`, baseline: 50 }))));

    function chartCard(title, sub, chart) {
      return h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, title), h('div', { class: 'sub-text', style: 'font-size:11.8px' }, sub))),
        h('div', { class: 'card-body', style: 'min-height:200px' }, chart));
    }
  };

  /* ------------------------------- students ------------------------------ */
  App.pages.students = async () => {
    const q = new URLSearchParams(location.search);
    const filters = {
      q: q.get('q') || '', department_id: q.get('department_id') || '', semester: q.get('semester') || '',
      section_id: q.get('section_id') || '', status: q.get('status') || '', batch: q.get('batch') || '',
      page: Number(q.get('page')) || 1,
    };
    const isAdmin = App.state.user.role === 'admin';
    const actions = [];
    if (isAdmin) {
      actions.push(
        h('button', { class: 'btn secondary', onClick: () => importStudentsDialog(), html: App.icon('upload', 15) + ' Import CSV' }),
        h('button', { class: 'btn secondary', onClick: () => downloadStudents(), html: App.icon('download', 15) + ' Export' }),
        h('button', { class: 'btn primary', onClick: () => App.studentForm(null, () => reload()), html: App.icon('plus', 15) + ' Add student' }));
    }
    const { root, content } = App.shell('/students', 'Students', 'Manage enrollment, sections and guardian contacts', actions);
    mount(root);

    const search = h('input', { class: 'f-input', value: filters.q, placeholder: 'Name, roll no, enrollment, parent…', onInput: App.debounce((e) => { filters.q = e.target.value; filters.page = 1; reload(); }, 350) });
    const deptSel = App.select(App.departmentOptions(), { value: filters.department_id, placeholder: 'All departments', onChange: (v) => { filters.department_id = v; filters.section_id = ''; filters.page = 1; rebuildSections(); reload(); } });
    const semSel = App.select([1, 2, 3, 4, 5, 6, 7, 8].map((s) => ({ value: s, label: `Semester ${s}` })), { value: filters.semester, placeholder: 'All semesters', onChange: (v) => { filters.semester = v; filters.page = 1; reload(); } });
    function rebuildSections() {
      return App.select(App.sectionOptions(filters.department_id), { value: '', placeholder: 'All sections', onChange: (v) => { filters.section_id = v; filters.page = 1; reload(); } });
    }
    let secSel = rebuildSections();
    const statusSel = App.select(['active', 'inactive', 'graduated', 'transferred'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })), { value: filters.status, placeholder: 'All statuses', onChange: (v) => { filters.status = v; filters.page = 1; reload(); } });
    const batchSel = App.select((App.state.meta.batches || []).map((b) => ({ value: b, label: `Batch ${b}` })), { value: filters.batch, placeholder: 'All batches', onChange: (v) => { filters.batch = v; filters.page = 1; reload(); } });
    const secHolder = h('div', { class: 'field' }, h('label', {}, 'Section'), secSel);
    const origRebuild = rebuildSections;
    deptSel.addEventListener('change', () => { const n = origRebuild(); secHolder.replaceChildren(h('label', {}, 'Section'), n); });

    const bar = h('div', { class: 'filter-bar' },
      h('div', { class: 'field grow' }, h('label', {}, 'Search'), search),
      h('div', { class: 'field' }, h('label', {}, 'Department'), deptSel),
      h('div', { class: 'field' }, h('label', {}, 'Semester'), semSel),
      secHolder,
      h('div', { class: 'field' }, h('label', {}, 'Batch'), batchSel),
      h('div', { class: 'field' }, h('label', {}, 'Status'), statusSel),
      h('button', { class: 'btn secondary', onClick: () => { App.navigate('/students'); } }, 'Clear'));

    const listBox = h('div', { class: 'card' });
    content.append(bar, listBox);

    async function reload() {
      listBox.replaceChildren(App.loading());
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v !== '' && v !== null) params.set(k, v); });
      params.set('page_size', '25');
      let r;
      try { r = await api(`/api/students?${params}`); } catch (e) { listBox.replaceChildren(App.errorBanner(e.message)); return; }
      if (!r.rows.length) { listBox.replaceChildren(App.empty('No students found', 'Adjust filters or add/import students.', '👥')); return; }
      const rows = r.rows.map((s) => ({
        __cells: [
          h('span', { class: 'mono strong' }, s.roll_no),
          h('span', { class: 'mono' }, s.enrollment_no),
          h('span', { class: 'strong' }, s.full_name),
          h('span', {}, s.department_name.split(' ')[0]),
          `Sem ${s.semester}`, s.section_name,
          s.parent_name ? h('div', {}, h('div', {}, s.parent_name), h('div', { class: 'sub-text' }, s.parent_phone || s.parent_email || '')) : h('span', { class: 'badge amber' }, 'no guardian'),
          h('span', { class: `badge ${s.status === 'active' ? 'green' : 'grey'}` }, s.status),
        ],
        id: s.id,
      }));
      listBox.replaceChildren(
        App.table(['Roll', 'Enrollment', 'Name', 'Dept', 'Sem', 'Sec', 'Guardian', 'Status'], rows, { onRow: (r0) => App.navigate(`/students/${r0.id}`), ariaLabel: 'Students' }),
        App.pagination({ total: r.total, page: r.page, size: r.size, onPage: (p) => { filters.page = p; reload(); } }));
    }
    await reload();

    async function downloadStudents() {
      try {
        await api.download('/api/students-export.csv?' + new URLSearchParams(Object.entries(filters).filter(([, v]) => v)));
        App.toast('Export started', 'students.csv is downloading.', 'success');
      } catch (e) { App.toast('Export failed', e.message, 'error'); }
    }

    function importStudentsDialog() {
      const file = h('input', { type: 'file', class: 'f-input', accept: '.csv' });
      const out = h('div', { style: 'display:none' });
      App.modal('Bulk import students (CSV)', h('div', {},
        h('div', { class: 'details-box mb' },
          h('b', {}, 'Required columns: '), h('code', {}, 'roll_no, full_name, department_code, semester, section_name'),
          h('div', { class: 'sub-text mt' }, 'Optional: enrollment_no, dob, gender, batch, email, phone, parent_name, parent_phone, parent_email, admission_year. Rows are upserted by enrollment_no.')),
        App.field('CSV file', file, { required: true }), out),
        [
          { label: 'Cancel', kind: 'secondary', onClick: () => { } },
          {
            label: 'Import', kind: 'primary', onClick: async () => {
              if (!file.files.length) { App.toast('Choose a file first', '', 'warning'); return false; }
              try {
                const fd = new FormData(); fd.append('file', file.files[0]);
                const r = await api('/api/students/import', { method: 'POST', formData: fd });
                out.style.display = 'block';
                out.replaceChildren(h('div', { class: 'info-banner' },
                  `Done: ${r.inserted} inserted, ${r.updated} updated, ${r.errors.length} error(s) out of ${r.total} rows.`,
                  r.errors.length ? h('div', { class: 'mt' }, r.errors.slice(0, 8).map((e2) => h('div', { class: 'mono' }, `Row ${e2.row}: ${e2.message}`))) : null));
                if (r.inserted || r.updated) { reload(); App.loadMeta(); }
                return false;
              } catch (e) { out.style.display = 'block'; out.replaceChildren(App.errorBanner(e.message)); return false; }
            },
          },
        ]);
    }
  };

  /* ---- shared student create/edit form (admin) ---- */
  App.studentForm = (existing, onSaved) => {
    const s = existing || {};
    const F = (key, type = 'text') => h('input', { class: 'f-input', type, value: s[key] ?? '' });
    const roll = F('roll_no'), name = F('full_name'), enr = F('enrollment_no'), dob = F('dob', 'date');
    const email = F('email', 'email'), phone = F('phone'), batch = F('batch');
    const pName = F('parent_name'), pPhone = F('parent_phone'), pEmail = F('parent_email', 'email');
    const year = F('admission_year', 'number');
    const gender = App.select([{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }], { value: s.gender || '', placeholder: '—' });
    const dept = App.select(App.departmentOptions(), { value: s.department_id || '', placeholder: 'Select department' });
    const sem = App.select([1, 2, 3, 4, 5, 6, 7, 8].map((x) => ({ value: x, label: `Semester ${x}` })), { value: s.semester || '', placeholder: 'Select' });
    const secHolder = h('select', { class: 'f-select' });
    const status = App.select(['active', 'inactive', 'graduated', 'transferred'].map((x) => ({ value: x, label: x })), { value: s.status || 'active' });
    function rebuildSec() {
      secHolder.replaceChildren(h('option', { value: '' }, 'Select section'));
      App.sectionOptions(dept.value).forEach((o) => {
        const opt = h('option', { value: o.value }, o.label);
        if (String(o.value) === String(s.section_id)) opt.selected = true;
        secHolder.append(opt);
      });
    }
    dept.addEventListener('change', rebuildSec);
    rebuildSec();
    const err = h('div', { class: 'error-banner', style: 'display:none' });
    App.modal(existing ? `Edit — ${s.full_name}` : 'Add student', h('div', {},
      h('div', { class: 'form-grid' },
        App.field('Roll No', roll, { required: true }), App.field('Enrollment No', enr, { required: true }),
        App.field('Full name', name, { required: true }), App.field('Gender', gender),
        App.field('Date of birth', dob), App.field('Admission year', year),
        App.field('Department', dept, { required: true }), App.field('Semester', sem, { required: true }),
        App.field('Section', secHolder, { required: true }), App.field('Batch', batch),
        App.field('Student email', email), App.field('Student phone', phone),
        App.field('Parent/Guardian name', pName), App.field('Parent phone', pPhone),
        App.field('Parent email', pEmail), App.field('Status', status)),
      err), [
      { label: 'Cancel', kind: 'secondary', onClick: () => { } },
      {
        label: existing ? 'Save changes' : 'Create student', kind: 'primary',
        onClick: async () => {
          err.style.display = 'none';
          try {
            const body = {
              roll_no: roll.value, full_name: name.value, enrollment_no: enr.value,
              dob: dob.value || null, gender: gender.value || null, department_id: Number(dept.value),
              semester: Number(sem.value), section_id: Number(secHolder.value), batch: batch.value || null,
              email: email.value || null, phone: phone.value || null,
              parent_name: pName.value || null, parent_phone: pPhone.value || null, parent_email: pEmail.value || null,
              admission_year: year.value ? Number(year.value) : null, status: status.value,
            };
            if (existing) await api(`/api/students/${s.id}`, { method: 'PUT', body });
            else await api('/api/students', { method: 'POST', body });
            App.toast(existing ? 'Student updated' : 'Student created', body.full_name, 'success');
            if (onSaved) onSaved();
          } catch (e2) { err.textContent = e2.message; err.style.display = 'block'; return false; }
        },
      },
    ], { wide: true });
  };

  /* --------------------------- student profile --------------------------- */
  App.pages.studentProfile = async (id) => {
    const { root, content } = App.shell('/students', 'Student profile', '', []);
    mount(root);
    content.append(App.loading());
    let d;
    try { d = await api(`/api/students/${id}`); } catch (e) { content.replaceChildren(App.errorBanner(e.message)); return; }
    content.replaceChildren();
    const s = d.student;
    const isAdmin = App.state.user.role === 'admin';
    const th = App.threshold();

    const overallCls = App.pctClass(d.overall.pct_bp, th);
    content.append(h('div', { class: 'card mb' }, h('div', { class: 'card-body flex wrap' },
      h('div', { class: 'avatar', style: 'width:54px;height:54px;font-size:19px' }, s.full_name.split(' ').map((x) => x[0]).slice(0, 2).join('')),
      h('div', { class: 'grow' },
        h('div', { class: 'flex wrap', style: 'gap:9px' },
          h('h1', { style: 'margin:0;font-size:19px' }, s.full_name),
          h('span', { class: `badge ${s.status === 'active' ? 'green' : 'grey'}` }, s.status)),
        h('div', { class: 'text-2', style: 'margin-top:3px' },
          `Roll ${s.roll_no} · ${s.enrollment_no} · ${s.department_name} — Semester ${s.semester}, Section ${s.section_name} · Batch ${s.batch || '—'}`)),
      h('div', { style: 'text-align:right' },
        h('div', { class: 'sub-text' }, 'Overall attendance'),
        h('div', { class: `badge ${overallCls}`, style: 'font-size:19px;padding:6px 16px' }, fmtPct(d.overall.pct_bp)),
        h('div', { class: 'sub-text', style: 'margin-top:3px' }, `${d.overall.present}/${d.overall.applicable} classes`)),
      isAdmin ? h('div', { class: 'flex' },
        h('button', { class: 'btn small secondary', onClick: () => App.studentForm(s, () => App.route()), html: App.icon('edit', 14) + ' Edit' }),
        s.status === 'active'
          ? h('button', {
            class: 'btn small danger', onClick: async () => {
              if (await App.confirm('Deactivate student?', `${s.full_name} will be marked inactive. Historical attendance is preserved.`)) {
                await api(`/api/students/${s.id}`, { method: 'DELETE' }); App.toast('Student deactivated', '', 'success'); App.route();
              }
            },
          }, 'Deactivate')
          : null)
        : null)));

    const infoCol = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Details')),
      h('div', { class: 'card-body' },
        h('dl', { class: 'kv' },
          h('dt', {}, 'Email'), h('dd', {}, s.email || '—'),
          h('dt', {}, 'Phone'), h('dd', {}, s.phone || '—'),
          h('dt', {}, 'Gender'), h('dd', {}, s.gender || '—'),
          h('dt', {}, 'Date of birth'), h('dd', {}, fmtDate(s.dob)),
          h('dt', {}, 'Joined'), h('dd', {}, s.joined_date ? fmtDate(s.joined_date) : '—'),
          h('dt', {}, 'Admission year'), h('dd', {}, s.admission_year || '—')),
        h('div', { class: 'divider' }),
        h('h3', { style: 'margin:0 0 8px;font-size:14px' }, 'Guardian'),
        s.parent_name
          ? h('dl', { class: 'kv' },
            h('dt', {}, 'Name'), h('dd', {}, s.parent_name),
            h('dt', {}, 'Phone'), h('dd', {}, s.parent_phone || '—'),
            h('dt', {}, 'Email'), h('dd', {}, s.parent_email || '—'))
          : h('div', { class: 'warn-banner', style: 'margin:0' }, 'No guardian contact on file — notifications cannot be delivered.')));

    content.append(h('div', { class: 'grid two' },
      h('div', {},
        h('div', { class: 'card mb' },
          h('div', { class: 'card-head' }, h('h3', {}, 'Subject-wise attendance')),
          h('div', { class: 'card-body flush' },
            d.by_subject.length
              ? App.table(['Subject', 'Present', 'Absent', 'Excused', 'Classes', 'Attendance'], d.by_subject.map((b) => ({
                __cells: [
                  h('div', {}, h('span', { class: 'strong' }, b.code), h('div', { class: 'sub-text' }, b.name)),
                  h('span', { class: 'num mono' }, String(b.present)),
                  h('span', { class: 'num mono' }, String(b.absent)),
                  h('span', { class: 'num mono' }, String(b.excused)),
                  h('span', { class: 'num mono' }, String(b.applicable)),
                  pctBar(b.pct_bp)],
              })), { ariaLabel: 'Subject attendance' })
              : App.empty('No attendance recorded', 'Attendance will appear here once classes are marked.'))),
        calendarCard(d),
        notificationsCard(d),
        changesCard(d)),
      h('div', {}, infoCol)));

    function calendarCard(d2) {
      const holder = h('div', { class: 'card-body' });
      renderMonth(App.todayLocal().slice(0, 7));
      function renderMonth(ym) {
        const [Y, M] = ym.split('-').map(Number);
        const first = new Date(Date.UTC(Y, M - 1, 1));
        const startDow = (first.getUTCDay() + 6) % 7;
        const days = new Date(Date.UTC(Y, M, 0)).getUTCDate();
        const byDate = {};
        d2.month_records.forEach((r) => { (byDate[r.date] = byDate[r.date] || []).push(r); });
        const grid = h('div', { class: 'cal' },
          ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => h('div', { class: 'cal-dow' }, w)),
          Array.from({ length: startDow }, () => h('div', { class: 'cal-cell empty' })),
          Array.from({ length: days }, (_, i) => {
            const date = `${ym}-${String(i + 1).padStart(2, '0')}`;
            const marks = byDate[date] || [];
            return h('div', {
              class: `cal-cell ${marks.length ? 'has-marks' : ''}`,
              onClick: marks.length ? () => dayDetail(date, marks) : null,
              attrs: { 'aria-label': `${App.fmtDate(date)}: ${marks.length ? marks.map((m) => m.status).join(', ') : 'no records'}` },
            },
              h('span', { class: marks.length ? 'strong' : 'text-3' }, String(i + 1)),
              h('span', { class: 'marks' }, marks.slice(0, 4).map((m) => h('span', { class: `mark ${m.status}` }, m.status))));
          }));
        const monthName = first.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        holder.replaceChildren(
          h('div', { class: 'flex mb' },
            h('button', { class: 'btn small secondary', onClick: () => renderMonth(shift(ym, -1)) }, '‹'),
            h('b', { class: 'grow', style: 'text-align:center' }, monthName),
            h('button', { class: 'btn small secondary', onClick: () => renderMonth(shift(ym, 1)) }, '›')),
          grid,
          h('div', { class: 'cal-legend' },
            [['P', 'Present'], ['A', 'Absent'], ['E', 'Excused'], ['H', 'Holiday'], ['C', 'Cancelled']]
              .map(([k, v]) => h('span', {}, h('span', { class: `mark ${k}` }), v)),
            h('span', { class: 'text-3' }, '(last ~2 months of records)')));
      }
      function shift(ym, delta) { const [Y, M] = ym.split('-').map(Number); const dt = new Date(Date.UTC(Y, M - 1 + delta, 1)); return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`; }
      function dayDetail(date, marks) {
        App.modal(`Attendance — ${App.fmtDate(date)}`, h('div', {}, marks.map((m) =>
          h('div', { class: 'flex', style: 'padding:7px 0;border-bottom:1px solid var(--border)' },
            statusBadge(m.status),
            h('div', { class: 'grow' }, h('b', {}, `${m.subject_code} — ${m.subject_name}`), h('div', { class: 'sub-text' }, `Period ${m.period}`)),
            m.updated_at ? h('span', { class: 'sub-text' }, `edited ${fmtDateTime(m.updated_at)}`) : null))), []);
      }
      return h('div', { class: 'card mb' }, h('div', { class: 'card-head' }, h('h3', {}, 'Attendance calendar')), holder);
    }

    function notificationsCard(d2) {
      return h('div', { class: 'card mb' }, h('div', { class: 'card-head' }, h('h3', {}, 'Notification history')),
        h('div', { class: 'card-body flush' }, d2.notifications.length
          ? App.table(['Date', 'Channel', 'Subject', 'At %', 'Status'], d2.notifications.map((n) => ({
            __cells: [fmtDateTime(n.created_at), h('span', { class: 'badge blue' }, n.channel), n.subject_code || 'ALL',
            h('span', { class: 'mono' }, fmtPct(n.attendance_bp)), App.notifStatusBadge(n)],
          })))
          : App.empty('No notifications yet', 'Parent notifications for this student will appear here.')));
    }
    function changesCard(d2) {
      return h('div', { class: 'card mb' }, h('div', { class: 'card-head' }, h('h3', {}, 'Change history (audit)')),
        h('div', { class: 'card-body flush' }, d2.changes.length
          ? App.table(['When', 'Subject', 'Date', 'Change', 'By', 'Reason'], d2.changes.map((c) => ({
            __cells: [fmtDateTime(c.created_at), c.subject_code, App.fmtDate(c.date),
            h('span', {}, c.old_status ? statusBadge(c.old_status) : '∅', ' → ', statusBadge(c.new_status)),
            c.changed_by || 'system', c.reason || '—'],
          })))
          : App.empty('No manual changes', 'Attendance corrections will be logged here with the actor and reason.')));
    }
  };

  App.notifStatusBadge = (n) => {
    const map = { sent: 'green', delivered: 'green', pending: 'blue', failed: 'red', skipped: 'amber' };
    const badge = h('span', { class: `badge ${map[n.status] || 'grey'}` }, h('span', { class: 'dot' }), n.status);
    if (n.error) badge.title = n.error;
    return badge;
  };
})(window.App);
