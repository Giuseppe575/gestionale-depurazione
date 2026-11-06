/**
 * ============================================================================
 *  GESTIONALE DEPURAZIONE – PANCRAZIO S.P.A.
 *  Backend Google Apps Script (API JSON) – v2.1
 *
 *  Registro: REG-IMP-03 – Registro autocontrollo settimanale AUA
 *            (analisi interne a MONTE e a VALLE dell'impianto)
 *  Rif.:     Piano di attività analisi nov-lug rev. 03 · PA-IMP-02 ·
 *            A.U.A. n. 1 del 21/01/2026
 *
 *  Funzioni:
 *   - registrazione operatore in due passaggi (richiesta dall'app →
 *     approvazione del titolare nel Foglio Google prima del primo accesso)
 *   - autenticazione operatori (username + password con hash salato e
 *     iterato, blocco dopo tentativi falliti, sessioni a scadenza)
 *   - registrazione parametri MONTE / VALLE con validazione lato server
 *   - verifica automatica dei limiti allo scarico (valle)
 *   - registro con catena di hash per verificare l'integrità dei dati
 *   - log degli accessi e delle operazioni
 *
 *  INSTALLAZIONE: vedi README.md (sezione "Backend Google Apps Script").
 *  Lo script va creato DAL Foglio Google (Estensioni → Apps Script).
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// CONFIGURAZIONE
// ----------------------------------------------------------------------------
const CONFIG = {
  SHEET_REGISTRO: 'REG-IMP-03 Autocontrollo',
  SHEET_OPERATORI: 'Operatori',
  SHEET_LOG: 'Log accessi',
  TIMEZONE: 'Europe/Rome',

  SESSION_TTL_SEC: 4 * 60 * 60,     // durata sessione: 4 ore (max CacheService 6h)
  MAX_LOGIN_FAILS: 5,               // tentativi errati prima del blocco
  LOCKOUT_MIN: 15,                  // minuti di blocco account
  PASSWORD_MIN_LEN: 8,
  HASH_ITERATIONS: 2000,
  NOTE_MAX_LEN: 500,
  RECENT_ROWS: 10,

  RECAPITO_SCARICO: 'Pubblica fognatura',

  // Limiti allo scarico (VALLE – pozzetto fiscale) per scarico in pubblica
  // fognatura – Tab. 3 All. 5 Parte III D.Lgs. 152/06 (come da REG-IMP-03).
  LIMITI_VALLE: {
    valle_ph:        { min: 5.5, max: 9.5, label: 'pH' },
    valle_cod:       { max: 500, label: 'COD (mg/L O₂)' },
    valle_n_nitrico: { max: 30,  label: 'Azoto nitrico (mg/L N)' },
    valle_cloro:     { max: 0.3, label: 'Cloro attivo libero (mg/L)' }
  },

  ODORI: ['Assente', 'Lieve', 'Moderato', 'Forte / anomalo']
};

// Definizione campi: chiave → regole di validazione (range plausibili fisici)
const CAMPI = {
  // MONTE – vasca di ossidazione (refluo da trattare)
  monte_ph:        { tipo: 'num', min: 0,  max: 14,     obbl: true,  label: 'MONTE pH' },
  monte_temp:      { tipo: 'num', min: 0,  max: 60,     obbl: true,  label: 'MONTE Temperatura' },
  monte_odore:     { tipo: 'odore',                     obbl: true,  label: 'MONTE Odore' },
  monte_cod:       { tipo: 'num', min: 0,  max: 100000, obbl: true,  label: 'MONTE COD' },
  monte_sed:       { tipo: 'num', min: 0,  max: 1000,   obbl: false, label: 'MONTE Solidi sedimentabili fanghi' },
  monte_od:        { tipo: 'num', min: 0,  max: 25,     obbl: false, label: 'MONTE Ossigeno disciolto' },
  // VALLE – pozzetto fiscale (refluo trattato)
  valle_ph:        { tipo: 'num', min: 0,  max: 14,     obbl: true,  label: 'VALLE pH' },
  valle_temp:      { tipo: 'num', min: 0,  max: 60,     obbl: true,  label: 'VALLE Temperatura' },
  valle_odore:     { tipo: 'odore',                     obbl: true,  label: 'VALLE Odore' },
  valle_cod:       { tipo: 'num', min: 0,  max: 100000, obbl: true,  label: 'VALLE COD' },
  valle_cloro:     { tipo: 'num', min: 0,  max: 50,     obbl: false, label: 'VALLE Cloro attivo libero' },
  valle_n_nitrico: { tipo: 'num', min: 0,  max: 1000,   obbl: false, label: 'VALLE Azoto nitrico' }
};

const HEADER_REGISTRO = [
  'ID record', 'Data/ora registrazione (server)', 'Data prelievo', 'Settimana (ISO)',
  'Operatore (username)', 'Operatore (nome)',
  'MONTE pH', 'MONTE Temp. (°C)', 'MONTE Odore', 'MONTE COD (mg/L O₂)',
  'MONTE Solidi sedim. fanghi (ml/L)', 'MONTE Ossigeno disciolto (mg/L)',
  'VALLE pH', 'VALLE Temp. (°C)', 'VALLE Odore', 'VALLE COD (mg/L O₂)',
  'VALLE Cloro attivo libero (mg/L)', 'VALLE Azoto nitrico (mg/L N)',
  'Esito valle', 'Parametri fuori limite', 'Note / N. NC (REG-NC-01)', 'Hash integrità'
];

const HEADER_OPERATORI = [
  'Username', 'Nome e cognome', 'Ruolo', 'Autorizzato (spunta per abilitare)', 'Salt', 'Hash password',
  'Cambio password obbligatorio', 'Tentativi falliti', 'Bloccato fino a',
  'Ultimo accesso', 'Creato il'
];
const OP = { USER: 0, NOME: 1, RUOLO: 2, ATTIVO: 3, SALT: 4, HASH: 5, MUST: 6, FAILS: 7, LOCK: 8, LAST: 9, CREATED: 10 };

const HEADER_LOG = ['Data/ora', 'Username', 'Evento', 'Esito', 'Dettaglio'];

// ----------------------------------------------------------------------------
// ENTRY POINT WEB APP
// ----------------------------------------------------------------------------
function doGet() {
  // Nessun dato esposto in GET.
  return json_({ ok: true, service: 'gestionale-depurazione', version: '2.1' });
}

function doPost(e) {
  let req;
  try {
    if (!e || !e.postData || !e.postData.contents || e.postData.contents.length > 20000) {
      return json_({ ok: false, error: 'Richiesta non valida.' });
    }
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Richiesta non valida.' });
  }

  try {
    switch (String(req.action || '')) {
      case 'register':       return json_(register_(req));
      case 'login':          return json_(login_(req));
      case 'logout':         return json_(logout_(req));
      case 'changePassword': return json_(changePassword_(req));
      case 'submit':         return json_(submit_(req));
      case 'recent':         return json_(recent_(req));
      default:               return json_({ ok: false, error: 'Azione non supportata.' });
    }
  } catch (err) {
    if (err && err.isAuth) return json_({ ok: false, auth: false, error: err.message });
    if (err && err.isUser) return json_({ ok: false, error: err.message });
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'Errore interno del server. Riprovare.' });
  }
}

// ----------------------------------------------------------------------------
// REGISTRAZIONE OPERATORE (1° passaggio: richiesta → in attesa di approvazione)
// ----------------------------------------------------------------------------
function register_(req) {
  const username = normUser_(req.username);
  const nome = String(req.nome || '').trim();
  const password = String(req.password || '');

  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw userErr_('Username non valido (3–40 caratteri: lettere minuscole, numeri, punto, trattino; es. mario.rossi).');
  }
  if (nome.length < 3 || nome.length > 80) {
    throw userErr_('Inserire Nome e Cognome (almeno 3 caratteri).');
  }
  const pwErr = passwordPolicyError_(password, username);
  if (pwErr) throw userErr_(pwErr);

  // Rate limit richieste di registrazione
  const cache = CacheService.getScriptCache();
  const rlKey = 'reg_rl';
  const rl = Number(cache.get(rlKey) || 0);
  if (rl >= 15) {
    log_(username, 'REGISTRAZIONE UTENTE', 'RIFIUTATO', 'Troppi tentativi di registrazione');
    throw userErr_('Troppe richieste ravvicinate. Riprovare più tardi.');
  }
  cache.put(rlKey, String(rl + 1), 15 * 60);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (findOperatore_(username)) {
      log_(username, 'REGISTRAZIONE UTENTE', 'RIFIUTATO', 'Username già esistente');
      throw userErr_('Username già registrato o in attesa di autorizzazione.');
    }
    const salt = randomSalt_();
    const sh = getSheet_(CONFIG.SHEET_OPERATORI, HEADER_OPERATORI);
    sh.appendRow([
      username, safeCell_(nome), 'operatore', false,
      salt, hashPassword_(password, salt), false, 0, '', '',
      Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss')
    ]);
    const last = sh.getLastRow();
    try { sh.getRange(last, OP.ATTIVO + 1).insertCheckboxes(); } catch (e) { /* opzionale */ }
    sh.getRange(last, 1, 1, 4).setBackground('#fff3cd');
  } finally {
    lock.releaseLock();
  }

  log_(username, 'REGISTRAZIONE UTENTE', 'IN ATTESA', 'Richiesta da ' + nome + ' – in attesa di autorizzazione nel foglio Operatori');
  return {
    ok: true,
    message: 'Richiesta registrata! Ora il Responsabile deve autorizzarti nel Foglio Google (foglio "Operatori", spunta su Autorizzato). Dopo l\'autorizzazione potrai accedere con username e password.'
  };
}

