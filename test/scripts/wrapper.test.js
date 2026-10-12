import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const ROOTDIR = ROOT.replace(/\/$/, '');

function setup({ zcodeRunning = false, prepareFails = false, prepareOutput = '' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-bin-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
echo "docker $*" >> "${log}"
case "$*" in
  *"prepare claude"*) ${prepareFails ? 'echo "errore" >&2; exit 7;' : ''} ${prepareOutput ? `cat "${path.join(bin, 'prepare.out')}"; exit 0;` : ''} printf "export ANTHROPIC_BASE_URL='https://p1-8000.proxy.runpod.net'\\nexec 'claude' '--version'\\n" ;;
esac
exit 0
`, { mode: 0o755 });
  if (prepareOutput) fs.writeFileSync(path.join(bin, 'prepare.out'), `${prepareOutput}\n`);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "claude $* base=$ANTHROPIC_BASE_URL" >> "${log}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pgrep'), `#!/bin/sh\n${zcodeRunning ? 'echo 123; exit 0' : 'exit 1'}\n`, { mode: 0o755 });
  for (const t of ['open', 'xdg-open']) fs.writeFileSync(path.join(bin, t), `#!/bin/sh\necho "open $*" >> "${log}"\n`, { mode: 0o755 });
  const run = (args, script = path.join(ROOT, 'bin/llmpod'), { cwd, env = {} } = {}) => spawnSync('sh', [script, ...args], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env }, encoding: 'utf8', input: '', cwd });
  return { run, log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

describe('bin/llmpod', () => {
  it('comandi normali passano al container senza TTY se stdin non è un terminale', () => {
    const t = setup();
    expect(t.run(['status']).status).toBe(0);
    expect(t.log()).toContain(' run --rm -T llmpod status');
  });

  it('run claude: prepare nel container, avvio sull\'host con le variabili', () => {
    const t = setup();
    expect(t.run(['run', 'claude', '--profile', 'qwen3-coder']).status).toBe(0);
    const log = t.log();
    expect(log).toMatch(/ run --rm -T llmpod prepare claude --format sh --host-config-dir \S+\/\.config\/llmpod --host-pi-dir \S+\/\.pi\/agent --profile qwen3-coder/);
    expect(log).toContain('claude --version base=https://p1-8000.proxy.runpod.net');
  });

  it('run zcode: rifiuta se ZCode è aperto, senza chiamare Docker', () => {
    const t = setup({ zcodeRunning: true });
    const r = t.run(['run', 'zcode']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Chiudi ZCode/);
    expect(t.log()).not.toContain(' run ');
    const t2 = setup();
    expect(t2.run(['run', 'zcode']).status).toBe(0);
    expect(t2.log()).toContain(' run --rm -T llmpod run zcode --no-open');
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
    expect(log).toContain(' run --rm -T llmpod run --help');
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
    expect(t.log()).toContain(' run --rm -T llmpod status');
  });

  it('non cambia la cartella corrente: il client parte dalla cartella del chiamante', () => {
    const t = setup({ prepareOutput: "exec 'pwd'" });
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-cwd-')));
    const r = t.run(['run', 'claude'], path.join(ROOT, 'bin/llmpod'), { cwd: elsewhere });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(elsewhere);
    expect(t.log()).toContain(`docker compose --project-directory ${ROOTDIR} -f ${ROOTDIR}/compose.yaml run --rm -T llmpod prepare claude`);
  });

  it('comandi normali: stessa cartella del chiamante e --project-directory', () => {
    const t = setup();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-cwd-'));
    expect(t.run(['status'], path.join(ROOT, 'bin/llmpod'), { cwd: elsewhere }).status).toBe(0);
    expect(t.log()).toContain(`docker compose --project-directory ${ROOTDIR} -f ${ROOTDIR}/compose.yaml run --rm -T llmpod status`);
  });

  it('docker-logs: segue gli ultimi 200 log del servizio llmpod (o di un altro servizio)', () => {
    const t = setup();
    expect(t.run(['docker-logs']).status).toBe(0);
    expect(t.log()).toMatch(/compose.yaml logs --tail 200 -f llmpod\n/);
    expect(t.run(['docker-logs', 'open-webui']).status).toBe(0);
    expect(t.log()).toMatch(/compose.yaml logs --tail 200 -f open-webui\n/);
  });

  it('logs: passa al container la CLI (log di vLLM del profilo), non i log dei container', () => {
    const t = setup();
    expect(t.run(['logs', 'prova', '--since', '10']).status).toBe(0);
    expect(t.log()).toContain(`compose.yaml run --rm -T llmpod logs prova --since 10`);
    expect(t.log()).not.toContain('logs --tail 200');
  });

  it('ui: nel setup Docker la avvia scripts/start, uscita 1, niente Docker', () => {
    const t = setup();
    const r = t.run(['ui']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Nel setup Docker l'interfaccia la avvia scripts/start");
    expect(t.log()).not.toContain('docker compose');
  });

  it('chat: apre Open WebUI sull\'host con localhost (porta configurabile) e stampa l\'URL', () => {
    const t = setup();
    const r = t.run(['chat']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('http://localhost:3000');
    expect(t.log()).toContain('open http://localhost:3000');
    expect(t.log()).not.toContain('docker compose');
    const t2 = setup();
    const r2 = t2.run(['chat'], undefined, { env: { LLMPOD_OPENWEBUI_PORT: '3456' } });
    expect(r2.stdout).toContain('http://localhost:3456');
    expect(t2.log()).toContain('open http://localhost:3456');
  });
});
