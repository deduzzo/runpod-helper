import { searchRows } from '../../core/search.js';
import { listSets, getSet, filterSetModels } from '../../core/model-sets.js';
import { LlmpodError, Codes } from '../../core/errors.js';
import { table, fmtGiB } from '../render.js';

const fmtTokens = (n) => n.toLocaleString('it-IT');

function showSets(ctx, json) {
  const sets = listSets();
  if (json) return ctx.io.raw(JSON.stringify(sets, null, 2));
  ctx.io.out(table(sets, [
    { key: 'id', label: 'Set' },
    { key: 'name', label: 'Nome' },
    { key: 'count', label: 'Modelli', align: 'right' },
    { key: 'description', label: 'Descrizione' },
  ]));
  ctx.io.out('\nModelli di un set: llmpod search --set <set>');
  return undefined;
}

function showSet(ctx, id, query, json) {
  const set = getSet(id);
  const rows = filterSetModels(set, query);
  if (json) return ctx.io.raw(JSON.stringify(rows.map(({ n, model }) => ({ n, ...model })), null, 2));
  ctx.io.out(`Set "${set.name}" (${set.id}): ${set.description}`);
  ctx.io.err(`⚠ ${set.warning}`);
  ctx.io.out('');
  if (!rows.length) {
    ctx.io.out(`Nessun modello del set corrisponde a "${query}"`);
    return undefined;
  }
  ctx.io.out(table(rows, [
    { label: '#', align: 'right', value: (r) => r.n },
    { label: 'Modello', value: (r) => r.model.id },
    { label: 'Variante', value: (r) => r.model.variant },
    { label: 'Formato', value: (r) => r.model.format.toUpperCase() },
    { label: 'Pesi', align: 'right', value: (r) => fmtGiB(r.model.weightsGiB) },
    { label: 'MTP', value: (r) => (r.model.mtp ? 'sì' : 'no') },
    { label: 'Contesto', align: 'right', value: (r) => fmtTokens(r.model.context) },
    { label: 'Consigliato', align: 'right', value: (r) => fmtTokens(r.model.recommendedContext) },
  ]));
  ctx.io.out(`\nCalcola costo e GPU con: llmpod plan ${set.id}/<n>  (es. llmpod plan ${set.id}/${rows[0].n}: revisione verificata e contesto consigliato)`);
  return undefined;
}

export function register(program, getCtx) {
  program.command('search [query...]')
    .description('Cerca su Hugging Face modelli text-generation adatti all\'uso agentico, oppure nei set consigliati (--set)')
    .option('--limit <n>', 'numero di risultati', (v) => Number.parseInt(v, 10), 20)
    .option('--all', 'includi i modelli senza chat template e quelli in formato MLX')
    .option('--set <id>', 'mostra solo i modelli del set consigliato <id> (il testo, se presente, filtra il set)')
    .option('--sets', 'elenca i set di modelli consigliati')
    .option('--json', 'output JSON')
    .action(async (query, opts) => {
      const ctx = getCtx();
      const text = query.join(' ').trim();
      if (opts.sets) return showSets(ctx, opts.json);
      if (opts.set) return showSet(ctx, opts.set, text, opts.json);
      if (!text) {
        throw new LlmpodError(Codes.INVALID_INPUT, 'Indica cosa cercare', { hint: 'Esempi: llmpod search qwen3 coder · llmpod search --set abliterated · llmpod search --sets' });
      }
      const rows = (await searchRows(ctx.hf, text, { limit: opts.limit, all: opts.all })).map((r) => ({ ...r, parser: r.parser ?? '⚠ nessuno', weights: r.weightsGiB ? fmtGiB(r.weightsGiB) : '?' }));
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
      return undefined;
    });
}
