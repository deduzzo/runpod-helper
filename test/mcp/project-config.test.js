import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { READ_ONLY_TOOLS } from '../../src/mcp/tools.js';

const root = new URL('../../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

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
      expect(r, r).toMatch(/^Bash\((node src\/cli\/index\.js|llmpod) (status|metrics|logs|search|--help)/);
    }
  });

  it('deny: lettura dei .env e comandi che stampano le chiavi', () => {
    const deny = settings.permissions.deny;
    expect(deny).toEqual(expect.arrayContaining(['Read(~/.config/llmpod/.env)', 'Read(**/.env)', 'Bash(cat *.env*)', 'Bash(grep *.env*)', 'Bash(llmpod env*)']));
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
