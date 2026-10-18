import { attachRenderer } from '../render.js';
import { fmtUSD } from '../../core/confirm.js';
import { AMBIGUOUS_CREATE_WARNING, WAIT_INTERVAL_MS } from '../../core/ops.js';
import { LlmpodError, Codes } from '../../core/errors.js';
import { parseGpuSpec } from '../../core/planner/gpu-choice.js';

// --wait: il costo si conferma PRIMA dell'attesa (al prezzo di adesso), così quando la GPU si libera l'avvio parte subito
// senza aspettare una risposta; se nel frattempo il prezzo cambia, up si ferma con PRICE_CHANGED senza creare nulla.
async function confirmWait(ctx, name, gpu, { yes, waitMax }) {
  const preview = await ctx.ops.upPreview(name);
  const same = (o) => o.gpu.id === gpu.id && (gpu.count == null || o.gpu.count === gpu.count);
  const option = preview.options.find(same) ?? preview.waitable.find(same);
  if (!option) {
    throw new LlmpodError(Codes.NO_GPU_AVAILABLE, `${gpu.id}${gpu.count ? ` ×${gpu.count}` : ''} non è tra le GPU adatte al profilo ${name}`, { hint: `Guarda le opzioni del piano: llmpod plan <modello>` });
  }
  const label = `${option.gpu.id} ×${option.gpu.count}`;
  const now = preview.options.some(same) ? 'disponibile ora' : `non disponibile ora: verifica ogni ${WAIT_INTERVAL_MS / 1000} s per al massimo ${waitMax} min e avvio appena disponibile`;
  const ok = yes || await ctx.io.ask(`Avvio di ${name} su ${label} a ${fmtUSD(option.hourlyUSD)}/h (massimo ${fmtUSD(option.maxCostUSD)} secondo i limiti di spegnimento), ${now}. Confermi la spesa?`, false);
  if (!ok) throw new LlmpodError(Codes.CANCELLED, 'Spesa non confermata: nessuna attesa e nessun Pod creato');
  return { gpu: { id: option.gpu.id, count: option.gpu.count }, expectedHourlyUSD: option.hourlyUSD };
}

// Gestione di Ctrl+C durante "up": non deve mai lasciare un Pod acceso senza avvisare.
export function createInterruptHandler({ ops, runpod, io, name, getPodId, isCreating = () => true, exit = (c) => process.exit(c) }) {
  let running = false;
  return async () => {
    if (running) {
      io.err('  Terminazione in corso, attendere…');
      return;
    }
    running = true;
    try {
      let id = getPodId();
      if (!id) {
        try {
          const pod = (await runpod.listPods()).find((p) => p.name === `llmpod-${name}` && !['TERMINATED', 'EXITED'].includes(p.status));
          id = pod?.id ?? null;
        } catch { /* ricerca best-effort */ }
      }
      if (!id) {
        if (isCreating()) io.err(`⚠ ${AMBIGUOUS_CREATE_WARNING}`);
        return;
      }
      let terminate = true;
      try {
        terminate = await io.ask(`\nInterrotto. Terminare il Pod ${id} per non continuare a pagare?`, true);
      } catch { /* risposta non ottenibile (es. secondo Ctrl+C): meglio spegnere */ }
      if (!terminate) {
        io.err(`⚠ Pod ${id} lasciato acceso: spegnilo con "llmpod down ${name}"`);
        return;
      }
      try {
        await ops.down(name, { yes: true });
      } catch (err) {
        io.err(`⚠ Il Pod ${id} potrebbe essere ancora attivo: ${err.message}. Controlla su https://www.runpod.io/console/pods`);
      }
    } finally {
      exit(130);
    }
  };
}

export function register(program, getCtx) {
  program.command('up <profilo>')
    .description('Crea il Pod, attende vLLM ed esegue lo smoke test')
    .option('--yes', 'non chiedere conferme')
    .option('--dry-run', 'mostra la richiesta senza creare nulla')
    .option('--gpu <id>', 'usa questa GPU, nella forma <id>[x<numero>]')
    .option('--wait', `se la GPU scelta non è disponibile, verifica ogni ${WAIT_INTERVAL_MS / 1000} s e avvia appena si libera (richiede --gpu)`)
    .option('--wait-max <minuti>', 'durata massima dell\'attesa', (v) => Number.parseInt(v, 10), 240)
    .action(async (name, opts) => {
      const ctx = getCtx();
      const { io } = ctx;
      const off = attachRenderer(ctx.events, io, { verbose: program.opts().verbose });
      let podId = null;
      let creating = false;
      const offPod = ctx.events.on((e) => {
        if (e.type === 'pod') podId = e.podId;
        if (e.type === 'phase' && /^Creazione del Pod/.test(e.message)) creating = true;
      });
      const onSigint = createInterruptHandler({ ops: ctx.ops, runpod: ctx.runpod, io, name, getPodId: () => podId, isCreating: () => creating });
      process.on('SIGINT', onSigint);
      try {
        if (opts.wait && !opts.gpu) throw new LlmpodError(Codes.INVALID_INPUT, '--wait richiede la GPU da attendere: --gpu <id>[x<numero>]');
        const gpu = opts.gpu ? parseGpuSpec(opts.gpu) : null;
        const chosen = opts.wait && !opts.dryRun ? await confirmWait(ctx, name, gpu, { yes: opts.yes, waitMax: opts.waitMax }) : null;
        const r = await ctx.ops.up(name, {
          yes: opts.yes, dryRun: opts.dryRun, gpu: chosen?.gpu ?? gpu,
          ...(chosen ? { expectedHourlyUSD: chosen.expectedHourlyUSD, costConfirmed: true, wait: { maxMinutes: opts.waitMax } } : {}),
        });
        if (r.dryRun) {
          io.out(`[dry-run] ${r.message}`);
          io.out(`Candidati: ${r.candidates.map((c) => `${c.id} ×${c.count} @ ${c.dataCenterId}${c.withVolume ? '' : ' (senza volume)'}`).join(', ')}`);
          io.out(JSON.stringify(r.body, null, 2));
          return;
        }
        io.out(`✓ ${name} pronto in ${r.startupSeconds} s`);
        io.out(`  Endpoint:  ${r.baseUrl}  (OpenAI: ${r.baseUrl}/v1)`);
        io.out(`  Costo:     ${fmtUSD(r.hourlyUSD)}/h su ${r.candidate.id} ×${r.candidate.count} (${r.candidate.dataCenterId})`);
        io.out('  Smoke test: /v1/models ✓  /v1/messages con strumento ✓  /v1/chat/completions con strumento ✓');
        if (r.contextSuggestion) io.out(`  La KV cache consente fino a ${r.contextSuggestion} token per richiesta: puoi rigenerare il profilo con --context ${r.contextSuggestion}`);
        if (r.repairedArgs && await io.ask('Salvare nel profilo gli argomenti corretti dal consulente?', true)) {
          ctx.ops.saveProfileArgs(name, r.repairedArgs);
          io.out(`✓ Profilo ${name} aggiornato`);
        }
        io.out(`Usa: llmpod run claude | opencode | pi | zcode   ·   Spegni: llmpod down ${name}`);
      } finally {
        process.off('SIGINT', onSigint);
        offPod();
        off();
      }
    });
}
