import { prepareClient } from '../../core/clients/prepare.js';
import { LlmpodError, Codes } from '../../core/errors.js';
import { piDir } from '../../core/clients/pi.js';

const sq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
// In PowerShell anche gli apici tipografici ‘ ’ chiudono una stringa tra apici singoli: si raddoppiano tutti.
const pq = (v) => `'${String(v).replace(/['\u2018\u2019\u201A\u201B]/g, (c) => c + c)}'`;

export function register(program, getCtx) {
  program.command('prepare <client>')
    .description('Prepara un client (claude, opencode, pi) e stampa lo script per avviarlo sull\'host (usato dal wrapper Docker)')
    .option('--profile <nome>', 'profilo')
    .option('--format <formato>', 'sh o ps1', 'sh')
    .option('--host-config-dir <dir>', 'percorso della cartella di configurazione sull\'host')
    .option('--host-pi-dir <dir>', 'percorso della cartella di pi sull\'host')
    .action(async (client, opts) => {
      if (!['sh', 'ps1'].includes(opts.format)) throw new LlmpodError(Codes.INVALID_INPUT, `Formato non valido: ${opts.format}`, { hint: 'Usa --format sh oppure --format ps1' });
      const ctx = getCtx();
      const ep = await ctx.ops.endpoint(await ctx.ops.resolveProfile(opts.profile));
      const containerPi = piDir(ctx.env);
      const prep = prepareClient(client, ep, { configDir: ctx.store.dir, piDir: containerPi });
      const translate = (v) => {
        let s = String(v);
        if (opts.hostConfigDir && s.startsWith(ctx.store.dir)) s = opts.hostConfigDir + s.slice(ctx.store.dir.length);
        if (opts.hostPiDir && s.startsWith(containerPi)) s = opts.hostPiDir + s.slice(containerPi.length);
        return s;
      };
      const env = Object.entries(prep.env).map(([k, v]) => [k, translate(v)]);
      const lines = opts.format === 'ps1'
        ? [...env.map(([k, v]) => `$env:${k} = ${pq(v)}`), `& ${[prep.command, ...prep.args].map(pq).join(' ')}; exit $LASTEXITCODE`]
        : [...env.map(([k, v]) => `export ${k}=${sq(v)}`), `exec ${[prep.command, ...prep.args].map(sq).join(' ')}`];
      // Output volutamente non mascherato: lo esegue il wrapper sull'host.
      ctx.io.raw(lines.join('\n'));
    });
}
