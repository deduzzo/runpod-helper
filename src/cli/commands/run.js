import { LlmpodError, Codes } from '../../core/errors.js';
import { resolveCwd } from '../cwd.js';
import { prepareClient } from '../../core/clients/prepare.js';
import { piDir } from '../../core/clients/pi.js';
import { updateZcode, zcodeDir } from '../../core/clients/zcode.js';

const INSTALL = {
  claude: 'Installa Claude Code: npm install -g @anthropic-ai/claude-code',
  opencode: 'Installa OpenCode: https://opencode.ai/docs',
  pi: 'Installa pi: npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
};

// Cartella di lavoro del client: --cwd esplicito; altrimenti la si chiede (default: la corrente) se il terminale è
// interattivo; altrimenti (es. Claude Code gestito, stdin non TTY) senza domande si passa esplicitamente la corrente.
// ZCode non avvia un processo nel progetto: nessuna cartella.
async function chooseCwd(client, opts, ctx) {
  if (client === 'zcode') return undefined;
  if (opts.cwd !== undefined) return resolveCwd(opts.cwd);
  const current = ctx.cwd();
  if (!ctx.io.interactive) return resolveCwd(current);
  const answer = String((await ctx.io.askText('In quale cartella vuoi lavorare con il modello?', current)) ?? '').trim();
  return resolveCwd(answer || current);
}

async function runClient(client, opts, getCtx, result) {
  const ctx = getCtx();
  if (!['claude', 'opencode', 'pi', 'zcode'].includes(client)) {
    throw new LlmpodError(Codes.INVALID_INPUT, `Client sconosciuto: ${client}`, { hint: 'Client supportati: claude, opencode, pi, zcode' });
  }
  const cwd = await chooseCwd(client, opts, ctx); // verificata prima di toccare Runpod; per zcode non c'è
  const ep = await ctx.ops.endpoint(await ctx.ops.resolveProfile(opts.profile));

  if (client === 'zcode') {
    const file = await updateZcode(ep, { dir: zcodeDir(ctx.env), isRunning: ctx.isZcodeRunning });
    ctx.io.out(`✓ ZCode configurato (${file}): scegli il modello "${ep.servedName}" del provider "llmpod (Runpod)".`);
    if (opts.open !== false && ctx.platform === 'darwin') ctx.spawn('open', ['-a', 'ZCode'], { stdio: 'ignore', detached: true }).unref?.();
    return;
  }

  const prep = prepareClient(client, ep, { configDir: ctx.store.dir, piDir: piDir(ctx.env) });
  const child = ctx.spawn(prep.command, prep.args, { ...(cwd ? { cwd } : {}), stdio: 'inherit', env: { ...process.env, ...prep.env } });
  result.code = await new Promise((resolve, reject) => {
    child.on('error', (err) => reject(err.code === 'ENOENT'
      ? new LlmpodError(Codes.INVALID_INPUT, `Comando "${prep.command}" non trovato`, { hint: INSTALL[client] })
      : err));
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

export function register(program, getCtx, result) {
  program.command('run <client>')
    .description('Avvia o configura un client sul Pod attivo: claude, opencode, pi, zcode')
    .option('--profile <nome>', 'profilo')
    .option('--cwd <cartella>', 'cartella di lavoro in cui avviare il client (se omessa e in un terminale interattivo, viene chiesta; default: la cartella corrente)')
    .option('--no-open', 'ZCode: non aprire l\'app dopo la configurazione')
    .action((client, opts) => runClient(client, opts, getCtx, result));

  program.command('claude')
    .description('Alias di "run claude"')
    .option('--profile <nome>', 'profilo')
    .option('--cwd <cartella>', 'cartella di lavoro in cui avviare Claude Code (se omessa e in un terminale interattivo, viene chiesta; default: la cartella corrente)')
    .action((opts) => runClient('claude', opts, getCtx, result));
}
