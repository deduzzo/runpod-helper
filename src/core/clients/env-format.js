export function formatEnv(env, format = 'sh') {
  const entries = Object.entries(env);
  if (format === 'json') return JSON.stringify(env, null, 2);
  if (format === 'ps1') return entries.map(([k, v]) => `$env:${k} = '${String(v).replace(/'/g, "''")}'`).join('\n');
  return entries.map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`).join('\n');
}
