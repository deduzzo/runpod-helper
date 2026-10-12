import { LlmpodError, Codes } from '../../core/errors.js';
import { resolveCwd } from '../cwd.js';
import { launchManaged, profilePrompt, realProjectDir } from './manage.js';
import { runInit } from './init.js';

const INIT_HINT = 'Esegui prima: llmpod init. Per automatizzare: llmpod init --runpod-key-stdin (chiave in pipe) oppure llmpod init --from-env --yes (variabile RUNPOD_API_KEY)';

const isConfigured = (store) => Boolean(store.readConfig().dataCenterId && store.readEnv().RUNPOD_API_KEY);

export function register(program, getCtx, result) {
  program.command('start')
    .description('Avvio guidato: configura llmpod se serve e apre Claude Code gestito nella tua cartella di lavoro')
    .option('--cwd <cartella>', 'cartella di lavoro (se omessa, la chiede o usa la cartella corrente)')
    .option('--dir <cartella>', 'alias di --cwd')
    .option('--profile <nome>', 'profilo su cui lavorare')
    .option('--yes', 'usa i valori predefiniti senza chiedere')
    .action(async (opts) => {
      const ctx = getCtx();
      const { io, store } = ctx;
      const interactive = io.interactive && !opts.yes;
      const extraArgs = profilePrompt(opts.profile);

      // 1. Configurazione: se manca, in un terminale propone di eseguire il flusso di `llmpod init` (stesso codice, opzioni vuote).
      if (!isConfigured(store)) {
        if (!interactive) throw new LlmpodError(Codes.INVALID_INPUT, 'llmpod non è configurato: esegui prima `llmpod init`', { hint: INIT_HINT });
        io.err('llmpod non è ancora configurato: serve la chiave API di Runpod (https://www.runpod.io/console/user/settings) e la scelta del datacenter.');
        if (!(await io.ask('Configuro ora llmpod? (poi apro Claude Code)', true))) {
          throw new LlmpodError(Codes.CANCELLED, 'Configurazione annullata', { hint: 'Quando vuoi: llmpod init' });
        }
        await (ctx.overrides?.runInit ?? runInit)({ ctx, opts: {} });
        if (!isConfigured(store)) throw new LlmpodError(Codes.INVALID_INPUT, 'La configurazione di llmpod non è completa', { hint: 'Riprova con: llmpod init' });
      }

      // 2. Cartella di lavoro.
      let dir = resolveCwd(opts.cwd ?? opts.dir);
      if (!dir) {
        const current = resolveCwd(ctx.cwd());
        const def = current !== realProjectDir() ? current : undefined;
        if (interactive) {
          const answer = String((await io.askText('In quale cartella vuoi lavorare?', def)) ?? '').trim();
          if (!answer) throw new LlmpodError(Codes.INVALID_INPUT, 'Indica la cartella in cui vuoi lavorare', { hint: 'Esempio: llmpod start --cwd ~/mio-progetto' });
          dir = resolveCwd(answer);
        } else if (def) {
          dir = def;
        } else {
          throw new LlmpodError(Codes.INVALID_INPUT, 'Indica la cartella di lavoro: la cartella corrente è quella di llmpod', { hint: 'Esempio: llmpod start --cwd ~/mio-progetto (oppure lancialo dalla cartella del tuo progetto)' });
        }
      }

      // 3. Avvio (con la cartella di llmpod come cwd parte come `manage`, senza flag aggiuntivi).
      await launchManaged({ ctx, cwd: dir, extraArgs, result });
    });
}
