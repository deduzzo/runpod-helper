import { createHash } from 'node:crypto';
import { LlmpodError, Codes } from '../core/errors.js';
import { assertProfileName } from '../core/config.js';
import { createEvents } from '../core/events.js';
import { redact } from '../core/secrets.js';
import { searchRows } from '../core/search.js';
import { runPlan, applyAdvice } from '../core/plan-flow.js';
import { testAdvisor } from '../core/advisor/advisor.js';
import { clientExports } from '../core/clients/env-format.js';
import { updateZcode, zcodeDir, isZcodeRunning } from '../core/clients/zcode.js';
import { HttpError, sendJson, readJson } from './http-utils.js';
import { resolveOpenwebuiUrl } from '../core/openwebui-url.js';

const adviceView = (a) => a && { accepted: a.accepted, rejected: a.rejected, changes: a.changes, rationale: a.rationale, warnings: a.warnings, recipePath: a.recipePath };
// Identificativo del piano: lega la proposta del consulente al piano per cui è stata generata.
// Parametro intero con valore predefinito e limiti: fuori intervallo → 400.
function intParam(value, def, min, max, label) {
  if (value === undefined || value === null) return def;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} deve essere un intero tra ${min} e ${max}`);
  return n;
}
const planId = (plan) => createHash('sha256').update(JSON.stringify(plan)).digest('hex');

export function createRoutes({ ctx, jobs, sse, state }) {
  const table = [];
  const add = (method, pattern, fn) => table.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });
  // R17 esteso: finché un job up/down è in corso, il profilo non si può modificare.
  const runningJob = (profile) => jobs.list().find((j) => j.status === 'running' && [`up:${profile}`, `down:${profile}`].includes(j.kind));
  const assertNotBusy = (profile) => {
    const busy = runningJob(profile);
    if (busy) throw new HttpError(409, `Per il profilo "${profile}" c'è già un'operazione in corso (${busy.kind.split(':')[0]})`);
  };
  const json = (fn) => async (c) => sendJson(c.res, 200, await fn(c));

  add('GET', '/api/overview', json(() => {
    const cfg = ctx.store.readConfig();
    const profiles = ctx.store.listProfiles().map((name) => {
      const p = ctx.store.readProfile(name);
      return { name, model: p.model?.id ?? null, gpu: p.gpu ?? null, context: p.context ?? null, hourlyUSD: p.estimate?.hourlyUSD ?? null, advisorApplied: Boolean(p.advisor?.applied) };
    });
    let advisor = { preset: null, enabled: Boolean(cfg.advisor?.enabled) };
    try { advisor = { preset: ctx.advisor.config()?.preset ?? null, enabled: Boolean(cfg.advisor?.enabled) }; } catch { /* configurazione incompleta */ }
    return {
      config: { dataCenterId: cfg.dataCenterId ?? null, cloud: cfg.cloud, volume: cfg.volume ?? null, watchdog: cfg.watchdog, vllmImage: cfg.vllmImage, openwebuiProfile: cfg.openwebuiProfile ?? null },
      profiles, advisor, jobs: jobs.list(),
    };
  }));

  add('GET', '/api/status', json(() => ctx.ops.status()));

  add('GET', '/api/search', json(async ({ url }) => ({
    rows: await searchRows(ctx.hf, url.searchParams.get('q') ?? '', { limit: intParam(url.searchParams.get('limit'), 20, 1, 100, 'limit'), all: url.searchParams.get('all') === '1' }),
  })));

  add('POST', '/api/plan', json(async ({ req }) => {
    const b = await readJson(req);
    const r = await runPlan({ ctx, modelRef: String(b.model ?? ''), context: intParam(b.context, 65536, 1024, 1_048_576, 'context'), concurrency: intParam(b.concurrency, 2, 1, 256, 'concurrency'), set: Array.isArray(b.set) ? b.set.map(String) : [], extra: Array.isArray(b.extra) ? b.extra.map(String) : [], advisor: typeof b.advisor === 'boolean' ? b.advisor : undefined });
    ctx.store.writeJson('last-plan.json', r.plan);
    state.lastAdvice = r.advice && r.advice.accepted.length ? r.advice : null;
    state.lastAdvicePlanId = state.lastAdvice ? planId(r.plan) : null;
    return { plan: r.plan, planId: planId(r.plan), advice: adviceView(r.advice), advisorError: r.advisorError ? redact(String(r.advisorError)) : r.advisorError, advisorSkipped: r.advisorSkipped };
  }));

  add('POST', '/api/plan/apply-advice', json(async ({ req }) => {
    await readJson(req);
    const plan = ctx.store.readJson('last-plan.json', null);
    if (!plan || !state.lastAdvice) throw new HttpError(400, 'Nessuna proposta del consulente da applicare');
    // R3: la proposta vale solo per il piano per cui è stata generata.
    if (planId(plan) !== state.lastAdvicePlanId) throw new HttpError(409, 'Il piano è cambiato: rigenera la proposta');
    applyAdvice(plan, state.lastAdvice);
    ctx.store.writeJson('last-plan.json', plan);
    state.lastAdvice = null;
    state.lastAdvicePlanId = null;
    return { plan, planId: planId(plan) };
  }));

  add('POST', '/api/profiles', json(async ({ req }) => {
    const b = await readJson(req);
    const name = String(b.name ?? '');
    assertNotBusy(name);
    // R11: se il client indica il piano che sta guardando, deve essere ancora quello salvato in last-plan.json.
    if (b.planId !== undefined) {
      if (typeof b.planId !== 'string') throw new HttpError(400, 'planId non valido');
      const current = ctx.store.readJson('last-plan.json', null);
      if (!current || planId(current) !== b.planId) throw new HttpError(409, 'Il piano è cambiato: ricalcolalo prima di salvare');
    }
    return { profile: ctx.ops.saveProfile(name) };
  }));
  add('GET', '/api/profiles/:name', json(({ params }) => ({ profile: ctx.store.readProfile(params.name) })));

  add('POST', '/api/jobs', json(async ({ req }) => {
    const { action, profile } = await readJson(req);
    if (!['up', 'down'].includes(action)) throw new HttpError(400, 'Azione non valida');
    assertProfileName(profile);
    // R17: un solo job attivo per profilo, qualunque sia l'azione.
    assertNotBusy(profile);
    const job = jobs.start(`${action}:${profile}`, async ({ ask, emit }) => {
      const events = createEvents();
      events.on((e) => emit(e));
      const ops = ctx.makeOps({ ask, events });
      if (action === 'down') return ops.down(profile, {});
      const r = await ops.up(profile, {});
      // R7: stessi passi finali di "llmpod up".
      if (r?.contextSuggestion) emit({ type: 'info', message: `La KV cache consente fino a ${r.contextSuggestion} token per richiesta: puoi rigenerare il profilo con un contesto maggiore` });
      if (r?.repairedArgs && await ask('Salvare nel profilo gli argomenti corretti dal consulente?', true)) {
        ops.saveProfileArgs(profile, r.repairedArgs);
        emit({ type: 'info', message: `Profilo ${profile} aggiornato` });
      }
      return r;
    });
    return { job };
  }));
  add('GET', '/api/jobs', json(() => ({ jobs: jobs.list() })));
  add('GET', '/api/jobs/:id', json(({ params, url }) => {
    const job = jobs.get(params.id);
    if (!job) throw new HttpError(404, 'Job non trovato');
    return { job, events: jobs.events(params.id, Number(url.searchParams.get('since')) || 0) };
  }));
  add('POST', '/api/jobs/:id/answer', async ({ req, res, params }) => {
    const b = await readJson(req);
    // R4: le domande sono di conferma (sì/no): la risposta deve essere un booleano.
    if (typeof b.answer !== 'boolean') throw new HttpError(400, 'La risposta deve essere true o false');
    if (!jobs.answer(params.id, String(b.questionId ?? ''), b.answer)) return sendJson(res, 409, { error: { code: 'CONFLICT', message: 'La domanda non è più attiva' } });
    return sendJson(res, 200, { ok: true });
  });

  add('GET', '/api/events', ({ req, res }) => sse.handler(req, res));

  add('POST', '/api/env', json(async ({ req }) => {
    const { profile } = await readJson(req);
    assertProfileName(profile);
    return { env: clientExports(await ctx.ops.endpoint(profile)) };
  }));

  add('POST', '/api/clients/zcode', json(async ({ req }) => {
    const { profile, zcodeClosed } = await readJson(req);
    assertProfileName(profile);
    if (zcodeClosed !== true) throw new HttpError(400, 'Conferma che ZCode è chiuso: lo riscrive all\'uscita e le modifiche andrebbero perse');
    // R18: fuori da Docker si controlla davvero se ZCode è in esecuzione, come nella CLI.
    const inDocker = Boolean(ctx.env?.LLMPOD_IN_DOCKER);
    const isRunning = inDocker ? async () => false : (ctx.isZcodeRunning ?? (() => isZcodeRunning()));
    const file = await updateZcode(await ctx.ops.endpoint(profile), { dir: zcodeDir(ctx.env), isRunning });
    return { file };
  }));

  add('POST', '/api/advisor/test', json(async ({ req }) => {
    await readJson(req);
    const provider = ctx.advisor.provider();
    if (!provider) throw new LlmpodError(Codes.ADVISOR_NOT_CONFIGURED, 'Nessun consulente attivo', { hint: 'Configuralo con: llmpod advisor' });
    return testAdvisor(provider);
  }));

  add('GET', '/api/openwebui', json(() => ({ url: resolveOpenwebuiUrl(ctx.env), profile: ctx.store.readConfig().openwebuiProfile ?? null, proxy: state.proxy ?? null })));
  add('POST', '/api/openwebui/profile', json(async ({ req }) => {
    const { profile } = await readJson(req);
    assertProfileName(profile);
    assertNotBusy(profile);
    ctx.store.writeConfig({ openwebuiProfile: profile });
    return { ok: true };
  }));

  return (method, pathname) => {
    for (const r of table) {
      const m = r.method === method && pathname.match(r.re);
      if (m) {
        const handler = (c) => r.fn({ ...c, params: m.groups ?? {} });
        handler.params = m.groups ?? {};
        return handler;
      }
    }
    return null;
  };
}
