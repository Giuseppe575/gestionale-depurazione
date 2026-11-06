# Gestionale Depurazione – Pancrazio S.p.A.

Web app **installabile su PC (Windows/Mac) e Smartphone (Android/iOS)** per la registrazione dell'**autocontrollo settimanale AUA** dell'impianto di depurazione (registro **REG-IMP-03**, Rev. 0 – 06/11/2026), con parametri **a MONTE** (vasca di ossidazione) e **a VALLE** (pozzetto fiscale), accesso riservato agli operatori abilitati in due passaggi.

| Punto | Parametri |
|---|---|
| MONTE – vasca di ossidazione | pH*, Temperatura*, Odore*, COD*, Solidi sedimentabili fanghi, Ossigeno disciolto |
| VALLE – pozzetto fiscale | pH*, Temperatura*, Odore*, COD*, Cloro attivo libero, Azoto nitrico |

\* obbligatori. Limiti allo scarico in pubblica fognatura (Tab. 3 All. 5 Parte III D.Lgs. 152/06):
COD ≤ 500 mg/L · Azoto nitrico ≤ 30 mg/L N · Cloro attivo libero ≤ 0,3 mg/L · pH 5,5–9,5.
In caso di superamento l'app obbliga a indicare il N. di non conformità (REG-NC-01) e marca la riga **NON CONFORME**.

## Abilitazione dell'operatore in 2 passaggi

1. **1° passaggio (Operatore da PC o cellulare):** apre l'app, clicca su **"1° Passaggio: Registrati"**, inserisce Nome e Cognome, Username e Password e invia la richiesta.
2. **2° passaggio (Titolare/Responsabile nel Foglio Google):** nel foglio **`Operatori`** compare la riga dell'operatore evidenziata in giallo con la casella **Autorizzato** disattivata (`FALSO`).
   - Basta **mettere la spunta** nella colonna D (`Autorizzato`), oppure usare il menu **Gestionale depurazione → Autorizza operatore in attesa**.
   - Da quel momento l'operatore può entrare nell'app (sia da PC che da cellulare) e inserire i dati, che arrivano tutti in tempo reale nel foglio **`REG-IMP-03 Autocontrollo`**.

## Come installare l'app su Computer e Cellulare

- **Su Computer (Chrome / Edge su Windows o Mac):** aprendo https://giuseppe575.github.io/gestionale-depurazione/ compare in alto a destra il pulsante **⬇ Installa App** (oppure l'icona di installazione nella barra degli indirizzi). Cliccandolo, l'app viene installata sul desktop/menu Start come programma autonomo.
- **Su Android (Chrome):** pulsante **⬇ Installa App** in alto oppure menu `⋮` → *Installa app / Aggiungi a schermata Home*.
- **Su iPhone / iPad (Safari):** tocca *Condividi* → *Aggiungi alla schermata Home*.

## Struttura

```
index.html, style.css, app.js, config.js        → frontend + PWA
manifest.webmanifest, sw.js, assets/icon-*.png  → installazione su PC e smartphone
apps-script/Code.gs, appsscript.json            → backend (Google Apps Script + Google Sheets)
```

## Backend Google Apps Script – installazione / aggiornamento

1. Aprire il Foglio Google del registro → **Estensioni → Apps Script**
   (se lo script esistente è un progetto separato, usare quello e impostare la proprietà script
   `SPREADSHEET_ID` con l'ID del foglio).
2. Sostituire tutto il contenuto di `Code.gs` con [apps-script/Code.gs](apps-script/Code.gs).
   In *Impostazioni progetto* attivare "Mostra file manifest" e incollare [apps-script/appsscript.json](apps-script/appsscript.json).
3. Salvare, ricaricare il Foglio: compare il menu **Gestionale depurazione**.
   Eseguire **1) Inizializza / proteggi fogli** (autorizzare lo script alla prima esecuzione).
4. **Esegui il deployment → Gestisci deployment → (deployment esistente) → Modifica → Versione: Nuova versione → Esegui il deployment.**
   Impostazioni: *Esegui come: Me* · *Chi ha accesso: Chiunque*.
   Aggiornando il deployment esistente l'URL `/exec` resta lo stesso già presente in `config.js`.
   Se si crea un nuovo deployment, copiare il nuovo URL in [config.js](config.js).

Fogli creati: `REG-IMP-03 Autocontrollo` (dove arrivano tutte le registrazioni da PC e cellulare), `Operatori` (con casella di spunta *Autorizzato*, colonne hash nascoste), `Log accessi`. I dati storici dei fogli precedenti non vengono toccati.

### Amministrazione (menu del Foglio, solo proprietario)
- **Autorizza operatore in attesa** · Nuovo operatore · Reimposta password · Attiva/disattiva (revoca immediata delle sessioni) · Sblocca
- **Verifica integrità registro**: ricalcola la catena di hash e segnala le righe modificate a mano.