// ----------------------------------------------------------------------------
// AUTENTICAZIONE
// ----------------------------------------------------------------------------
function login_(req) {
  const username = normUser_(req.username);
  const password = String(req.password || '');
  const GENERIC = 'Credenziali non valide o account bloccato.';

  if (!username || !password || password.length > 200) throw userErr_(GENERIC);

  // Limite tentativi anche per username inesistenti (anti brute-force/enumerazione)
  const cache = CacheService.getScriptCache();
  const rlKey = 'rl_' + sha256Hex_(username);
  const rl = Number(cache.get(rlKey) || 0);
  if (rl >= CONFIG.MAX_LOGIN_FAILS * 2) {
    log_(username, 'LOGIN', 'RIFIUTATO', 'Troppi tentativi (rate limit)');
    throw userErr_(GENERIC);
  }

  const op = findOperatore_(username);
  const now = new Date();

  if (!op) {
    hashPassword_(password, 'dummy-salt-000000'); // tempo costante approssimato
    cache.put(rlKey, String(rl + 1), CONFIG.LOCKOUT_MIN * 60);
    log_(username, 'LOGIN', 'FALLITO', 'Username inesistente');
    throw userErr_(GENERIC);
  }

  const lockedUntil = op.row[OP.LOCK] ? new Date(op.row[OP.LOCK]) : null;
  if (lockedUntil && lockedUntil > now) {
    log_(username, 'LOGIN', 'RIFIUTATO', 'Account bloccato');
    throw userErr_(GENERIC);
  }

  const hash = hashPassword_(password, String(op.row[OP.SALT]));
  if (!safeEqual_(hash, String(op.row[OP.HASH]))) {
    const fails = Number(op.row[OP.FAILS] || 0) + 1;
    op.sheet.getRange(op.rowIndex, OP.FAILS + 1).setValue(fails);
    if (fails >= CONFIG.MAX_LOGIN_FAILS) {
      op.sheet.getRange(op.rowIndex, OP.LOCK + 1)
        .setValue(new Date(now.getTime() + CONFIG.LOCKOUT_MIN * 60000));
      op.sheet.getRange(op.rowIndex, OP.FAILS + 1).setValue(0);
      log_(username, 'LOGIN', 'BLOCCO', 'Account bloccato per ' + CONFIG.LOCKOUT_MIN + ' min');
    } else {
      log_(username, 'LOGIN', 'FALLITO', 'Password errata (' + fails + ')');
    }
    cache.put(rlKey, String(rl + 1), CONFIG.LOCKOUT_MIN * 60);
    throw userErr_(GENERIC);
  }

  // Password corretta, ma verifica se il Responsabile ha dato l'autorizzazione nel foglio
  if (!isTrue_(op.row[OP.ATTIVO])) {
    log_(username, 'LOGIN', 'IN ATTESA', 'Accesso tentato prima dell\'autorizzazione del Responsabile');
    throw userErr_('Account in attesa di autorizzazione (o disabilitato): il Responsabile deve attivare la spunta "Autorizzato" nel foglio Operatori.');
  }

  // Successo
  op.sheet.getRange(op.rowIndex, OP.FAILS + 1, 1, 3).setValues([[0, '', now]]);
  cache.remove(rlKey);

  const token = Utilities.getUuid() + Utilities.getUuid();
  const sess = {
    username: username,
    nome: String(op.row[OP.NOME]),
    ruolo: String(op.row[OP.RUOLO] || 'operatore'),
    mustChange: isTrue_(op.row[OP.MUST])
  };
  cache.put(sessKey_(token), JSON.stringify(sess), CONFIG.SESSION_TTL_SEC);
  log_(username, 'LOGIN', 'OK', '');

  return {
    ok: true,
    token: token,
    nome: sess.nome,
    ruolo: sess.ruolo,
    mustChange: sess.mustChange,
    expiresIn: CONFIG.SESSION_TTL_SEC,
    config: publicConfig_()
  };
}

