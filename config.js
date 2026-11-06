/*
 * Configurazione del frontend.
 * API_URL = URL della Web App Google Apps Script (deployment "/exec").
 * Se si aggiorna lo stesso deployment esistente con una nuova versione,
 * l'URL resta invariato.
 * NB: l'URL non è un segreto: la protezione è data dall'autenticazione operatore.
 */
window.APP_CONFIG = Object.freeze({
  API_URL: 'https://script.google.com/macros/s/AKfycby-zdYGbyl9o1etWe1iiSepgrmDFcgb6cjdDxQQ4qQjj_PhXfQeKo5ToUErQMRJEQtXnw/exec',
  INACTIVITY_LOGOUT_MIN: 30
});
