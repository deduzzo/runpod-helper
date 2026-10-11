import { Command, CommanderError } from 'commander';
import { LlmpodError, Codes } from '../core/errors.js';
import { redact } from '../core/secrets.js';
import { createContext, VERSION } from './context.js';
import { createIo } from './render.js';
import { createPrompt } from './prompt.js';
import * as init from './commands/init.js';
import * as search from './commands/search.js';
import * as plan from './commands/plan.js';
import * as save from './commands/save.js';
import * as up from './commands/up.js';
import * as down from './commands/down.js';
import * as status from './commands/status.js';
import * as env from './commands/env.js';
import * as run from './commands/run.js';
import * as rotateKey from './commands/rotate-key.js';
import * as destroyVolume from './commands/destroy-volume.js';
import * as advisor from './commands/advisor.js';
import * as ui from './commands/ui.js';
import * as chat from './commands/chat.js';
import * as prepare from './commands/prepare.js';

export const COMMANDS = [init, search, plan, save, up, down, status, env, run, rotateKey, destroyVolume, advisor, ui, chat, prepare];

export async function runCli(argv, { io, env = process.env, overrides = {} } = {}) {
  const ownPrompt = io ? null : createPrompt();
  io ??= createIo({ prompt: ownPrompt });
  const result = { code: 0 };
  const program = new Command('llmpod')
    .description('LLM self-hosted su Runpod come backend di coding agent')
    .version(VERSION)
    .option('--verbose', 'mostra i log di vLLM durante l\'avvio')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.raw(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) });
  let ctx;
  const getCtx = () => (ctx ??= createContext({ env, io, overrides }));
  for (const cmd of COMMANDS) cmd.register(program, getCtx, result);

  try {
    await program.parseAsync(argv, { from: 'user' });
    return result.code;
  } catch (err) {
    if (err instanceof CommanderError) {
      return ['commander.helpDisplayed', 'commander.version', 'commander.help'].includes(err.code) ? 0 : (err.exitCode || 1);
    }
    if (err instanceof LlmpodError) {
      io.err(`Errore [${err.code}]: ${err.message}`);
      if (err.hint) io.err(`  Suggerimento: ${err.hint}`);
      for (const line of err.details?.lastLines ?? []) io.err(`  │ ${line}`);
      return err.code === Codes.CANCELLED ? 130 : 1;
    }
    io.err(`Errore inatteso: ${redact(program.opts().verbose ? err.stack : err.message)}`);
    return 1;
  } finally {
    ownPrompt?.close();
  }
}
