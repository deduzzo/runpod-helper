// Metriche Prometheus di vLLM (/metrics, non autenticato): lettura, istantanea e tassi su una finestra di due letture.
const LINE = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/;
const LABEL = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

export function parsePrometheus(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(LINE);
    if (!m) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    for (const l of (m[2] ?? '').matchAll(LABEL)) labels[l[1]] = l[2].replace(/\\(.)/g, '$1');
    out.push({ name: m[1], labels, value });
  }
  return out;
}

// Somma dei campioni con quel nome (più motori o etichette) che soddisfano `filter`; null se non ce n'è nessuno.
function total(samples, name, filter = () => true) {
  const found = samples.filter((s) => s.name === name && filter(s.labels));
  return found.length ? found.reduce((sum, s) => sum + s.value, 0) : null;
}

export function snapshotMetrics(text) {
  const s = parsePrometheus(text);
  const n = (name, filter) => total(s, name, filter) ?? 0;
  const drafts = total(s, 'vllm:spec_decode_num_drafts_total');
  const perPos = [];
  for (const x of s.filter((v) => v.name === 'vllm:spec_decode_num_accepted_tokens_per_pos_total')) {
    const i = Number(x.labels.position);
    if (Number.isInteger(i) && i >= 0 && i < 64) perPos[i] = (perPos[i] ?? 0) + x.value;
  }
  return {
    promptTokens: n('vllm:prompt_tokens_total'),
    generationTokens: n('vllm:generation_tokens_total'),
    running: n('vllm:num_requests_running'),
    waiting: n('vllm:num_requests_waiting'),
    // V1: kv_cache_usage_perc; versioni precedenti: gpu_cache_usage_perc (frazione 0..1)
    kvUsage: total(s, 'vllm:kv_cache_usage_perc') ?? total(s, 'vllm:gpu_cache_usage_perc'),
    preemptions: n('vllm:num_preemptions_total'),
    completed: n('vllm:request_success_total'),
    aborted: n('vllm:request_success_total', (l) => l.finished_reason === 'abort' || l.finished_reason === 'error'),
    http4xx: n('http_requests_total', (l) => /^4/.test(l.status ?? '')),
    http5xx: n('http_requests_total', (l) => /^5/.test(l.status ?? '')),
    spec: drafts == null ? null : {
      drafts,
      draftTokens: n('vllm:spec_decode_num_draft_tokens_total'),
      acceptedTokens: n('vllm:spec_decode_num_accepted_tokens_total'),
      perPosition: Array.from(perPos, (v) => v ?? 0),
    },
  };
}

const round = (x, digits = 1) => Math.round(x * 10 ** digits) / 10 ** digits;
// Differenza di un contatore: se vLLM è stato ricaricato tra le letture il contatore riparte da zero (mai negativo).
const delta = (a, b) => Math.max(0, b - a);

// Accettazione della decodifica speculativa (MTP o altri metodi): percentuale dei token proposti accettati,
// lunghezza media accettata per passo (1 + accettati/bozze, come la riporta vLLM) e accettazione per posizione.
function acceptance({ drafts, draftTokens, acceptedTokens, perPosition }) {
  if (!(drafts > 0)) return null;
  return {
    drafts,
    acceptanceRatePct: draftTokens > 0 ? round((acceptedTokens / draftTokens) * 100) : null,
    meanAcceptedLength: round(1 + acceptedTokens / drafts, 2),
    perPositionPct: perPosition.map((v) => round((v / drafts) * 100)),
  };
}

export function summarizeMetrics(a, b, windowSeconds) {
  const rate = (k) => round(delta(a[k], b[k]) / windowSeconds);
  let speculative = null;
  if (b.spec) {
    const before = a.spec ?? { drafts: 0, draftTokens: 0, acceptedTokens: 0, perPosition: [] };
    const reset = b.spec.drafts < before.drafts;
    const base = reset ? { drafts: 0, draftTokens: 0, acceptedTokens: 0, perPosition: [] } : before;
    speculative = {
      total: acceptance(b.spec),
      window: acceptance({
        drafts: b.spec.drafts - base.drafts,
        draftTokens: b.spec.draftTokens - base.draftTokens,
        acceptedTokens: b.spec.acceptedTokens - base.acceptedTokens,
        perPosition: b.spec.perPosition.map((v, i) => v - (base.perPosition[i] ?? 0)),
      }),
    };
  }
  return {
    windowSeconds,
    throughput: { generationTokensPerSec: rate('generationTokens'), promptTokensPerSec: rate('promptTokens') },
    requests: { running: b.running, waiting: b.waiting, completedInWindow: delta(a.completed, b.completed) },
    kvCacheUsagePct: b.kvUsage == null ? null : round(b.kvUsage * 100),
    speculative,
    errors: { aborted: b.aborted, preemptions: b.preemptions, http4xx: b.http4xx, http5xx: b.http5xx, http5xxInWindow: delta(a.http5xx, b.http5xx) },
  };
}