function logout_(req) {
  const token = String(req.token || '');
  if (token) {
    const sess = getSession_(token, true);
    CacheService.getScriptCache().remove(sessKey_(token));
    if (sess) log_(sess.username, 'LOGOUT', 'OK', '');
  }
  return { ok: true };
}

function changePassword_(req) {
  const sess = requireSession_(req.token, true);
  const oldPw = String(req.oldPassword || '');
  const newPw = String(req.newPassword || '');

  const pwErr = passwordPolicyError_(newPw, sess.username);
  if (pwErr) throw userErr_(pwErr);

  const op = findOperatore_(sess.username);
  if (!op) throw authErr_('Sessione non valida.');
  if (!safeEqual_(hashPassword_(oldPw, String(op.row[OP.SALT])), String(op.row[OP.HASH]))) {
    log_(sess.username, 'CAMBIO PASSWORD', 'FALLITO', 'Password attuale errata');
    throw userErr_('La password attuale non è corretta.');
  }
  if (oldPw === newPw) throw userErr_('La nuova password deve essere diversa da quella attuale.');

  const salt = randomSalt_();
  op.sheet.getRange(op.rowIndex, OP.SALT + 1, 1, 3)
    .setValues([[salt, hashPassword_(newPw, salt), false]]);

  sess.mustChange = false;
  CacheService.getScriptCache().put(sessKey_(req.token), JSON.stringify(sess), CONFIG.SESSION_TTL_SEC);
  log_(sess.username, 'CAMBIO PASSWORD', 'OK', '');
  return { ok: true };
}

