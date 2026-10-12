import fs from 'node:fs';
import { LlmpodError, Codes } from '../errors.js';
import { applyOverrides } from '../planner/vllm-args.js';
import { profileDownloadBytes } from '../planner/vram.js';
import { ncclEnv } from '../planner/nccl.js';

const SUPERVISOR = fs.readFileSync(new URL('./supervisor.py', import.meta.url));
export const START_CMD = 'echo "$LLMPOD_SUPERVISOR_B64" | base64 -d > /tmp/supervisor.py && exec python3 -u /tmp/supervisor.py';
const MAX_BODY_BYTES = 100_000;

export const argsForCount = (args, count) => applyOverrides(args, { set: [`tensor-parallel-size=${count}`] });

export function buildPodBody({ profile, candidate, apiKey, hfToken, minCudaVersion, supervisorSource = SUPERVISOR }) {
  const withVolume = Boolean(candidate.withVolume && profile.volume?.id);
  const env = {
    LLMPOD_SUPERVISOR_B64: Buffer.from(supervisorSource).toString('base64'),
    LLMPOD_MODEL: profile.model.id,
    LLMPOD_SERVED_NAME: profile.servedName,
    LLMPOD_VLLM_ARGS: JSON.stringify(argsForCount(profile.vllm.args, candidate.count)),
    LLMPOD_IDLE_MINUTES: String(profile.watchdog.idleMinutes),
    LLMPOD_MAX_HOURS: String(profile.watchdog.maxHours),
    LLMPOD_MODEL_BYTES: String(profileDownloadBytes(profile)),
    HF_HOME: withVolume ? '/workspace/hf' : '/root/.cache/huggingface',
    VLLM_API_KEY: apiKey,
    // Multi-GPU senza NVLink: il supervisore avvia vLLM con l'ambiente del Pod, quindi NCCL le legge da qui.
    ...ncclEnv({ gpuId: candidate.id, count: candidate.count, ncclSafe: profile.ncclSafe }),
  };
  if (profile.model.gated && hfToken) env.HF_TOKEN = hfToken;

  const body = {
    name: `llmpod-${profile.name}`,
    image: profile.vllm.image,
    cloud: profile.cloud,
    gpu: { id: candidate.id, count: candidate.count, minCudaVersion },
    dataCenterIds: [candidate.dataCenterId],
    ports: ['8000/http', '8001/http'],
    entrypoint: ['/bin/sh', '-c'],
    cmd: [START_CMD],
    env,
    disk: withVolume ? 20 : Math.ceil((profileDownloadBytes(profile) / 1e9) * 1.2) + 20,
  };
  if (withVolume) body.mounts = { network: [{ volumeId: profile.volume.id, path: '/workspace' }] };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
    throw new LlmpodError(Codes.INVALID_INPUT, 'La richiesta di creazione del Pod supera i 100 KB consentiti da Runpod');
  }
  return body;
}
