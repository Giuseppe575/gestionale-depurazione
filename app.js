/*
 * Pancrazio S.p.A. – Gestionale depurazione
 * Frontend REG-IMP-03 – Autocontrollo settimanale MONTE / VALLE
 */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const $ = (id) => document.getElementById(id);
  const SS_KEY = 'gd_session';

  const CAMPI_NUM = ['monte_ph', 'monte_temp', 'monte_cod', 'monte_sed', 'monte_od',
                     'valle_ph', 'valle_temp', 'valle_cod', 'valle_cloro', 'valle_n_nitrico'];
  const LABEL = {
    monte_ph: 'pH', monte_temp: 'Temperatura (°C)', monte_odore: 'Odore', monte_cod: 'COD (mg/L O₂)',
    monte_sed: 'Solidi sedimentabili fanghi (ml/L)', monte_od: 'Ossigeno disciolto (mg/L)',
    valle_ph: 'pH', valle_temp: 'Temperatura (°C)', valle_odore: 'Odore', valle_cod: 'COD (mg/L O₂)',
    valle_cloro: 'Cloro attivo libero (mg/L)', valle_n_nitrico: 'Azoto nitrico (mg/L N)'
  };

  let session = null;       // { token, nome, mustChange, config }
  let inactivityTimer = null;

  // ------------------------------------------------------------------ API
  async function api(action, payload) {
    const body = Object.assign({ action: action }, payload || {});
    if (session && session.token) body.token = session.token;
    let res;
    try {
      // text/plain evita il preflight CORS verso Apps Script
      res = await fetch(CFG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (e) {
      throw new Error('Impossibile contattare il server. Verificare la connessione.');
    }
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('Risposta del server non valida.'); }
    if (data && data.auth === false) {
      clearSession();
      showView('login');
      throw new Error(data.error || 'Sessione scaduta.');
    }
    if (!data || !data.ok) throw new Error((data && data.error) || 'Errore sconosciuto.');
    return data;
  }

  // ------------------------------------------------------------------ UI helpers
  function showAlert(msg, type) {
    const box = $('alertBox');
    box.className = 'alert alert-' + (type || 'danger');
    box.textContent = msg;
    box.classList.remove('d-none');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function hideAlert() { $('alertBox').classList.add('d-none'); }

  function showView(name) {
    $('viewLogin').hidden = name !== 'login';
    $('viewChangePw').hidden = name !== 'changePw';
    $('viewForm').hidden = name !== 'form';
    $('userBox').hidden = name === 'login';
    if (session) $('userName').textContent = session.nome;
  }

  function setBusy(btn, busy, text) {
    btn.disabled = busy;
    if (busy) { btn.dataset.txt = btn.textContent; btn.textContent = text || 'Attendere…'; }
    else if (btn.dataset.txt) btn.textContent = btn.dataset.txt;
  }

  function saveSession() { sessionStorage.setItem(SS_KEY, JSON.stringify(session)); }
  function clearSession() { session = null; sessionStorage.removeItem(SS_KEY); }

  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const a = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------------ Inattività
  function resetInactivity() {
    if (!session) return;
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      doLogout(true);
    }, CFG.INACTIVITY_LOGOUT_MIN * 60000);
  }
  ['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, resetInactivity, { passive: true }));

  // ------------------------------------------------------------------ Login / logout
  $('formLogin').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();
    const u = $('username').value.trim();
    const p = $('password').value;
    if (!u || !p) { showAlert('Inserire username e password.'); return; }
    const btn = $('btnLogin');
    setBusy(btn, true, 'Accesso in corso…');
    try {
      const r = await api('login', { username: u, password: p });
      session = { token: r.token, nome: r.nome, mustChange: r.mustChange, config: r.config };
      saveSession();
      $('password').value = '';
      afterLogin();
    } catch (err) {
      showAlert(err.message);
    } finally {
      setBusy(btn, false);
    }
  });

  async function doLogout(timeout) {
    try { if (session) await api('logout'); } catch (e) { /* ignora */ }
    clearSession();
    clearTimeout(inactivityTimer);
    $('formAC').reset();
    showView('login');
    if (timeout) showAlert('Sessione chiusa per inattività.', 'warning');
  }
  $('btnLogout').addEventListener('click', () => doLogout(false));

  function afterLogin() {
    resetInactivity();
    if (session.mustChange) { showView('changePw'); return; }
    initForm();
    showView('form');
    loadRecent();
  }

  // ------------------------------------------------------------------ Cambio password
  $('formChangePw').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();
    const oldPw = $('oldPw').value, newPw = $('newPw').value, newPw2 = $('newPw2').value;
    if (newPw !== newPw2) { showAlert('Le due nuove password non coincidono.'); return; }
    if (newPw.length < 8 || !/[A-Za-z]/.test(newPw) || !/\d/.test(newPw)) {
      showAlert('La password deve avere almeno 8 caratteri, con lettere e numeri.'); return;
    }
    const btn = e.submitter || $('formChangePw').querySelector('button');
    setBusy(btn, true);
    try {
      await api('changePassword', { oldPassword: oldPw, newPassword: newPw });
      session.mustChange = false;
      saveSession();
      $('formChangePw').reset();
      showAlert('Password aggiornata correttamente.', 'success');
      afterLogin();
    } catch (err) {
      showAlert(err.message);
    } finally {
      setBusy(btn, false);
    }
  });

  // ------------------------------------------------------------------ Form autocontrollo
  function initForm() {
    const cfg = session.config || {};
    $('recapito').value = cfg.recapito || '';
    $('data_prelievo').value = todayISO();
    $('data_prelievo').max = todayISO();

    document.querySelectorAll('select.odore').forEach((sel) => {
      sel.replaceChildren();
      const ph = new Option('— seleziona —', '');
      sel.add(ph);
      (cfg.odori || []).forEach((o) => sel.add(new Option(o, o)));
    });

    const lim = cfg.limitiValle || {};
    document.querySelectorAll('.lim').forEach((el) => {
      const L = lim[el.dataset.lim];
      if (!L) return;
      el.textContent = L.min !== undefined ? '(limite ' + L.min + '–' + L.max + ')' : '(limite ≤ ' + L.max + ')';
    });
    checkLimiti();
  }

  function num(id) {
    const v = $(id).value.trim().replace(',', '.');
    return v === '' ? null : Number(v);
  }

  function checkLimiti() {
    const lim = (session && session.config && session.config.limitiValle) || {};
    const fuori = [];
    Object.keys(lim).forEach((k) => {
      const L = lim[k], v = num(k), el = $(k);
      const over = v !== null && ((L.min !== undefined && v < L.min) || (L.max !== undefined && v > L.max));
      el.classList.toggle('is-over', over);
      if (over) fuori.push(L.label + ' = ' + v);
    });
    const w = $('ncWarning');
    if (fuori.length) {
      w.textContent = '⚠ Valori oltre i limiti allo scarico: ' + fuori.join(', ') +
        '. Ripetere la misura; se confermato aprire una non conformità (REG-NC-01), riportarne il numero nelle Note e informare il Responsabile dell\'impianto.';
      w.classList.remove('d-none');
    } else {
      w.classList.add('d-none');
    }
    return fuori;
  }
  $('formAC').addEventListener('input', checkLimiti);

  function raccogliDati() {
    const d = { data_prelievo: $('data_prelievo').value, note: $('note').value.trim() };
    CAMPI_NUM.forEach((k) => { d[k] = $(k).value.trim().replace(',', '.'); });
    d.monte_odore = $('monte_odore').value;
    d.valle_odore = $('valle_odore').value;
    return d;
  }

  function validaClient() {
    const form = $('formAC');
    if (!form.checkValidity()) {
      form.classList.add('was-validated');
      const first = form.querySelector(':invalid');
      if (first) first.focus();
      return 'Compilare correttamente tutti i campi obbligatori (*) – controllare i valori evidenziati.';
    }
    const fuori = checkLimiti();
    if (fuori.length && $('note').value.trim().length < 3) {
      $('note').focus();
      return 'Ci sono valori oltre i limiti: indicare nelle Note il N. di non conformità (REG-NC-01).';
    }
    return '';
  }

  function riepilogoNode(d, fuori) {
    const wrap = document.createElement('div');
    const p = document.createElement('p');
    p.className = 'mb-2';
    p.textContent = 'Data prelievo: ' + d.data_prelievo.split('-').reverse().join('/') + ' · Operatore: ' + session.nome;
    wrap.appendChild(p);

    const tbl = document.createElement('table');
    tbl.className = 'table table-sm mb-2';
    const head = tbl.createTHead().insertRow();
    ['Parametro', 'MONTE', 'VALLE'].forEach((h) => { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); });
    const body = tbl.createTBody();
    const righe = [
      ['pH', 'monte_ph', 'valle_ph'], ['Temperatura (°C)', 'monte_temp', 'valle_temp'],
      ['Odore', 'monte_odore', 'valle_odore'], ['COD (mg/L O₂)', 'monte_cod', 'valle_cod'],
      ['Solidi sedim. fanghi (ml/L)', 'monte_sed', null], ['Ossigeno disciolto (mg/L)', 'monte_od', null],
      ['Cloro attivo libero (mg/L)', null, 'valle_cloro'], ['Azoto nitrico (mg/L N)', null, 'valle_n_nitrico']
    ];
    righe.forEach((r) => {
      const tr = body.insertRow();
      tr.insertCell().textContent = r[0];
      tr.insertCell().textContent = r[1] ? (d[r[1]] || 'n.r.') : '—';
      const c = tr.insertCell();
      c.textContent = r[2] ? (d[r[2]] || 'n.r.') : '—';
      if (r[2] && $(r[2]).classList.contains('is-over')) c.className = 'text-danger fw-bold';
    });
    wrap.appendChild(tbl);

    const esito = document.createElement('div');
    esito.className = 'alert py-2 mb-0 ' + (fuori.length ? 'alert-danger' : 'alert-success');
    esito.textContent = fuori.length ? 'Esito valle: NON CONFORME – ' + fuori.join(', ') : 'Esito valle: CONFORME ai limiti allo scarico';
    wrap.appendChild(esito);
    if (d.note) {
      const n = document.createElement('p');
      n.className = 'mt-2 mb-0';
      n.textContent = 'Note: ' + d.note;
      wrap.appendChild(n);
    }
    return wrap;
  }

  let pendingData = null;
  $('formAC').addEventListener('submit', (e) => {
    e.preventDefault();
    hideAlert();
    const err = validaClient();
    if (err) { showAlert(err, 'warning'); return; }
    pendingData = { data: raccogliDati(), requestId: uuid() };
    $('dlgBody').replaceChildren(riepilogoNode(pendingData.data, checkLimiti()));
    $('dlgConfirm').showModal();
  });

  $('dlgCancel').addEventListener('click', () => { $('dlgConfirm').close(); pendingData = null; });

  $('dlgOk').addEventListener('click', async () => {
    if (!pendingData) return;
    const btn = $('dlgOk');
    setBusy(btn, true, 'Registrazione…');
    try {
      const r = await api('submit', pendingData);
      $('dlgConfirm').close();
      pendingData = null;
      $('formAC').reset();
      $('formAC').classList.remove('was-validated');
      initForm();
      showAlert('✅ Registrazione salvata (ID ' + r.id + ', ' + r.timestamp + ') – Esito valle: ' + r.esito,
        r.esito === 'CONFORME' ? 'success' : 'warning');
      loadRecent();
    } catch (err) {
      $('dlgConfirm').close();
      showAlert(err.message);
    } finally {
      setBusy(btn, false);
    }
  });

  // ------------------------------------------------------------------ Ultime registrazioni
  async function loadRecent() {
    const tb = $('recentBody');
    try {
      const r = await api('recent');
      tb.replaceChildren();
      if (!r.rows.length) {
        const tr = tb.insertRow(); const td = tr.insertCell();
        td.colSpan = 6; td.className = 'text-muted'; td.textContent = 'Nessuna registrazione.';
        return;
      }
      r.rows.forEach((row) => {
        const tr = tb.insertRow();
        [row.data, row.operatore, row.monte.cod, row.valle.cod, row.valle.ph].forEach((v) => {
          tr.insertCell().textContent = v || '—';
        });
        const td = tr.insertCell();
        const b = document.createElement('span');
        b.className = 'badge ' + (row.esito === 'CONFORME' ? 'badge-ok' : 'badge-nc');
        b.textContent = row.esito;
        td.appendChild(b);
      });
    } catch (err) {
      tb.replaceChildren();
      const td = tb.insertRow().insertCell();
      td.colSpan = 6; td.className = 'text-danger'; td.textContent = err.message;
    }
  }
  $('btnRefresh').addEventListener('click', loadRecent);

  // ------------------------------------------------------------------ Avvio
  const logo = $('logo');
  logo.addEventListener('load', () => { logo.hidden = false; });
  logo.addEventListener('error', () => logo.remove());

  try { session = JSON.parse(sessionStorage.getItem(SS_KEY) || 'null'); } catch (e) { session = null; }
  if (session && session.token) afterLogin(); else showView('login');
})();