function requireSession_(token, allowMustChange) {
  const sess = getSession_(token, false);
  if (!sess) throw authErr_('Sessione scaduta o non valida. Effettuare di nuovo l\'accesso.');
  if (sess.mustChange && !allowMustChange) {
    throw userErr_('È necessario cambiare la password prima di registrare dati.');
  }
  return sess;
}

function getSession_(token, silent) {
  token = String(token || '');
  if (!/^[0-9a-f-]{72}$/i.test(token)) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get(sessKey_(token));
  if (!raw) return null;
  const sess = JSON.parse(raw);
  if (!silent) {
    // Verifica che l'operatore sia ancora attivo (revoca immediata)
    const op = findOperatore_(sess.username);
    if (!op || !isTrue_(op.row[OP.ATTIVO])) {
      cache.remove(sessKey_(token));
      return null;
    }
    // Rinnovo scadenza (sliding expiration)
    cache.put(sessKey_(token), raw, CONFIG.SESSION_TTL_SEC);
  }
  return sess;
}

// ----------------------------------------------------------------------------
// REGISTRAZIONE AUTOCONTROLLO
// ----------------------------------------------------------------------------
function submit_(req) {
  const sess = requireSession_(req.token, false);
  const d = req.data || {};

  // Anti doppio invio (idempotenza)
  const requestId = String(req.requestId || '');
  if (!/^[0-9a-zA-Z-]{8,64}$/.test(requestId)) throw userErr_('Richiesta non valida (ID mancante).');
  const cache = CacheService.getScriptCache();
  const dupKey = 'req_' + requestId;
  const prev = cache.get(dupKey);
  if (prev) return JSON.parse(prev);

  // --- Validazione data prelievo
  const dataPrelievo = parseDate_(d.data_prelievo);
  if (!dataPrelievo) throw userErr_('Data del prelievo non valida.');
  const oggi = new Date();
  if (dataPrelievo.getTime() > oggi.getTime() + 24 * 3600 * 1000) {
    throw userErr_('La data del prelievo non può essere nel futuro.');
  }
  if (oggi.getTime() - dataPrelievo.getTime() > 60 * 24 * 3600 * 1000) {
    throw userErr_('La data del prelievo è più vecchia di 60 giorni: contattare il Responsabile.');
  }

  // --- Validazione parametri
  const v = {};
  const errori = [];
  Object.keys(CAMPI).forEach(function (k) {
    const c = CAMPI[k];
    const raw = d[k];
    const vuoto = raw === undefined || raw === null || String(raw).trim() === '';
    if (vuoto) {
      if (c.obbl) errori.push(c.label + ': obbligatorio');
      v[k] = '';
      return;
    }
    if (c.tipo === 'num') {
      const n = Number(String(raw).replace(',', '.').trim());
      if (!isFinite(n)) { errori.push(c.label + ': non è un numero'); return; }
      if (n < c.min || n > c.max) { errori.push(c.label + ': fuori intervallo (' + c.min + '–' + c.max + ')'); return; }
      v[k] = Math.round(n * 1000) / 1000;
    } else if (c.tipo === 'odore') {
      const s = String(raw).trim();
      if (CONFIG.ODORI.indexOf(s) === -1) { errori.push(c.label + ': valore non ammesso'); return; }
      v[k] = s;
    }
  });
  if (errori.length) throw userErr_('Dati non validi: ' + errori.join('; '));

  const note = String(d.note || '').trim().substring(0, CONFIG.NOTE_MAX_LEN);

  // --- Verifica limiti allo scarico (VALLE)
  const fuori = [];
  Object.keys(CONFIG.LIMITI_VALLE).forEach(function (k) {
    const L = CONFIG.LIMITI_VALLE[k];
    if (v[k] === '') return;
    if ((L.min !== undefined && v[k] < L.min) || (L.max !== undefined && v[k] > L.max)) {
      fuori.push(L.label + ' = ' + v[k]);
    }
  });
  const esito = fuori.length ? 'NON CONFORME' : 'CONFORME';
  if (fuori.length && note.length < 3) {
    throw userErr_('Valori oltre i limiti allo scarico (' + fuori.join(', ') +
      '). Ripetere la misura e indicare nelle Note il N. di non conformità (REG-NC-01).');
  }

  // --- Scrittura con lock e catena di hash
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let idRecord, timestamp;
  try {
    const sh = getSheet_(CONFIG.SHEET_REGISTRO, HEADER_REGISTRO);
    const last = sh.getLastRow();
    const prevHash = last > 1 ? String(sh.getRange(last, HEADER_REGISTRO.length).getValue()) : 'GENESIS';

    timestamp = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    idRecord = 'AC-' + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd-HHmmss') + '-' +
      Utilities.getUuid().substring(0, 4).toUpperCase();

    const row = [
      idRecord, timestamp,
      Utilities.formatDate(dataPrelievo, CONFIG.TIMEZONE, 'yyyy-MM-dd'),
      isoWeek_(dataPrelievo),
      sess.username, safeCell_(sess.nome),
      v.monte_ph, v.monte_temp, v.monte_odore, v.monte_cod, v.monte_sed, v.monte_od,
      v.valle_ph, v.valle_temp, v.valle_odore, v.valle_cod, v.valle_cloro, v.valle_n_nitrico,
      esito, safeCell_(fuori.join('; ')), safeCell_(note)
    ];
    row.push(rowHash_(prevHash, row));

    sh.getRange(last + 1, 1, 1, row.length).setValues([row]);
    if (esito === 'NON CONFORME') {
      sh.getRange(last + 1, 19).setBackground('#f8d7da').setFontWeight('bold');
    }
  } finally {
    lock.releaseLock();
  }

  log_(sess.username, 'REGISTRAZIONE', 'OK', idRecord + ' – ' + esito);
  const res = { ok: true, id: idRecord, timestamp: timestamp, esito: esito, fuoriLimite: fuori };
  cache.put(dupKey, JSON.stringify(res), 600);
  return res;
}

