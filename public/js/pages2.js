'use strict';
/* ═══ Pages 2: subjects, records, take attendance, import, defaulters ═══ */
(function (App) {
  const { h, api, icon, esc, fmtPct, fmtDate, fmtDateTime, statusBadge, pctBar, mount } = App;

  /* ------------------------------- subjects ------------------------------ */
  App.pages.subjects = async () => {
    const isAdmin = App.state.user.role === 'admin';
    const actions = isAdmin ? [h('button', { class: 'btn primary', onClick: () => subjectForm(null), html: icon('plus', 15) + ' Add subject' })] : [];
    const { root, content } = App.shell('/subjects', 'Subjects', isAdmin ? 'Subjects and their assigned teachers' : 'Subjects assigned to you', actions);
    mount(root);
    content.append(App.loading());
    let r;
    try { r = await api('/api/subjects?page_size=200'); } catch (e) { content.replaceChildren(App.errorBanner(e.message)); return; }
    content.replaceChildren();
    if (!r.rows.length) {
      content.append(h('div', { class: 'card' }, App.empty('No subjects yet', isAdmin ? 'Create a subject to start taking attendance.' : 'No subjects are assigned to you yet — ask an admin.', '📚')));
      return;
    }
    const grid = h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fill,minmax(320px,1fr))' });
    for (const s of r.rows) {
      grid.append(h('div', { class: 'card' },
        h('div', { class: 'card-body' },
          h('div', { class: 'flex', style: 'align-items:flex-start' },
            h('div', { class: 'grow' },
              h('div', { class: 'flex', style: 'gap:8px' },
                h('span', { class: 'badge blue' }, s.code),
                h('span', { class: `badge ${s.status === 'active' ? 'green' : 'grey'}` }, s.status)),
              h('div', { style: 'font-weight:700;font-size:15px;margin-top:6px' }, s.name),
              h('div', { class: 'sub-text' }, `${s.department_name} · Semester ${s.semester} · Section ${s.section_name}`),
              h('div', { class: 'sub-text' }, `${s.teacher_name || 'No teacher'} · ${s.credits} credits · ${s.academic_year || ''}`)),
            isAdmin ? h('button', { class: 'icon-btn', title: 'Edit subject', onClick: () => subjectForm(s), html: icon('edit', 15) }) : null),
          h('div', { class: 'flex mt', style: 'gap:14px' },
            h('span', { class: 'sub-text' }, h('b', { class: 'text-2' }, String(s.student_count)), ' students'),
            h('span', { class: 'sub-text' }, h('b', { class: 'text-2' }, String(s.classes_held)), ' class days held')),
          h('div', { class: 'flex mt' },
            h('button', { class: 'btn small secondary', onClick: () => App.navigate(`/attendance/take?subject_id=${s.id}`) }, 'Take attendance'),
            h('button', { class: 'btn small secondary', onClick: () => App.navigate(`/attendance/import?subject_id=${s.id}`) }, 'Import sheet'),
            h('button', { class: 'btn small ghost', onClick: () => App.navigate(`/attendance?subject_id=${s.id}`) }, 'Records')))));
    }
    content.append(grid);

    function subjectForm(existing) {
      const s = existing || {};
      const code = h('input', { class: 'f-input', value: s.code || '', placeholder: 'e.g. CS401' });
      const name = h('input', { class: 'f-input', value: s.name || '', placeholder: 'e.g. Operating Systems' });
      const dept = App.select(App.departmentOptions(), { value: s.department_id || '', placeholder: 'Select department' });
      const sem = App.select([1, 2, 3, 4, 5, 6, 7, 8].map((x) => ({ value: x, label: `Semester ${x}` })), { value: s.semester || '', placeholder: 'Select' });
      const sec = h('select', { class: 'f-select' });
      const credits = h('input', { class: 'f-input', type: 'number', min: 0, max: 30, value: s.credits ?? 3 });
      const teacher = h('select', { class: 'f-select' });
      const statusSel = App.select([{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }], { value: s.status || 'active' });
      function rebuildSec() {
        sec.replaceChildren(h('option', { value: '' }, 'Select section'));
        App.sectionOptions(dept.value).forEach((o) => {
          const opt = h('option', { value: o.value }, o.label);
          if (String(o.value) === String(s.section_id)) opt.selected = true;
          sec.append(opt);
        });
      }
      dept.addEventListener('change', rebuildSec); rebuildSec();
      api('/api/users?role=teacher&page_size=200').then((u) => {
        teacher.replaceChildren(h('option', { value: '' }, 'Unassigned'));
        u.rows.forEach((t) => {
          const opt = h('option', { value: t.id }, `${t.name} (${t.email})`);
          if (t.id === s.teacher_id) opt.selected = true;
          teacher.append(opt);
        });
      }).catch(() => { });
      const err = h('div', { class: 'error-banner', style: 'display:none' });
      App.modal(existing ? `Edit — ${s.code}` : 'Add subject', h('div', {},
        h('div', { class: 'form-grid' },
          App.field('Subject code', code, { required: true }), App.field('Subject name', name, { required: true }),
          App.field('Department', dept, { required: true }), App.field('Semester', sem, { required: true }),
          App.field('Section', sec, { required: true }), App.field('Credits', credits),
          App.field('Teacher', teacher), App.field('Status', statusSel)), err), [
        { label: 'Cancel', kind: 'secondary', onClick: () => { } },
        {
          label: existing ? 'Save' : 'Create', kind: 'primary', onClick: async () => {
            err.style.display = 'none';
            try {
              const body = {
                code: code.value, name: name.value, department_id: Number(dept.value),
                semester: Number(sem.value), section_id: Number(sec.value),
                teacher_id: teacher.value ? Number(teacher.value) : null,
                credits: Number(credits.value), status: statusSel.value,
                academic_year: App.state.settings.academic_year || null,
              };
              if (existing) await api(`/api/subjects/${s.id}`, { method: 'PUT', body });
              else await api('/api/subjects', { method: 'POST', body });
              App.toast('Subject saved', `${body.code} — ${body.name}`, 'success');
              App.route();
            } catch (e) { err.textContent = e.message; err.style.display = 'block'; return false; }
          },
        },
      ]);
    }
  };

  /* ------------------------- attendance records --------------------------- */
  App.pages.attendanceRecords = async () => {
    const q = new URLSearchParams(location.search);
    const filters = {
      q: q.get('q') || '', subject_id: q.get('subject_id') || '', section_id: q.get('section_id') || '',
      department_id: q.get('department_id') || '', semester: q.get('semester') || '',
      status: q.get('status') || '', date: q.get('date') || '', from: q.get('from') || '', to: q.get('to') || '',
      page: 1,
    };
    const { root, content } = App.shell('/attendance', 'Attendance Records', 'Browse, filter and correct individual attendance events', []);
    mount(root);
    let subjects = [];
    try { subjects = (await api('/api/subjects?page_size=500')).rows; } catch { }

    const search = h('input', { class: 'f-input', value: filters.q, placeholder: 'Student / roll…', onInput: App.debounce((e) => { filters.q = e.target.value; filters.page = 1; reload(); }, 350) });
    const subSel = App.select(subjects.map((s) => ({ value: s.id, label: `${s.code} · ${s.name} (Sem ${s.semester}${s.section_name})` })),
      { value: filters.subject_id, placeholder: 'All subjects', onChange: (v) => { filters.subject_id = v; filters.page = 1; reload(); } });
    const statusSel = App.select(['P', 'A', 'E', 'H', 'C'].map((x) => ({ value: x, label: { P: 'Present', A: 'Absent', E: 'Excused', H: 'Holiday', C: 'Cancelled' }[x] })),
      { value: filters.status, placeholder: 'Any status', onChange: (v) => { filters.status = v; filters.page = 1; reload(); } });
    const dateI = h('input', { class: 'f-input', type: 'date', value: filters.date, onChange: (e) => { filters.date = e.target.value; filters.page = 1; reload(); } });
    const fromI = h('input', { class: 'f-input', type: 'date', value: filters.from, onChange: (e) => { filters.from = e.target.value; filters.page = 1; reload(); } });
    const toI = h('input', { class: 'f-input', type: 'date', value: filters.to, onChange: (e) => { filters.to = e.target.value; filters.page = 1; reload(); } });

    const listBox = h('div', { class: 'card' });
    content.append(
      h('div', { class: 'filter-bar' },
        h('div', { class: 'field grow' }, h('label', {}, 'Search'), search),
        h('div', { class: 'field', style: 'min-width:230px' }, h('label', {}, 'Subject'), subSel),
        h('div', { class: 'field' }, h('label', {}, 'Status'), statusSel),
        h('div', { class: 'field' }, h('label', {}, 'Exact date'), dateI),
        h('div', { class: 'field' }, h('label', {}, 'From'), fromI),
        h('div', { class: 'field' }, h('label', {}, 'To'), toI),
        h('button', { class: 'btn secondary', onClick: () => App.navigate('/attendance') }, 'Clear')),
      listBox);

    async function reload() {
      listBox.replaceChildren(App.loading());
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
      params.set('page_size', '50');
      let r;
      try { r = await api(`/api/attendance?${params}`); } catch (e) { listBox.replaceChildren(App.errorBanner(e.message)); return; }
      if (!r.rows.length) { listBox.replaceChildren(App.empty('No records match', 'Try widening the filters, or take attendance for this class.', '🗓')); return; }
      listBox.replaceChildren(
        App.table(['Date', 'Period', 'Roll', 'Student', 'Subject', 'Status', 'Source', ''], r.rows.map((a) => ({
          __cells: [
            h('span', { class: 'strong' }, App.fmtDate(a.date)),
            h('span', { class: 'mono' }, `P${a.period}`),
            h('span', { class: 'mono' }, a.roll_no),
            h('a', { href: `/students/${a.student_id}`, onClick: (e) => { e.preventDefault(); e.stopPropagation(); App.navigate(`/students/${a.student_id}`); } }, a.full_name),
            h('span', {}, h('b', {}, a.subject_code), ' ', h('span', { class: 'sub-text' }, a.subject_name)),
            statusBadge(a.status),
            h('span', { class: `badge ${a.source === 'import' ? 'purple' : 'outline'}` }, a.source),
            h('button', { class: 'btn small secondary', onClick: () => editRecord(a) }, 'Edit')],
        })), { ariaLabel: 'Attendance records' }),
        App.pagination({ total: r.total, page: r.page, size: r.size, onPage: (p) => { filters.page = p; reload(); } }));
    }
    await reload();

    function editRecord(a) {
      const sel = App.select(['P', 'A', 'E', 'H', 'C'].map((x) => ({ value: x, label: { P: 'Present', A: 'Absent', E: 'Excused', H: 'Holiday', C: 'Cancelled' }[x] })), { value: a.status });
      const reason = h('input', { class: 'f-input', placeholder: 'e.g. Medical document submitted' });
      const isAdmin = App.state.user.role === 'admin';
      App.modal(`Correct attendance`, h('div', {},
        h('div', { class: 'details-box mb' },
          h('dl', { class: 'kv' },
            h('dt', {}, 'Student'), h('dd', {}, `${a.full_name} (Roll ${a.roll_no})`),
            h('dt', {}, 'Subject'), h('dd', {}, `${a.subject_code} — ${a.subject_name}`),
            h('dt', {}, 'Date'), h('dd', {}, `${App.fmtDate(a.date)} · Period ${a.period}`),
            h('dt', {}, 'Current'), h('dd', {}, statusBadge(a.status)))),
        App.field('Change to', sel, { required: true }),
        App.field('Reason (optional, stored in audit)', reason),
        h('div', { class: 'hint', style: 'font-size:11.8px;color:var(--text-3)' },
          'The change is written to the audit log and the student’s change history; notification rules are re-evaluated automatically.')), [
        { label: 'Cancel', kind: 'secondary', onClick: () => { } },
        ...(isAdmin ? [{
          label: 'Delete record', kind: 'danger', onClick: async () => {
            if (await App.confirm('Delete this attendance record?', 'This removes the record permanently; the deletion itself is audited.', 'Delete', 'danger')) {
              await api(`/api/attendance/${a.id}`, { method: 'DELETE' });
              App.toast('Record deleted', '', 'success'); reload();
            }
            return true;
          },
        }] : []),
        {
          label: 'Save correction', kind: 'primary', onClick: async () => {
            try {
              await api(`/api/attendance/${a.id}`, { method: 'PUT', body: { status: sel.value, reason: reason.value || null } });
              App.toast('Attendance corrected', `${a.full_name} — ${App.fmtDate(a.date)}: ${a.status} → ${sel.value}`, 'success');
              reload();
            } catch (e) { App.toast('Save failed', e.message, 'error'); return false; }
          },
        },
      ]);
    }
  };

  /* --------------------------- take attendance ---------------------------- */
  App.pages.takeAttendance = async () => {
    const q = new URLSearchParams(location.search);
    const { root, content } = App.shell('/attendance/take', 'Take Attendance', 'Mark today’s class — or correct a past one', []);
    mount(root);
    let subjects = [];
    try { subjects = (await api('/api/subjects?page_size=500')).rows; } catch (e) { content.append(App.errorBanner(e.message)); return; }
    if (!subjects.length) { content.append(h('div', { class: 'card' }, App.empty('No subjects assigned', 'An admin must assign subjects before attendance can be taken.', '📚'))); return; }

    const selSubject = App.select(subjects.map((s) => ({ value: s.id, label: `${s.code} — ${s.name} · Sem ${s.semester} ${s.section_name}` })),
      { value: q.get('subject_id') || subjects[0].id });
    const selDate = h('input', { class: 'f-input', type: 'date', value: App.todayLocal(), max: App.todayLocal() });
    const selPeriod = App.select([1, 2, 3, 4, 5, 6, 7, 8].map((p) => ({ value: p, label: `Period ${p}` })), { value: q.get('period') || 1 });
    const loadBtn = h('button', { class: 'btn primary', html: icon('clipboard', 15) + ' Load class list' });

    const bar = h('div', { class: 'filter-bar' },
      h('div', { class: 'field', style: 'min-width:280px' }, h('label', {}, 'Subject'), selSubject),
      h('div', { class: 'field' }, h('label', {}, 'Date'), selDate),
      h('div', { class: 'field' }, h('label', {}, 'Period'), selPeriod),
      h('div', { class: 'field' }, h('label', { html: ' ' }, ' '), loadBtn));
    const bodyBox = h('div', {});
    content.append(bar, bodyBox);

    // NOTE: these must be initialized before the first loadRoster() call below —
    // the awaited call closes over both (was a TDZ crash: "Cannot access 'marks'
    // before initialization" on every page load).
    let roster = [];
    const marks = new Map();

    loadBtn.addEventListener('click', loadRoster);
    await loadRoster();

    async function loadRoster() {
      marks.clear();
      bodyBox.replaceChildren(App.loading('Loading class list…'));
      let r;
      try {
        r = await api(`/api/attendance/roster?subject_id=${selSubject.value}&date=${selDate.value}&period=${selPeriod.value}`);
      } catch (e) { bodyBox.replaceChildren(App.errorBanner(e.message)); return; }
      roster = r.students;
      roster.forEach((s) => marks.set(s.id, s.marked));
      renderRoster(r);
    }

    function setMark(id, v, rowEl) {
      marks.set(id, marks.get(id) === v ? null : v);
      paintRow(rowEl, id);
      updateCounts();
    }
    function paintRow(rowEl, id) {
      const v = marks.get(id);
      rowEl.querySelectorAll('.seg button').forEach((b) => {
        b.className = v === b.dataset.v ? `on-${v}` : '';
      });
    }
    function counts() {
      let p = 0, a = 0, e = 0, un = 0;
      for (const s of roster) {
        const v = marks.get(s.id);
        if (v === 'P') p++; else if (v === 'A') a++; else if (v === 'E') e++; else un++;
      }
      return { p, a, e, un, total: roster.length };
    }

    function renderRoster(r) {
      const countLine = h('div', { class: 'grow strong' });
      const countsText = () => {
        const c = counts();
        countLine.textContent = `${c.total} students · ${c.p} Present · ${c.a} Absent${c.e ? ` · ${c.e} Excused` : ''}${c.un ? ` · ${c.un} unmarked` : ''}`;
        return c;
      };
      window.__updateCounts = countsText;

      const mkAll = (v) => () => { roster.forEach((s) => marks.set(s.id, v)); bodyBox.querySelectorAll('tbody tr').forEach((tr, i) => paintRow(tr, roster[i].id)); countsText(); };
      const saveBtn = h('button', { class: 'btn primary', html: icon('check', 15) + ' Save attendance', onClick: save });

      const card = h('div', { class: 'card' },
        h('div', { class: 'card-head', style: 'flex-wrap:wrap;gap:8px' },
          countLine,
          r.taken_before ? h('span', { class: 'badge amber', title: 'This class already has attendance. Saving again will update changed marks (audited).' }, 'already marked — editing') : h('span', { class: 'badge green' }, 'new class'),
          h('div', { class: 'flex' },
            h('button', { class: 'btn small secondary', onClick: mkAll('P') }, 'Present all'),
            h('button', { class: 'btn small secondary', onClick: mkAll('A') }, 'Absent all'),
            h('button', {
              class: 'btn small secondary', onClick: async () => {
                const rr = await api(`/api/attendance/roster?subject_id=${selSubject.value}&date=${selDate.value}&period=${selPeriod.value}`);
                rr.students.forEach((s) => marks.set(s.id, s.marked));
                bodyBox.querySelectorAll('tbody tr').forEach((tr, i) => paintRow(tr, rr.students[i].id));
                countsText();
                App.toast('Reset', 'Marks restored to the last saved state.');
              },
            }, 'Reset'),
            saveBtn)),
        h('div', { class: 'card-body flush' },
          App.table(['Roll', 'Student', 'Mark'], roster.map((s) => ({
            __cells: [
              h('span', { class: 'mono strong' }, s.roll_no),
              h('div', {}, h('span', { class: 'strong' }, s.full_name), h('span', { class: 'sub-text' }, ' ' + s.enrollment_no)),
              h('div', { class: 'seg', role: 'radiogroup', 'aria-label': `Attendance for ${s.full_name}` },
                ['P', 'A', 'E'].map((v) => h('button', {
                  type: 'button', dataset: { v }, role: 'radio', 'aria-checked': String(marks.get(s.id) === v),
                  onClick: (e) => { setMark(s.id, v, e.target.closest('tr')); },
                }, v)))],
        })), { ariaLabel: 'Class roster' })));

      async function save() {
        const c = countsText();
        const ok = await App.confirm('Save attendance?', h('div', {},
          h('p', { style: 'margin:0 0 6px' }, `${c.total} students — ${c.p} Present, ${c.a} Absent${c.e ? `, ${c.e} Excused` : ''}${c.un ? `, ${c.un} unmarked (skipped)` : ''}.`),
          r.taken_before ? h('p', { class: 'text-2', style: 'margin:0' }, 'Existing marks for this class will be updated; every change is recorded in the audit trail.') : null),
          'Save');
        if (!ok) return;
        saveBtn.disabled = true;
        try {
          const entries = roster.filter((s) => marks.get(s.id)).map((s) => ({ student_id: s.id, status: marks.get(s.id) }));
          const res = await api('/api/attendance/bulk', {
            method: 'POST',
            body: { subject_id: Number(selSubject.value), date: selDate.value, period: Number(selPeriod.value), entries },
          });
          const notif = res.notifications && (res.notifications.sent || res.notifications.skipped || res.notifications.failed)
            ? `\nNotification rules triggered: ${res.notifications.sent || 0} sent, ${res.notifications.skipped || 0} skipped, ${res.notifications.failed || 0} failed.`
            : '';
          App.toast('Attendance saved',
            `${res.created} new, ${res.updated} updated, ${res.unchanged} unchanged${res.invalid.length ? `, ${res.invalid.length} invalid` : ''}.${notif}`, 'success', 6500);
          await loadRoster();
        } catch (e2) {
          App.toast('Save failed', e2.message, 'error');
        } finally { saveBtn.disabled = false; }
      }
      bodyBox.replaceChildren(card);
      countsText();
    }
    function updateCounts() { if (window.__updateCounts) window.__updateCounts(); }
  };

  /* ------------------------------ import upload --------------------------- */
  App.pages.importUpload = async () => {
    const q = new URLSearchParams(location.search);
    const actions = [h('button', {
      class: 'btn secondary', onClick: () => {
        const csv = 'Roll No,Name,01/09,03/09\n101,Rahul Kumar,P,P\n102,Aman Gupta,A,P';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = 'sample-attendance-matrix.csv'; a.click();
      },
    }, 'Sample matrix CSV')];
    const { root, content } = App.shell('/attendance/import', 'Import Attendance Sheet', 'Upload → validate → review → confirm. Nothing is written until you approve it.', actions);
    mount(root);
    let subjects = [];
    try { subjects = (await api('/api/subjects?page_size=500')).rows; } catch (e) { content.append(App.errorBanner(e.message)); return; }

    // upload card
    const subSel = App.select(subjects.map((s) => ({ value: s.id, label: `${s.code} — ${s.name} · Sem ${s.semester} ${s.section_name}` })),
      { value: q.get('subject_id') || (subjects[0] && subjects[0].id), placeholder: 'Select subject' });
    const periodSel = App.select([1, 2, 3, 4, 5, 6, 7, 8].map((p) => ({ value: p, label: `Period ${p}` })), { value: 1 });
    const file = h('input', { class: 'f-input', type: 'file', accept: '.csv,.xlsx' });
    const out = h('div', { style: 'margin-top:12px' });
    const upBtn = h('button', { class: 'btn primary', html: icon('upload', 15) + ' Upload & validate' });
    upBtn.addEventListener('click', async () => {
      out.replaceChildren();
      if (!subSel.value) { out.append(App.errorBanner('Choose the subject this sheet belongs to.')); return; }
      if (!file.files.length) { out.append(App.errorBanner('Choose a CSV or XLSX file.')); return; }
      upBtn.disabled = true; upBtn.replaceChildren(h('span', { class: 'spinner' }), 'Parsing & validating…');
      try {
        const fd = new FormData();
        fd.append('subject_id', subSel.value);
        fd.append('period', periodSel.value);
        fd.append('file', file.files[0]);
        const r = await api('/api/attendance/import', { method: 'POST', formData: fd });
        App.toast('Sheet processed', 'Opening the review console…', 'success');
        App.navigate(`/attendance/import/${r.import_id}/review`);
      } catch (e) {
        out.append(App.errorBanner(e.message));
      } finally {
        upBtn.disabled = false; upBtn.replaceChildren('Upload & validate');
      }
    });

    content.append(h('div', { class: 'grid two' },
      h('div', {},
        h('div', { class: 'card mb' },
          h('div', { class: 'card-head' }, h('h3', {}, '1 · Choose class & file')),
          h('div', { class: 'card-body' },
            App.field('Subject', subSel, { required: true }),
            App.field('Period', periodSel),
            App.field('Attendance sheet (CSV or XLSX)', file, { required: true }),
            h('div', { class: 'flex' }, upBtn),
            out)),
        historyCard()),
      h('div', {},
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, 'Supported formats')),
          h('div', { class: 'card-body' },
            h('b', {}, 'Matrix sheet (most common)'),
            h('pre', { class: 'msg-preview mono', style: 'max-height:130px' }, 'Roll No,Name,01/09,03/09,05/09\n101,Rahul Kumar,P,P,A\n102,Aman Gupta,A,P,P'),
            h('b', {}, 'Long sheet'),
            h('pre', { class: 'msg-preview mono', style: 'max-height:110px' }, 'Roll No,Name,Date,Status\n101,Rahul Kumar,01/09/2026,Present\n102,Aman Gupta,01/09/2026,Absent'),
            h('div', { class: 'sub-text mt' },
              'Accepted marks: P / Present / ✓ / 1, A / Absent / ✗ / 0, E / Leave, H / Holiday, C / Cancelled. ',
              'Dates may be 01/09, 01-09-2026, 2026-09-01 or “1 Sep”. Column order and roll-vs-enrollment are handled automatically.'),
            h('div', { class: 'warn-banner', style: 'margin:10px 0 0' },
              'PDF and photo scans are NOT processed in this build (no OCR pipeline): the system will say so instead of guessing. Convert them to CSV/XLSX first.'))))));

    async function historyCard() {
      const cardBox = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Recent imports')), h('div', { class: 'card-body flush' }, App.loading()));
      try {
        const r = await api('/api/attendance/imports');
        cardBox.querySelector('.card-body').replaceChildren(
          r.rows.length ? App.table(['File', 'Subject', 'Status', 'Result', ''], r.rows.slice(0, 12).map((i) => ({
            __cells: [
              h('div', {}, h('div', { class: 'strong', style: 'max-width:190px;overflow:hidden;text-overflow:ellipsis' }, i.filename), h('div', { class: 'sub-text' }, fmtDateTime(i.created_at))),
              i.subject_code || '—',
              h('span', { class: `badge ${{ reviewed: 'blue', confirmed: 'green', cancelled: 'grey', failed: 'red', pending: 'amber' }[i.status] || 'grey'}` }, i.status),
              i.summary && i.summary.confirmed
                ? h('span', { class: 'sub-text' }, `+${i.summary.confirmed.inserted} · ~${i.summary.confirmed.replaced} · skip ${i.summary.confirmed.skipped_conflict + i.summary.confirmed.skipped_rows}`)
                : i.summary ? h('span', { class: 'sub-text' }, `${i.summary.total_rows} rows`) : '—',
              i.status === 'reviewed' ? h('button', { class: 'btn small secondary', onClick: () => App.navigate(`/attendance/import/${i.id}/review`) }, 'Review') : null],
          }))) : App.empty('No imports yet'));
      } catch (e) {
        cardBox.querySelector('.card-body').replaceChildren(App.errorBanner(e.message));
      }
      return cardBox;
    }
  };

  /* ------------------------------ import review --------------------------- */
  App.pages.importReview = async (id) => {
    const { root, content } = App.shell('/attendance/import', 'Review Import', '', []);
    mount(root);
    content.append(App.loading('Loading review…'));
    let d;
    try { d = await api(`/api/attendance/import/${id}`); } catch (e) { content.replaceChildren(App.errorBanner(e.message)); return; }
    content.replaceChildren();
    const imp = d.import;
    if (imp.status === 'confirmed') {
      content.append(
        h('div', { class: 'info-banner' }, `Import #${imp.id} (${imp.filename}) was already confirmed${imp.confirmed_at ? ' on ' + fmtDateTime(imp.confirmed_at) : ''} and is locked.`),
        summaryStrip(imp.summary),
        h('button', { class: 'btn secondary', onClick: () => App.navigate('/attendance/import') }, '‹ Back to imports'));
      return;
    }
    if (imp.status === 'cancelled') {
      content.append(h('div', { class: 'warn-banner' }, 'This import was cancelled.'), h('button', { class: 'btn secondary', onClick: () => App.navigate('/attendance/import') }, '‹ Back'));
      return;
    }

    let policy = 'skip';
    let summary = imp.summary || {};
    const stripBox = h('div', {});
    const rowsBox = h('div', { class: 'card-body flush' });
    const students = d.students;

    content.append(
      h('div', { class: 'page-head' },
        h('div', {},
          h('h1', {}, `Review: ${imp.filename}`),
          h('div', { class: 'sub' }, `${imp.subject_code || ''} — ${imp.subject_name || ''} · Period ${imp.period} · uploaded ${fmtDateTime(imp.created_at)} by ${imp.uploaded_by || ''}`))),
      stripBox,
      (summary.file_issues || []).map((i) => h('div', { class: 'warn-banner' }, i)),
      summary.previous_import ? h('div', { class: 'warn-banner' }, summary.previous_import) : null,
      h('div', { class: 'card mb' },
        h('div', { class: 'card-head', style: 'flex-wrap:wrap;gap:10px' },
          h('div', { class: 'grow flex', style: 'gap:8px;align-items:baseline' },
            h('label', { class: 'sub-text', style: 'font-weight:650' }, 'When the file disagrees with an existing record:'),
            App.select([
              { value: 'skip', label: 'Keep existing (skip imported) — default' },
              { value: 'replace', label: 'Replace existing (audited)' },
            ], { value: policy, onChange: (v) => { policy = v; } })),
          h('div', { class: 'flex' },
            h('button', {
              class: 'btn secondary', onClick: async () => {
                if (await App.confirm('Cancel this import?', 'The staged rows will be discarded; nothing was written to attendance yet.')) {
                  await api(`/api/attendance/import/${id}/cancel`, { method: 'POST' });
                  App.toast('Import cancelled', '', 'success'); App.navigate('/attendance/import');
                }
              },
            }, 'Cancel import'),
            h('button', { class: 'btn primary', onClick: () => confirm(false), html: icon('check', 15) + ' Confirm import' }))),
        rowsBox));

    function summaryStrip(s) {
      const item = (label, val, color) => h('div', { class: 'card rs' }, h('div', { class: 'n', style: `color:${color || 'var(--text)'}` }, String(val ?? 0)), h('div', { class: 'l' }, label));
      return h('div', { class: 'review-strip' },
        item('Rows detected', s.total_rows),
        item('Students matched', s.matched, 'var(--green)'),
        item('Needs review', s.possible ?? s.needs_review, 'var(--blue)'),
        item('Not found', s.unmatched, 'var(--red)'),
        item('Duplicates', s.duplicates, 'var(--amber)'),
        item('Invalid values', (s.invalid_status || 0) + (s.invalid_date || 0), 'var(--amber)'),
        item('Conflicts', s.conflicts, 'var(--amber)'));
    }

    function updateStrip() { stripBox.replaceChildren(summaryStrip(summary)); }
    updateStrip();

    const rowState = new Map(d.rows.map((r) => [r.id, r]));

    function studentCell(st) {
      if (st.match_status === 'matched' && st.student_id) {
        return h('div', {}, h('span', { class: 'strong' }, st.student_name || '—'), h('div', { class: 'sub-text' }, `Roll ${st.student_roll || ''}`));
      }
      const sel = h('select', { class: 'f-select', style: 'min-width:190px', 'aria-label': 'Choose student' });
      sel.append(h('option', { value: '' }, '— choose student —'));
      const cands = st.match_candidates || [];
      if (cands.length) {
        const grp = h('optgroup', { label: 'Possible matches' });
        cands.forEach((c) => grp.append(h('option', { value: c.id }, `≈ ${c.full_name} (Roll ${c.roll_no}) ${c.status !== 'active' ? '[' + c.status + ']' : ''}`)));
        sel.append(grp);
      }
      const grp2 = h('optgroup', { label: 'All students in section' });
      students.forEach((s) => grp2.append(h('option', { value: s.id }, `${s.full_name} (Roll ${s.roll_no})`)));
      sel.append(grp2);
      if (st.student_id) sel.value = String(st.student_id);
      sel.addEventListener('change', () => updateRow(st.id, { student_id: sel.value ? Number(sel.value) : null }));
      return sel;
    }

    function issuesCell(st) {
      if (!st.issues || !st.issues.length) return h('span', { class: 'badge green' }, 'ok');
      return h('div', { class: 'flex wrap', style: 'gap:4px;max-width:340px' },
        st.issues.map((i) => h('span', {
          class: `badge ${/not found|Invalid|future/i.test(i) ? 'red' : /existing|conflict|Duplicate/i.test(i) ? 'amber' : 'blue'}`,
        }, i)));
    }

    const STATUS_OPTS = ['', 'P', 'A', 'E', 'H', 'C'];
    function rowNode(st) {
      const tr = h('tr', { class: `row-${st.validation} ${st.action === 'ignore' ? 'row-ignored' : ''}` });
      const dateIn = h('input', { class: 'f-input', style: 'width:118px;padding:5px 8px', value: st.date || st.dateRawGuess || '', placeholder: 'YYYY-MM-DD' });
      dateIn.addEventListener('change', () => updateRow(st.id, { date: dateIn.value }));
      const stSel = h('select', { class: 'f-select', style: 'width:86px;padding:5px 8px' },
        STATUS_OPTS.map((v) => h('option', { value: v, ...(String(v) === String(st.status_value || '').toUpperCase() && v ? { selected: true } : {}) },
          v === '' ? '—' : { P: 'P', A: 'A', E: 'E', H: 'H', C: 'C' }[v])));
      if (st.status_value) {
        const up = String(st.status_value).toUpperCase();
        if (STATUS_OPTS.includes(up)) stSel.value = up;
      }
      stSel.addEventListener('change', () => updateRow(st.id, { status: stSel.value }));
      const ignore = h('input', { type: 'checkbox', 'aria-label': `Ignore row ${st.row_no}` });
      ignore.checked = st.action === 'ignore';
      ignore.addEventListener('change', () => updateRow(st.id, { action: ignore.checked ? 'ignore' : 'import' }));
      tr.append(
        h('td', { class: 'mono text-3' }, String(st.row_no)),
        h('td', {}, h('span', { class: 'mono' }, st.roll_no || '—')),
        h('td', {}, st.name || '—'),
        h('td', {}, studentCell(st)),
        h('td', {}, dateIn),
        h('td', {}, stSel),
        h('td', {}, st.conflict_existing ? h('span', { class: 'badge amber', title: 'Existing value in the database' }, `DB says ${st.conflict_existing}`) : null),
        h('td', {}, issuesCell(st)),
        h('td', { style: 'text-align:center' }, ignore));
      return tr;
    }

    function renderRows() {
      const tbody = h('tbody', {}, [...rowState.values()].map((st) => rowNode(st)));
      rowsBox.replaceChildren(
        h('div', { class: 'table-wrap' },
          h('table', { class: 'tbl' },
            h('thead', {}, h('tr', {},
              ['#', 'Roll (file)', 'Name (file)', 'Student', 'Date', 'Mark', 'Conflict', 'Validation', 'Ignore']
                .map((t2) => h('th', { scope: 'col' }, t2)))),
            tbody)));
    }
    renderRows();

    async function updateRow(rowId, patch) {
      try {
        const r = await api(`/api/attendance/import/${id}/rows/${rowId}`, { method: 'PUT', body: patch });
        summary = r.summary;
        updateStrip();
        const idx = [...rowState.keys()].indexOf(rowId);
        const detail = await api(`/api/attendance/import/${id}`);
        const fresh = detail.rows.find((x) => x.id === rowId);
        if (!fresh) return;
        rowState.set(rowId, fresh);
        const tbody = rowsBox.querySelector('tbody');
        if (tbody && tbody.children[idx]) tbody.replaceChild(rowNode(fresh), tbody.children[idx]);
      } catch (e) {
        App.toast('Could not update row', e.message, 'error');
        renderRows();
      }
    }

    async function confirm(force) {
      try {
        const r = await api(`/api/attendance/import/${id}/confirm`, { method: 'POST', body: { conflict_policy: policy, force } });
        const n = r.notifications;
        App.modal('Import confirmed', h('div', {},
          h('div', { class: 'details-box' },
            h('dl', { class: 'kv' },
              h('dt', {}, 'New records'), h('dd', {}, String(r.inserted)),
              h('dt', {}, 'Existing replaced'), h('dd', {}, String(r.replaced)),
              h('dt', {}, 'Conflicts kept as-is'), h('dd', {}, String(r.skipped_conflict)),
              h('dt', {}, 'Rows skipped'), h('dd', {}, String(r.skipped_rows)))),
          (n.sent || n.skipped || n.failed) ? h('div', { class: 'info-banner mt' }, `Notification rules ran: ${n.sent} sent, ${n.skipped} skipped, ${n.failed} failed (see Notifications).`) : null,
          h('p', { class: 'text-2' }, 'Dashboards and percentages have been recalculated from the new records.')), [
          { label: 'View notifications', kind: 'secondary', onClick: () => App.navigate('/notifications') },
          { label: 'Done', kind: 'primary', onClick: () => App.navigate(`/attendance?subject_id=${imp.subject_id}`) },
        ]);
      } catch (e) {
        if (e.status === 409 && e.code === 'unresolved') {
          const okRows = await App.confirm('Unresolved rows remain', h('div', {},
            h('p', {}, e.message),
            h('p', { class: 'text-2' }, 'You can import only the valid rows now, or go back and fix/ignore the remaining rows first.')), 'Import valid rows only');
          if (okRows) return confirm(true);
        } else if (e.status === 409 && e.code === 'locked') {
          App.toast('Already confirmed', e.message, 'warning'); App.route();
        } else {
          App.toast('Confirm failed', e.message, 'error');
        }
      }
    }
  };

  /* ------------------------------- defaulters ----------------------------- */
  App.pages.defaulters = async () => {
    const q = new URLSearchParams(location.search);
    const th = App.threshold();
    const filters = {
      department_id: q.get('department_id') || '', semester: q.get('semester') || '',
      section_id: q.get('section_id') || '', subject_id: q.get('subject_id') || '',
      band: q.get('band') || '', notified: q.get('notified') || '', q: q.get('q') || '', page: 1,
    };
    const { root, content } = App.shell('/defaulters', 'Attendance Defaulters', `Students below the configured ${th}% threshold`, []);
    mount(root);
    let subjects = [];
    try { subjects = (await api('/api/subjects?page_size=500')).rows; } catch { }
    let providers = {};
    try { providers = (await api('/api/notifications/providers')).providers; } catch { }

    const selected = new Map(); // key student_id|subject_id → row
    const search = h('input', { class: 'f-input', value: filters.q, placeholder: 'Name / roll…', onInput: App.debounce((e) => { filters.q = e.target.value; filters.page = 1; reload(); }, 350) });
    const deptSel = App.select(App.departmentOptions(), { value: filters.department_id, placeholder: 'All departments', onChange: (v) => { filters.department_id = v; filters.page = 1; reload(); } });
    const semSel = App.select([1, 2, 3, 4, 5, 6, 7, 8].map((s) => ({ value: s, label: `Sem ${s}` })), { value: filters.semester, placeholder: 'All sems', onChange: (v) => { filters.semester = v; filters.page = 1; reload(); } });
    const subSel = App.select(subjects.map((s) => ({ value: s.id, label: s.code })), { value: filters.subject_id, placeholder: 'All subjects', onChange: (v) => { filters.subject_id = v; filters.page = 1; reload(); } });
    const bandSel = App.select([
      { value: '', label: `All below ${th}%` }, { value: 'critical', label: 'Critical (<50%)' },
      { value: '50to60', label: '50–60%' }, { value: '60to75', label: '60–75%' },
    ], { value: filters.band, onChange: (v) => { filters.band = v; filters.page = 1; reload(); } });
    const notifSel = App.select([
      { value: '', label: 'Notification: any' }, { value: 'no', label: 'Not yet notified' },
      { value: 'yes', label: 'Notified' }, { value: 'failed', label: 'Delivery failed' },
    ], { value: filters.notified, onChange: (v) => { filters.notified = v; filters.page = 1; reload(); } });

    const listBox = h('div', { class: 'card' });
    const sendBar = h('div', { class: 'info-banner', style: 'display:none;align-items:center;gap:10px' });

    content.append(
      h('div', { class: 'filter-bar' },
        h('div', { class: 'field grow' }, h('label', {}, 'Search'), search),
        h('div', { class: 'field' }, h('label', {}, 'Department'), deptSel),
        h('div', { class: 'field' }, h('label', {}, 'Semester'), semSel),
        h('div', { class: 'field' }, h('label', {}, 'Subject'), subSel),
        h('div', { class: 'field' }, h('label', {}, 'Band'), bandSel),
        h('div', { class: 'field' }, h('label', {}, 'Notification'), notifSel),
        h('button', { class: 'btn secondary', onClick: () => App.navigate('/defaulters') }, 'Clear'),
        h('button', { class: 'btn secondary', onClick: exportCsv, html: icon('download', 14) + ' CSV' }),
        h('button', { class: 'btn secondary', onClick: () => exportCsv(true), html: icon('download', 14) + ' XLSX' })),
      sendBar, listBox);

    function filterParams() {
      const p = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v) p.set(k, v); });
      return p;
    }
    async function exportCsv(xlsx) {
      try {
        await api.download(`/api/reports/defaulters?${filterParams()}${xlsx ? '&format=xlsx' : ''}`,
          xlsx ? 'defaulters.xlsx' : 'defaulters.csv');
        App.toast('Report downloaded', '', 'success');
      } catch (e) { App.toast('Export failed', e.message, 'error'); }
    }

    function updateSendBar() {
      if (!selected.size) { sendBar.style.display = 'none'; return; }
      const channels = ['email', 'sms', 'whatsapp'].filter((c) => providers[c]?.enabled);
      const chSel = App.select(channels.length ? channels.map((c) => ({ value: c, label: `${c.toUpperCase()}${providers[c]?.webhook_configured ? '' : providers[c]?.log_fallback ? ' (log provider)' : ''}` })) : [{ value: '', label: 'no channel enabled' }]);
      sendBar.style.display = 'flex';
      sendBar.replaceChildren(
        h('b', {}, `${selected.size} selected`),
        chSel,
        h('button', {
          class: 'btn primary small', onClick: async () => {
            if (!chSel.value) return;
            const missing = [...selected.values()].filter((r) => !r.parent_phone && !r.parent_email).length;
            const okGo = await App.confirm(`Notify parents of ${selected.size} student(s)?`,
              `Channel: ${chSel.value.toUpperCase()}. ${missing ? `${missing} student(s) have no guardian contact and will be skipped honestly.` : 'All selected students have guardian contacts.'} Each delivery attempt is logged.`,
              'Send notifications');
            if (!okGo) return;
            try {
              const items = [...selected.values()].map((r) => ({ student_id: r.student_id, subject_id: r.subject_id }));
              const r2 = await api('/api/notifications/send', { method: 'POST', body: { channel: chSel.value, items } });
              App.modal('Notification results', h('div', {},
                h('div', { class: 'details-box mb' }, `Sent: ${r2.summary.sent} · Skipped: ${r2.summary.skipped} · Failed: ${r2.summary.failed}`),
                App.table(['Student', 'Result', 'Reason'], r2.results.map((x) => {
                  const src = selected.get(`${x.student_id}|${items.find((i) => i.student_id === x.student_id)?.subject_id}`);
                  return { __cells: [src ? src.full_name : `#${x.student_id}`, App.notifStatusBadge({ status: x.status }), x.error || '—'] };
                }))), [{ label: 'Close', kind: 'primary', onClick: () => { } }]);
              selected.clear(); updateSendBar(); reload();
            } catch (e) { App.toast('Send failed', e.message, 'error'); }
          },
        }, h('span', { html: icon('send', 14) }), 'Send notifications'),
        h('button', { class: 'btn ghost small', onClick: () => { selected.clear(); updateSendBar(); reload(); } }, 'Clear selection'));
    }

    async function reload() {
      listBox.replaceChildren(App.loading());
      const p = filterParams(); p.set('page_size', '25');
      let r;
      try { r = await api(`/api/attendance/defaulters?${p}`); } catch (e) { listBox.replaceChildren(App.errorBanner(e.message)); return; }
      if (!r.rows.length) {
        listBox.replaceChildren(App.empty('No defaulters match 🎉', `Every student matching these filters is at or above ${th}%.`, '✓'));
        return;
      }
      const headCb = h('input', { type: 'checkbox', 'aria-label': 'Select all on page' });
      headCb.addEventListener('change', () => {
        r.rows.forEach((row) => {
          const key = `${row.student_id}|${row.subject_id}`;
          if (headCb.checked) selected.set(key, row); else selected.delete(key);
        });
        listBox.querySelectorAll('tbody input[type=checkbox]').forEach((c) => { c.checked = headCb.checked; });
        updateSendBar();
      });
      listBox.replaceChildren(
        App.table([headCb, 'Roll', 'Student', 'Class', 'Subject', 'P / T', 'Attendance', 'Guardian contact', 'Notified', ''], r.rows.map((row) => {
          const key = `${row.student_id}|${row.subject_id}`;
          const cb = h('input', { type: 'checkbox', 'aria-label': `Select ${row.full_name}` });
          cb.checked = selected.has(key);
          cb.addEventListener('change', () => { if (cb.checked) selected.set(key, row); else selected.delete(key); updateSendBar(); });
          const notif = row.notif_status
            ? h('div', {}, App.notifStatusBadge({ status: row.notif_status }), h('div', { class: 'sub-text' }, `${row.notif_channel || ''} ${App.fmtDateTime(row.notif_at)}`))
            : h('span', { class: 'badge grey' }, 'never');
          return {
            __cells: [
              cb,
              h('span', { class: 'mono' }, row.roll_no),
              h('a', { href: `/students/${row.student_id}`, onClick: (e) => { e.preventDefault(); App.navigate(`/students/${row.student_id}`); } }, row.full_name),
              h('span', { class: 'sub-text' }, `${row.department_name.split(' ')[0]} · Sem ${row.semester} · ${row.section_name}`),
              h('span', { title: row.subject_name }, h('b', {}, row.subject_code)),
              h('span', { class: 'mono' }, `${row.present}/${row.applicable}`),
              pctBar(row.pct_bp),
              row.parent_name
                ? h('div', {}, h('div', {}, row.parent_name), h('div', { class: 'sub-text' }, row.parent_phone || row.parent_email || '—'))
                : h('span', { class: 'badge amber' }, 'contact unavailable'),
              notif,
              h('button', { class: 'btn small ghost', onClick: () => { selected.set(key, row); updateSendBar(); sendBar.scrollIntoView({ behavior: 'smooth' }); } }, 'Notify')],
          };
        }), { ariaLabel: 'Defaulters' }),
        App.pagination({ total: r.total, page: r.page, size: r.size, onPage: (p2) => { filters.page = p2; reload(); } }));
    }
    await reload();
  };
})(window.App);
