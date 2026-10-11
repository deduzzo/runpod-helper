import { LlmpodError } from '../core/errors.js';
import { redact } from '../core/secrets.js';
import { HttpError, JSON_CT, SECURITY_HEADERS, sendJson, parseCookies, safeEqual, serveStatic } from './http-utils.js';

export { HttpError };
const COOKIE = 'llmpod_session';

export function createApp({ ctx, token, port, staticDir, jobs, version, routes = () => null, isClosing = () => false }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  async function handle(req, res) {
    const host = req.headers.host ?? '';
    if (!allowedHosts.has(host)) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Host non consentito' } });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Origine non consentita' } });
    const url = new URL(req.url, `http://${host}`);

    // Richieste che modificano stato: controlli centralizzati (CSRF / content-type).
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) {
      // Spegnimento in corso: nessuna nuova operazione (altrimenti partirebbero job che nessuno potrebbe più chiudere).
      if (isClosing()) return sendJson(res, 503, { error: { code: 'UNAVAILABLE', message: 'llmpod ui si sta chiudendo' } });
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Richiesta cross-site non consentita' } });
      if (site === undefined && req.headers.origin === undefined) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Origine mancante' } });
      if (!JSON_CT.test(req.headers['content-type'] ?? '')) return sendJson(res, 415, { error: { code: 'HTTP', message: 'Content-Type deve essere application/json' } });
    }

    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
      if (!safeEqual(url.searchParams.get('t'), token)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
        return res.end('Link non valido: riapri l\'indirizzo stampato da llmpod ui');
      }
      res.writeHead(302, { 'set-cookie': `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`, location: '/', ...SECURITY_HEADERS });
      return res.end();
    }

    if (url.pathname.startsWith('/api/')) {
      if (!safeEqual(parseCookies(req.headers.cookie)[COOKIE], token)) {
        return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Sessione non valida: apri il link stampato da llmpod ui' } });
      }
      if (req.method === 'GET' && url.pathname === '/api/session') return sendJson(res, 200, { ok: true, version });
      const handler = routes(req.method, url.pathname);
      if (!handler) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Percorso API sconosciuto' } });
      return handler({ req, res, url, ctx, jobs, params: handler.params ?? {} });
    }

    if (serveStatic(req, res, staticDir)) return undefined;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Non trovato');
  }

  function onError(req, res, err) {
    if (res.headersSent) {
      console.error(`[llmpod ui] errore a risposta iniziata: ${redact(String(err?.stack ?? err))}`);
      res.destroy();
      return;
    }
    if (err instanceof HttpError) {
      if (err.status === 413) res.setHeader('connection', 'close');
      sendJson(res, err.status, { error: { code: 'HTTP', message: err.message } });
      return;
    }
    if (err instanceof LlmpodError) {
      sendJson(res, 400, { error: { code: err.code, message: redact(err.message), hint: err.hint ? redact(err.hint) : undefined } });
      return;
    }
    console.error(`[llmpod ui] errore interno: ${redact(String(err?.stack ?? err))}`);
    sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Errore interno' } });
  }

  return (req, res) => {
    handle(req, res)
      .catch((err) => onError(req, res, err))
      .catch(() => res.destroy());
  };
}
