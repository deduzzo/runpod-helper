import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;

function fakeBin({ dockerRunning = true, infoMessage = '', composeV2 = true } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-bin-'));
  const log = path.join(bin, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  info) ${infoMessage ? `echo "${infoMessage}" >&2; ` : ''}${dockerRunning ? 'exit 0' : 'exit 1'} ;;
  compose)
    case "$*" in
      "compose version") ${composeV2 ? 'exit 0' : 'echo "docker: unknown command: docker compose" >&2; exit 1'} ;;
      *"compose up -d"*) echo "ENV LLMPOD_UI_TOKEN=$LLMPOD_UI_TOKEN COMPOSE_PROFILES=$COMPOSE_PROFILES" >> "${log}" ;;
    esac
    case "$*" in
      *"run --rm -it llmpod init"*) printf 'RUNPOD_API_KEY=rpa_FINTA\\n' >> "$LLMPOD_CONFIG_DIR/.env" ;;
    esac
    exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  for (const t of ['open', 'xdg-open']) fs.writeFileSync(path.join(bin, t), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { bin, log };
}

// Cartella con soli link simbolici ai comandi usati dagli script, senza docker:
// funziona anche se sulla macchina esiste un vero docker in /usr/bin o /bin.
function noDockerBin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-nobin-'));
  const cmds = ['sh', 'mkdir', 'chmod', 'grep', 'cut', 'head', 'tail', 'od', 'tr', 'id', 'dirname', 'uname', 'cat', 'sleep'];
  for (const c of cmds) {
    const found = ['/usr/bin', '/bin'].map((d) => path.join(d, c)).find((p) => fs.existsSync(p));
    if (found) fs.symlinkSync(found, path.join(dir, c));
  }
  return dir;
}

// Con tty=true lo script gira in uno pseudo-terminale (stdin è un terminale, come nel doppio clic).
function runStart(args, { home, bin, path: pathEnv, tty = false }) {
  const script = path.join(ROOT, 'scripts/start.sh');
  const cmd = tty
    ? ['python3', [path.join(ROOT, 'test/scripts/pty-run.py'), 'sh', script, ...args]]
    : ['sh', [script, ...args]];
  return spawnSync(cmd[0], cmd[1], {
    env: { HOME: home, PATH: pathEnv ?? `${bin}:/usr/bin:/bin` }, encoding: 'utf8',
  });
}

function runStop({ home, bin, path: pathEnv }) {
  return spawnSync('sh', [path.join(ROOT, 'scripts/stop.sh')], {
    env: { HOME: home, PATH: pathEnv ?? `${bin}:/usr/bin:/bin` }, encoding: 'utf8',
  });
}

const newHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-home-'));

