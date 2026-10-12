import { runPlan, applyAdvice } from '../../core/plan-flow.js';
import { fmtUSD } from '../../core/confirm.js';
import { shellQuoteArgs } from '../../core/planner/shell-quote.js';
import { mtpLabel } from '../../core/planner/mtp-label.js';
import { resolveSetRef } from '../../core/model-sets.js';
import { optionLabel, applyGpuChoice, isUsable, vramLabel } from '../../core/planner/gpu-choice.js';
import { table, fmtGiB, attachRenderer, renderAdvice } from '../render.js';

const toInt = (v) => Number.parseInt(v, 10);
const collect = (v, acc) => [...acc, v];

// Chiede quale GPU usare tra le opzioni disponibili ora (predefinita: la scelta del piano) e salva il piano.
async function chooseGpu(ctx, plan) {
  const { io } = ctx;
  const available = (plan.options ?? []).filter(isUsable);
  if (available.length) {
    const key = (o) => `${o.id}|${o.count}`;
    const picked = await io.askChoice('Quale GPU usare?', available.map((o) => ({ id: key(o), label: optionLabel(o, plan.dataCenterId) })), plan.gpu ? key(plan.gpu) : null);
    const o = available.find((x) => key(x) === picked);
    if (!plan.gpu || o.id !== plan.gpu.id || o.count !== plan.gpu.count) applyGpuChoice(plan, { id: o.id, count: o.count });
  }
  ctx.store.writeJson('last-plan.json', plan);
}

export function register(program, getCtx) {
  program.command('plan <modello>')
    .description('Stima VRAM, sceglie la GPU e gli argomenti di vllm serve (org/modello, org/modello@rev, URL, <set>/<n> o <set>/<id> di un set consigliato)')
    .option('--context <n>', 'lunghezza massima del contesto (con <set>/<n>: quello consigliato dal set)', toInt, 65536)
    .option('--concurrency <n>', 'richieste in parallelo previste', toInt, 2)
    .option('--set <chiave=valore>', 'imposta un argomento di vLLM (ripetibile)', collect, [])
    .option('--extra-arg <arg>', 'aggiunge un argomento di vLLM (ripetibile)', collect, [])
    .option('--image <immagine>', 'immagine vLLM (default da config.json)')
    .option('--allow-trust-remote-code', 'consente --trust-remote-code')
    .option('--advisor', 'usa il consulente anche se disattivato nella configurazione')
    .option('--no-advisor', 'non usare il consulente')
    .option('--gpu <id>', 'usa questa GPU, nella forma <id>[x<numero>] (senza domanda)')
    .option('--yes', 'applica la proposta del consulente senza chiedere (e non chiede la GPU)')
    .option('--json', 'output JSON')
    .action(async (ref, opts, cmd) => {
      const ctx = getCtx();
      // <set>/<n>: modello del set alla revisione verificata; senza --context esplicito vale il contesto consigliato.
      const fromSet = resolveSetRef(ref);
      if (fromSet) ctx.io.err(`⚠ Set ${fromSet.setId}: ${fromSet.warning}`);
      const modelRef = fromSet ? fromSet.modelRef : ref;
      const context = fromSet && cmd.getOptionValueSource('context') === 'default' ? fromSet.recommendedContext : opts.context;
      const off = attachRenderer(ctx.events, ctx.io);
      let result;
      try {
        result = await runPlan({
          ctx, modelRef, context, concurrency: opts.concurrency, set: opts.set, extra: opts.extraArg,
          image: opts.image, allowTrustRemoteCode: Boolean(opts.allowTrustRemoteCode), advisor: opts.advisor, gpu: opts.gpu,
          onProgress: (message) => ctx.events.emit('phase', { message }),
        });
      } finally {
        off();
      }
      const { plan, advice, advisorError, advisorSkipped } = result;
      if (advisorSkipped) ctx.io.err(`ℹ ${advisorSkipped}: uso gli argomenti di base`);
      if (advisorError) ctx.io.err(`⚠ Consulente non disponibile: ${advisorError}; uso gli argomenti di base`);
      if (advice) {
        if (!opts.json) renderAdvice(ctx.io, advice);
        if (advice.accepted.length > 0 && (opts.yes || (!opts.json && await ctx.io.ask('Applicare le modifiche proposte dal consulente?', false)))) applyAdvice(plan, advice);
      }
      const { io } = ctx;
      // La domanda sulla GPU solo in un terminale interattivo, senza --gpu, --yes e --json.
      const askGpu = !opts.json && !opts.yes && !opts.gpu && io.interactive;
      if (!askGpu) ctx.store.writeJson('last-plan.json', plan);
      if (opts.json) return io.raw(JSON.stringify(plan, null, 2));

      const m = plan.model;
      io.out(`Modello:   ${m.id} @ ${m.revision.slice(0, 12)} (${m.requestedRevision})  licenza: ${m.license ?? '?'}  gated: ${m.gated ? 'sì' : 'no'}`);
      io.out(`Memoria:   pesi ${fmtGiB(plan.estimate.weightsGiB)} · KV cache ${fmtGiB(plan.estimate.kvGiB)} (${plan.context} token × ${plan.concurrency}) · per GPU ${fmtGiB(plan.estimate.perGpuGiB)}${plan.kvCacheDtype ? ' · KV FP8' : ''}`);
      io.out(`Parser:    strumenti ${plan.parsers.tool ?? 'nessuno'} · ragionamento ${plan.parsers.reasoning ?? 'nessuno'}`);
      if (plan.mtp) io.out(`${plan.mtp.draft === 'dspark' ? 'Draft:    ' : 'MTP:      '} ${mtpLabel(plan.mtp)}`);
      io.out('');
      io.out(table(plan.options ?? plan.candidates, [
        { key: 'name', label: 'GPU' },
        { key: 'count', label: 'N', align: 'right' },
        { label: 'VRAM', align: 'right', value: (c) => vramLabel(c) },
        { label: 'Per GPU', align: 'right', value: (c) => fmtGiB(c.perGpuGiB) },
        { label: 'Margine', align: 'right', value: (c) => fmtGiB(c.headroomGiB) },
        { label: 'Costo', align: 'right', value: (c) => `${fmtUSD(c.hourly)}/h` },
        { label: `In ${plan.dataCenterId}`, value: (c) => (c.available === false ? 'non disponibile ora' : c.fits === false ? 'non entra più' : c.availabilityHere) },
      ]));
      io.out('');
      if (askGpu) await chooseGpu(ctx, plan);
      if (plan.gpu) io.out(`Scelta:    ${plan.gpu.id} ×${plan.gpu.count} a ${fmtUSD(plan.hourlyUSD)}/h`);
      if (plan.alternatives.length) io.out(`Alternative: ${plan.alternatives.map((a) => `${a.id} ×${a.count} (${fmtUSD(a.hourly)}/h)`).join(', ')}`);
      io.out(`vLLM:      ${plan.vllm.image}`);
      io.out(`           vllm serve ${shellQuoteArgs([m.id])} --served-model-name <profilo> ${shellQuoteArgs(plan.vllm.args)}`);
      for (const w of plan.warnings) io.out(`⚠ ${w}`);
      io.out('\nSalva il piano come profilo con: llmpod save <nome>');
    });
}
