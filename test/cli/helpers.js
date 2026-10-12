import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { runCli } from '../../src/cli/program.js';
import { createIo } from '../../src/cli/render.js';
import { createStore } from '../../src/core/config.js';
import { clearSecrets } from '../../src/core/secrets.js';

export const SECRETS = { RUNPOD_API_KEY: 'rpa_SEGRETO_RUNPOD_FINTO_123', HF_TOKEN: 'hf_SEGRETO_HF_FINTO_1234567' };

export function sandbox({ answers = {} } = {}) {
  clearSecrets();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-cli-'));
  const env = { LLMPOD_CONFIG_DIR: path.join(root, 'cfg'), ZCODE_DIR: path.join(root, 'zcode'), PI_CODING_AGENT_DIR: path.join(root, 'pi') };
  const store = createStore({ dir: env.LLMPOD_CONFIG_DIR, platform: 'linux' });
  const outBuf = [];
  const errBuf = [];
  const prompt = {
    isTty: Boolean(answers.interactive),
    ask: vi.fn(async () => (answers.ask?.length ? answers.ask.shift() : true)),
    askText: vi.fn(async (q, def) => (answers.text?.length ? answers.text.shift() : def)),
    askSecret: vi.fn(async () => (answers.secret?.length ? answers.secret.shift() : '')),
  };
  const io = createIo({ stdout: { write: (s) => outBuf.push(s) }, stderr: { write: (s) => errBuf.push(s) }, prompt });
  return {
    root, env, store, io, prompt,
    out: () => outBuf.join(''),
    err: () => errBuf.join(''),
    all: () => outBuf.join('') + errBuf.join(''),
    run: (argv, overrides = {}) => runCli(argv, { io, env, overrides }),
  };
}
