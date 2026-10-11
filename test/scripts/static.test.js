import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(path.join(ROOT, p));
const text = (p) => read(p).toString('utf8');

describe('compose.yaml', () => {
  const c = text('compose.yaml');
  it('Open WebUI con autenticazione: primo account amministratore, nessuna registrazione successiva', () => {
    expect(c).toMatch(/WEBUI_AUTH: "true"/);
    expect(c).toMatch(/ENABLE_SIGNUP: "false"/);
    expect(c).not.toMatch(/WEBUI_AUTH: "false"/);
  });
  it('porta di Open WebUI configurabile e URL coerente per il servizio llmpod', () => {
    expect(c).toContain('"127.0.0.1:${LLMPOD_OPENWEBUI_PORT:-3000}:8080"');
    expect(c).toContain('LLMPOD_OPENWEBUI_URL: http://127.0.0.1:${LLMPOD_OPENWEBUI_PORT:-3000}');
  });
  it('passa LLMPOD_HOST_OS al servizio llmpod', () => {
    expect(c).toContain('LLMPOD_HOST_OS: ${LLMPOD_HOST_OS:-}');
  });
});

describe('script Windows', () => {
  const ps1 = ['bin/llmpod.ps1', 'scripts/start.ps1', 'scripts/stop.ps1'];
  const crlf = [...ps1, 'bin/llmpod.cmd', 'scripts/start.bat', 'scripts/stop.bat'];

  it.each(crlf)('%s: fine riga CRLF ovunque', (f) => {
    const t = text(f);
    expect(t.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });
  it.each(ps1)('%s: BOM UTF-8', (f) => {
    expect([...read(f).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
  it.each(ps1)('%s: niente Set-Location (la cartella dell\'utente non cambia)', (f) => {
    expect(text(f)).not.toMatch(/Set-Location|Push-Location/);
    expect(text(f)).toContain('--project-directory');
  });
  it('start.ps1, stop.ps1 e llmpod.ps1 impostano LLMPOD_HOST_OS=windows', () => {
    for (const f of ps1) expect(text(f)).toContain("$env:LLMPOD_HOST_OS = 'windows'");
  });
  it('llmpod.cmd lancia llmpod.ps1 con ExecutionPolicy Bypass e propaga l\'esito', () => {
    expect(text('bin/llmpod.cmd')).toBe('@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0llmpod.ps1" %*\r\nexit /b %ERRORLEVEL%\r\n');
  });
  it('start.bat: pause anche in caso di successo (la finestra con l\'URL non si chiude)', () => {
    const t = text('scripts/start.bat');
    expect(t).toMatch(/\r\npause\r\n/);
    expect(t).not.toMatch(/if not "%RC%"=="0" pause/);
  });
  it('llmpod.ps1 ripristina le variabili d\'ambiente in finally', () => {
    const t = text('bin/llmpod.ps1');
    expect(t).toMatch(/finally \{\s*Restore-Env/);
    expect(t).toContain('Remove-Item -LiteralPath "Env:$n"');
  });
});

describe('script sh', () => {
  it.each(['bin/llmpod', 'scripts/start.sh', 'scripts/stop.sh', 'scripts/lib.sh'])('%s: nessun cd nella cartella del progetto', (f) => {
    expect(text(f)).not.toMatch(/^\s*cd "\$(ROOT|SCRIPT_DIR\/\.\.)"/m);
  });
});
