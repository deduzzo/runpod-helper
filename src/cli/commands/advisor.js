import { LlmpodError, Codes } from '../../core/errors.js';
import { PRESETS, ZAI_NOTICE, CLAUDE_CLI_IN_DOCKER, availablePresets } from '../../core/advisor/presets.js';
import { testAdvisor } from '../../core/advisor/advisor.js';
import { table } from '../render.js';

const FIELDS = ['LLMPOD_ADVISOR_PRESET', 'LLMPOD_ADVISOR_API_KEY', 'LLMPOD_ADVISOR_MODEL', 'LLMPOD_ADVISOR_BASE_URL', 'LLMPOD_ADVISOR_PROTOCOL', 'LLMPOD_ADVISOR_AUTH'];

export async function configureAdvisor(ctx, { preset: chosen } = {}) {
  const { io, store } = ctx;
  const env = store.readEnv();
  const offered = availablePresets(ctx.env);
  io.out(table(Object.entries(offered).map(([id, p]) => ({ id, label: p.label })), [{ key: 'id', label: 'Preset' }, { key: 'label', label: 'Descrizione' }]));
  const preset = chosen ?? await io.askText('Preset del consulente:', offered[env.LLMPOD_ADVISOR_PRESET] ? env.LLMPOD_ADVISOR_PRESET : 'zai-coding-plan');
  const p = PRESETS[preset];
  if (!p) throw new LlmpodError(Codes.INVALID_INPUT, `Preset sconosciuto: "${preset}"`, { hint: `Preset: ${Object.keys(offered).join(', ')}` });
  if (!offered[preset]) throw new LlmpodError(Codes.INVALID_INPUT, CLAUDE_CLI_IN_DOCKER);

  const cfg = store.readConfig();
  let zaiNoticeAcknowledged = Boolean(cfg.advisor?.zaiNoticeAcknowledged);
  if (preset === 'zai-coding-plan' && !zaiNoticeAcknowledged) {
    io.out(`⚠ ${ZAI_NOTICE}`);
    if (!(await io.ask('Confermi di voler usare il Coding Plan come consulente?', false))) throw new LlmpodError(Codes.CANCELLED, 'Configurazione del consulente annullata');
    zaiNoticeAcknowledged = true;
  }

  const next = Object.fromEntries(FIELDS.map((f) => [f, undefined]));
  next.LLMPOD_ADVISOR_PRESET = preset;
  if (preset === 'custom') {
    next.LLMPOD_ADVISOR_PROTOCOL = await io.askText('Protocollo (anthropic o openai):', env.LLMPOD_ADVISOR_PROTOCOL ?? 'openai');
    next.LLMPOD_ADVISOR_BASE_URL = await io.askText('Base URL (https://…; con protocollo openai includi /v1 (es. https://host/v1); con anthropic no (es. https://host)):', env.LLMPOD_ADVISOR_BASE_URL);
    next.LLMPOD_ADVISOR_MODEL = await io.askText('Modello:', env.LLMPOD_ADVISOR_MODEL);
    next.LLMPOD_ADVISOR_AUTH = await io.askText('Autenticazione (bearer o x-api-key):', env.LLMPOD_ADVISOR_AUTH ?? 'bearer');
  } else if (!['claude-cli', 'pod'].includes(preset)) {
    const model = await io.askText(`Modello${p.model ? ` (invio per ${p.model})` : ''}:`, '');
    if (model) next.LLMPOD_ADVISOR_MODEL = model;
  }
  if (!['claude-cli', 'pod'].includes(preset)) {
    // La chiave salvata si può mantenere solo verso lo stesso provider; per "custom" contano anche URL, protocollo e autenticazione
    // (altrimenti la chiave finirebbe a un host diverso da quello per cui è stata inserita).
    const normUrl = (u) => (u ?? '').replace(/\/+$/, '');
    const sameEndpoint = preset !== 'custom'
      || (normUrl(env.LLMPOD_ADVISOR_BASE_URL) === normUrl(next.LLMPOD_ADVISOR_BASE_URL)
        && env.LLMPOD_ADVISOR_PROTOCOL === next.LLMPOD_ADVISOR_PROTOCOL
        && env.LLMPOD_ADVISOR_AUTH === next.LLMPOD_ADVISOR_AUTH);
    const sameProvider = env.LLMPOD_ADVISOR_PRESET === preset && Boolean(env.LLMPOD_ADVISOR_API_KEY) && sameEndpoint;
    const key = await io.askSecret(sameProvider ? 'Chiave API del consulente (invio per mantenere quella attuale):' : 'Chiave API del consulente (input nascosto):');
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
      await configureAdvisor(ctx, { preset: opts.preset });
    });
}
