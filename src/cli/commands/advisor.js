import { Option } from 'commander';
import { LlmpodError, Codes } from '../../core/errors.js';
import { readSecretFromStdin, secretArgOption } from '../stdin.js';
import { PRESETS, ZAI_NOTICE, CLAUDE_CLI_IN_DOCKER, availablePresets } from '../../core/advisor/presets.js';
import { testAdvisor } from '../../core/advisor/advisor.js';
import { table } from '../render.js';

const FIELDS = ['LLMPOD_ADVISOR_PRESET', 'LLMPOD_ADVISOR_API_KEY', 'LLMPOD_ADVISOR_MODEL', 'LLMPOD_ADVISOR_BASE_URL', 'LLMPOD_ADVISOR_PROTOCOL', 'LLMPOD_ADVISOR_AUTH'];

const NO_KEY_PRESETS = ['claude-cli', 'pod'];

export async function configureAdvisor(ctx, { preset: chosen, model: chosenModel, baseUrl: chosenBaseUrl, protocol: chosenProtocol, auth: chosenAuth, apiKeyStdin = false, acceptZaiNotice = false } = {}) {
  const { io, store } = ctx;
  // Con --api-key-stdin lo standard input è occupato dalla chiave: nessuna domanda, tutto arriva dalle opzioni.
  const noPrompt = apiKeyStdin;
  const eof = (flag) => ({ eofHint: `Lo standard input non è un terminale: indica ${flag} (o esegui il comando in un terminale interattivo)` });
  const needOption = (flag, what) => new LlmpodError(Codes.INVALID_INPUT, `Con --api-key-stdin ${what} va indicato con ${flag}`, { hint: 'Con --api-key-stdin il comando non fa domande: tutte le informazioni arrivano dalle opzioni' });
  const env = store.readEnv();
  const offered = availablePresets(ctx.env);
  io.out(table(Object.entries(offered).map(([id, p]) => ({ id, label: p.label })), [{ key: 'id', label: 'Preset' }, { key: 'label', label: 'Descrizione' }]));
  if (!chosen && noPrompt) throw needOption('--preset <nome>', 'il preset');
  const preset = chosen ?? await io.askText('Preset del consulente:', offered[env.LLMPOD_ADVISOR_PRESET] ? env.LLMPOD_ADVISOR_PRESET : 'zai-coding-plan', eof('--preset <nome>'));
  const p = PRESETS[preset];
  if (!p) throw new LlmpodError(Codes.INVALID_INPUT, `Preset sconosciuto: "${preset}"`, { hint: `Preset: ${Object.keys(offered).join(', ')}` });
  if (!offered[preset]) throw new LlmpodError(Codes.INVALID_INPUT, CLAUDE_CLI_IN_DOCKER);
  const needsKey = !NO_KEY_PRESETS.includes(preset);
  if (apiKeyStdin && !needsKey) throw new LlmpodError(Codes.INVALID_INPUT, `Il preset ${preset} non usa una chiave API: togli --api-key-stdin`);

  const cfg = store.readConfig();
  let zaiNoticeAcknowledged = Boolean(cfg.advisor?.zaiNoticeAcknowledged);
  if (preset === 'zai-coding-plan' && !zaiNoticeAcknowledged) {
    io.out(`⚠ ${ZAI_NOTICE}`);
    if (acceptZaiNotice) {
      io.out('Presa visione dell\'avviso registrata (--accept-zai-notice).');
    } else if (noPrompt) {
      throw new LlmpodError(Codes.INVALID_INPUT, 'Serve la presa visione dell\'avviso del Coding Plan di Z.ai, ma senza terminale non si può chiedere', { hint: 'Leggi l\'avviso qui sopra e aggiungi --accept-zai-notice per confermare' });
    } else if (!(await io.ask('Confermi di voler usare il Coding Plan come consulente?', false, eof('--accept-zai-notice per confermare di aver letto l\'avviso')))) {
      throw new LlmpodError(Codes.CANCELLED, 'Configurazione del consulente annullata');
    }
    zaiNoticeAcknowledged = true;
  }

  const next = Object.fromEntries(FIELDS.map((f) => [f, undefined]));
  next.LLMPOD_ADVISOR_PRESET = preset;
  if (preset === 'custom') {
    if (noPrompt && !chosenBaseUrl) throw needOption('--base-url <url>', 'il Base URL');
    if (noPrompt && !chosenModel) throw needOption('--model <nome>', 'il modello');
    next.LLMPOD_ADVISOR_PROTOCOL = chosenProtocol ?? (noPrompt ? 'openai' : await io.askText('Protocollo (anthropic o openai):', env.LLMPOD_ADVISOR_PROTOCOL ?? 'openai', eof('--protocol <anthropic|openai>')));
    next.LLMPOD_ADVISOR_BASE_URL = chosenBaseUrl ?? await io.askText('Base URL (https://…; con protocollo openai includi /v1 (es. https://host/v1); con anthropic no (es. https://host)):', env.LLMPOD_ADVISOR_BASE_URL, eof('--base-url <url>'));
    next.LLMPOD_ADVISOR_MODEL = chosenModel ?? await io.askText('Modello:', env.LLMPOD_ADVISOR_MODEL, eof('--model <nome>'));
    next.LLMPOD_ADVISOR_AUTH = chosenAuth ?? (noPrompt ? 'bearer' : await io.askText('Autenticazione (bearer o x-api-key):', env.LLMPOD_ADVISOR_AUTH ?? 'bearer', eof('--auth <bearer|x-api-key>')));
  } else if (needsKey) {
    const model = chosenModel ?? (noPrompt ? '' : await io.askText(`Modello${p.model ? ` (invio per ${p.model})` : ''}:`, ''));
    if (model) next.LLMPOD_ADVISOR_MODEL = model;
  }
  if (needsKey) {
    // La chiave salvata si può mantenere solo verso lo stesso provider; per "custom" contano anche URL, protocollo e autenticazione
    // (altrimenti la chiave finirebbe a un host diverso da quello per cui è stata inserita).
    const normUrl = (u) => (u ?? '').replace(/\/+$/, '');
    const sameEndpoint = preset !== 'custom'
      || (normUrl(env.LLMPOD_ADVISOR_BASE_URL) === normUrl(next.LLMPOD_ADVISOR_BASE_URL)
        && env.LLMPOD_ADVISOR_PROTOCOL === next.LLMPOD_ADVISOR_PROTOCOL
        && env.LLMPOD_ADVISOR_AUTH === next.LLMPOD_ADVISOR_AUTH);
    const sameProvider = env.LLMPOD_ADVISOR_PRESET === preset && Boolean(env.LLMPOD_ADVISOR_API_KEY) && sameEndpoint;
    const key = apiKeyStdin
      ? await readSecretFromStdin(ctx.stdin, { flag: '--api-key-stdin', what: 'la chiave API del consulente' })
      : await io.askSecret(sameProvider ? 'Chiave API del consulente (invio per mantenere quella attuale):' : 'Chiave API del consulente (input nascosto):', eof('--api-key-stdin (la chiave si legge dallo standard input, mai dalla riga di comando)'));
    if (!key && !sameProvider) {
      throw new LlmpodError(Codes.INVALID_INPUT, 'Chiave API del consulente mancante', {
        hint: env.LLMPOD_ADVISOR_API_KEY ? 'La chiave salvata appartiene a un altro provider o endpoint e non viene riutilizzata: inseriscila di nuovo' : 'Esegui di nuovo: llmpod advisor',
      });
    }
    next.LLMPOD_ADVISOR_API_KEY = key || env.LLMPOD_ADVISOR_API_KEY;
  }
  store.writeEnv(next);
  store.writeConfig({ advisor: { enabled: true, zaiNoticeAcknowledged } });
  ctx.advisor.config(); // valida subito: lancia ADVISOR_NOT_CONFIGURED se manca qualcosa
  io.out(`✓ Consulente configurato: ${p.label}`);
  return preset;
}