function recent_(req) {
  requireSession_(req.token, true);
  const sh = getSheet_(CONFIG.SHEET_REGISTRO, HEADER_REGISTRO);
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, rows: [] };
  const n = Math.min(CONFIG.RECENT_ROWS, last - 1);
  const values = sh.getRange(last - n + 1, 1, n, HEADER_REGISTRO.length - 1).getDisplayValues();
  const rows = values.reverse().map(function (r) {
    return {
      id: r[0], registrato: r[1], data: r[2], operatore: r[5],
      monte: { ph: r[6], temp: r[7], odore: r[8], cod: r[9], sed: r[10], od: r[11] },
      valle: { ph: r[12], temp: r[13], odore: r[14], cod: r[15], cloro: r[16], n_nitrico: r[17] },
      esito: r[18]
    };
  });
  return { ok: true, rows: rows };
}

function publicConfig_() {
  return { recapito: CONFIG.RECAPITO_SCARICO, limitiValle: CONFIG.LIMITI_VALLE, odori: CONFIG.ODORI };
}

// ----------------------------------------------------------------------------
// AMMINISTRAZIONE (menu nel Foglio Google – solo proprietario)
// ----------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Gestionale depurazione')
    .addItem('1) Inizializza / proteggi fogli', 'setupFogli')
    .addSeparator()
    .addItem('Autorizza operatore in attesa', 'menuAutorizzaOperatore')
    .addItem('Nuovo operatore (crea da foglio)', 'menuNuovoOperatore')
    .addItem('Reimposta password operatore', 'menuResetPassword')
    .addItem('Attiva / disattiva operatore', 'menuToggleOperatore')
    .addItem('Sblocca operatore', 'menuSbloccaOperatore')
    .addSeparator()
    .addItem('Verifica integrità registro', 'verificaIntegrita')
    .addToUi();
}

