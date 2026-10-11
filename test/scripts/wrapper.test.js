import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;

function setup({ zcodeRunning = false, prepareFails = false, prepareOutput = '' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-bin-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
echo "docker $*" >> "${log}"
case "$*" in
  *"prepare claude"*) ${prepareFails ? 'echo "errore" >&2; exit 7;' : ''} ${prepareOutput ? `printf '%s\\n' '${prepareOutput}'; exit 0;` : ''} printf "export ANTHROPIC_BASE_URL='https://p1-8000.proxy.runpod.net'\\nexec 'claude' '--version'\\n" ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "claude $* base=$ANTHROPIC_BASE_URL" >> "${log}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pgrep'), `#!/bin/sh\n${zcodeRunning ? 'echo 123; exit 0' : 'exit 1'}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "open $*" >> "${log}"\n`, { mode: 0o755 });
  const run = (args, script = path.join(ROOT, 'bin/llmpod')) => spawnSync('sh', [script, ...args], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8', input: '' });
  return { run, log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

describe('bin/llmpod', () => {
  it('comandi normali passano al container senza TTY se stdin non è un terminale', () => {
    const t = setup();
    expect(t.run(['status']).status).toBe(0);
    expect(t.log()).toContain('docker compose run --rm -T llmpod status');
  });

  it('run claude: prepare nel container, avvio sull\'host con le variabili', () => {
    const t = setup();
    expect(t.run(['run', 'claude', '--profile', 'qwen3-coder']).status).toBe(0);
    const log = t.log();
    expect(log).toMatch(/docker compose run --rm -T llmpod prepare claude --format sh --host-config-dir \S+\/\.config\/llmpod --host-pi-dir \S+\/\.pi\/agent --profile qwen3-coder/);
    expect(log).toContain('claude --version base=https://p1-8000.proxy.runpod.net');
  });

  it('run zcode: rifiuta se ZCode è aperto, senza chiamare Docker', () => {
    const t = setup({ zcodeRunning: true });
    const r = t.run(['run', 'zcode']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Chiudi ZCode/);
    expect(t.log()).not.toContain('docker compose run');
    const t2 = setup();
    expect(t2.run(['run', 'zcode']).status).toBe(0);
    expect(t2.log()).toContain('docker compose run --rm -T llmpod run zcode --no-open');
  });

  it('run claude: se prepare fallisce esce con lo stesso codice senza eseguire nulla', () => {
    const t = setup({ prepareFails: true });
    const r = t.run(['run', 'claude']);
    expect(r.status).toBe(7);
    expect(t.log()).not.toContain('claude --version');
    expect(r.stdout).toBe('');
  });

  it('run --help: opzione, non client → comando normale nel container', () => {
    const t = setup();
    expect(t.run(['run', '--help']).status).toBe(0);
    const log = t.log();
    expect(log).toContain('docker compose run --rm -T llmpod run --help');
    expect(log).not.toContain('prepare');
  });

  it('output di prepare inatteso: non valutato né stampato', () => {
    const t = setup({ prepareOutput: 'echo SEGRETO-chiave; touch /tmp/llmpod-pwned-test' });
    const r = t.run(['run', 'claude']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Risposta inattesa da prepare/);
    expect(r.stdout + r.stderr).not.toContain('SEGRETO-chiave');
    expect(fs.existsSync('/tmp/llmpod-pwned-test')).toBe(false);
  });

  it('funziona anche tramite link simbolico (anche relativo e a catena)', () => {
    const t = setup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-link-'));
    fs.symlinkSync(path.join(ROOT, 'bin/llmpod'), path.join(dir, 'a'));
    fs.symlinkSync('a', path.join(dir, 'b'));
    expect(t.run(['status'], path.join(dir, 'b')).status).toBe(0);
    expect(t.log()).toContain('docker compose run --rm -T llmpod status');
  });
});
