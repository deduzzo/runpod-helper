# Report: `manage --cwd` e `run --cwd`

Stato: completato. Test: `npm test` (JS 1146 test + Python 58) e `npm run build:web` verdi.

## Cosa è stato fatto
- `src/cli/cwd.js` (nuovo): `resolveCwd()` risolve a percorso assoluto (supporta `~`), errore INVALID_INPUT con hint se non esiste o non è una cartella.
- `llmpod manage --cwd <dir>` (alias `--dir`): `claude` parte con `cwd = <dir>` e i flag `--mcp-config` (JSON inline, server.js assoluto, env solo LLMPOD_CONFIG_DIR/ZCODE_DIR/PI_CODING_AGENT_DIR se impostate), `--settings <PROJECT_DIR>/.claude/settings.json`, `--add-dir <PROJECT_DIR>`. Senza `--cwd`, o con `--cwd` = PROJECT_DIR (confronto con realpath), comportamento invariato.
- `llmpod run <client> --cwd <dir>` e alias `llmpod claude --cwd`: `cwd` passato a `ctx.spawn` solo se indicato; verificato prima di contattare Runpod; zcode lo accetta senza effetto.
- MCP `client_commands`: la `note` ora ricorda `--cwd <cartella>` (schema invariato).
- README e docs/GUIDA.md aggiornati.

## Decisioni
- `--strict-mcp-config` NON usato: l'utente mantiene i propri server MCP.
- Il prompt iniziale va PRIMA dei flag: `--mcp-config` e `--add-dir` sono variadici e leggerebbero il prompt come proprio valore.
- Impostata `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` nell'ambiente di claude (solo con `--cwd` esterno): senza, Claude Code non carica il CLAUDE.md delle cartelle di `--add-dir`. Nessun segreto.

## Dubbi / da verificare a mano con claude reale
- Non ho potuto avviare claude reale: che `--add-dir` carichi le `.claude/skills` di llmpod e che la variabile sul CLAUDE.md funzioni è da conoscenza della documentazione, non verificato. Per questo la nota sulle skill è rimasta (attenuata) nell'avviso a runtime e in GUIDA.
- La chiave `enabledMcpjsonServers` di settings.json non incide: il server arriva da `--mcp-config` con lo stesso nome `llmpod`, quindi i permessi `mcp__llmpod__*` valgono.
