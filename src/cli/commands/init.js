import { LlmpodError, Codes } from '../../core/errors.js';
import { confirmCost } from '../../core/confirm.js';
import { table } from '../render.js';
import { configureAdvisor } from './advisor.js';

async function verifyHfToken(http, token) {
  const r = await http.request('GET', 'https://huggingface.co/api/whoami-v2', { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new LlmpodError(Codes.HF_AUTH, `Token Hugging Face non valido (HTTP ${r.status})`, { hint: 'Crea un token "Read" su https://huggingface.co/settings/tokens' });
}

export function register(program, getCtx) {
  program.command('init')
    .description('Configurazione guidata: credenziali, datacenter preferito, network volume per i pesi')
    .option('--datacenter <id>', 'datacenter preferito (es. EU-RO-1)')
    .option('--volume-size <gb>', 'dimensione del network volume in GB', (v) => Number.parseInt(v, 10))
    .option('--yes', 'non chiedere conferme')
    .option('--dry-run', 'non creare il volume')
    .action(async (opts) => {
      const ctx = getCtx();
      const { io, store } = ctx;
      store.ensureDir();

      if (!store.readEnv().RUNPOD_API_KEY || !(await io.ask('Chiave Runpod già configurata. Mantenerla?', true))) {
        const key = await io.askSecret('Chiave API Runpod (input nascosto):');
        if (!key) throw new LlmpodError(Codes.INVALID_INPUT, 'La chiave Runpod è obbligatoria', { hint: 'Creala su https://www.runpod.io/console/user/settings (permessi Restricted: Pods, Network Volumes e Templates in Read/Write)' });
        store.writeEnv({ RUNPOD_API_KEY: key });
      }
      await ctx.runpod.listPods();
      io.out('✓ Chiave Runpod valida');

      if (!store.readEnv().HF_TOKEN || !(await io.ask('Token Hugging Face già configurato. Mantenerlo?', true))) {
        const token = await io.askSecret('Token Hugging Face (facoltativo, serve per i modelli gated; invio per saltare):');
        if (token) {
          await verifyHfToken(ctx.http, token);
          store.writeEnv({ HF_TOKEN: token });
          io.out('✓ Token Hugging Face valido');
        }
      }

      const dcs = await ctx.runpod.listDataCenters();
      const usable = dcs
        .filter((d) => (d.networkVolumeTypes ?? []).length > 0)
        .map((d) => ({ id: d.id, region: d.region, gpus: (d.gpuAvailability ?? []).filter((g) => g.availability !== 'NONE').length }))
        .sort((a, b) => b.gpus - a.gpus);
      io.out(table(usable.slice(0, 15), [
        { key: 'id', label: 'Datacenter' }, { key: 'region', label: 'Regione' }, { key: 'gpus', label: 'GPU disponibili', align: 'right' },
      ]));
      const cfg = store.readConfig();
      const suggested = cfg.dataCenterId ?? usable.find((d) => d.region === 'EUROPE')?.id ?? usable[0]?.id;
      const dc = opts.datacenter ?? await io.askText('Datacenter preferito (il volume dei pesi sarà creato lì):', suggested);
      if (!usable.some((d) => d.id === dc)) throw new LlmpodError(Codes.INVALID_INPUT, `Datacenter "${dc}" non valido o senza network volume`);

      const existing = (await ctx.runpod.listVolumes()).filter((v) => v.dataCenter === dc);
      let volume = null;
      if (existing.length && (opts.yes || await io.ask(`Riutilizzare il volume ${existing[0].name} (${existing[0].size} GB)?`, true))) {
        volume = existing[0];
      } else {
        const size = opts.volumeSize ?? Number.parseInt(await io.askText('Dimensione del volume in GB (circa 2× i pesi dei modelli: 150 per ~30B, 500+ per 200B+):', '150'), 10);
        if (!Number.isInteger(size) || size < 10 || size > 4096) throw new LlmpodError(Codes.INVALID_INPUT, 'La dimensione deve essere tra 10 e 4096 GB');
        const conf = await confirmCost({ monthlyUSD: size * cfg.volumePricePerGbMonth, description: `Creazione del network volume llmpod-pesi da ${size} GB in ${dc}`, yes: opts.yes, dryRun: opts.dryRun, ask: io.ask });
        if (conf.dryRun) io.out(`[dry-run] ${conf.message}`);
        else volume = await ctx.runpod.createVolume({ name: 'llmpod-pesi', size, dataCenter: dc });
      }
      store.writeConfig({ dataCenterId: dc, ...(volume ? { volume: { id: volume.id, name: volume.name, size: volume.size, dataCenterId: dc } } : {}) });
      io.out(`✓ Configurazione salvata in ${store.dir}`);
      if (!store.readConfig().advisor?.enabled && !opts.yes && !opts.dryRun
        && await io.ask('Configurare ora il consulente IA che propone gli argomenti di vLLM?', false)) {
        await configureAdvisor(ctx);
      }
    });
}
