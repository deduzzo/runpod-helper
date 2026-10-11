import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { LlmpodError, Codes } from '../../core/errors.js';
import { registerSecret } from '../../core/secrets.js';
import { startUi } from '../../server/start.js';
import { VERSION } from '../context.js';
import { openBrowser } from '../open-browser.js';

const STATIC_DIR = fileURLToPath(new URL('../../../dist/web', import.meta.url));
const TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/;

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
    .option('--proxy-port <porta>', 'porta del proxy per Open WebUI (predefinita: LLMPOD_PROXY_PORT o 8081)')
    .option('--no-proxy', 'non avviare il proxy per Open WebUI')
    .option('--no-open', 'non aprire il browser')
    .action(async (opts) => {
      const ctx = getCtx();
      const { env, io } = ctx;
      const host = opts.host ?? env.LLMPOD_UI_HOST ?? '127.0.0.1';
      const port = parsePort(opts.port ?? env.LLMPOD_UI_PORT ?? 7860, 'Porta');
      const proxyPort = parsePort(opts.proxyPort ?? env.LLMPOD_PROXY_PORT ?? 8081, 'Porta del proxy');
      const proxyHost = env.LLMPOD_PROXY_HOST ?? host;

      let token = env.LLMPOD_UI_TOKEN;
      if (token === undefined || token === '') {
        token = randomBytes(24).toString('hex');
      } else if (!TOKEN_RE.test(token)) {
        throw new LlmpodError(Codes.INVALID_INPUT, 'LLMPOD_UI_TOKEN non valido: servono almeno 16 caratteri tra lettere, cifre, "_" e "-"', { hint: 'Imposta un token più lungo oppure rimuovi la variabile per generarne uno casuale a ogni avvio' });
      }
      registerSecret(token);

      const staticDir = fs.existsSync(path.join(STATIC_DIR, 'index.html')) ? STATIC_DIR : null;
      if (!staticDir) io.err('⚠ Interfaccia non compilata: esegui "npm run build:web" (le API funzionano comunque)');

      const ui = await startUi(ctx, { host, port, proxyHost, proxyPort, proxy: opts.proxy, token, staticDir, version: VERSION });
      // Uscita volutamente non mascherata: l'URL contiene il token, che serve all'utente per accedere.
      io.raw(`Interfaccia llmpod: ${ui.url}`);
      if (ui.proxyPort) io.out(`Proxy per Open WebUI su ${proxyHost}:${ui.proxyPort}`);
      if (opts.open && env.LLMPOD_IN_DOCKER !== '1') openBrowser(ui.url, { platform: ctx.platform, spawn: ctx.spawn });
      await new Promise((resolve) => {
        let stopping = false;
        const stop = () => {
          if (stopping) return;
          stopping = true;
          ui.shutdown({ io }).catch((err) => io.err(`⚠ Chiusura incompleta: ${err.message}`)).finally(resolve);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });
}
