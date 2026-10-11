import { claudeEnv } from './claude-code.js';

export function formatEnv(env, format = 'sh') {
  const entries = Object.entries(env);
  if (format === 'json') return JSON.stringify(env, null, 2);
  if (format === 'ps1') return entries.map(([k, v]) => `$env:${k} = '${String(v).replace(/'/g, "''")}'`).join('\n');
  return entries.map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`).join('\n');
}

export function clientExports(ep) {
  return { ...claudeEnv(ep), OPENAI_BASE_URL: `${ep.baseUrl}/v1`, OPENAI_API_KEY: ep.apiKey, LLMPOD_MODEL: ep.servedName, LLMPOD_API_KEY: ep.apiKey };
}
