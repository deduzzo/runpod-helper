import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { READ_ONLY_TOOLS, ASK_TOOLS } from '../../src/mcp/tools.js';

const root = new URL('../../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

// Corrispondenza delle regole Bash come le descrive la documentazione dei permessi di Claude Code: "*" = qualunque testo;
// " *" finale copre anche il comando senza argomenti. Ordine: deny, poi ask, poi allow.
function bashMatches(rule, command) {
  const m = rule.match(/^Bash\((.*)\)$/);
  if (!m) return false;
  const pattern = m[1];
  if (pattern.endsWith(' *') && !pattern.slice(0, -2).includes('*') && command === pattern.slice(0, -2)) return true;
  const re = new RegExp(`^${pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(command);
}
function decide(permissions, command) {
  for (const kind of ['deny', 'ask', 'allow']) if ((permissions[kind] ?? []).some((r) => bashMatches(r, command))) return kind;
  return 'default';
}

describe('integrazione con Claude Code nel repository', () => {
  const settings = JSON.parse(read('.claude/settings.json'));

  it('.mcp.json registra il server llmpod (node src/mcp/server.js)', () => {
    expect(JSON.parse(read('.mcp.json')).mcpServers.llmpod).toEqual({ command: 'node', args: ['src/mcp/server.js'] });
  });

  it('allow: solo gli strumenti MCP di sola lettura; mai quelli che costano o distruggono', () => {
    const mcpAllowed = settings.permissions.allow.filter((r) => r.startsWith('mcp__llmpod__')).map((r) => r.slice('mcp__llmpod__'.length));
    expect(mcpAllowed.sort()).toEqual([...READ_ONLY_TOOLS].sort());
    for (const t of ['up', 'tune', 'keep', 'down', 'save_profile', 'job_answer']) expect(mcpAllowed).not.toContain(t);
    for (const r of settings.permissions.allow.filter((x) => x.startsWith('Bash('))) {
      expect(r, r).toMatch(/^Bash\((node src\/cli\/index\.js|llmpod) (status \*|metrics \*|logs \*|search \*|--help)\)$/);
    }
  });

  it('ask: tutto ciò che spende o modifica (MCP e CLI) chiede sempre all\'utente', () => {
    const ask = settings.permissions.ask;
    const mcpAsk = ask.filter((r) => r.startsWith('mcp__llmpod__')).map((r) => r.slice('mcp__llmpod__'.length));
    expect(mcpAsk.sort()).toEqual([...ASK_TOOLS].sort());
    for (const cmd of ['up p', 'tune p --set max-num-seqs=4', 'keep p --max-hours 12', 'down p', 'down', 'destroy-volume', 'rotate-key p', 'save p', 'init', 'advisor --disable']) {
      expect(decide(settings.permissions, `llmpod ${cmd}`), cmd).toBe('ask');
      expect(decide(settings.permissions, `node src/cli/index.js ${cmd}`), cmd).toBe('ask');
    }
  });

  it('allow: i comandi CLI di sola lettura, anche senza argomenti', () => {
    for (const cmd of ['status', 'status --all', 'metrics p --json', 'logs p --since 3', 'search --set abliterated', '--help']) {
      expect(decide(settings.permissions, `llmpod ${cmd}`), cmd).toBe('allow');
      expect(decide(settings.permissions, `node src/cli/index.js ${cmd}`), cmd).toBe('allow');
    }
    expect(decide(settings.permissions, 'llmpod statusx')).toBe('default');
  });

  it('deny: lettura dei .env e comandi che stampano le chiavi; .env.example resta leggibile', () => {
    const deny = settings.permissions.deny;
    expect(deny).toEqual(expect.arrayContaining(['Read(~/.config/llmpod/.env)', 'Read(**/.env)', 'Edit(**/.env)']));
    for (const cmd of ['cat ~/.config/llmpod/.env', 'cat .env', 'grep KEY ~/.config/llmpod/.env', 'head -3 .env | wc', 'llmpod env', 'llmpod env p --format json', 'node src/cli/index.js env p']) {
      expect(decide(settings.permissions, cmd), cmd).toBe('deny');
    }
    for (const cmd of ['cat .env.example', 'grep X .env.example']) expect(decide(settings.permissions, cmd), cmd).not.toBe('deny');
    expect(deny.some((r) => r.startsWith('Read(') && r.includes('.env.'))).toBe(false);
  });

  it('skill del progetto con frontmatter name/description in italiano', () => {
    for (const name of ['llmpod-avvia', 'llmpod-stato', 'llmpod-tune', 'llmpod-spegni']) {
      const text = read(`.claude/skills/${name}/SKILL.md`);
      const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
      expect(fm, name).toBeTruthy();
      expect(fm[1]).toMatch(new RegExp(`^name: ${name}$`, 'm'));
      expect(fm[1]).toMatch(/^description: .*(Pod|vLLM|modello)/m);
    }
  });

  it('CLAUDE.md contiene le regole vincolanti', () => {
    const md = read('CLAUDE.md');
    for (const re of [/italiano/, /ELIMINANO, mai fermati/, /MTP o decodifica speculativa/, /Mai leggere né stampare chiavi/, /costo orario e il costo massimo/, /Non toccare Pod/]) expect(md).toMatch(re);
  });
});
