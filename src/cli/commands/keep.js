import { LlmpodError, Codes } from '../../core/errors.js';
import { fmtUSD } from '../../core/confirm.js';
import { fmtHours } from '../../core/watchdog.js';
import { attachRenderer, fmtDuration } from '../render.js';

function number(value, label) {
  const n = Number(String(value).trim().replace(',', '.')); // virgola decimale (0,25) come in italiano
  if (String(value).trim() === '' || !Number.isFinite(n)) throw new LlmpodError(Codes.INVALID_INPUT, `${label}: "${value}" non è un numero`);
  return n;
}

export function register(program, getCtx) {
  program.command('keep [profilo]')
    .description('Cambia i limiti di spegnimento di un Pod già avviato (inattività, ore massime) senza riavviarlo')
    .option('--idle-minutes <n>', 'minuti di inattività dopo cui spegnere il Pod (intero tra 5 e 1440; 0 = mai)')
    .option('--no-idle', 'non spegnere mai il Pod per inattività (resta il limite di ore massime)')
    .option('--max-hours <n>', 'ore massime di vita dall\'avvio del Pod (0,25..168)')
    .option('--save', 'aggiorna anche il profilo, per i prossimi avvii')
    .option('--yes', 'non chiedere conferma del costo massimo')
    .action(async (name, opts) => {
      const ctx = getCtx();
      if (opts.idle === false && opts.idleMinutes !== undefined) throw new LlmpodError(Codes.INVALID_INPUT, 'Usa --no-idle oppure --idle-minutes, non entrambi');
      const idleMinutes = opts.idle === false ? 0 : opts.idleMinutes !== undefined ? number(opts.idleMinutes, '--idle-minutes') : undefined;
      const maxHours = opts.maxHours !== undefined ? number(opts.maxHours, '--max-hours') : undefined;
      if (idleMinutes === undefined && maxHours === undefined) {
        throw new LlmpodError(Codes.INVALID_INPUT, 'Indica almeno un limite da cambiare', { hint: 'Esempi: llmpod keep <profilo> --max-hours 24   ·   llmpod keep <profilo> --no-idle   ·   llmpod keep <profilo> --idle-minutes 120' });
      }
      const profile = await ctx.ops.resolveProfile(name);
      const off = attachRenderer(ctx.events, ctx.io);
      try {
        const r = await ctx.ops.keep(profile, { idleMinutes, maxHours, save: opts.save, yes: opts.yes });
        const { io } = ctx;
        io.out(`✓ Limiti di spegnimento aggiornati sul Pod ${r.podId} (${profile})`);
        io.out(`  Inattività: ${r.idleLimitSeconds > 0 ? fmtDuration(r.idleLimitSeconds) : 'nessuno spegnimento per inattività'}`);
        io.out(`  Durata massima: ${fmtHours(r.maxSeconds)} dall'avvio — si spegnerà tra ${fmtDuration(r.remainingSeconds)} (circa ${new Date(r.expiresAt).toLocaleString('it-IT')})`);
        io.out(r.maxCostUSD == null ? '  Costo massimo fino alla scadenza: costo orario non noto' : `  Costo massimo fino alla scadenza: ${fmtUSD(r.maxCostUSD)} (${fmtUSD(r.hourlyUSD)}/h)`);
        if (r.saved) io.out(`  Profilo ${profile} aggiornato per i prossimi avvii`);
        else io.out(`  Vale solo per questo Pod: con --save si aggiorna anche il profilo ${profile}`);
      } finally {
        off();
      }
    });
}
