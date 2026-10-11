import { LlmpodError, Codes } from '../../core/errors.js';
import { resolveOpenwebuiUrl } from '../../core/openwebui-url.js';
import { openBrowser } from '../open-browser.js';

export function register(program, getCtx) {
  program.command('chat')
    .description('Apre Open WebUI (collegato al Pod tramite il proxy di llmpod ui) per una prova veloce')
    .option('--no-open', 'stampa solo l\'indirizzo senza aprire il browser')
    .action(async (opts) => {
      const ctx = getCtx();
      // Stessa validazione dell'interfaccia web: credenziali rimosse, valore mai riportato negli errori.
      const url = new URL(resolveOpenwebuiUrl(ctx.env));
      const notRunning = new LlmpodError(Codes.NETWORK, `Open WebUI non risponde su ${url.origin}`, {
        hint: 'Avvia Open WebUI con scripts/start.sh (Docker) oppure usa la pagina Prova veloce di llmpod ui',
      });
      let res;
      try {
        res = await ctx.http.request('GET', url.href, { retry: false, timeoutMs: 3000 });
      } catch {
        throw notRunning;
      }
      if (res.status >= 500) throw notRunning;
      ctx.io.out(`Open WebUI: ${url.href}`);
      if (opts.open) openBrowser(url.href, { platform: ctx.platform, spawn: ctx.spawn });
    });
}
