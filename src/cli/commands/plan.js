import { LlmpodError, Codes } from '../../core/errors.js';
import { makePlan } from '../../core/planner/plan.js';
import { loadFlags } from '../../core/planner/vllm-args.js';
import { fmtUSD } from '../../core/confirm.js';
import { table, fmtGiB, attachRenderer } from '../render.js';

const toInt = (v) => Number.parseInt(v, 10);
const collect = (v, acc) => [...acc, v];

export function register(program, getCtx) {
  program.command('plan <modello>')
    .description('Stima VRAM, sceglie la GPU e gli argomenti di vllm serve (org/modello, org/modello@rev o URL)')
    .option('--context <n>', 'lunghezza massima del contesto', toInt, 65536)
    .option('--concurrency <n>', 'richieste in parallelo previste', toInt, 2)
    .option('--set <chiave=valore>', 'imposta un argomento di vLLM (ripetibile)', collect, [])
    .option('--extra-arg <arg>', 'aggiunge un argomento di vLLM (ripetibile)', collect, [])
    .option('--image <immagine>', 'immagine vLLM (default da config.json)')
    .option('--allow-trust-remote-code', 'consente --trust-remote-code')
    .option('--json', 'output JSON')
    .action(async (modelRef, opts) => {
      const ctx = getCtx();
      const cfg = ctx.store.readConfig();
      if (!cfg.dataCenterId) throw new LlmpodError(Codes.INVALID_INPUT, 'Nessun datacenter configurato', { hint: 'Esegui: llmpod init' });
      const off = attachRenderer(ctx.events, ctx.io);
      let plan;
      try {
        plan = await makePlan({
          hf: ctx.hf, runpod: ctx.runpod, modelRef, context: opts.context, concurrency: opts.concurrency,
          cloud: cfg.cloud, dataCenterId: cfg.dataCenterId, minCudaVersion: cfg.minCudaVersion,
          vllmImage: opts.image ?? cfg.vllmImage, set: opts.set, extra: opts.extraArg, flags: loadFlags(),
          allowTrustRemoteCode: Boolean(opts.allowTrustRemoteCode),
          onProgress: (message) => ctx.events.emit('phase', { message }),
        });
      } finally {
        off();
      }
      ctx.store.writeJson('last-plan.json', plan);
      if (opts.json) return ctx.io.raw(JSON.stringify(plan, null, 2));

      const { io } = ctx;
      const m = plan.model;
      io.out(`Modello:   ${m.id} @ ${m.revision.slice(0, 12)} (${m.requestedRevision})  licenza: ${m.license ?? '?'}  gated: ${m.gated ? 'sì' : 'no'}`);
      io.out(`Memoria:   pesi ${fmtGiB(plan.estimate.weightsGiB)} · KV cache ${fmtGiB(plan.estimate.kvGiB)} (${plan.context} token × ${plan.concurrency}) · per GPU ${fmtGiB(plan.estimate.perGpuGiB)}${plan.kvCacheDtype ? ' · KV FP8' : ''}`);
      io.out(`Parser:    strumenti ${plan.parsers.tool ?? 'nessuno'} · ragionamento ${plan.parsers.reasoning ?? 'nessuno'}`);
      io.out('');
      io.out(table(plan.candidates, [
        { key: 'name', label: 'GPU' },
        { key: 'count', label: 'N', align: 'right' },
        { label: 'VRAM', align: 'right', value: (c) => `${c.memoryGiB} GB` },
        { label: 'Per GPU', align: 'right', value: (c) => fmtGiB(c.perGpuGiB) },
        { label: 'Margine', align: 'right', value: (c) => fmtGiB(c.headroomGiB) },
        { label: 'Costo', align: 'right', value: (c) => `${fmtUSD(c.hourly)}/h` },
        { label: `In ${plan.dataCenterId}`, value: (c) => c.availabilityHere },
      ]));
      io.out('');
      if (plan.gpu) io.out(`Scelta:    ${plan.gpu.id} ×${plan.gpu.count} a ${fmtUSD(plan.hourlyUSD)}/h`);
      if (plan.alternatives.length) io.out(`Alternative: ${plan.alternatives.map((a) => `${a.id} ×${a.count} (${fmtUSD(a.hourly)}/h)`).join(', ')}`);
      io.out(`vLLM:      ${plan.vllm.image}`);
      io.out(`           vllm serve ${m.id} --served-model-name <profilo> ${plan.vllm.args.join(' ')}`);
      for (const w of plan.warnings) io.out(`⚠ ${w}`);
      io.out('\nSalva il piano come profilo con: llmpod save <nome>');
    });
}
