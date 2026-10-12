import { LlmpodError, Codes } from '../../core/errors.js';

export function register(program, getCtx) {
  program.command('logs [profilo]')
    .description('Log di vLLM dal supervisore del Pod (chiavi mascherate)')
    .option('--since <n>', 'solo le righe successive al numero n (cursore)', (v) => Number.parseInt(v, 10), 0)
    .option('--follow', 'continua a mostrare le nuove righe (Ctrl+C per uscire)')
    .option('--json', 'output JSON ({ lines, cursor })')
    .action(async (name, opts) => {
      const ctx = getCtx();
      if (!Number.isInteger(opts.since) || opts.since < 0) throw new LlmpodError(Codes.INVALID_INPUT, '--since deve essere un intero non negativo');
      const profile = await ctx.ops.resolveProfile(name);
      let cursor = opts.since;
      let stop = false;
      const onSigint = () => { stop = true; };
      if (opts.follow) process.on('SIGINT', onSigint);
      try {
        do {
          const r = await ctx.ops.logs(profile, { since: cursor });
          if (opts.json) ctx.io.raw(JSON.stringify(r, null, opts.follow ? 0 : 2));
          else for (const l of r.lines) ctx.io.out(l.line);
          cursor = r.cursor;
          if (opts.follow && !stop) await ctx.sleep(2000);
        } while (opts.follow && !stop);
      } finally {
        if (opts.follow) process.off('SIGINT', onSigint);
      }
    });
}
