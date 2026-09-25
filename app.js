/* LWH Timesheet -- employee hours viewer
 * Data comes only from four Supabase RPCs (emp_create_pin, emp_login, emp_get_hours, emp_logout).
 * Date rule: never pass a date string to new Date(). Dates/times arrive as plain
 * "YYYY-MM-DD" / "YYYY-MM-DDTHH:MM" Central wall-clock text and are handled as integers.
 */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const TOKEN_KEY = 'lwhts.token';
  const EMPID_KEY = 'lwhts.empId';
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const DAYS_LONG = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  const $ = (id) => document.getElementById(id);
  const state = { data: null, weekIndex: 0, lastFetch: 0 };

  // ---------------- Storage (guarded) ----------------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  // ---------------- API ----------------
  async function rpc(fn, params) {
    let res;
    try {
      res = await fetch(CFG.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
        method: 'POST',
        headers: { 'apikey': CFG.SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
        cache: 'no-store'
      });
    } catch (e) {
      throw new Error("Can't reach the server. Check your connection and try again.");
    }
    if (!res.ok) throw new Error('The server had a problem (' + res.status + '). Try again in a minute.');
    return res.json();
  }

  // ---------------- Date / time helpers (integer based) ----------------
  function ymd(s) { const p = s.split('-'); return { y: +p[0], m: +p[1], d: +p[2] }; }
  function dayNum(s) { const t = ymd(s); return Date.UTC(t.y, t.m - 1, t.d) / 86400000; }
  function fromDayNum(n) {
    const dt = new Date(n * 86400000);
    return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
  }
  function addDays(s, n) { return fromDayNum(dayNum(s) + n); }
  function dow(s) { return new Date(dayNum(s) * 86400000).getUTCDay(); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function shortDate(s) { const t = ymd(s); return MONTHS[t.m - 1] + ' ' + t.d; }
  function rangeLabel(a, b) {
    const x = ymd(a), y = ymd(b);
    return x.m === y.m ? shortDate(a) + ' \u2013 ' + y.d : shortDate(a) + ' \u2013 ' + shortDate(b);
  }
  function slashDate(s) { const t = ymd(s); return t.m + '/' + t.d; }

  // minutes from midnight of baseDate to the "YYYY-MM-DDTHH:MM" stamp (handles overnight)
  function minutesFrom(baseDate, stamp) {
    const [d, t] = stamp.split('T');
    const hm = t.split(':');
    return (dayNum(d) - dayNum(baseDate)) * 1440 + (+hm[0]) * 60 + (+hm[1]);
  }
  function clock12(stamp) {
    const hm = stamp.split('T')[1].split(':');
    let h = +hm[0]; const m = hm[1];
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + m + ' ' + ap;
  }
  function deviceNowStamp() {
    const n = new Date();
    return n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate()) +
           'T' + pad(n.getHours()) + ':' + pad(n.getMinutes());
  }
  function fmtHours(h) { return (Math.round(h * 100) / 100).toFixed(2); }

  // ---------------- Views ----------------
  function show(view) {
    ['viewLoading', 'viewSignIn', 'viewSetup', 'viewHours'].forEach((v) => { $(v).hidden = v !== view; });
    $('topbarActions').hidden = view !== 'viewHours';
    window.scrollTo(0, 0);
  }
  function setError(el, msg) { el.textContent = msg || ''; el.hidden = !msg; }
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function busy(btn, on, label) {
    btn.disabled = on;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; }
    else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
  }
  function cleanId(v) { return String(v || '').replace(/\D/g, ''); }

  // ---------------- Auth flows ----------------
  $('signInForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('signInError'); setError(err, '');
    const empId = cleanId($('siEmpId').value);
    const pin = cleanId($('siPin').value);
    if (!empId) return setError(err, 'Enter your employee ID.');
    if (pin.length !== 6) return setError(err, 'Your PIN is 6 digits.');
    const btn = $('signInBtn'); busy(btn, true, 'Signing in…');
    try {
      const r = await rpc('emp_login', { p_emp_id: Number(empId), p_pin: pin });
      if (!r.ok) { setError(err, r.error); return; }
      store.set(TOKEN_KEY, r.token); store.set(EMPID_KEY, empId);
      $('siPin').value = '';
      await loadHours(true);
    } catch (ex) { setError(err, ex.message); }
    finally { busy(btn, false); }
  });

  $('setupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('setupError'); setError(err, '');
    const empId = cleanId($('suEmpId').value);
    const code = $('suCode').value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const pin = cleanId($('suPin').value);
    const pin2 = cleanId($('suPin2').value);
    if (!empId) return setError(err, 'Enter your employee ID.');
    if (code.length !== 8) return setError(err, 'The setup code has 8 letters and numbers, like ABCD-2345.');
    if (pin.length !== 6) return setError(err, 'Choose a PIN that is exactly 6 digits.');
    if (pin !== pin2) return setError(err, 'The two PINs do not match. Type them again.');
    const btn = $('setupBtn'); busy(btn, true, 'Setting up…');
    try {
      const r = await rpc('emp_create_pin', { p_emp_id: Number(empId), p_setup_code: code, p_pin: pin });
      if (!r.ok) { setError(err, r.error); return; }
      store.set(TOKEN_KEY, r.token); store.set(EMPID_KEY, empId);
      $('setupForm').reset();
      await loadHours(true);
      toast('PIN saved. You are signed in.');
    } catch (ex) { setError(err, ex.message); }
    finally { busy(btn, false); }
  });

  $('suCode').addEventListener('input', (e) => {
    const raw = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
    e.target.value = raw.length > 4 ? raw.slice(0, 4) + '-' + raw.slice(4) : raw;
  });

  $('toSetup').addEventListener('click', () => {
    $('suEmpId').value = $('siEmpId').value; show('viewSetup'); $('suEmpId').focus();
  });
  $('toSignIn').addEventListener('click', () => { show('viewSignIn'); });

  $('signOutBtn').addEventListener('click', async () => {
    const tok = store.get(TOKEN_KEY);
    store.del(TOKEN_KEY); state.data = null;
    if (tok) { try { await rpc('emp_logout', { p_token: tok }); } catch (e) { /* offline is fine */ } }
    $('siEmpId').value = store.get(EMPID_KEY) || '';
    show('viewSignIn');
  });

  $('refreshBtn').addEventListener('click', () => loadHours(false, true));

  // ---------------- Load + render ----------------
  async function loadHours(fromSignIn, announce) {
    const tok = store.get(TOKEN_KEY);
    if (!tok) { show('viewSignIn'); return; }
    if (!state.data) show('viewLoading');
    try {
      const r = await rpc('emp_get_hours', { p_token: tok });
      if (!r.ok) {
        store.del(TOKEN_KEY); state.data = null;
        $('siEmpId').value = store.get(EMPID_KEY) || '';
        show('viewSignIn');
        if (!fromSignIn) setError($('signInError'), 'You were signed out. Sign in again to see your hours.');
        return;
      }
      state.data = r; state.lastFetch = Date.now();
      if (fromSignIn) state.weekIndex = 0;
      render();
      show('viewHours');
      if (announce) toast('Hours updated');
    } catch (ex) {
      if (state.data) { toast(ex.message); return; }
      show('viewSignIn'); setError($('signInError'), ex.message);
    }
  }

  function punchesForWeek(weekStart) {
    return state.data.punches.filter((p) => p.week_start === weekStart);
  }

  function render() {
    const d = state.data;
    $('empName').textContent = d.employee.name;
    $('empId').textContent = 'Employee ID ' + d.employee.emp_id;
    renderAttention();
    renderWeek();
    $('syncedAt').textContent = d.synced_at
      ? 'Timeclock data as of ' + syncedLabel(d.synced_at, d.today) + '.'
      : 'Timeclock data has not synced yet.';
  }

  function syncedLabel(stamp, today) {
    const day = stamp.slice(0, 10);
    const when = day === today ? 'today' : (day === addDays(today, -1) ? 'yesterday' : shortDate(day));
    return clock12(stamp.slice(0, 16)) + ' ' + when;
  }

  function renderAttention() {
    const box = $('attention');
    const d = state.data;
    const missing = d.punches.filter((p) => p.status === 'missing_out');
    box.innerHTML = '';
    if (!missing.length) { box.hidden = true; return; }
    const p = document.createElement('p');
    p.textContent = missing.length === 1 ? 'A punch needs attention' : missing.length + ' punches need attention';
    const ul = document.createElement('ul');
    missing.forEach((m) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = DAYS[dow(m.date)] + ', ' + shortDate(m.date) + ': no clock-out after ' + clock12(m.in);
      b.addEventListener('click', () => {
        state.weekIndex = Math.max(0, d.weeks.indexOf(m.week_start));
        renderWeek();
        const row = document.querySelector('[data-date="' + m.date + '"]');
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      li.appendChild(b); ul.appendChild(li);
    });
    box.appendChild(p); box.appendChild(ul); box.hidden = false;
  }

  function weekName(i) {
    if (i === 0) return 'This week';
    if (i === 1) return 'Last week';
    return i + ' weeks ago';
  }

  function renderWeek() {
    const d = state.data;
    const i = state.weekIndex;
    const ws = d.weeks[i];
    const we = addDays(ws, 6);
    const punches = punchesForWeek(ws);

    $('weekRange').textContent = rangeLabel(ws, we);
    $('weekName').textContent = weekName(i);
    $('prevWeek').disabled = i >= d.weeks.length - 1;
    $('nextWeek').disabled = i <= 0;

    const total = punches.reduce((s, p) => s + (p.hours || 0), 0);
    const problems = punches.filter((p) => p.status === 'missing_out').length;
    const onClock = punches.some((p) => p.status === 'on_clock');
    $('weekHours').textContent = fmtHours(total);
    const note = $('weekNote');
    note.classList.toggle('bad', problems > 0);
    note.classList.toggle('good', problems === 0 && punches.length > 0 && !onClock);
    if (problems) note.textContent = problems === 1 ? '1 missing clock-out' : problems + ' missing clock-outs';
    else if (onClock) note.textContent = 'On the clock now; total updates after you clock out';
    else if (punches.length) note.textContent = 'No missed punches found';
    else note.textContent = 'No time recorded this week';

    // Shared hour axis for the week's strips
    const nowStamp = deviceNowStamp();
    let lo = Infinity, hi = -Infinity;
    const spans = punches.map((p) => {
      const start = minutesFrom(p.date, p.in);
      let end;
      if (p.out) end = minutesFrom(p.date, p.out);
      else if (p.status === 'on_clock') end = Math.max(start + 15, minutesFrom(p.date, nowStamp));
      else end = start + 120;          // missing: draw a 2-hour open-ended stub
      lo = Math.min(lo, start); hi = Math.max(hi, end);
      return { p, start, end };
    });
    if (!spans.length) { lo = 6 * 60; hi = 18 * 60; }
    lo = Math.floor(lo / 60) * 60; hi = Math.ceil(hi / 60) * 60;
    if (hi - lo < 8 * 60) hi = lo + 8 * 60;
    const range = hi - lo;
    const hourPct = (100 * 60 / range).toFixed(4) + '%';

    // Only label location/team when this week has more than one (e.g. split days)
    const showWhere = new Set(punches.map((p) => (p.location || '') + '|' + (p.team || ''))).size > 1;
    const sites = Array.from(new Set(punches.map((p) => [p.location, p.team].filter(Boolean).join(', '))));
    $('weekSite').textContent = !showWhere && sites[0] ? sites[0] : '';
    $('weekSite').hidden = showWhere || !sites[0];

    const list = $('dayList');
    list.innerHTML = '';
    for (let k = 0; k < 7; k++) {
      const date = addDays(ws, k);
      const daySpans = spans.filter((s) => s.p.date === date);
      const li = document.createElement('li');
      li.className = 'day' + (date === d.today ? ' today' : '');
      li.dataset.date = date;

      const name = document.createElement('div');
      name.className = 'day-name';
      name.innerHTML = DAYS[k] + '<span class="day-date">' + shortDate(date) + '</span>';
      name.setAttribute('aria-label', DAYS_LONG[k] + ' ' + shortDate(date));

      const hrs = document.createElement('div');
      const dayTotal = daySpans.reduce((s, x) => s + (x.p.hours || 0), 0);
      const dayOpen = daySpans.some((x) => x.p.status === 'on_clock');
      if (daySpans.length && dayOpen && dayTotal === 0) { hrs.className = 'day-hours none'; hrs.textContent = 'In progress'; }
      else if (daySpans.length) { hrs.className = 'day-hours'; hrs.textContent = fmtHours(dayTotal) + ' h'; }
      else { hrs.className = 'day-hours none'; hrs.textContent = 'No time'; }

      const body = document.createElement('div');
      body.className = 'day-body';
      if (daySpans.length) {
        const strip = document.createElement('div');
        strip.className = 'strip';
        strip.style.setProperty('--hour', hourPct);
        strip.setAttribute('aria-hidden', 'true');
        daySpans.forEach((s) => {
          const seg = document.createElement('span');
          seg.className = 'seg ' + s.p.status;
          seg.style.left = (100 * (s.start - lo) / range) + '%';
          seg.style.width = (100 * (s.end - s.start) / range) + '%';
          strip.appendChild(seg);
        });
        body.appendChild(strip);

        const ul = document.createElement('ul');
        ul.className = 'punches';
        daySpans.forEach((s, idx) => {
          const pli = document.createElement('li');
          pli.className = 'punch';
          const time = document.createElement('span');
          time.className = 'punch-time';
          const outTxt = s.p.out ? clock12(s.p.out) : (s.p.status === 'on_clock' ? 'now' : 'no clock-out');
          const nextDay = s.p.out && s.p.out.slice(0, 10) !== s.p.date ? ' (next day)' : '';
          time.textContent = clock12(s.p.in) + ' to ' + outTxt + nextDay;
          const h = document.createElement('span');
          h.className = 'punch-time';
          h.textContent = s.p.hours != null ? fmtHours(s.p.hours) : '';
          pli.appendChild(time); pli.appendChild(h);
          if (showWhere) {
            const w = document.createElement('span');
            w.className = 'punch-where';
            w.textContent = [s.p.location, s.p.team].filter(Boolean).join(', ');
            if (w.textContent) pli.appendChild(w);
          }
          ul.appendChild(pli);
        });
        body.appendChild(ul);

        daySpans.forEach((s) => {
          if (s.p.status === 'missing_out' || s.p.status === 'on_clock') {
            const f = document.createElement('span');
            f.className = 'flag ' + s.p.status;
            f.textContent = s.p.status === 'missing_out'
              ? 'Missing clock-out. Tell your supervisor.'
              : 'On the clock since ' + clock12(s.p.in);
            body.appendChild(f);
          }
        });
      }

      li.appendChild(name); li.appendChild(hrs);
      if (daySpans.length) li.appendChild(body);
      list.appendChild(li);
    }
  }

  $('prevWeek').addEventListener('click', () => {
    if (state.weekIndex < state.data.weeks.length - 1) { state.weekIndex++; renderWeek(); }
  });
  $('nextWeek').addEventListener('click', () => {
    if (state.weekIndex > 0) { state.weekIndex--; renderWeek(); }
  });

  // ---------------- Print / share ----------------
  function weekSummaryText() {
    const d = state.data;
    const ws = d.weeks[state.weekIndex];
    const punches = punchesForWeek(ws);
    const lines = [
      'LWH Timesheet: ' + d.employee.name + ' (ID ' + d.employee.emp_id + ')',
      'Week of ' + rangeLabel(ws, addDays(ws, 6)) + ': ' +
        fmtHours(punches.reduce((s, p) => s + (p.hours || 0), 0)) + ' hours',
      ''
    ];
    for (let k = 0; k < 7; k++) {
      const date = addDays(ws, k);
      const ps = punches.filter((p) => p.date === date);
      if (!ps.length) { lines.push(DAYS[k] + ' ' + slashDate(date) + ': no time'); continue; }
      const segs = ps.map((p) => clock12(p.in) + ' to ' +
        (p.out ? clock12(p.out) : (p.status === 'on_clock' ? 'now' : 'NO CLOCK-OUT')));
      const tot = ps.reduce((s, p) => s + (p.hours || 0), 0);
      lines.push(DAYS[k] + ' ' + slashDate(date) + ': ' + segs.join(', ') + ' (' + fmtHours(tot) + ')');
    }
    if (d.synced_at) lines.push('', 'Timeclock data as of ' + syncedLabel(d.synced_at, d.today) + '.');
    return lines.join('\n');
  }

  $('printBtn').addEventListener('click', () => {
    const d = state.data;
    const ws = d.weeks[state.weekIndex];
    const old = document.title;
    document.title = 'Timesheet ' + d.employee.name + ' ' + slashDate(ws) + '-' + slashDate(addDays(ws, 6));
    window.print();
    setTimeout(() => { document.title = old; }, 1000);
  });

  $('shareBtn').addEventListener('click', async () => {
    const text = weekSummaryText();
    if (navigator.share) {
      try { await navigator.share({ title: 'My hours', text }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(text); toast('Week copied. Paste it into a text or email.'); }
    catch (e) { toast('Sharing is not available on this device. Use Print instead.'); }
  });

  // Refresh when the app comes back to the foreground after 5+ minutes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.data && Date.now() - state.lastFetch > 5 * 60 * 1000) {
      loadHours(false);
    }
  });

  // ---------------- Start ----------------
  $('siEmpId').value = store.get(EMPID_KEY) || '';
  if (store.get(TOKEN_KEY)) loadHours(false);
  else show('viewSignIn');

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works without it */ });
  }
})();