function setupFogli() {
  const ss = getSpreadsheet_();
  const reg = getSheet_(CONFIG.SHEET_REGISTRO, HEADER_REGISTRO);
  const ops = getSheet_(CONFIG.SHEET_OPERATORI, HEADER_OPERATORI);
  const log = getSheet_(CONFIG.SHEET_LOG, HEADER_LOG);

  [reg, ops, log].forEach(function (sh) {
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#006064').setFontColor('#ffffff');
    // Protezione: solo il proprietario dello script può modificare
    const prot = sh.protect().setDescription('Gestito dal gestionale – non modificare a mano');
    const me = Session.getEffectiveUser();
    prot.addEditor(me);
    prot.removeEditors(prot.getEditors().filter(function (u) { return u.getEmail() !== me.getEmail(); }));
    if (prot.canDomainEdit()) prot.setDomainEdit(false);
  });
  reg.getRange('G1:L1').setBackground('#1565c0');
  reg.getRange('M1:R1').setBackground('#2e7d32');
  // Nasconde le colonne tecniche (Salt/Hash) ma lascia visibile il foglio Operatori per spuntare "Autorizzato"
  try { ops.showSheet(); ops.hideColumns(5, 2); } catch (e) { /* opzionale */ }
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
  SpreadsheetApp.getUi().alert(
    'Fogli inizializzati e protetti.\n\n' +
    'Quando un operatore invia la richiesta di registrazione dall\'app, compare nel foglio "Operatori" con sfondo giallo e "Autorizzato" = FALSO.\n' +
    'Per abilitarlo: metti la spunta nella colonna D ("Autorizzato") oppure usa il menu "Gestionale depurazione → Autorizza operatore in attesa".'
  );
}

function menuAutorizzaOperatore() {
  const ui = SpreadsheetApp.getUi();
  const sh = getSheet_(CONFIG.SHEET_OPERATORI, HEADER_OPERATORI);
  const last = sh.getLastRow();
  const inAttesa = [];
  if (last >= 2) {
    const data = sh.getRange(2, 1, last - 1, 4).getValues();
    data.forEach(function (r) {
      if (!isTrue_(r[OP.ATTIVO])) inAttesa.push(r[OP.USER] + ' (' + r[OP.NOME] + ')');
    });
  }
  const elenco = inAttesa.length ? '\nIn attesa:\n- ' + inAttesa.join('\n- ') + '\n\n' : '\n(Nessun operatore attualmente in attesa)\n\n';
  const u = ui.prompt('Autorizza operatore', elenco + 'Inserisci lo username da autorizzare:', ui.ButtonSet.OK_CANCEL);
  if (u.getSelectedButton() !== ui.Button.OK) return;
  const username = normUser_(u.getResponseText());
  const op = findOperatore_(username);
  if (!op) { ui.alert('Operatore non trovato.'); return; }
  op.sheet.getRange(op.rowIndex, OP.ATTIVO + 1).setValue(true);
  op.sheet.getRange(op.rowIndex, 1, 1, 4).setBackground('#d1e7dd');
  log_(username, 'ADMIN', 'OK', 'Operatore autorizzato dal Responsabile');
  ui.alert('Operatore "' + username + '" AUTORIZZATO.\nDa questo momento può accedere all\'app e registrare i parametri.');
}

