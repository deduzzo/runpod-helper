import { formatEnv, clientExports } from '../../core/clients/env-format.js';

export function register(program, getCtx) {
  program.command('env')
    .description('Stampa gli export per collegare altri client al Pod (contiene la chiave del profilo)')
    .option('--profile <nome>', 'profilo')
    .option('--format <formato>', 'sh, ps1 o json', 'sh')
    .action(async (opts) => {
      const ctx = getCtx();
      const ep = await ctx.ops.endpoint(await ctx.ops.resolveProfile(opts.profile));
      const env = clientExports(ep);
      // Uscita volutamente non mascherata: l'utente chiede esplicitamente gli export con la chiave.
      ctx.io.raw(formatEnv(env, opts.format));
    });
}
