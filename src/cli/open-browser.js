// Apre l'URL nel browser predefinito. Restituisce false se non è stato possibile (l'URL va comunque stampato).
export function openBrowser(url, { platform = process.platform, spawn }) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  // cmd interpreta questi caratteri: meglio non aprire che rischiare di eseguire altro.
  if (platform === 'win32' && /[&^|<>"%]/.test(parsed.href)) return false;
  const [cmd, args] = platform === 'darwin' ? ['open', [parsed.href]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', parsed.href]] : ['xdg-open', [parsed.href]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on?.('error', () => {}); // browser non disponibile: nessun crash
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
