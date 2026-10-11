import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DEFAULT_FRAME_SOURCES = ['http://127.0.0.1:3000', 'http://localhost:3000'];
// Difesa in profondità: ogni origine va in una direttiva CSP, quindi solo schema://host[:porta] con caratteri sicuri.
const ORIGIN_RE = /^https?:\/\/([A-Za-z0-9.-]+|\[[0-9a-fA-F:.]+\])(:\d{1,5})?$/;
const buildCsp = (frameSources) => `default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src ${frameSources.join(' ')}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;

export const SECURITY_HEADERS = {
  'content-security-policy': buildCsp(DEFAULT_FRAME_SOURCES),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

// Imposta le origini consentite per l'iframe di Open WebUI (porta/host di LLMPOD_OPENWEBUI_URL). Un solo server per
// processo: l'oggetto è condiviso e viene letto a ogni risposta. Senza argomenti ripristina i valori predefiniti.
export function setFrameSources(origins = DEFAULT_FRAME_SOURCES) {
  for (const o of origins) if (!ORIGIN_RE.test(o)) throw new Error('Origine non valida per la CSP (frame-src)');
  SECURITY_HEADERS['content-security-policy'] = buildCsp(origins);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

export const JSON_CT = /^application\/json(\s*;|$)/i;

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(body);
}

export function readJson(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    if (!JSON_CT.test(req.headers['content-type'] ?? '')) return reject(new HttpError(415, 'Content-Type deve essere application/json'));
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        // Niente destroy qui: la risposta 413 deve poter arrivare al client. Si scarta il resto del corpo.
        if (!tooBig) { tooBig = true; chunks.length = 0; reject(new HttpError(413, 'Richiesta troppo grande')); }
        return;
      }
      if (!tooBig) chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      let data;
      try { data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { reject(new HttpError(400, 'JSON non valido')); return; }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) { reject(new HttpError(400, 'Il corpo deve essere un oggetto JSON')); return; }
      resolve(data);
    });
    req.on('error', reject);
  });
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    if (i < 0) return [p, ''];
    const raw = p.slice(i + 1);
    let value;
    try { value = decodeURIComponent(raw); } catch { return null; } // cookie malformato = assente
    return [p.slice(0, i), value];
  }).filter(Boolean));
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function serveStatic(req, res, rootDir) {
  if (!['GET', 'HEAD'].includes(req.method) || !rootDir) return false;
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return false; }
  const root = path.resolve(rootDir);
  let file = path.resolve(root, `.${rel}`);
  if (file !== root && !file.startsWith(root + path.sep)) return false;
  if (!path.extname(file) || (fs.existsSync(file) && fs.statSync(file).isDirectory())) file = path.join(root, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const headers = { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return true;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', (err) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end(err.code === 'ENOENT' ? 'Non trovato' : 'Errore di lettura del file');
  });
  stream.on('open', () => {
    res.writeHead(200, headers);
    stream.pipe(res);
  });
  res.on('close', () => stream.destroy());
  return true;
}
