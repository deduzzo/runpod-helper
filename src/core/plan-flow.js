import { LlmpodError, Codes } from './errors.js';
import { makePlan, syncDerivedFields } from './planner/plan.js';
import { loadFlags } from './planner/vllm-args.js';
import { advisePlan } from './advisor/advisor.js';
import { applyGpuChoice, parseGpuSpec } from './planner/gpu-choice.js';
import { makeFitsWith } from './advisor/advice.js';
import { createRecipes } from './advisor/recipes.js';

// advisor: true = forza il consulente, false = salta, undefined = regola unica di attivazione (ctx.advisor.active()).
export async function runPlan({ ctx, modelRef, context = 65536, concurrency = 2, set = [], extra = [], image, allowTrustRemoteCode = false, advisor, gpu, onProgress = () => {} }) {
  const cfg = ctx.store.readConfig();
  if (!cfg.dataCenterId) throw new LlmpodError(Codes.INVALID_INPUT, 'Nessun datacenter configurato', { hint: 'Esegui: llmpod init' });
  const flags = loadFlags();
  const plan = await makePlan({
    hf: ctx.hf, runpod: ctx.runpod, modelRef, context, concurrency, cloud: cfg.cloud, dataCenterId: cfg.dataCenterId,
    minCudaVersion: cfg.minCudaVersion, vllmImage: image ?? cfg.vllmImage, set, extra, flags, allowTrustRemoteCode, onProgress,
  });
  // Scelta esplicita della GPU ('<id>[x<n>]' o { id, count }): prima del consulente, che ragiona sul numero di GPU scelto.
  if (gpu) applyGpuChoice(plan, typeof gpu === 'string' ? parseGpuSpec(gpu) : gpu);
  plan.advisor = null;
  let advice = null;
  let advisorError = null;
  let advisorSkipped = null;
  if (advisor === true || (advisor !== false && ctx.advisor.active())) {
    try {
      const provider = ctx.advisor.provider(undefined, { force: advisor === true });
      if (!provider) {
        advisorSkipped = 'Consulente non configurato o disponibile solo per le correzioni dopo up';
      } else {
        onProgress(`Consulto ${provider.label}`);
        advice = await advisePlan({ provider, plan, hf: ctx.hf, recipes: createRecipes({ http: ctx.http }), flags, fitsWith: makeFitsWith(plan), allowTrustRemoteCode });
        plan.advisor = { preset: ctx.advisor.config()?.preset ?? null, applied: false, rationale: advice.rationale, notes: advice.warnings, recipePath: advice.recipePath, rejected: advice.rejected, proposed: advice.changes };
      }
    } catch (err) {
      if (err.code === Codes.CANCELLED) throw err;
      advisorError = err.message;
    }
  }
  return { plan, advice, advisorError, advisorSkipped };
}

export function applyAdvice(plan, advice) {
  plan.vllm.args = advice.args;
  syncDerivedFields(plan);
  if (plan.advisor) plan.advisor.applied = true;
  return plan;
}
