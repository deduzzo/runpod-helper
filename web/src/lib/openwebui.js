const LOOPBACK = ['127.0.0.1', 'localhost'];

// R27: il cookie di sessione llmpod_session è legato all'host, non alla porta. Se l'interfaccia è aperta su un nome di host
// loopback e Open WebUI usa lo stesso nome, il browser invierebbe il cookie anche a Open WebUI: si usa l'altro nome
// (127.0.0.1 <-> localhost), stessa porta. Indirizzi non loopback restano invariati.
export function embedUrl(url, pageHostname) {
  if (!url) return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  if (!LOOPBACK.includes(u.hostname) || u.hostname !== pageHostname) return url;
  u.hostname = LOOPBACK.find((h) => h !== u.hostname);
  return u.pathname === '/' && !u.search && !u.hash ? u.origin : u.href;
}
