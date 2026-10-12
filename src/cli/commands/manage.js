import { fileURLToPath } from 'node:url';
import { LlmpodError, Codes } from '../../core/errors.js';
import { assertProfileName } from '../../core/config.js';

// Cartella del progetto llmpod (dal percorso del pacchetto): contiene CLAUDE.md, .claude/ (skill e permessi) e .mcp.json.
export const PROJECT_DIR = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');

const INSTALL_HINT = 'Installa Claude Code: curl -fsSL https://claude.ai/install.sh | bash   (oppure: npm install -g @anthropic-ai/claude-code)';

export function register(program, getCtx, result) {
  program.command('manage')
    .description('Modalità "Claude Code managed": avvia Claude Code nella cartella di llmpod, con skill, permessi e server MCP del progetto')
    .option('--profile <nome>', 'profilo su cui lavorare')
    .action(async (opts) => {
      const ctx = getCtx();
      const args = [];
      if (opts.profile) {
        assertProfileName(opts.profile);
        args.push(`Lavora sul profilo llmpod "${opts.profile}": mostrami lo stato dei Pod e proponi i passi successivi.`);
      }
      ctx.io.err(`▸ Avvio di Claude Code in ${PROJECT_DIR}`);
      // Nessuna chiave nell'ambiente: Claude Code usa llmpod tramite il server MCP e la CLI, che leggono da soli la configurazione.
      const child = ctx.spawn('claude', args, { cwd: PROJECT_DIR, stdio: 'inherit', env: { ...process.env, ...(ctx.env === process.env ? {} : ctx.env) } });
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
