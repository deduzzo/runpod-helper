import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const ROOTDIR = ROOT.replace(/\/$/, '');

function fakeBin({ dockerRunning = true, infoMessage = '', composeV2 = true, secOpts = 'name=seccomp', context = 'default', waitSupport = true, pods = [], uname = '' } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-bin-'));
  const log = path.join(bin, 'docker.log');
  const podsJson = JSON.stringify({ pods: pods.map((p) => ({ profile: p.profile, podId: p.podId, status: p.status ?? 'RUNNING', ...(p.noState ? {} : { state: p.state ?? 'running', stateLabel: p.state === 'stopped' ? 'spento' : 'avviato' }), gpu: { id: 'GPU', count: 1 }, supervisor: null })), balance: null, volume: null }, null, 2);
  fs.writeFileSync(path.join(bin, 'status.json'), podsJson);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  info)
    case "$*" in
      *SecurityOptions*) echo "${secOpts}"; exit 0 ;;
    esac
    ${infoMessage ? `echo "${infoMessage}" >&2; ` : ''}${dockerRunning ? 'exit 0' : 'exit 1'} ;;
  context) echo "${context}"; exit 0 ;;
  image) exit 0 ;;
  compose)
    case "$*" in
      "compose version") ${composeV2 ? 'exit 0' : 'echo "docker: unknown command: docker compose" >&2; exit 1'} ;;
      *" up --help"*) ${waitSupport ? 'echo "      --wait-timeout int   Maximum duration to wait"' : 'echo "Usage: docker compose up"'}; exit 0 ;;
      *" up -d"*) echo "ENV LLMPOD_UI_TOKEN=$LLMPOD_UI_TOKEN COMPOSE_PROFILES=$COMPOSE_PROFILES UID=$LLMPOD_UID GID=$LLMPOD_GID OWPORT=$LLMPOD_OPENWEBUI_PORT" >> "${log}" ;;
      *" status --json"*) cat "${path.join(bin, 'status.json')}"; exit 0 ;;
    esac
    case "$*" in
      *" run --rm -it llmpod init"*) printf 'RUNPOD_API_KEY=rpa_FINTA\\n' >> "$LLMPOD_CONFIG_DIR/.env"; echo '{}' > "$LLMPOD_CONFIG_DIR/config.json" ;;
    esac
    exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  for (const t of ['open', 'xdg-open']) fs.writeFileSync(path.join(bin, t), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (uname) fs.writeFileSync(path.join(bin, 'uname'), `#!/bin/sh\necho ${uname}\n`, { mode: 0o755 });
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
function runStart(args, { home, bin, path: pathEnv, tty = false, env = {}, cwd }) {
  const script = path.join(ROOT, 'scripts/start.sh');
  const cmd = tty
    ? ['python3', [path.join(ROOT, 'test/scripts/pty-run.py'), 'sh', script, ...args]]
    : ['sh', [script, ...args]];
  return spawnSync(cmd[0], cmd[1], {
    env: { HOME: home, PATH: pathEnv ?? `${bin}:/usr/bin:/bin`, ...env }, encoding: 'utf8', cwd,
  });
}

function runStop({ home, bin, path: pathEnv, env = {}, cwd }) {
  return spawnSync('sh', [path.join(ROOT, 'scripts/stop.sh')], {
    env: { HOME: home, PATH: pathEnv ?? `${bin}:/usr/bin:/bin`, ...env }, encoding: 'utf8', cwd,
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
    expect(calls).toContain(' build llmpod');
    expect(calls).toContain(' run --rm -it llmpod init');
    expect(calls).toContain(' up -d --wait --wait-timeout 120');
    // compose lavora sulla cartella del progetto senza cambiare la cartella corrente
    expect(calls).toContain(`compose --project-directory ${ROOTDIR} -f ${ROOTDIR}/compose.yaml build llmpod`);
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
    expect(calls).toMatch(/COMPOSE_PROFILES= UID=/);
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
    expect(calls).not.toContain(' build ');
    expect(calls).not.toContain('init');
  });

  it('.env senza newline finale: la riga RUNPOD_API_KEY resta intatta', () => {
    const home = newHome();
    const cfg = path.join(home, '.config/llmpod');
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.env'), 'RUNPOD_API_KEY=rpa_FINTA');
    fs.writeFileSync(path.join(cfg, 'config.json'), '{}');
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
    expect(fs.readFileSync(log, 'utf8')).toContain(' --profile openwebui down');
    expect(fs.existsSync(path.join(home, '.config/llmpod/.env'))).toBe(false);
  });

  it('Docker assente → messaggio chiaro e uscita 1', () => {
    const empty = noDockerBin();
    const r = runStop({ home: newHome(), bin: empty, path: empty });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Docker non trovato/);
  });
});