function menuNuovoOperatore() {
  const ui = SpreadsheetApp.getUi();
  const u = ui.prompt('Nuovo operatore', 'Username (solo lettere minuscole, numeri, punto; es. mario.rossi):', ui.ButtonSet.OK_CANCEL);
  if (u.getSelectedButton() !== ui.Button.OK) return;
  const n = ui.prompt('Nuovo operatore', 'Nome e cognome:', ui.ButtonSet.OK_CANCEL);
  if (n.getSelectedButton() !== ui.Button.OK) return;
  try {
    const pw = creaOperatore(u.getResponseText(), n.getResponseText(), 'operatore');
    ui.alert('Operatore creato.\n\nUsername: ' + normUser_(u.getResponseText()) +
      '\nPassword temporanea: ' + pw +
      '\n\nComunicala all\'operatore di persona: al primo accesso dovrà cambiarla.');
  } catch (e) { ui.alert('Errore: ' + e.message); }
}

function menuResetPassword() {
  const ui = SpreadsheetApp.getUi();
  const u = ui.prompt('Reimposta password', 'Username:', ui.ButtonSet.OK_CANCEL);
  if (u.getSelectedButton() !== ui.Button.OK) return;
  try {
    const pw = resetPasswordOperatore(u.getResponseText());
    ui.alert('Password reimpostata.\nPassword temporanea: ' + pw + '\n\nAl prossimo accesso andrà cambiata.');
  } catch (e) { ui.alert('Errore: ' + e.message); }
}

function menuToggleOperatore() {
  const ui = SpreadsheetApp.getUi();
  const u = ui.prompt('Attiva / disattiva', 'Username:', ui.ButtonSet.OK_CANCEL);
  if (u.getSelectedButton() !== ui.Button.OK) return;
  const op = findOperatore_(normUser_(u.getResponseText()));
  if (!op) { ui.alert('Operatore non trovato.'); return; }
  const nuovo = !isTrue_(op.row[OP.ATTIVO]);
  op.sheet.getRange(op.rowIndex, OP.ATTIVO + 1).setValue(nuovo);
  log_(op.row[OP.USER], 'ADMIN', 'OK', nuovo ? 'Operatore attivato' : 'Operatore disattivato');
  ui.alert('Operatore ' + (nuovo ? 'ATTIVATO' : 'DISATTIVATO') + '. Le sessioni aperte vengono revocate.');
}

function menuSbloccaOperatore() {
  const ui = SpreadsheetApp.getUi();
  const u = ui.prompt('Sblocca operatore', 'Username:', ui.ButtonSet.OK_CANCEL);
  if (u.getSelectedButton() !== ui.Button.OK) return;
  const username = normUser_(u.getResponseText());
  const op = findOperatore_(username);
  if (!op) { ui.alert('Operatore non trovato.'); return; }
  op.sheet.getRange(op.rowIndex, OP.FAILS + 1, 1, 2).setValues([[0, '']]);
  CacheService.getScriptCache().remove('rl_' + sha256Hex_(username));
  log_(username, 'ADMIN', 'OK', 'Operatore sbloccato');
  ui.alert('Operatore sbloccato.');
}

/** Crea un operatore e restituisce la password temporanea. */
function creaOperatore(username, nome, ruolo) {
  username = normUser_(username);
  nome = String(nome || '').trim();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error('Username non valido (3–40 caratteri: a-z 0-9 . _ -).');
  if (nome.length < 3) throw new Error('Nome non valido.');
  if (findOperatore_(username)) throw new Error('Username già esistente.');
  const pw = tempPassword_();
  const salt = randomSalt_();
  const sh = getSheet_(CONFIG.SHEET_OPERATORI, HEADER_OPERATORI);
  sh.appendRow([username, safeCell_(nome), ruolo || 'operatore', true, salt, hashPassword_(pw, salt), true, 0, '', '', new Date()]);
  log_(username, 'ADMIN', 'OK', 'Operatore creato');
  return pw;
}

function resetPasswordOperatore(username) {
  username = normUser_(username);
  const op = findOperatore_(username);
  if (!op) throw new Error('Operatore non trovato.');
  const pw = tempPassword_();
  const salt = randomSalt_();
  op.sheet.getRange(op.rowIndex, OP.SALT + 1, 1, 5).setValues([[salt, hashPassword_(pw, salt), true, 0, '']]);
  log_(username, 'ADMIN', 'OK', 'Password reimpostata');
  return pw;
}