describe('scripts/start.sh', () => {
  it('primo avvio: crea cartelle e .env 600, chiave interna, init, up, URL con token', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-home-'));
    const { bin, log } = fakeBin();
    const r = runStart([], { home, bin, tty: true });
    expect(r.status).toBe(0);
    const cfg = path.join(home, '.config/llmpod');
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o700);
    const envFile = path.join(cfg, '.env');
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(envFile, 'utf8')).toMatch(/^LLMPOD_OPENWEBUI_KEY=[A-Za-z0-9_-]{40,}$/m);
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls).toContain('compose build llmpod');
    expect(calls).toContain('compose run --rm -it llmpod init');
    expect(calls).toContain('compose up -d');
    expect(r.stdout).toMatch(/Interfaccia llmpod: http:\/\/127\.0\.0\.1:7860\/\?t=[A-Za-z0-9]{40,}/);
    expect(r.stdout).not.toMatch(/LLMPOD_OPENWEBUI_KEY|rpa_FINTA/);
    // stderr e stdout non contengono né la chiave interna né quella Runpod
    const internalKey = fs.readFileSync(envFile, 'utf8').match(/^LLMPOD_OPENWEBUI_KEY=(.+)$/m)[1];
    for (const out of [r.stdout, r.stderr]) {
      expect(out).not.toContain(internalKey);
      expect(out).not.toContain('rpa_FINTA');
    }
    // il docker finto riceve lo stesso token dell'URL e il profilo openwebui
    const token = r.stdout.match(/\?t=([A-Za-z0-9]+)/)[1];
    expect(calls).toContain(`ENV LLMPOD_UI_TOKEN=${token} COMPOSE_PROFILES=openwebui`);
    expect(fs.existsSync(path.join(home, '.zcode/v2'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.pi/agent'))).toBe(true);
  });

  it('secondo avvio: niente init se la chiave Runpod c\'è; chiave interna invariata', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-home-'));
    const { bin, log } = fakeBin();
    runStart([], { home, bin, tty: true });
    const before = fs.readFileSync(path.join(home, '.config/llmpod/.env'), 'utf8');
    fs.writeFileSync(log, '');
    expect(runStart(['--no-openwebui'], { home, bin }).status).toBe(0);
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls).not.toContain('init');
    expect(calls).toMatch(/COMPOSE_PROFILES=\n/);
    expect(fs.readFileSync(path.join(home, '.config/llmpod/.env'), 'utf8')).toBe(before);
  });

  it('Docker assente o fermo → messaggio chiaro e uscita 1', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-home-'));
    const empty = noDockerBin();
    const r1 = runStart([], { home, bin: empty, path: empty });
    expect(r1.status).toBe(1);
    expect(r1.stderr).toMatch(/Docker non trovato/);
    const { bin } = fakeBin({ dockerRunning: false });
    const r2 = runStart([], { home, bin });
    expect(r2.status).toBe(1);
    expect(r2.stderr).toMatch(/Docker non è in esecuzione/);
  });
});

describe('scripts/start.sh: casi particolari', () => {
  it('prima configurazione senza terminale → uscita 1, nessuna build né init', () => {
    const home = newHome();
    const { bin, log } = fakeBin();
    const r = runStart([], { home, bin });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Prima configurazione: esegui lo script da un terminale interattivo/);
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    expect(calls).not.toContain('compose build');
    expect(calls).not.toContain('init');
  });

  it('.env senza newline finale: la riga RUNPOD_API_KEY resta intatta', () => {
    const home = newHome();
    const cfg = path.join(home, '.config/llmpod');
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.env'), 'RUNPOD_API_KEY=rpa_FINTA');
    const { bin } = fakeBin();
    expect(runStart([], { home, bin }).status).toBe(0);
    const content = fs.readFileSync(path.join(cfg, '.env'), 'utf8');
    expect(content).toMatch(/^RUNPOD_API_KEY=rpa_FINTA\nLLMPOD_OPENWEBUI_KEY=[0-9a-f]{64}\n$/);
  });

  it('Docker senza permessi → messaggio dedicato', () => {
    const { bin } = fakeBin({ dockerRunning: false, infoMessage: 'permission denied while trying to connect to the docker API' });
    const r = runStart([], { home: newHome(), bin });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Docker non accessibile: aggiungi l'utente al gruppo docker o usa Docker Desktop/);
  });

  it('Docker Compose v2 assente → messaggio chiaro', () => {
    const { bin } = fakeBin({ composeV2: false });
    const r = runStart([], { home: newHome(), bin });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Docker Compose v2 non trovato/);
  });
});

describe('scripts/stop.sh', () => {
  it('ferma i servizi senza creare la chiave interna né il .env', () => {
    const home = newHome();
    const { bin, log } = fakeBin();
    const r = runStop({ home, bin });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toContain('compose --profile openwebui down');
    expect(fs.existsSync(path.join(home, '.config/llmpod/.env'))).toBe(false);
  });

  it('Docker assente → messaggio chiaro e uscita 1', () => {
    const empty = noDockerBin();
    const r = runStop({ home: newHome(), bin: empty, path: empty });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Docker non trovato/);
  });
});
