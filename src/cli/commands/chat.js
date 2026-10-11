import { LlmpodError, Codes } from '../../core/errors.js';
import { openBrowser } from '../open-browser.js';

const DEFAULT_URL = 'http://127.0.0.1:3000';

export function register(program, getCtx) {
  program.command('chat')
    .description('Apre Open WebUI (collegato al Pod tramite il proxy di llmpod ui) per una prova veloce')
    .option('--no-open', 'stampa solo l\'indirizzo senza aprire il browser')
    .action(async (opts) => {
      const ctx = getCtx();
      const raw = ctx.env.LLMPOD_OPENWEBUI_URL || DEFAULT_URL;
      let url;
      try {
        url = new URL(raw);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocollo');
      } catch {
        // Il valore non viene riportato: potrebbe contenere credenziali.
        throw new LlmpodError(Codes.INVALID_INPUT, 'LLMPOD_OPENWEBUI_URL non valido', { hint: 'Usa un indirizzo http(s), ad esempio http://127.0.0.1:3000' });
      }
      // Mai credenziali nell'indirizzo richiesto, stampato o aperto nel browser.
      url.username = '';
      url.password = '';
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
