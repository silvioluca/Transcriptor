# Transcriptor

Trascrizione dal vivo dal microfono, con riconoscimento di chi parla e archivio personale.

- **Audio mai salvato né inviato.** Microfono → rilevatore di voce → modello Whisper, tutto nel browser. Ogni frase resta in RAM solo finché non è trascritta, poi viene scartata.
- **Interlocutori distinti.** Ogni frase riceve un'impronta vocale (WeSpeaker ResNet34) e viene assegnata a Persona 1, 2, 3… Nomi e correzioni si fanno con un clic.
- **Archivio.** Accesso con Google; il testo viene salvato su Firestore (piano gratuito), una frase alla volta, anche offline.
- **Gratis.** GitHub Pages + Firebase Spark + modelli open source.

## Messa online (15 minuti)

### 1. Firebase

1. Vai su <https://console.firebase.google.com> → **Aggiungi progetto** (piano Spark, gratuito; Google Analytics non serve).
2. **Build → Authentication → Inizia → Metodo di accesso → Google → Abilita** → Salva.
3. **Build → Firestore Database → Crea database** → modalità produzione → località `eur3 (europe-west)` o `europe-west8 (Milano)`.
4. Firestore → scheda **Regole** → incolla il contenuto di `firestore.rules` → **Pubblica**.
5. **Impostazioni progetto (ingranaggio) → Le tue app → icona `</>`** → registra app web (Hosting non serve) → copia l'oggetto `firebaseConfig` dentro `js/config.js`.

### 2. GitHub Pages

1. Crea un repository (es. `transcriptor`) e carica tutti i file di questa cartella, `.nojekyll` compreso.
2. Repository → **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `root`** → Save.
3. Dopo un minuto il sito è su `https://TUONOME.github.io/transcriptor/`.

### 3. Autorizza il dominio

Firebase → **Authentication → Impostazioni → Domini autorizzati → Aggiungi dominio** → `TUONOME.github.io`.

Fatto. Apri il sito, accedi con Google, premi il pulsante rosso.

## Prova in locale

```bash
cd transcriptor
python3 -m http.server 8000
# apri http://localhost:8000  (localhost è già autorizzato in Firebase)
```

Serve un server: aprendo `index.html` con doppio clic microfono e worker non funzionano.

## Uso

| Azione | Come |
|---|---|
| Scegli cosa ascoltare | menu accanto al pulsante rosso |
| Registra / pausa / riprendi | pulsante rosso o barra spaziatrice |
| Chiudi la sessione | **Termina** |
| Rinomina una persona o uniscine due | clic sul nome in alto (la persona unita prende il nome scritto) |
| Elimina una trascrizione | icona cestino nell'archivio, o menu download → Elimina |
| Assegna una frase a un'altra persona | clic sul nome accanto alla frase |
| Correggi il testo | clic sul testo, Invio per confermare (testo vuoto = elimina frase) |
| Vai a un punto | clic sul nastro colorato |
| Continua una trascrizione salvata | aprila dall'archivio e premi il pulsante rosso |
| Esporta | icona download: testo, Markdown, sottotitoli SRT, JSON |

## Audio da YouTube, Meet e altre app

Menu accanto al pulsante rosso (solo Chrome/Edge su computer):

| Scelta | Cosa ascolta | Quando |
|---|---|---|
| Microfono | la stanza | riunioni dal vivo |
| Scheda o schermo | l'audio di una scheda o di tutto il sistema | video YouTube, webinar |
| Scheda + microfono | scheda e microfono insieme | chiamate Meet/Zoom/Teams nel browser |

Premendo il pulsante rosso il browser chiede cosa condividere:
- **Scheda** (consigliato): scegli la scheda e attiva *Condividi anche l'audio della scheda*.
- **Schermo intero** (Windows): attiva *Condividi audio di sistema*, così prendi anche app desktop (Zoom, Teams, Spotify).
- Una finestra singola non porta l'audio.

