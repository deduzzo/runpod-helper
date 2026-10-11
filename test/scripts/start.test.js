import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;

function fakeBin({ dockerRunning = true } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-bin-'));
  const log = path.join(bin, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  info) ${dockerRunning ? 'exit 0' : 'exit 1'} ;;
  compose)
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
  const cmds = ['sh', 'mkdir', 'chmod', 'grep', 'cut', 'head', 'od', 'tr', 'id', 'dirname', 'uname', 'cat', 'sleep'];
  for (const c of cmds) {
    const found = ['/usr/bin', '/bin'].map((d) => path.join(d, c)).find((p) => fs.existsSync(p));
    if (found) fs.symlinkSync(found, path.join(dir, c));
  }
  return dir;
}

function runStart(args, { home, bin, path: pathEnv }) {
  return spawnSync('sh', [path.join(ROOT, 'scripts/start.sh'), ...args], {
    env: { HOME: home, PATH: pathEnv ?? `${bin}:/usr/bin:/bin` }, encoding: 'utf8',
  });
}

describe('scripts/start.sh', () => {
  it('primo avvio: crea cartelle e .env 600, chiave interna, init, up, URL con token', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-home-'));
    const { bin, log } = fakeBin();
    const r = runStart([], { home, bin });
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
    expect(fs.existsSync(path.join(home, '.zcode/v2'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.pi/agent'))).toBe(true);
  });

  it('secondo avvio: niente init se la chiave Runpod c\'è; chiave interna invariata', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-home-'));
    const { bin, log } = fakeBin();
    runStart([], { home, bin });
    const before = fs.readFileSync(path.join(home, '.config/llmpod/.env'), 'utf8');
    fs.writeFileSync(log, '');
    expect(runStart(['--no-openwebui'], { home, bin }).status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).not.toContain('init');
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
