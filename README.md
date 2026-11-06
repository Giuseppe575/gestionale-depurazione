# Gestionale Depurazione – Pancrazio S.p.A.

Web app per la registrazione dell'**autocontrollo settimanale AUA** dell'impianto di depurazione
(registro **REG-IMP-03**, Rev. 0 – 06/11/2026), con parametri **a MONTE** (vasca di ossidazione) e
**a VALLE** (pozzetto fiscale), accesso riservato agli operatori autenticati.

| Punto | Parametri |
|---|---|
| MONTE – vasca di ossidazione | pH*, Temperatura*, Odore*, COD*, Solidi sedimentabili fanghi, Ossigeno disciolto |
| VALLE – pozzetto fiscale | pH*, Temperatura*, Odore*, COD*, Cloro attivo libero, Azoto nitrico |

\* obbligatori. Limiti allo scarico in pubblica fognatura (Tab. 3 All. 5 Parte III D.Lgs. 152/06):
COD ≤ 500 mg/L · Azoto nitrico ≤ 30 mg/L N · Cloro attivo libero ≤ 0,3 mg/L · pH 5,5–9,5.
In caso di superamento l'app obbliga a indicare il N. di non conformità (REG-NC-01) e marca la riga **NON CONFORME**.

## Struttura

```
index.html, style.css, app.js, config.js   → frontend (GitHub Pages)
apps-script/Code.gs, appsscript.json       → backend (Google Apps Script + Google Sheets)
```

## Backend Google Apps Script – installazione / aggiornamento

1. Aprire il Foglio Google del registro → **Estensioni → Apps Script**
   (se lo script esistente è un progetto separato, usare quello e impostare la proprietà script
   `SPREADSHEET_ID` con l'ID del foglio).
2. Sostituire tutto il contenuto di `Code.gs` con [apps-script/Code.gs](apps-script/Code.gs).
   In *Impostazioni progetto* attivare "Mostra file manifest" e incollare [apps-script/appsscript.json](apps-script/appsscript.json).
3. Salvare, ricaricare il Foglio: compare il menu **Gestionale depurazione**.
   Eseguire **1) Inizializza / proteggi fogli** (autorizzare lo script alla prima esecuzione).
4. **Gestionale depurazione → Nuovo operatore** per ogni operatore: viene mostrata una password
   temporanea da consegnare di persona; al primo accesso l'operatore deve cambiarla.
5. **Esegui il deployment → Gestisci deployment → (deployment esistente) → Modifica → Versione: Nuova versione → Esegui il deployment.**
   Impostazioni: *Esegui come: Me* · *Chi ha accesso: Chiunque*.
   Aggiornando il deployment esistente l'URL `/exec` resta lo stesso già presente in `config.js`.
   Se si crea un nuovo deployment, copiare il nuovo URL in [config.js](config.js).

Fogli creati: `REG-IMP-03 Autocontrollo` (registro), `Operatori` (nascosto, password solo come hash),
`Log accessi`. I dati storici dei fogli precedenti non vengono toccati.

### Amministrazione (menu del Foglio, solo proprietario)
- Nuovo operatore · Reimposta password · Attiva/disattiva (revoca immediata delle sessioni) · Sblocca
- **Verifica integrità registro**: ricalcola la catena di hash e segnala le righe modificate a mano.

## Sicurezza (sintesi)
- Login con username + password personale; hash SHA-256 salato e iterato, blocco dopo 5 tentativi per 15 min.
- Sessione con token casuale (4 h, chiusura automatica dopo 30 min di inattività), logout con revoca.
- Operatore e data/ora registrati **dal server** (non modificabili dal client).
- Validazione server di tutti i campi, protezione da formula-injection, anti doppio invio, lock di scrittura.
- Fogli protetti (solo proprietario), log accessi/operazioni, catena di hash anti-manomissione.
- Frontend con Content-Security-Policy, Subresource Integrity sul CSS, nessun `innerHTML`.