Con *Scheda + microfono* usa le cuffie, altrimenti il microfono riprende anche le casse e le frasi arrivano due volte. Se chiudi la condivisione dalla barra del browser, la registrazione termina da sola.

## Trascrizione nel cloud (Groq)

Impostazioni → **Dove trascrivere → Nel cloud con Groq**. Usa Whisper large-v3 sui server Groq: più preciso, nessun carico sulla scheda grafica.

1. Crea un account gratuito su <https://console.groq.com> → **API Keys → Create API Key**.
2. Incolla la chiave (`gsk_…`) nelle impostazioni. Resta solo nel `localStorage` di quel browser, mai su Firestore né su GitHub.

- Piano gratuito: 20 richieste/minuto, 2 ore di audio all'ora, 8 ore al giorno. Groq conta minimo 10 s per richiesta, quindi il sito raggruppa le frasi (fino a 10 s, o al massimo 6–9 s di attesa) in un solo invio e poi ridistribuisce il testo usando i tempi delle parole.
- Il riconoscimento di chi parla resta nel browser (modello voci ~26 MB, su CPU).
- L'audio delle frasi viene inviato a Groq. Senza connessione le frasi aspettano in memoria e partono quando torna la rete.

## Lettura ad alta voce

Due modi di usarla:

- **Text to Speech** (pulsante nella barra laterale, sotto **Speech to Text**): apre un testo nuovo. Scrivi o incolla, scegli la voce, premi **Leggi**. Il testo si salva in archivio insieme alle trascrizioni (campo `kind: 'tts'` nello stesso documento Firestore) e si riapre da lì, con la voce scelta.
- **Altoparlante in alto a destra**, con una trascrizione aperta: la legge dall'inizio, evidenziando la frase in corso. Nel pannello scegli una voce per ogni persona; la scelta resta salvata nella trascrizione.

In entrambi i casi, a lettura generata **Scarica .wav** salva l'audio. Le voci si aggiungono e si eliminano in **Impostazioni** (o da **Gestisci voci**).

Tre tipi di voce:

| Tipo | Dove gira | Cosa serve |
|---|---|---|
| Voci pronte | nel browser | niente: la voce (28–64 MB) si scarica al primo uso e resta in cache |
| Voce Piper addestrata | nel browser | i due file `.onnx` e `.onnx.json` di una voce addestrata sulle tue registrazioni |
| Voce clonata | server sul tuo computer | 10–30 s di registrazione e il server della cartella `server/` acceso |

