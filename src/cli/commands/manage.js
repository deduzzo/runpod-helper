import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmpodError, Codes } from '../../core/errors.js';
import { assertProfileName } from '../../core/config.js';
import { resolveCwd } from '../cwd.js';

// Cartella del progetto llmpod (dal percorso del pacchetto): contiene CLAUDE.md, .claude/ (skill e permessi) e .mcp.json.
export const PROJECT_DIR = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');

// File che rendono "managed" la sessione di Claude Code: regole, permessi, skill e server MCP del progetto.
export const PROJECT_FILES = ['CLAUDE.md', '.claude/settings.json', '.claude/skills', '.mcp.json'];
export const missingProjectFiles = (dir = PROJECT_DIR) => PROJECT_FILES.filter((f) => !fs.existsSync(path.join(dir, f)));

const realProjectDir = () => { try { return fs.realpathSync(PROJECT_DIR); } catch { return PROJECT_DIR; } };

// Variabili di configurazione da passare al server MCP (solo percorsi di configurazione, mai chiavi o segreti).
const MCP_ENV_KEYS = ['LLMPOD_CONFIG_DIR', 'ZCODE_DIR', 'PI_CODING_AGENT_DIR'];

// Flag che portano la configurazione gestita di llmpod in una sessione di Claude Code avviata in un'altra cartella.
// --mcp-config è una stringa JSON inline (un solo argomento argv, nessun file temporaneo) con il percorso assoluto di server.js;
// non uso --strict-mcp-config, così restano disponibili anche i server MCP dell'utente.
export function managedFlags(env = process.env) {
  const mcpEnv = Object.fromEntries(MCP_ENV_KEYS.filter((k) => env[k]).map((k) => [k, env[k]]));
  const server = { command: 'node', args: [path.join(PROJECT_DIR, 'src', 'mcp', 'server.js')] };
  if (Object.keys(mcpEnv).length) server.env = mcpEnv;
  return [
    '--mcp-config', JSON.stringify({ mcpServers: { llmpod: server } }),
    '--settings', path.join(PROJECT_DIR, '.claude', 'settings.json'),
    '--add-dir', PROJECT_DIR,
  ];
}

const INSTALL_HINT = 'Installa Claude Code: curl -fsSL https://claude.ai/install.sh | bash   (oppure: npm install -g @anthropic-ai/claude-code)';

export function register(program, getCtx, result) {
  program.command('manage')
    .description('Modalità "Claude Code managed": avvia Claude Code nella cartella di llmpod, con skill, permessi e server MCP del progetto')
    .option('--profile <nome>', 'profilo su cui lavorare')
    .option('--cwd <cartella>', 'lavora nella cartella del tuo progetto: Claude Code parte lì, con la configurazione gestita di llmpod')
    .option('--dir <cartella>', 'alias di --cwd')
    .action(async (opts) => {
      const ctx = getCtx();
      const workDir = resolveCwd(opts.cwd ?? opts.dir);
      // Con --cwd uguale alla cartella del progetto llmpod non serve nessun flag aggiuntivo.
      const external = workDir && workDir !== realProjectDir() ? workDir : null;
      const args = [];
      if (opts.profile) {
        assertProfileName(opts.profile);
        args.push(`Lavora sul profilo llmpod "${opts.profile}": mostrami lo stato dei Pod e proponi i passi successivi.`);
      }
      const missing = missingProjectFiles();
      if (missing.length) {
        ctx.io.err(`⚠ Mancano in ${PROJECT_DIR}: ${missing.join(', ')}. Claude Code partirebbe senza le regole, i permessi o il server MCP di llmpod`);
        ctx.io.err('  Usa una copia completa del repository o reinstalla il pacchetto');
        if (missing.includes('CLAUDE.md') && !(await ctx.io.ask('Avviare comunque Claude Code?', false))) {
          throw new LlmpodError(Codes.CANCELLED, 'Avvio annullato: manca CLAUDE.md nella cartella del progetto');
        }
      }
      const env = { ...process.env, ...(ctx.env === process.env ? {} : ctx.env) };
      let cwd = PROJECT_DIR;
      if (external) {
        cwd = external;
        // --mcp-config e --add-dir accettano più valori: il prompt iniziale (se c'è) va PRIMA dei flag, altrimenti verrebbe letto come un loro valore.
        args.push(...managedFlags(ctx.env));
        // Senza questa variabile Claude Code non carica il CLAUDE.md delle cartelle di --add-dir.
        env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1';
        ctx.io.err(`▸ Avvio di Claude Code gestito da llmpod nella cartella ${external}`);
        ctx.io.err(`  Regole (CLAUDE.md), permessi e strumenti MCP di llmpod vengono dal progetto ${PROJECT_DIR}; le skill /llmpod-* dipendono da --add-dir (se non compaiono, usa gli strumenti MCP)`);
      } else {
        ctx.io.err(`▸ Avvio di Claude Code in ${PROJECT_DIR}`);
      }
      // Nessuna chiave nell'ambiente: Claude Code usa llmpod tramite il server MCP e la CLI, che leggono da soli la configurazione.
      const child = ctx.spawn('claude', args, { cwd, stdio: 'inherit', env });
      result.code = await new Promise((resolve, reject) => {
        child.on('error', (err) => reject(err.code === 'ENOENT'
          ? new LlmpodError(Codes.INVALID_INPUT, 'Comando "claude" non trovato', { hint: INSTALL_HINT })
          : err));
        child.on('exit', (code) => resolve(code ?? 0));
      });
    });

  program.command('mcp')
    .description('Avvia il server MCP di llmpod su stdio (per Claude Code e altri client MCP)')
    .action(async () => {
      const { startStdioServer } = await import('../../mcp/server.js');
      await startStdioServer({ env: getCtx().env });
    });
}
