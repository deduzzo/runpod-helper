import { LlmpodError, Codes } from '../core/errors.js';

export const DEFAULT_OPENWEBUI_URL = 'http://127.0.0.1:3000';
const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

// Indirizzo di Open WebUI: LLMPOD_OPENWEBUI_URL (come per "llmpod chat") oppure quello predefinito.
// Mai credenziali nell'indirizzo; il valore non compare nel messaggio d'errore (potrebbe contenerle).
export function resolveOpenwebuiUrl(env = {}) {
  const raw = env?.LLMPOD_OPENWEBUI_URL || DEFAULT_OPENWEBUI_URL;
  let url;
  try {
    url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocollo');
  } catch {
    throw new LlmpodError(Codes.INVALID_INPUT, 'LLMPOD_OPENWEBUI_URL non valido', { hint: 'Usa un indirizzo http(s), ad esempio http://127.0.0.1:3000' });
  }
  url.username = '';
  url.password = '';
  return url.pathname === '/' && !url.search && !url.hash ? url.origin : url.href;
}

// Origini da ammettere in frame-src. R27: se Open WebUI è in locale, la pagina Prova veloce può usare l'altro nome
// di host loopback (localhost <-> 127.0.0.1) per non inviargli il cookie di sessione: si ammettono entrambi.
export function frameSources(urlString) {
  const url = new URL(urlString);
  if (!LOOPBACK.has(url.hostname)) return [url.origin];
  return [...LOOPBACK].map((host) => `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`);
}
