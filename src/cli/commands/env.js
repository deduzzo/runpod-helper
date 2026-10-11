import { formatEnv } from '../../core/clients/env-format.js';
import { claudeEnv } from '../../core/clients/claude-code.js';

export function register(program, getCtx) {
  program.command('env')
    .description('Stampa gli export per collegare altri client al Pod (contiene la chiave del profilo)')
    .option('--profile <nome>', 'profilo')
    .option('--format <formato>', 'sh, ps1 o json', 'sh')
    .action(async (opts) => {
      const ctx = getCtx();
      const ep = await ctx.ops.endpoint(await ctx.ops.resolveProfile(opts.profile));
      const env = {
        ...claudeEnv(ep),
        OPENAI_BASE_URL: `${ep.baseUrl}/v1`,
        OPENAI_API_KEY: ep.apiKey,
        LLMPOD_MODEL: ep.servedName,
        LLMPOD_API_KEY: ep.apiKey,
      };
      // Uscita volutamente non mascherata: l'utente chiede esplicitamente gli export con la chiave.
      ctx.io.raw(formatEnv(env, opts.format));
    });
}