describe('scripts/start.sh: correzioni della revisione finale', () => {
  const prepared = () => {
    const home = newHome();
    const cfg = path.join(home, '.config/llmpod');
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.env'), 'RUNPOD_API_KEY=rpa_FINTA\n');
    fs.writeFileSync(path.join(cfg, 'config.json'), '{}');
    return { home, cfg };
  };

  it('non cambia la cartella corrente: lavora da qualunque cartella', () => {
    const { home } = prepared();
    const { bin, log } = fakeBin();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-cwd-'));
    expect(runStart([], { home, bin, cwd: elsewhere }).status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toContain(`--project-directory ${ROOTDIR} -f ${ROOTDIR}/compose.yaml up -d`);
  });

  it('la configurazione iniziale si ripropone se manca config.json (init interrotto)', () => {
    const { home, cfg } = prepared();
    fs.rmSync(path.join(cfg, 'config.json'));
    const { bin, log } = fakeBin();
    expect(runStart([], { home, bin, tty: true }).status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toContain(' run --rm -it llmpod init');
    // senza terminale si ferma con il messaggio
    fs.rmSync(path.join(cfg, 'config.json'));
    const r = runStart([], { home, bin });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Prima configurazione/);
  });

  it('usa "up -d --wait" solo se compose lo supporta e avvisa che Open WebUI può essere lento', () => {
    const { home } = prepared();
    const a = fakeBin({ waitSupport: true });
    const ra = runStart([], { home, bin: a.bin });
    expect(ra.status).toBe(0);
    expect(fs.readFileSync(a.log, 'utf8')).toContain(' up -d --wait --wait-timeout 120');
    expect(ra.stdout + ra.stderr).toMatch(/Open WebUI.*alcuni minuti/);
    const b = fakeBin({ waitSupport: false });
    expect(runStart([], { home, bin: b.bin }).status).toBe(0);
    const calls = fs.readFileSync(b.log, 'utf8');
    expect(calls).toContain(' up -d');
    expect(calls).not.toContain('--wait');
  });

  it('suggerisce bin/llmpod docker-logs e usa la porta di Open WebUI configurata', () => {
    const { home } = prepared();
    const { bin, log } = fakeBin();
    const r = runStart([], { home, bin, env: { LLMPOD_OPENWEBUI_PORT: '3456' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Open WebUI: http://127.0.0.1:3456');
    expect(r.stdout).toContain('bin/llmpod docker-logs');
    expect(r.stdout + r.stderr).not.toMatch(/bin\/llmpod logs\b/);
    expect(fs.readFileSync(log, 'utf8')).toContain('OWPORT=3456');
    const r2 = runStart([], { home, bin });
    expect(r2.stdout).toContain('Open WebUI: http://127.0.0.1:3000');
  });

  it('PI_CODING_AGENT_DIR dell\'host è rispettata; le cartelle mancanti vengono create', () => {
    const { home } = prepared();
    const { bin } = fakeBin();
    const piDir = path.join(home, 'altro-pi');
    expect(runStart([], { home, bin, env: { PI_CODING_AGENT_DIR: piDir } }).status).toBe(0);
    expect(fs.existsSync(piDir)).toBe(true);
    expect(fs.existsSync(path.join(home, '.pi/agent'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.zcode/v2'))).toBe(true);
  });

  describe('utente del container su Linux', () => {
    const uid = (r, log) => fs.readFileSync(log, 'utf8').match(/UID=(\d+) GID=(\d+)/).slice(1, 3).join(':');
    it('Docker rootless → 0:0', () => {
      const { home } = prepared();
      const { bin, log } = fakeBin({ uname: 'Linux', secOpts: 'name=seccomp,profile=builtin name=rootless' });
      const r = runStart([], { home, bin });
      expect(r.status).toBe(0);
      expect(uid(r, log)).toBe('0:0');
    });
    it('Docker Desktop for Linux (context desktop-linux) → 0:0', () => {
      const { home } = prepared();
      const { bin, log } = fakeBin({ uname: 'Linux', context: 'desktop-linux' });
      expect(uid(runStart([], { home, bin }), log)).toBe('0:0');
    });
    it('Docker Engine normale su Linux → UID e GID dell\'utente', () => {
      const { home } = prepared();
      const { bin, log } = fakeBin({ uname: 'Linux' });
      expect(uid(runStart([], { home, bin }), log)).toBe(`${process.getuid()}:${process.getgid()}`);
    });
  });
});

describe('scripts/stop.sh: Pod ancora attivi', () => {
  const withKey = () => {
    const home = newHome();
    const cfg = path.join(home, '.config/llmpod');
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.env'), 'RUNPOD_API_KEY=rpa_FINTA\n');
    return home;
  };

  it('avvisa che il Pod resta acceso e a pagamento (da eliminare), senza toccarlo; poi ferma i container', () => {
    const { bin, log } = fakeBin({ pods: [{ profile: 'qwen3-coder', podId: 'abc123' }, { profile: 'glm', podId: 'zzz999' }] });
    const r = runStop({ home: withKey(), bin });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Il Pod abc123 del profilo qwen3-coder resta acceso e a pagamento: eliminalo con bin/llmpod down qwen3-coder');
    expect(r.stderr).toContain('Il Pod zzz999 del profilo glm resta acceso e a pagamento: eliminalo con bin/llmpod down glm');
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls).toContain(' run --rm -T llmpod status --json');
    expect(calls.indexOf('status --json')).toBeLessThan(calls.indexOf('--profile openwebui down'));
    expect(calls).not.toMatch(/llmpod down/);
    expect(r.stdout).toMatch(/I Pod su Runpod non vengono toccati.*si eliminano con bin\/llmpod down/);
  });

  it('avvisa anche dei Pod spenti: costano ancora il disco e vanno eliminati', () => {
    const { bin } = fakeBin({ pods: [{ profile: 'glm', podId: 'old777', status: 'EXITED', state: 'stopped' }, { profile: 'qwen3-coder', podId: 'abc123' }] });
    const r = runStop({ home: withKey(), bin });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Il Pod old777 del profilo glm è spento ma costa ancora lo spazio su disco: eliminalo con bin/llmpod down glm');
    expect(r.stderr).not.toMatch(/old777.*resta acceso/);
    expect(r.stderr).toContain('Il Pod abc123 del profilo qwen3-coder resta acceso e a pagamento');
  });

  it('un Pod senza campo state (output di una versione precedente) è trattato come acceso, anche se è l\'ultimo', () => {
    const { bin } = fakeBin({ pods: [{ profile: 'glm', podId: 'old777', status: 'EXITED', state: 'stopped' }, { profile: 'qwen3-coder', podId: 'abc123', noState: true }] });
    const r = runStop({ home: withKey(), bin });
    expect(r.stderr).toContain('Il Pod old777 del profilo glm è spento ma costa ancora lo spazio su disco');
    expect(r.stderr).toContain('Il Pod abc123 del profilo qwen3-coder resta acceso e a pagamento: eliminalo con bin/llmpod down qwen3-coder');
  });

  it('nessun Pod: nessun avviso', () => {
    const { bin } = fakeBin();
    const r = runStop({ home: withKey(), bin });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/resta acceso/);
  });

  it('senza chiave Runpod il controllo si salta (e non si lancia run)', () => {
    const { bin, log } = fakeBin();
    expect(runStop({ home: newHome(), bin }).status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).not.toContain('status --json');
  });

  it('se il controllo fallisce prosegue con lo stop', () => {
    const { bin, log } = fakeBin();
    fs.writeFileSync(path.join(bin, 'status.json'), 'non json');
    const r = runStop({ home: withKey(), bin });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/resta acceso/);
    expect(fs.readFileSync(log, 'utf8')).toContain('--profile openwebui down');
  });

  it('non cambia la cartella corrente', () => {
    const { bin, log } = fakeBin();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-cwd-'));
    expect(runStop({ home: newHome(), bin, cwd: elsewhere }).status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toContain(`--project-directory ${ROOTDIR} -f ${ROOTDIR}/compose.yaml --profile openwebui down`);
  });
});
