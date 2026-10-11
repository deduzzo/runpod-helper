import { LlmpodError, Codes } from './errors.js';
import { redact } from './secrets.js';

const IDEMPOTENT = new Set(['GET', 'HEAD', 'DELETE']);
const backoff = (attempt) => Math.min(1000 * 2 ** attempt, 8000);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createHttp({ fetch = globalThis.fetch, userAgent, timeoutMs = 30000, maxRetries = 3, sleep = defaultSleep } = {}) {
  async function request(method, url, { headers = {}, json, body, query, timeoutMs: t = timeoutMs, retry = true } = {}) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)));
      else u.searchParams.set(k, String(v));
    }
    const h = { 'user-agent': userAgent, accept: 'application/json', ...headers };
    let payload = body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const canRetryServer = retry && IDEMPOTENT.has(method);

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(u, { method, headers: h, body: payload, signal: AbortSignal.timeout(t) });
      } catch (err) {
        if (canRetryServer && attempt < maxRetries) { await sleep(backoff(attempt)); continue; }
        throw new LlmpodError(Codes.NETWORK, redact(`Errore di rete verso ${u.host}: ${err.message}`), { cause: new Error(redact(err.message)) });
      }
      const retryable = res.status === 429 ? retry : canRetryServer && res.status >= 500;
      if (retryable && attempt < maxRetries) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
        continue;
      }
      const text = await res.text();
      let data = text;
      try { data = text ? JSON.parse(text) : null; } catch { /* testo non JSON */ }
      return { status: res.status, ok: res.ok, headers: res.headers, data };
    }
  }
  return { request };
}

export function httpError(res, what) {
  const d = res.data;
  const detail = typeof d === 'string' ? d.slice(0, 300) : d?.detail ?? d?.title ?? d?.error ?? d?.message ?? '';
  return new LlmpodError(Codes.HTTP, redact(`${what}: HTTP ${res.status} ${detail}`.trim()), { details: { status: res.status } });
}
