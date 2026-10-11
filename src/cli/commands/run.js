import { LlmpodError, Codes } from '../../core/errors.js';
import { prepareClaude } from '../../core/clients/claude-code.js';
import { prepareOpencode } from '../../core/clients/opencode.js';
import { preparePi, piDir } from '../../core/clients/pi.js';
import { updateZcode, zcodeDir } from '../../core/clients/zcode.js';

const INSTALL = {
  claude: 'Installa Claude Code: npm install -g @anthropic-ai/claude-code',
  opencode: 'Installa OpenCode: https://opencode.ai/docs',
  pi: 'Installa pi: npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
};

async function runClient(client, opts, getCtx, result) {
  const ctx = getCtx();
  if (!['claude', 'opencode', 'pi', 'zcode'].includes(client)) {
    throw new LlmpodError(Codes.INVALID_INPUT, `Client sconosciuto: ${client}`, { hint: 'Client supportati: claude, opencode, pi, zcode' });
  }
  const ep = await ctx.ops.endpoint(await ctx.ops.resolveProfile(opts.profile));

  if (client === 'zcode') {
    const file = await updateZcode(ep, { dir: zcodeDir(ctx.env), isRunning: ctx.isZcodeRunning });
    ctx.io.out(`✓ ZCode configurato (${file}): scegli il modello "${ep.servedName}" del provider "llmpod (Runpod)".`);
    if (opts.open !== false && ctx.platform === 'darwin') ctx.spawn('open', ['-a', 'ZCode'], { stdio: 'ignore', detached: true }).unref?.();
    return;
  }

  const prep = {
    claude: () => prepareClaude(ep),
    opencode: () => prepareOpencode(ep, { dir: ctx.store.dir }),
    pi: () => preparePi(ep, { dir: piDir(ctx.env) }),
  }[client]();
  const child = ctx.spawn(prep.command, prep.args, { stdio: 'inherit', env: { ...process.env, ...prep.env } });
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
    .option('--no-open', 'ZCode: non aprire l\'app dopo la configurazione')
    .action((client, opts) => runClient(client, opts, getCtx, result));

  program.command('claude')
    .description('Alias di "run claude"')
    .option('--profile <nome>', 'profilo')
    .action((opts) => runClient('claude', opts, getCtx, result));
}
