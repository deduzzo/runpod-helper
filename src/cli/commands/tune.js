import { LlmpodError, Codes } from '../../core/errors.js';
import { attachRenderer, renderAdvice } from '../render.js';

const collect = (v, acc) => [...acc, v];

function renderPreview(io, r) {
  io.out(`Pod ${r.podId} (${r.profile}) · vLLM: ${r.phase}`);
  renderAdvice(io, { rationale: '', changes: r.changes, rejected: [], warnings: [] });
  if (r.unknownFlags?.length) io.out(`⚠ Flag non riconosciuti da questa versione di vLLM: ${r.unknownFlags.join(', ')}`);
  if (r.contextChange) io.out(`Contesto: ${r.contextChange.from} → ${r.contextChange.to} token`);
  const m = r.memory;
  if (m.fits == null) io.out(`Memoria per GPU: ${m.note}`);
  else io.out(`Memoria per GPU (${m.gpu} ×${m.count}, ${m.memoryGiB} GB): servono circa ${String(m.neededGiB).replace('.', ',')} GiB su ${String(m.availableGiB).replace('.', ',')} GiB utilizzabili`);
}

export function register(program, getCtx) {
  program.command('tune <profilo>')
    .description('Cambia gli argomenti di vLLM sul Pod avviato e lo ricarica (il Pod resta acceso)')
    .option('--set <chiave=valore>', 'imposta un argomento di vLLM (ripetibile; valore false = rimuove)', collect, [])
    .option('--extra-arg <arg>', 'aggiunge un argomento di vLLM (ripetibile)', collect, [])
    .option('--dry-run', 'mostra diff e stima di memoria senza ricaricare')
    .option('--yes', 'non chiedere conferme (in caso di errore torna agli argomenti precedenti)')
    .option('--save', 'salva i nuovi argomenti nel profilo (e il contesto, se cambia)')
    .option('--json', 'output JSON')
    .action(async (name, opts) => {
      const ctx = getCtx();
      if (!opts.set.length && !opts.extraArg.length) {
        throw new LlmpodError(Codes.INVALID_INPUT, 'Indica almeno un argomento da cambiare', { hint: 'Esempi: llmpod tune <profilo> --set max-num-seqs=4   ·   --set kv-cache-dtype=fp8   ·   --set max-model-len=32768' });
      }
      const { io } = ctx;
      const off = attachRenderer(ctx.events, io, { verbose: program.opts().verbose });
      try {
        if (!opts.dryRun && !opts.json) renderPreview(io, await ctx.ops.tunePreview(name, { set: opts.set, extra: opts.extraArg }));
        const r = await ctx.ops.tune(name, { set: opts.set, extra: opts.extraArg, dryRun: opts.dryRun, yes: opts.yes, save: opts.save });
        if (opts.json) return io.raw(JSON.stringify(r, null, 2));
        if (r.dryRun) {
          renderPreview(io, r);
          io.out(`[dry-run] ${r.note}: nessuna modifica applicata`);
          return undefined;
        }
        io.out(`✓ vLLM ricaricato sul Pod ${r.podId} con i nuovi argomenti · smoke test ✓`);
        if (r.kvCacheTokens) io.out(`  KV cache: ${r.kvCacheTokens.toLocaleString('it-IT')} token`);
        io.out(r.saved ? `  Profilo ${name} aggiornato per i prossimi avvii` : `  Vale solo per questo Pod: con --save si aggiorna anche il profilo ${name}`);
        io.out(`  Controlla l'effetto con: llmpod metrics ${name}`);
        return undefined;
      } finally {
        off();
      }
    });
}
