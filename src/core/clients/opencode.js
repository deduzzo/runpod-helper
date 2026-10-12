import fs from 'node:fs';
import path from 'node:path';
import { maxOutputTokens, clientContext } from './claude-code.js';

export function opencodeConfig({ baseUrl, servedName, context }) {
  return {
    $schema: 'https://opencode.ai/config.json',
    model: `llmpod/${servedName}`,
    small_model: `llmpod/${servedName}`,
    provider: {
      llmpod: {
        npm: '@ai-sdk/openai-compatible',
        name: 'llmpod (Runpod)',
        options: { baseURL: `${baseUrl}/v1`, apiKey: '{env:LLMPOD_API_KEY}' },
        models: { [servedName]: { name: servedName, limit: { context: clientContext(context), output: maxOutputTokens(context) } } },
      },
    },
  };
}

export function prepareOpencode(endpoint, { dir }) {
  const file = path.join(dir, 'clients', 'opencode.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(opencodeConfig(endpoint), null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { command: 'opencode', args: [], env: { OPENCODE_CONFIG: file, LLMPOD_API_KEY: endpoint.apiKey } };
}