export function register(program, getCtx) {
  program.command('advisor')
    .description('Configura il consulente IA che propone e corregge gli argomenti di vLLM')
    .option('--preset <nome>', 'preset da usare senza chiederlo')
    .option('--api-key-stdin', 'legge la chiave API dalla prima riga dello standard input (senza domande; richiede --preset)')
    .option('--accept-zai-notice', 'registra la presa visione dell\'avviso del Coding Plan di Z.ai senza chiederla')
    .option('--model <nome>', 'modello del consulente senza chiederlo')
    .option('--base-url <url>', 'Base URL (preset custom)')
    .option('--protocol <protocollo>', 'protocollo del preset custom: anthropic o openai')
    .option('--auth <schema>', 'autenticazione del preset custom: bearer o x-api-key')
    .addOption(secretArgOption(Option, '--api-key', '--api-key-stdin'))
    .option('--test', 'verifica che il consulente risponda con una proposta valida')
    .option('--disable', 'disattiva il consulente')
    .action(async (opts) => {
      const ctx = getCtx();
      if (opts.disable) {
        const cfg = ctx.store.readConfig();
        ctx.store.writeConfig({ advisor: { ...cfg.advisor, enabled: false } });
        return ctx.io.out('✓ Consulente disattivato');
      }
      if (opts.test) {
        const provider = ctx.advisor.provider();
        if (!provider) throw new LlmpodError(Codes.ADVISOR_NOT_CONFIGURED, 'Nessun consulente attivo per i piani', { hint: 'Esegui: llmpod advisor' });
        const { label } = await testAdvisor(provider);
        return ctx.io.out(`✓ Consulente raggiungibile (${label})`);
      }
      if (opts.protocol && !['anthropic', 'openai'].includes(opts.protocol)) throw new LlmpodError(Codes.INVALID_INPUT, `Protocollo non valido: "${opts.protocol}"`, { hint: 'Valori ammessi: anthropic, openai' });
      if (opts.auth && !['bearer', 'x-api-key'].includes(opts.auth)) throw new LlmpodError(Codes.INVALID_INPUT, `Autenticazione non valida: "${opts.auth}"`, { hint: 'Valori ammessi: bearer, x-api-key' });
      await configureAdvisor(ctx, { preset: opts.preset, model: opts.model, baseUrl: opts.baseUrl, protocol: opts.protocol, auth: opts.auth, apiKeyStdin: opts.apiKeyStdin, acceptZaiNotice: opts.acceptZaiNotice });
    });
}