Le voci pronte sono quelle di [Piper](https://huggingface.co/rhasspy/piper-voices) (italiano: Paola, Serena, Riccardo; più inglese, francese, spagnolo, tedesco, portoghese). Ogni voce ha la sua licenza, indicata nella scheda del modello. Al primo uso si scarica anche il dizionario dei fonemi (18 MB).

Le voci aggiunte restano nell'IndexedDB di quel browser, campione audio compreso: non vanno su Firestore né su GitHub. Usa solo voci di persone che hanno dato il consenso.

### Voce Piper addestrata

Dà una voce che funziona nel browser come quelle pronte, anche senza rete. L'addestramento si fa fuori dal sito e richiede una scheda grafica NVIDIA (va bene un notebook Colab).

1. Registra 30–60 minuti della stessa persona, in ambiente silenzioso, e taglia l'audio in frasi di 2–15 secondi (file WAV).
2. Scrivi `metadata.csv` con una riga per file: `frase001.wav|Testo pronunciato nella frase.`
3. Segui la [guida di Piper](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/TRAINING.md): `python3 -m piper.train fit` con `--data.espeak_voice it`, `--model.sample_rate 22050` e, per fare prima, `--ckpt_path` puntato a un [checkpoint](https://huggingface.co/datasets/rhasspy/piper-checkpoints) di qualità `medium` (per l'italiano: `it/it_IT/serena/medium`).
4. Esporta con `python3 -m piper.train.export_onnx`. Ottieni `voce.onnx`; il file scritto da `--data.config_path` durante l'addestramento va rinominato `voce.onnx.json`.
5. Nel sito: Impostazioni → **Aggiungi una voce Piper addestrata**, scegli i due file insieme.

### Voce clonata (server locale)

Il modello di clonazione è [XTTS-v2](https://huggingface.co/coqui/XTTS-v2): pesa circa 1,9 GB e non gira nel browser, quindi parte da un piccolo server Python sul tuo computer. Licenza Coqui CPML: solo uso non commerciale (il server chiede di accettarla al primo avvio).

```bash
cd server
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python clone_server.py
```

Serve Python 3.10 o più recente. Poi nel sito: Impostazioni → **Clona una voce da una registrazione** → **Verifica server** → carica un file audio o registra dal microfono → **Aggiungi voce**.

- Senza scheda grafica NVIDIA la sintesi gira sul processore ed è lenta (più lenta del parlato). Con `--device cuda` e PyTorch per CUDA è molto più rapida.
- Il sito, anche da GitHub Pages, chiama `http://127.0.0.1:8020`. Chrome ed Edge lo permettono, chiedendo il permesso di accedere alla rete locale; Safari no.
- Il server ascolta solo su questo computer e non salva nulla su disco. Per limitarlo al tuo sito: `python clone_server.py --origin https://TUONOME.github.io`.

## Unione delle frasi

Impostazioni → Interlocutori → **Unisci le frasi consecutive della stessa persona** (attiva di default). Due frasi della stessa persona separate da una pausa sotto la soglia (default 8 s) diventano un solo paragrafo. **Unisci ora** applica la regola alla trascrizione aperta, anche a quelle già in archivio.

## Qualità e prestazioni

| Qualità | Modello | Download | Dove |
|---|---|---|---|
| Veloce | whisper-base | ~100 MB | qualsiasi dispositivo |
| Accurata | whisper-small | ~450 MB | PC con scheda grafica (WebGPU) |
| Massima | whisper-large-v3-turbo | ~1,4 GB | GPU recente con fp16 |

Modelli scaricati una sola volta, poi in cache del browser. In più il modello voci (~26 MB).

- **Browser consigliato:** Chrome o Edge desktop recenti (WebGPU). Firefox e Safari funzionano ma su CPU sono più lenti: usa *Veloce*.
- Se la trascrizione resta indietro, l'audio in attesa cresce fino al limite impostato (predefinito 3 minuti, circa 11 MB di RAM); oltre, i pezzi più vecchi vengono scartati e segnalati.
- Riconoscimento voci: funziona meglio con frasi di almeno 1–2 secondi e un solo microfono vicino a tutti. Voci sovrapposte finiscono nella stessa frase. Se due persone vengono unite, alza **Separazione voci**; se una persona viene divisa in due, abbassala oppure unisci a mano.
- GitHub Pages non permette l'isolamento cross-origin, quindi su CPU l'elaborazione è a thread singolo. Con WebGPU non conta.

## Struttura

```
index.html          interfaccia
css/style.css       stile (chiaro e scuro automatici)
js/app.js           logica, coda di trascrizione, interfaccia
js/audio.js         microfono + VAD Silero, segmentazione in RAM
js/worker.js        Whisper + impronta vocale (Web Worker)
js/cloud.js         trascrizione Groq a gruppi
js/speakers.js      raggruppamento online delle voci
js/store.js         Firebase Auth + Firestore
js/export.js        esportazioni
js/tts.js           lettura ad alta voce: voci, riproduzione, archivio voci
js/tts-worker.js    Piper nel browser (Web Worker)
js/config.js        la tua configurazione Firebase
server/             server locale per le voci clonate (XTTS-v2)
firestore.rules     regole di sicurezza
```

Dati Firestore: `users/{uid}/conversations/{id}` (titolo, durata, persone) e `…/segments/{id}` (inizio, fine, persona, testo).

## Costi

Piano Firebase Spark: 1 GiB di dati, 20.000 scritture e 50.000 letture al giorno. Un'ora di riunione ≈ 700–1.000 scritture e circa 60 KB di testo. Uso personale: gratis.
