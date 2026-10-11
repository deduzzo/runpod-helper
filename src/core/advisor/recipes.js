const TREE_URL = 'https://api.github.com/repos/vllm-project/recipes/git/trees/main?recursive=1';
const RAW_BASE = 'https://raw.githubusercontent.com/vllm-project/recipes/main/';
const EXCLUDED = new Set(['readme.md', 'contributing.md', 'agents.md', 'claude.md']);
const MAX_CHARS = 12000;

const tokens = (s) => s.toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t.length >= 2);

export function pickRecipe(modelId, paths) {
  const wanted = new Set(tokens(modelId.split('/').pop() ?? ''));
  let best = null;
  for (const path of paths) {
    const parts = path.split('/');
    const file = parts.at(-1);
    if (!file.endsWith('.md') || EXCLUDED.has(file.toLowerCase()) || parts.some((p) => p.startsWith('.'))) continue;
    const score = tokens(file.slice(0, -3)).filter((t) => wanted.has(t)).length;
    if (score < 1) continue;
    if (!best || score > best.score || (score === best.score && file.length < best.file.length)) best = { path, file, score };
  }
  return best?.path ?? null;
}

export function createRecipes({ http }) {
  let paths = null;
  return {
    async find(modelId) {
      try {
        if (!paths) {
          const r = await http.request('GET', TREE_URL, { timeoutMs: 20000 });
          if (!r.ok || !Array.isArray(r.data?.tree)) return null;
          paths = r.data.tree.filter((t) => t.type === 'blob').map((t) => t.path);
        }
        const path = pickRecipe(modelId, paths);
        if (!path) return null;
        const url = RAW_BASE + path.split('/').map(encodeURIComponent).join('/');
        const f = await http.request('GET', url, { headers: { accept: 'text/plain' }, timeoutMs: 20000 });
        if (!f.ok || typeof f.data !== 'string') return null;
        return { path, text: f.data.slice(0, MAX_CHARS) };
      } catch {
        return null;
      }
    },
  };
}
