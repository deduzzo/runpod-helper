import { Option } from 'commander';
import { LlmpodError, Codes } from '../../core/errors.js';
import { readSecretFromStdin, secretArgOption } from '../stdin.js';
import { confirmCost } from '../../core/confirm.js';
import { table } from '../render.js';
import { configureAdvisor } from './advisor.js';

async function verifyHfToken(http, token) {
  const r = await http.request('GET', 'https://huggingface.co/api/whoami-v2', { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new LlmpodError(Codes.HF_AUTH, `Token Hugging Face non valido (HTTP ${r.status})`, { hint: 'Crea un token "Read" su https://huggingface.co/settings/tokens' });
}

// Flusso di configurazione guidata (usato da `llmpod init` e da `llmpod start`). Con opts vuote chiede tutto in modo interattivo.
export async function runInit({ ctx, opts = {} }) {
  const { io, store } = ctx;
  store.ensureDir();

  // Con un flag *-stdin lo standard input contiene il segreto: le credenziali non fanno domande.
  const noCredPrompt = Boolean(opts.runpodKeyStdin || opts.hfTokenStdin || opts.fromEnv);
  const fromEnv = (name) => (opts.fromEnv ? String(ctx.env[name] ?? '').trim() : '');
  const eof = (flags) => ({ eofHint: `Lo standard input non è un terminale: usa ${flags}` });
  const RUNPOD_HINT = 'Creala su https://www.runpod.io/console/user/settings (permessi Restricted: Pods, Network Volumes e Templates in Read/Write)';

  if (opts.runpodKeyStdin) {
    store.writeEnv({ RUNPOD_API_KEY: await readSecretFromStdin(ctx.stdin, { flag: '--runpod-key-stdin', what: 'la chiave Runpod' }) });
  } else if (fromEnv('RUNPOD_API_KEY')) {
    store.writeEnv({ RUNPOD_API_KEY: fromEnv('RUNPOD_API_KEY') });
  } else if (noCredPrompt) {
    if (!store.readEnv().RUNPOD_API_KEY) {
      throw new LlmpodError(Codes.INVALID_INPUT, 'Chiave Runpod mancante: senza terminale non si può chiedere', {
        hint: `Passala con --runpod-key-stdin (in pipe) oppure imposta RUNPOD_API_KEY nell'ambiente e usa --from-env. ${RUNPOD_HINT}`,
      });
    }
  } else if (!store.readEnv().RUNPOD_API_KEY || !(await io.ask('Chiave Runpod già configurata. Mantenerla?', true))) {
    const key = await io.askSecret('Chiave API Runpod (input nascosto):', eof('--runpod-key-stdin (chiave in pipe) oppure --from-env (variabile RUNPOD_API_KEY)'));
    if (!key) throw new LlmpodError(Codes.INVALID_INPUT, 'La chiave Runpod è obbligatoria', { hint: RUNPOD_HINT });
    store.writeEnv({ RUNPOD_API_KEY: key });
  }
  await ctx.runpod.listPods();
  io.out('✓ Chiave Runpod valida');

  const saveHfToken = async (token) => {
    await verifyHfToken(ctx.http, token);
    store.writeEnv({ HF_TOKEN: token });
    io.out('✓ Token Hugging Face valido');
  };
  if (opts.hfTokenStdin) {
    await saveHfToken(await readSecretFromStdin(ctx.stdin, { flag: '--hf-token-stdin', what: 'il token Hugging Face' }));
  } else if (fromEnv('HF_TOKEN')) {
    await saveHfToken(fromEnv('HF_TOKEN'));
  } else if (!noCredPrompt && (!store.readEnv().HF_TOKEN || !(await io.ask('Token Hugging Face già configurato. Mantenerlo?', true)))) {
    const token = await io.askSecret('Token Hugging Face (facoltativo, serve per i modelli gated; invio per saltare):');
    if (token) await saveHfToken(token);
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
  const dc = opts.datacenter ?? await io.askText('Datacenter preferito (il volume dei pesi sarà creato lì):', suggested, eof('--datacenter <id>'));
  if (!usable.some((d) => d.id === dc)) throw new LlmpodError(Codes.INVALID_INPUT, `Datacenter "${dc}" non valido o senza network volume`);

  let volume = null;
  let noVolume = opts.volume === false;
  if (!noVolume) {
    const existing = (await ctx.runpod.listVolumes()).filter((v) => v.dataCenter === dc);
    if (existing.length && (opts.yes || await io.ask(`Riutilizzare il volume ${existing[0].name} (${existing[0].size} GB)?`, true, eof('--yes (riusa il volume) oppure --no-volume')))) {
      volume = existing[0];
    } else {
      const size = opts.volumeSize ?? Number.parseInt(await io.askText('Dimensione del volume in GB (circa 2× i pesi dei modelli: 150 per ~30B, 500+ per 200B+):', '150', eof('--volume-size <gb>')), 10);
      if (!Number.isInteger(size) || size < 10 || size > 4096) throw new LlmpodError(Codes.INVALID_INPUT, 'La dimensione deve essere tra 10 e 4096 GB');
      try {
        const conf = await confirmCost({ monthlyUSD: size * cfg.volumePricePerGbMonth, description: `Creazione del network volume llmpod-pesi da ${size} GB in ${dc}`, yes: opts.yes, dryRun: opts.dryRun, ask: (q, d) => io.ask(q, d, eof('--yes (conferma il costo) oppure --no-volume')) });
        if (conf.dryRun) io.out(`[dry-run] ${conf.message}`);
        else volume = await ctx.runpod.createVolume({ name: 'llmpod-pesi', size, dataCenter: dc });
      } catch (err) {
        // Rifiutare il costo del volume non annulla l'init: si prosegue senza volume.
        if (err.code !== Codes.CANCELLED) throw err;
        noVolume = true;
      }
    }
  }
  const patch = { dataCenterId: dc };
  if (volume) patch.volume = { id: volume.id, name: volume.name, size: volume.size, dataCenterId: dc };
  if (noVolume) {
    // Un volume già configurato nello stesso datacenter verrebbe usato dai profili: non va più usato. Uno di un altro
    // datacenter non è usato dai profili di questo datacenter e resta configurato (gestibile con destroy-volume).
    if (cfg.volume && cfg.volume.dataCenterId === dc) {
      patch.volume = null;
      io.err(`⚠ Il volume ${cfg.volume.name} (${cfg.volume.size} GB, ${dc}) non sarà più usato da llmpod ma esiste ancora e continua a costare: eliminalo dalla console di Runpod (https://www.runpod.io/console/user/storage) se non ti serve`);
    }
    io.err('⚠ Nessun network volume: i pesi saranno scaricati a ogni avvio (puoi crearne uno rilanciando llmpod init)');
  }
  store.writeConfig(patch);
  io.out(`✓ Configurazione salvata in ${store.dir}`);
  if (!store.readConfig().advisor?.enabled && !opts.yes && !opts.dryRun && !noCredPrompt
    && await io.ask('Configurare ora il consulente IA che propone gli argomenti di vLLM?', false)) {
    await configureAdvisor(ctx);
  }
}

export function register(program, getCtx) {
  program.command('init')
    .description('Configurazione guidata: credenziali, datacenter preferito, network volume per i pesi')
    .option('--datacenter <id>', 'datacenter preferito (es. EU-RO-1)')
    .option('--volume-size <gb>', 'dimensione del network volume in GB', (v) => Number.parseInt(v, 10))
    .option('--yes', 'non chiedere conferme')
    .option('--no-volume', 'configura il datacenter senza creare né riusare un network volume (pesi scaricati a ogni avvio)')
    .option('--dry-run', 'non creare il volume')
    .addOption(new Option('--runpod-key-stdin', 'legge la chiave Runpod dalla prima riga dello standard input (senza domande)').conflicts('hfTokenStdin'))
    .addOption(new Option('--hf-token-stdin', 'legge il token Hugging Face dalla prima riga dello standard input (senza domande)').conflicts('runpodKeyStdin'))
    .option('--from-env', 'usa RUNPOD_API_KEY e HF_TOKEN dall\'ambiente del processo, se impostate (mai senza questo flag)')
    .addOption(secretArgOption(Option, '--runpod-key', '--runpod-key-stdin'))
    .addOption(secretArgOption(Option, '--hf-token', '--hf-token-stdin'))
    .action(async (opts) => runInit({ ctx: getCtx(), opts }));
}
