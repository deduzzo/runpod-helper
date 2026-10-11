import { searchRows } from '../../core/search.js';
import { table, fmtGiB } from '../render.js';

export function register(program, getCtx) {
  program.command('search <query...>')
    .description('Cerca su Hugging Face modelli text-generation adatti all\'uso agentico')
    .option('--limit <n>', 'numero di risultati', (v) => Number.parseInt(v, 10), 20)
    .option('--all', 'includi i modelli senza chat template e quelli in formato MLX')
    .option('--json', 'output JSON')
    .action(async (query, opts) => {
      const ctx = getCtx();
      const rows = (await searchRows(ctx.hf, query.join(' '), { limit: opts.limit, all: opts.all })).map((r) => ({ ...r, parser: r.parser ?? '⚠ nessuno', weights: r.weightsGiB ? fmtGiB(r.weightsGiB) : '?' }));
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
        { label: 'MTP', value: (r) => (r.mtp === true ? 'sì' : '?') },
      ]));
      ctx.io.out('\nLa VRAM necessaria comprende anche la KV cache: calcolala con "llmpod plan <modello>".');
    });
}
