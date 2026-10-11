# llmpod — runpod-helper

> **Stato: in progettazione.** Il codice non è ancora stato scritto: questo repository contiene per ora
> il README con le decisioni di design prese e le verifiche già fatte sulle API. Le istruzioni di
> installazione arriveranno con la prima versione.

`llmpod` è una CLI (con interfaccia web locale) che automatizza il ciclo di vita di un **LLM
self-hosted su [Runpod](https://www.runpod.io)**, da usare come backend di coding agent come
**Claude Code**, **OpenCode** e **ZCode**:

1. scelta del modello da Hugging Face (ricerca o ID diretto);
2. stima della VRAM e scelta automatica della GPU (o multi-GPU) più economica e disponibile;
3. avvio di un Pod con [vLLM](https://docs.vllm.ai) pronto all'uso;
4. configurazione automatica del client scelto;
5. **distruzione automatica del Pod per inattività**, anche a portatile spento;
6. ricreazione identica da un profilo salvato.

## Funzionalità previste (v1)

| Comando | Cosa fa |
|---|---|
| `llmpod init` | Configurazione guidata: credenziali, datacenter preferito, network volume per i pesi |
| `llmpod search <query>` | Cerca su Hugging Face modelli adatti all'uso agentico (chat template, tool calling) |
| `llmpod plan <modello>` | Stima VRAM (pesi + KV cache + margine), sceglie la GPU, propone gli argomenti di `vllm serve` |
| `llmpod save <nome>` | Salva il piano come profilo riutilizzabile |
| `llmpod up <profilo>` | Crea il Pod, attende vLLM, esegue uno smoke test con chiamata a strumento |
| `llmpod run <client>` | Avvia Claude Code / OpenCode, o configura ZCode, puntandoli al Pod |
| `llmpod env` | Stampa gli `export` per altri client |
| `llmpod chat` | Prova veloce con Open WebUI locale (Docker) collegato al Pod |
| `llmpod status` | Pod attivi, uptime, costo della sessione, credito residuo, costo del volume |
| `llmpod down` | Termina il Pod (il volume con i pesi resta) |
| `llmpod rotate-key` | Rigenera la chiave API di vLLM del profilo |
| `llmpod destroy-volume` | Elimina il network volume (doppia conferma) |
| `llmpod ui` | Interfaccia web locale (React + Vite + Tailwind, installabile come PWA) |

Ogni operazione che costa denaro mostra il **costo orario stimato e chiede conferma**
(`--yes` per saltarla); tutti i comandi che creano o distruggono risorse supportano `--dry-run`.

## Decisioni di design

- **Node.js ≥ 20, ESM, dipendenze minime** (`commander`, `fetch` nativo). Un modulo `core`
  condiviso da CLI e interfaccia web, che comunicano con il core tramite eventi.
- **Runpod REST API v2** (`https://api.runpod.io/v2`) per Pod, volumi e catalogo GPU con
  disponibilità per datacenter. Il fallback tra GPU è gestito lato client, come indicato dalla
  documentazione Runpod.
- **Immagine ufficiale `vllm/vllm-openai`** con versione fissata nel profilo (mai `latest`).
  Nessuna immagine derivata: l'entrypoint viene sostituito e uno script supervisore viene
  iniettato tramite variabile d'ambiente.
- **Supervisore nel Pod**: avvia vLLM, legge le metriche Prometheus (`/metrics`) ogni 60 s e
  termina il Pod dopo N minuti senza richieste (default 30) o comunque dopo una durata massima
  (default 8 h).
- **Network volume** per i pesi nel datacenter preferito; se lì non ci sono GPU disponibili,
  con il consenso dell'utente si ripiega su un altro datacenter scaricando i pesi sul disco del
  container.
- **Chiave API di vLLM per profilo**, salvata localmente e rigenerabile.
- **Parametri di vLLM su tre livelli**: regole deterministiche (architettura → tool-call parser,
  reasoning parser, dtype, quantizzazione); un consulente LLM che legge la scheda del modello e
  le recipe ufficiali di vLLM, con proposte validate su uno schema e sui flag ammessi; verifica
  dopo l'avvio con correzioni proposte e applicate solo previa conferma.
- **IA esterna modulare** per il consulente: protocolli Anthropic e OpenAI con preset
  (Z.ai GLM, Anthropic, OpenAI, endpoint personalizzato, il modello sul Pod, `claude -p`).
- **Deploy con Docker Compose** (web UI, core e Open WebUI) e script di avvio per macOS,
  Linux e Windows.
- **Credenziali** in `~/.config/llmpod/.env` con permessi `600`. Chiavi e token non vengono mai
  scritti nei log.

## Verifiche già fatte

### Chiave API iniettata da Runpod nel Pod (11 ottobre 2026)

Runpod inietta in ogni Pod la variabile `RUNPOD_API_KEY`, descritta solo come *"Pod-scoped API
key"*. Con tre Pod CPU di prova abbiamo verificato cosa permette:

| Operazione con la chiave iniettata | Esito |
|---|---|
| `GET /v2/pods/{proprio id}` | ✅ 200 |
| `DELETE /v2/pods/{proprio id}` (auto-terminazione) | ✅ funziona |
| Leggere o terminare **un altro** Pod (v2) | ❌ 404, non visibile |
| Elencare i Pod, leggere i template (v2) | ❌ 403 |
| Qualsiasi chiamata REST v1 | ❌ 403 |
| GraphQL (saldo, Pod, `podTerminate`) | ❌ Unauthorized |

Conseguenza: il watchdog usa **solo** la chiave iniettata, che può terminare esclusivamente il
proprio Pod; nessuna chiave dell'utente viene mai passata al Pod.

Nota pratica: Cloudflare davanti alle API Runpod risponde `403 error code: 1010` allo
User-Agent predefinito di Python (`Python-urllib/…`); serve uno User-Agent personalizzato.

## Client supportati

| Client | Protocollo | Integrazione |
|---|---|---|
| Claude Code | Anthropic `/v1/messages` | variabili d'ambiente (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, modelli) e avvio di `claude` |
| OpenCode | OpenAI Chat Completions | provider `openai-compatible` e avvio di `opencode` |
| ZCode | OpenAI Chat Completions | provider in `~/.zcode/v2/config.json` (da modificare ad app chiusa) |
| Open WebUI | OpenAI Chat Completions | container Docker locale per prove rapide |

## Licenza

[MIT](LICENSE)
