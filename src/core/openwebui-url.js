import { LlmpodError, Codes } from './errors.js';

export const DEFAULT_OPENWEBUI_URL = 'http://127.0.0.1:3000';
const HOST_RE = /^([A-Za-z0-9.-]+|\[[0-9a-fA-F:.]+\])$/;
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
  // Il nome host finisce nella CSP (frame-src): il parser URL ammette ";", "," e "'" che ne altererebbero le direttive.
  if (!HOST_RE.test(url.hostname)) {
    throw new LlmpodError(Codes.INVALID_INPUT, 'LLMPOD_OPENWEBUI_URL non valido', { hint: 'Il nome host può contenere solo lettere, cifre, "." e "-" (oppure un indirizzo IPv6 tra parentesi quadre)' });
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

// R27: il cookie di sessione llmpod_session è legato all'host, non alla porta. Se l'interfaccia è aperta su un nome di host
// loopback e Open WebUI usa lo stesso nome, il browser invierebbe il cookie anche a Open WebUI: si usa l'altro nome
// (127.0.0.1 <-> localhost), stessa porta. Indirizzi non loopback restano invariati. Funzione pura: usata da web e CLI.
export function embedUrl(url, pageHostname) {
  if (!url) return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  if (!LOOPBACK.has(u.hostname) || u.hostname !== pageHostname) return url;
  u.hostname = [...LOOPBACK].find((h) => h !== u.hostname);
  return u.pathname === '/' && !u.search && !u.hash ? u.origin : u.href;
}
