import { describe, it, expect } from 'vitest';
import { causeLines, waitForReady } from '../../src/core/pod/launcher.js';

describe('causa dell\'errore di vLLM', () => {
  const log = [
    '(EngineCore_DP0 pid=812) ERROR 10-12 08:20:01 core.py:900] EngineCore failed to start.',
    '(EngineCore_DP0 pid=812) Traceback (most recent call last):',
    '(EngineCore_DP0 pid=812)   File "/usr/local/lib/python3.12/dist-packages/vllm/v1/engine/core.py", line 890, in run_engine_core',
    '(EngineCore_DP0 pid=812) NotImplementedError: NVFP4 MoE kernels are not supported on this GPU (sm_120)',
    '(APIServer pid=3390) Traceback (most recent call last):',
    '(APIServer pid=3390)   File "/usr/local/lib/python3.12/dist-packages/vllm/v1/engine/core_client.py", line 1060, in __init__',
    '(APIServer pid=3390)            ^^^^^^^^^^^^^^^^^^^^^',
    '(APIServer pid=3390) RuntimeError: Engine core initialization failed. See root cause above. Failed core proc(s): {}',
  ];

  it('estrae le righe di causa senza i frame dello stack', () => {
    expect(causeLines(log)).toEqual([
      'NotImplementedError: NVFP4 MoE kernels are not supported on this GPU (sm_120)',
      'RuntimeError: Engine core initialization failed. See root cause above. Failed core proc(s): {}',
    ]);
  });

  it('waitForReady mette la causa nel messaggio e in testa a lastLines, anche se è uscita dalle ultime 200 righe', async () => {
    const filler = Array.from({ length: 300 }, (_, i) => `(APIServer pid=3390) riga ${i}`);
    const lines = [log[3], ...filler, ...log.slice(4)].map((line, i) => ({ n: i + 1, line }));
    let calls = 0;
    const sup = { logs: async () => (calls++ === 0 ? { lines } : { lines: [] }), status: async () => ({ phase: 'error', lastError: 'vLLM terminato con codice 1' }) };
    const err = await waitForReady({ sup, timeoutMs: 60_000, sleep: async () => {} }).catch((e) => e);
    expect(err.message).toMatch(/causa: RuntimeError: Engine core initialization failed/);
    expect(err.details.rootCause[0]).toMatch(/NotImplementedError: NVFP4/);
    expect(err.details.lastLines[0]).toMatch(/NotImplementedError/);
  });
});
