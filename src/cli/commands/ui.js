import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { LlmpodError, Codes } from '../../core/errors.js';
import { registerSecret } from '../../core/secrets.js';
import { startUi, assertUiToken } from '../../server/start.js';
import { VERSION } from '../context.js';
import { openBrowser } from '../open-browser.js';

const STATIC_DIR = fileURLToPath(new URL('../../../dist/web', import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
// Variabile d'ambiente vuota = assente.
const envValue = (v) => (v === undefined || v === '' ? undefined : v);

function parsePort(value, label) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new LlmpodError(Codes.INVALID_INPUT, `${label} non valida: "${value}"`, { hint: 'Usa un numero tra 0 e 65535' });
  return n;
}

export function register(program, getCtx) {
  program.command('ui')
    .description('Avvia l\'interfaccia web locale e il proxy per Open WebUI')
    .option('--host <host>', 'indirizzo di ascolto (predefinito: LLMPOD_UI_HOST o 127.0.0.1)')
    .option('--port <porta>', 'porta dell\'interfaccia (predefinita: LLMPOD_UI_PORT o 7860)')
    .option('--proxy-host <host>', 'indirizzo di ascolto del proxy (predefinito: LLMPOD_PROXY_HOST, altrimenti come --host; 127.0.0.1 se --host è localhost o IPv6)')
    .option('--proxy-port <porta>', 'porta del proxy per Open WebUI (predefinita: LLMPOD_PROXY_PORT o 8081)')
    .option('--no-proxy', 'non avviare il proxy per Open WebUI')
    .option('--no-open', 'non aprire il browser')
    .action(async (opts) => {
      const ctx = getCtx();
      const { env, io } = ctx;
      const host = opts.host ?? envValue(env.LLMPOD_UI_HOST) ?? '127.0.0.1';
      const port = parsePort(opts.port ?? envValue(env.LLMPOD_UI_PORT) ?? 7860, 'Porta');
      const proxyPort = parsePort(opts.proxyPort ?? envValue(env.LLMPOD_PROXY_PORT) ?? 8081, 'Porta del proxy');
      // Con host localhost/IPv6 il proxy resta su 127.0.0.1 (non eredita), salvo scelta esplicita.
      const proxyHost = opts.proxyHost ?? envValue(env.LLMPOD_PROXY_HOST) ?? (host === 'localhost' || host.includes(':') ? '127.0.0.1' : host);

      let token = envValue(env.LLMPOD_UI_TOKEN);
      if (token === undefined) token = randomBytes(24).toString('hex');
      else assertUiToken(token, { source: 'LLMPOD_UI_TOKEN' });
      registerSecret(token);

      // Il controllo Host dell'interfaccia accetta solo 127.0.0.1/localhost: un indirizzo diverso non la rende usabile da altri host.
      if (!LOOPBACK.has(host)) {
        io.err(env.LLMPOD_IN_DOCKER === '1'
          ? `⚠ Ascolto su ${host} dentro Docker: pubblica la porta solo su 127.0.0.1 (ad esempio -p 127.0.0.1:${port}:${port}), altrimenti il proxy è raggiungibile dalla rete`
          : `⚠ Ascolto su ${host}: il controllo Host accetta solo 127.0.0.1 e localhost, quindi l'interfaccia non è utilizzabile da altri computer della rete (usa 127.0.0.1)`);
      }
      if (opts.proxy && !LOOPBACK.has(proxyHost) && env.LLMPOD_IN_DOCKER !== '1') {
        io.err(`⚠ Ascolto su ${proxyHost} (proxy per Open WebUI): è raggiungibile da altri computer della rete e la chiave interna è l'unica protezione. Usa 127.0.0.1 se non ti serve`);
      }

      const staticDir = fs.existsSync(path.join(STATIC_DIR, 'index.html')) ? STATIC_DIR : null;
      if (!staticDir) io.err('⚠ Interfaccia non compilata: esegui "npm run build:web" (le API funzionano comunque)');

      const ui = await startUi(ctx, { host, port, proxyHost, proxyPort, proxy: opts.proxy, token, staticDir, version: VERSION });
      // Uscita volutamente non mascherata: l'URL contiene il token, che serve all'utente per accedere.
      io.raw(`Interfaccia llmpod: ${ui.url}`);
      if (ui.proxyPort) io.out(`Proxy per Open WebUI su ${proxyHost.includes(':') ? `[${proxyHost}]` : proxyHost}:${ui.proxyPort}`);
      if (opts.open && env.LLMPOD_IN_DOCKER !== '1') openBrowser(ui.url, { platform: ctx.platform, spawn: ctx.spawn });
      await new Promise((resolve) => {
        let stopping = false;
        // process.on (non once): un secondo segnale durante lo spegnimento non deve riattivare il comportamento predefinito.
        const stop = () => {
          if (stopping) { io.err('  Terminazione in corso, attendere…'); return; }
          stopping = true;
          ui.shutdown({ io })
            .catch((err) => io.err(`⚠ Chiusura incompleta: ${err.message}`))
            .finally(() => {
              process.off('SIGINT', stop);
              process.off('SIGTERM', stop);
              process.off('SIGHUP', stop);
              // Il processo deve terminare davvero: nessun job rimasto (polling, consulente, domande) deve restare in vita.
              ctx.exit(0);
              resolve();
            });
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        process.on('SIGHUP', stop);
      });
    });
}
