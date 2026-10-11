import { Readable } from 'node:stream';
import { redact } from '../core/secrets.js';
import { safeEqual } from './http-utils.js';

const MAX_BODY = 10 * 1024 * 1024;
const NEGATIVE_TTL_MS = 10_000;

function fail(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', ...(status === 413 ? { connection: 'close' } : {}) });
  res.end(JSON.stringify({ error: { message, type: 'llmpod_proxy' } }));
}

class TooLargeError extends Error {
  constructor() { super('Richiesta troppo grande (massimo 10 MB)'); }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // Niente destroy: la risposta 413 deve arrivare al client. Il resto del corpo viene scartato.
        if (!tooBig) { tooBig = true; chunks.length = 0; reject(new TooLargeError()); }
        return;
      }
      if (!tooBig) chunks.push(c);
    });
    req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

export function createOpenwebuiProxy({ resolveTarget, internalKey, userAgent, fetchImpl = fetch }) {
  if (typeof internalKey !== 'string' || internalKey.length < 16) {
    throw new Error('internalKey del proxy Open WebUI mancante o troppo corta (minimo 16 caratteri)');
  }
  return async (req, res) => {
    // Registrato subito: se il client chiude mentre si risolve il Pod o si legge il corpo, l'upstream non parte/si annulla.
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let phase = 'pod';
    try {
      const url = new URL(req.url, 'http://proxy');
      if (!url.pathname.startsWith('/v1/')) return fail(res, 404, 'Percorso non supportato dal proxy di llmpod');
      if (!safeEqual(req.headers.authorization, `Bearer ${internalKey}`)) return fail(res, 401, 'Chiave del proxy non valida');
      const target = await resolveTarget();
      if (!target) return fail(res, 503, 'Nessun Pod attivo: avvia un profilo con "llmpod up" e scegli il profilo per Open WebUI');
      phase = 'body';
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      if (ac.signal.aborted) return undefined;
      phase = 'network';
      const upstream = await fetchImpl(`${target.baseUrl}${url.pathname}${url.search}`, {
        method: req.method,
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${target.apiKey}`,
          'content-type': req.headers['content-type'] ?? 'application/json',
          accept: req.headers.accept ?? '*/*',
          'user-agent': userAgent,
        },
        body,
        signal: ac.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        upstream.body?.cancel().catch(() => {});
        resolveTarget.invalidate?.();
        return fail(res, 502, `Pod non raggiungibile: risposta con reindirizzamento (HTTP ${upstream.status}) non seguita`);
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
      return undefined;
    } catch (err) {
      if (err instanceof TooLargeError) return fail(res, 413, err.message);
      if (err.code === 'MULTIPLE_PODS') return fail(res, 503, err.message);
      if (phase === 'pod') return fail(res, 502, `Impossibile determinare il Pod: ${redact(err.message)}`);
      if (phase === 'body') return fail(res, 400, `Lettura della richiesta fallita: ${redact(err.message)}`);
      resolveTarget.invalidate?.();
      const code = err.cause?.code ? ` (${err.cause.code})` : '';
      return fail(res, 502, `Pod non raggiungibile: ${redact(err.message)}${redact(code)}`);
    }
  };
}

export function createTargetResolver({ store, getOps, ttlMs = 30_000 }) {
  let cache = null;
  const resolve = async () => {
    const cfg = store.readConfig();
    const active = Object.keys(store.readState().pods ?? {});
    if (!cfg.openwebuiProfile && active.length > 1) {
      throw Object.assign(new Error('Più Pod attivi: scegli il profilo per Open WebUI nella pagina Prova veloce'), { code: 'MULTIPLE_PODS' });
    }
    const profile = cfg.openwebuiProfile ?? (active.length === 1 ? active[0] : null);
    if (!profile) return null;
    if (cache && cache.profile === profile && Date.now() - cache.at < (cache.target ? ttlMs : NEGATIVE_TTL_MS)) return cache.target;
    try {
      const ep = await getOps().endpoint(profile);
      cache = { profile, at: Date.now(), target: { baseUrl: ep.baseUrl, apiKey: ep.apiKey } };
      return cache.target;
    } catch (err) {
      if (err.code === 'NOT_FOUND') { cache = { profile, at: Date.now(), target: null }; return null; }
      throw err;
    }
  };
  resolve.invalidate = () => { cache = null; };
  return resolve;
}
