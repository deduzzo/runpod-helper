import { detectParsers } from '../../core/planner/vllm-args.js';
import { bytesFromSafetensorsParams, GiB } from '../../core/planner/vram.js';
import { table, fmtGiB } from '../render.js';

export function register(program, getCtx) {
  program.command('search <query...>')
    .description('Cerca su Hugging Face modelli text-generation adatti all\'uso agentico')
    .option('--limit <n>', 'numero di risultati', (v) => Number.parseInt(v, 10), 20)
    .option('--all', 'includi i modelli senza chat template')
    .option('--json', 'output JSON')
    .action(async (query, opts) => {
      const ctx = getCtx();
      const models = (await ctx.hf.searchModels(query.join(' '), { limit: opts.limit })).filter((m) => opts.all || m.hasChatTemplate);
      const rows = models.map((m) => {
        const known = m.architectures.length || m.modelType;
        const p = known ? detectParsers({ modelId: m.id, config: { architectures: m.architectures, model_type: m.modelType } }) : { tool: null };
        const bytes = bytesFromSafetensorsParams(m.paramsByDtype);
        return { ...m, parser: p.tool ?? '⚠ nessuno', weights: bytes ? fmtGiB(bytes / GiB) : '?' };
      });
      if (opts.json) return ctx.io.raw(JSON.stringify(rows, null, 2));
      ctx.io.out(table(rows, [
        { key: 'id', label: 'Modello' },
        { label: 'Parametri', align: 'right', value: (r) => (r.params ? `${(r.params / 1e9).toFixed(1)} B` : '?') },
        { label: 'Dtype', value: (r) => r.dtypes.join('+') || '?' },
        { label: 'Licenza', value: (r) => r.license ?? '?' },
        { label: 'Gated', value: (r) => (r.gated ? 'sì' : 'no') },
        { label: 'Download', align: 'right', value: (r) => r.downloads ?? '?' },
        { label: 'Aggiornato', value: (r) => (r.lastModified ? r.lastModified.slice(0, 10) : '?') },
        { key: 'weights', label: 'Pesi', align: 'right' },
        { key: 'parser', label: 'Tool parser' },
      ]));
      ctx.io.out('\nLa VRAM necessaria comprende anche la KV cache: calcolala con "llmpod plan <modello>".');
    });
}
