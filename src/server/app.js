import { LlmpodError } from '../core/errors.js';
import { redact } from '../core/secrets.js';
import { HttpError, SECURITY_HEADERS, sendJson, parseCookies, safeEqual, serveStatic } from './http-utils.js';

export { HttpError };
const COOKIE = 'llmpod_session';

export function createApp({ ctx, token, port, staticDir, jobs, version, routes = () => null }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  async function handle(req, res) {
    const host = req.headers.host ?? '';
    if (!allowedHosts.has(host)) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Host non consentito' } });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Origine non consentita' } });
    const url = new URL(req.url, `http://${host}`);

    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
      if (!safeEqual(url.searchParams.get('t'), token)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
        return res.end('Link non valido: riapri l\'indirizzo stampato da llmpod ui');
      }
      res.writeHead(302, { 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`, location: '/', ...SECURITY_HEADERS });
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

  return (req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader('connection', 'close');
        return sendJson(res, err.status, { error: { code: 'HTTP', message: err.message } });
      }
      if (err instanceof LlmpodError) return sendJson(res, 400, { error: { code: err.code, message: redact(err.message), hint: err.hint ? redact(err.hint) : undefined } });
      console.error(`[llmpod ui] errore interno: ${redact(err?.stack ?? err)}`);
      return sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Errore interno' } });
    });
  };
}