/** Ricalcola la catena di hash e segnala eventuali righe alterate. */
function verificaIntegrita() {
  const sh = getSheet_(CONFIG.SHEET_REGISTRO, HEADER_REGISTRO);
  const last = sh.getLastRow();
  let msg;
  if (last < 2) {
    msg = 'Registro vuoto.';
  } else {
    const data = sh.getRange(2, 1, last - 1, HEADER_REGISTRO.length).getValues();
    let prev = 'GENESIS';
    const errori = [];
    data.forEach(function (r, i) {
      const stored = String(r[r.length - 1]);
      const calc = rowHash_(prev, r.slice(0, -1));
      if (calc !== stored) errori.push(i + 2);
      prev = stored;
    });
    msg = errori.length
      ? 'ATTENZIONE: righe con hash non corrispondente (possibile modifica manuale): ' + errori.join(', ')
      : 'Integrità verificata: ' + data.length + ' registrazioni, nessuna alterazione rilevata.';
  }
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
  return msg;
}

// ----------------------------------------------------------------------------
// UTILITÀ
// ----------------------------------------------------------------------------
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function userErr_(msg) { const e = new Error(msg); e.isUser = true; return e; }
function authErr_(msg) { const e = new Error(msg); e.isAuth = true; return e; }

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name, header) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function findOperatore_(username) {
  if (!username) return null;
  const sh = getSheet_(CONFIG.SHEET_OPERATORI, HEADER_OPERATORI);
  const last = sh.getLastRow();
  if (last < 2) return null;
  const data = sh.getRange(2, 1, last - 1, HEADER_OPERATORI.length).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][OP.USER]).toLowerCase() === username) {
      return { sheet: sh, rowIndex: i + 2, row: data[i] };
    }
  }
  return null;
}

function log_(username, evento, esito, dettaglio) {
  try {
    const sh = getSheet_(CONFIG.SHEET_LOG, HEADER_LOG);
    sh.appendRow([
      Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
      safeCell_(String(username || '').substring(0, 60)), evento, esito, safeCell_(String(dettaglio || ''))
    ]);
  } catch (e) { console.error('log_ fallito: ' + e); }
}

function normUser_(u) { return String(u || '').trim().toLowerCase().substring(0, 40); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || String(v).toUpperCase() === 'VERO' || String(v).toUpperCase() === 'SI' || String(v).toUpperCase() === 'SÌ' || String(v) === '1'; }
function sessKey_(token) { return 'sess_' + sha256Hex_(token); }

/** Evita l'iniezione di formule nei fogli (=, +, -, @ all'inizio). */
function safeCell_(s) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/**
 * Hash di una riga del registro in forma canonica, insensibile alle
 * conversioni automatiche di Google Sheets (testo→data, apostrofo iniziale).
 */
function rowHash_(prevHash, row) {
  const canon = row.map(function (c, j) {
    if (Object.prototype.toString.call(c) === '[object Date]') {
      return Utilities.formatDate(c, CONFIG.TIMEZONE, j === 1 ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd');
    }
    if (typeof c === 'number') return String(c);
    const s = String(c == null ? '' : c);
    return /^'[=+\-@\t\r]/.test(s) ? s.substring(1) : s;
  });
  return sha256Hex_(prevHash + '|' + canon.join('\u241F'));
}

function sha256Hex_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/** Hash password: SHA-256 salato e iterato (key stretching). */
function hashPassword_(password, salt) {
  let h = sha256Hex_(salt + ':' + password);
  for (let i = 0; i < CONFIG.HASH_ITERATIONS; i++) h = sha256Hex_(h + ':' + salt);
  return h;
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function randomSalt_() { return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''); }

function tempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const rnd = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  let out = '';
  for (let i = 0; i < 12; i++) out += chars[parseInt(rnd.substr(i * 2, 2), 16) % chars.length];
  return out;
}

function passwordPolicyError_(pw, username) {
  if (pw.length < CONFIG.PASSWORD_MIN_LEN) return 'La password deve avere almeno ' + CONFIG.PASSWORD_MIN_LEN + ' caratteri.';
  if (pw.length > 128) return 'Password troppo lunga.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'La password deve contenere lettere e numeri.';
  if (pw.toLowerCase().indexOf(username) !== -1) return 'La password non può contenere lo username.';
  return '';
}

function parseDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}

function isoWeek_(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + ('0' + week).slice(-2);
}
