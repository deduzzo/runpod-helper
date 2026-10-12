#!/usr/bin/env python3
"""Supervisore llmpod: avvia vLLM, espone lo stato su :8001 e termina il Pod per inattività.

Solo libreria standard. Configurazione tramite variabili d'ambiente (vedi env_config).
Il Pod si termina con la RUNPOD_API_KEY iniettata da Runpod, che può agire solo su questo Pod.
"""
import hmac
import json
import math
import os
import re
import signal
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = '0.1.0'
USER_AGENT = 'llmpod-supervisor/' + VERSION
METRIC_LINE = re.compile(r'^([A-Za-z_:][A-Za-z0-9_:]*)(\{.*\})?\s+(\S+)')
KV_LINE = re.compile(r'KV cache size:\s*([\d,]+)\s*tokens')
RELOAD_FORBIDDEN = ('--api-key', '--host', '--port', '--served-model-name', '--config')


def parse_metrics(text):
    """Restituisce (richieste in corso + in attesa, richieste completate totali)."""
    sums = {}
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        m = METRIC_LINE.match(line)
        if not m:
            continue
        try:
            value = float(m.group(3))
        except ValueError:
            continue
        sums[m.group(1)] = sums.get(m.group(1), 0.0) + value
    in_flight = sums.get('vllm:num_requests_running', 0.0) + sums.get('vllm:num_requests_waiting', 0.0)
    return in_flight, sums.get('vllm:request_success_total', 0.0)


def parse_kv_tokens(line):
    m = KV_LINE.search(line)
    return int(m.group(1).replace(',', '')) if m else None


# Barra tqdm di vLLM durante la lettura dei pesi: "Loading safetensors checkpoint shards:  66% Completed | 135/206 [14:39<08:15, 6.98s/it]".
LOAD_LINE = re.compile(r'Loading safetensors checkpoint shards:\s*(\d+)%\s*Completed\s*\|\s*(\d+)/(\d+)\s*\[([\d:]+)<([\d:]+|\?)')
# Righe che indicano che vLLM sta leggendo i pesi (da qui un riavvio ricaricherebbe tutto). Non "Starting to load model":
# il download da Hugging Face avviene dentro load_model, dopo quella riga.
LOAD_START = re.compile(r'Loading safetensors checkpoint shards|Loading weights took')
# Pesi letti: da qui vLLM prepara KV cache, compilazione e CUDA graph (con comunicazione NCCL tra le GPU).
LOAD_DONE = re.compile(r'Loading weights took|Model loading took')
# Messaggi "contenitore" di EngineCore e APIServer: ripetono o rimandano alla causa stampata prima da un altro processo.
WRAPPER_RE = re.compile(r'Engine core initialization failed|Worker failed with error|check the stack trace above|'
                        r'See root cause above|EngineCore failed|EngineDeadError|Worker proc \S+ died', re.I)
# Errori non transitori: un riavvio ripeterebbe lo stesso errore (e, durante il caricamento, ricaricherebbe tutti i pesi).
FATAL_RE = re.compile(r'NCCL error|CUDA error|Cuda failure|cudaError|out of memory|OutOfMemoryError|illegal memory access|'
                      r'NotImplementedError|ValueError|AssertionError', re.I)
# Errori di rete o del download (Hugging Face), che possono sparire ritentando.
TRANSIENT_RE = re.compile(r'ConnectionError|ConnectTimeout|ReadTimeout|Timeout(Error)?\b|Connection (reset|refused|aborted)|'
                          r'Temporary failure in name resolution|Name or service not known|MaxRetryError|IncompleteRead|'
                          r'ChunkedEncodingError|ProtocolError|LocalEntryNotFoundError|HfHubHTTPError: 5\d\d|'
                          r'\b50[234] Server Error|429 Client Error')
CAUSE_RE = re.compile(r'(\b[A-Z]\w*(Error|Exception|Timeout)\b|CUDA error|Cuda failure|out of memory|not supported|unsupported|NotImplemented)')
WARNING_RE = re.compile(r'\bWARNING\b')
# Processi di compilazione (Inductor, JIT di FlashInfer/Triton, autotune): finché girano vLLM può restare muto a lungo.
COMPILERS = {'ninja', 'nvcc', 'cicc', 'ptxas', 'cc1plus', 'cc1', 'ld', 'ld.lld', 'ld.gold', 'gcc', 'g++', 'c++', 'cc',
             'cudafe++', 'fatbinary', 'nvlink', 'clang', 'clang++'}
COMPILE_CMDLINE = re.compile(r'\b(ninja|nvcc|ptxas|cicc)\b|(triton|flashinfer)\S*[/_](build|jit|compile)')
STALL_POSTPONE_SECONDS = 600


def stall_cause(minutes):
    return (f'vLLM fermo senza log da {minutes} minuti dopo il caricamento dei pesi '
            '(possibile blocco NCCL/P2P o compilazione molto lunga)')
FRAME_RE = re.compile(r'^\s*(File "|\^+\s*$|Traceback \(most recent call last\)|return |raise$)')
PROC_PREFIX = re.compile(r'^\([\w.-]+ pid=\d+\)\s*')


def _seconds(text):
    """'mm:ss' o 'h:mm:ss' di tqdm in secondi; None per '?'."""
    if not text or text == '?':
        return None
    total = 0
    for part in text.split(':'):
        if not part.isdigit():
            return None
        total = total * 60 + int(part)
    return total


def parse_load_progress(line):
    m = LOAD_LINE.search(line)
    if not m:
        return None
    return {'done': int(m.group(2)), 'total': int(m.group(3)), 'percent': int(m.group(1)),
            'elapsedSeconds': _seconds(m.group(4)), 'remainingSeconds': _seconds(m.group(5))}


def cause_line(line):
    """La riga senza il prefisso del processo se descrive un errore (non un frame dello stack), altrimenti None."""
    clean = PROC_PREFIX.sub('', line).strip()
    if not clean or FRAME_RE.match(clean) or not CAUSE_RE.search(clean):
        return None
    return clean


def classify_line(line):
    """'wrapper' (messaggio contenitore), 'fatal' (errore non transitorio), 'transient' (rete/download) o None."""
    clean = cause_line(line)
    if clean is None:
        return None
    if WRAPPER_RE.search(clean):
        return 'wrapper'
    if FATAL_RE.search(clean):
        return 'fatal'
    if TRANSIENT_RE.search(clean):
        return 'transient'
    return None


def compiling_descendants(pid, proc_root='/proc'):
    """Nomi dei processi di compilazione discendenti di `pid`, letti da /proc (stat per il padre, comm e cmdline)."""
    children = {}
    names = {}
    try:
        entries = [e for e in os.listdir(proc_root) if e.isdigit()]
    except OSError:
        return []
    for entry in entries:
        try:
            with open(os.path.join(proc_root, entry, 'stat')) as f:
                stat_line = f.read()
        except OSError:
            continue
        head, _, rest = stat_line.rpartition(')')
        fields = rest.split()
        if len(fields) < 2 or not fields[1].lstrip('-').isdigit():
            continue
        child = int(entry)
        children.setdefault(int(fields[1]), []).append(child)
        names[child] = head.partition('(')[2]
    found = []
    stack = list(children.get(pid, []))
    seen = set()
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(children.get(cur, []))
        comm = names.get(cur, '')
        cmdline = ''
        try:
            with open(os.path.join(proc_root, str(cur), 'cmdline'), 'rb') as f:
                cmdline = f.read().replace(b'\0', b' ').decode('utf-8', 'replace')
        except OSError:
            pass
        if comm in COMPILERS or COMPILE_CMDLINE.search(cmdline):
            found.append(comm)
    return found


def restart_decision(loading_started, fatal, transient, restarts, max_restarts, was_ready=False):
    """(riavviare?, motivo). Durante l'avvio si riavvia solo per errori chiaramente transitori prima della lettura dei pesi:
    un riavvio dopo ricaricherebbe tutti i pesi (anche 20 minuti a pagamento) e un errore NCCL/CUDA/OOM si ripeterebbe.
    Un crash con vLLM già pronto (a runtime) ha diritto a un riavvio."""
    if was_ready:
        if restarts >= max_restarts:
            return False, f'dopo {restarts} riavvii'
        return True, 'crash di vLLM dopo che era pronto'
    if loading_started:
        return False, 'durante il caricamento dei pesi: nessun riavvio automatico (ricaricare i pesi costerebbe altro tempo)'
    if fatal:
        return False, 'per un errore non transitorio: nessun riavvio automatico'
    if not transient:
        return False, 'senza un errore transitorio riconosciuto: nessun riavvio automatico'
    if restarts >= max_restarts:
        return False, f'dopo {restarts} riavvii'
    return True, 'errore transitorio (rete o download) prima del caricamento dei pesi'


class IdleTracker:
    def __init__(self, now):
        self.last_activity = now
        self.last_success = None

    def observe(self, now, in_flight, success_total):
        if in_flight > 0 or (self.last_success is not None and success_total > self.last_success):
            self.last_activity = now
        self.last_success = success_total

    def idle_seconds(self, now):
        return now - self.last_activity


IDLE_MINUTES_RANGE = (5, 1440)   # oppure 0 = inattività disattivata
MAX_HOURS_RANGE = (0.25, 168)
MIN_REMAINING_SECONDS = 300      # margine: non si accorcia il massimo fin quasi all'uptime (il Pod verrebbe eliminato subito)


def termination_reason(now, started_at, max_seconds, idle_seconds, idle_limit):
    """idle_limit <= 0 disattiva lo spegnimento per inattività: resta la durata massima."""
    if now - started_at >= max_seconds:
        return 'max-duration'
    if idle_limit > 0 and idle_seconds is not None and idle_seconds >= idle_limit:
        return 'idle'
    return None


def _bounded_number(value, low, high, label, integer=False, allow_zero=False):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'{label} deve essere un numero')
    try:
        if not math.isfinite(value) or (integer and float(value) != int(value)):
            raise ValueError(f'{label} deve essere un numero' + (' intero' if integer else ''))
        ok = (allow_zero and value == 0) or low <= value <= high
        value = float(value)
    except OverflowError:  # interi JSON enormi
        raise ValueError(f'{label} fuori intervallo') from None
    if not ok:
        raise ValueError(f'{label} deve essere ' + ('0 oppure ' if allow_zero else '') + f'tra {low} e {high}')
    return value


def valid_watchdog(payload):
    """Valida il corpo di POST /watchdog. Restituisce (idleMinutes, maxHours); None = invariato.
    idleMinutes: intero, 0 (disattivata) oppure 5..1440. ValueError se non valido o se non c'è nessun valore."""
    if not isinstance(payload, dict):
        raise ValueError('corpo non valido')
    idle = _bounded_number(payload.get('idleMinutes'), *IDLE_MINUTES_RANGE, 'idleMinutes', integer=True, allow_zero=True)
    hours = _bounded_number(payload.get('maxHours'), *MAX_HOURS_RANGE, 'maxHours')
    if idle is None and hours is None:
        raise ValueError('nessun valore da cambiare')
    return idle, hours


def valid_reload_args(payload):
    args = payload.get('args') if isinstance(payload, dict) else None
    if not isinstance(args, list) or not 0 < len(args) <= 200:
        return None
    if not all(isinstance(a, str) and 0 < len(a) <= 2000 for a in args):
        return None
    if any(forbidden_option(a) for a in args):
        return None
    return args


def forbidden_option(arg):
    """Vero se l'argomento è (anche abbreviato o con '_') un'opzione vietata in /reload."""
    if not arg.startswith('--'):
        return False
    name = arg.split('=')[0].replace('_', '-').lower()
    if name in RELOAD_FORBIDDEN:
        return True
    # argparse accetta abbreviazioni univoche (--por, --serv): vietate se prefisso di un'opzione vietata
    return len(name) >= 5 and any(f.startswith(name) for f in RELOAD_FORBIDDEN)


def delete_pod(api, pod_id, key):
    """DELETE del Pod con la chiave iniettata. Restituisce (ok, errore)."""
    req = urllib.request.Request(f'{api}/pods/{pod_id}', method='DELETE',
                                 headers={'User-Agent': USER_AGENT, 'Authorization': 'Bearer ' + key})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            if r.status in (200, 202, 204):
                return True, None
            return False, f'terminazione fallita: HTTP {r.status}'
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return True, None
        return False, f'terminazione fallita: HTTP {e.code}'
    except Exception as e:  # noqa: BLE001
        return False, f'terminazione fallita: {e}'


def emergency_terminate(env):
    """Un tentativo di terminare il Pod leggendo solo l'ambiente (configurazione rotta). Restituisce True se riuscito."""
    pod_id = env.get('RUNPOD_POD_ID', '')
    key = env.get('RUNPOD_API_KEY', '')
    if not pod_id or not key:
        print('[llmpod] RUNPOD_POD_ID o RUNPOD_API_KEY mancanti: impossibile terminare il Pod', file=sys.stderr, flush=True)
        return False
    ok, err = delete_pod(env.get('LLMPOD_RUNPOD_API', 'https://api.runpod.io/v2'), pod_id, key)
    if not ok:
        print(f'[llmpod] {err}', file=sys.stderr, flush=True)
    return ok


def env_config(env):
    port = int(env.get('LLMPOD_VLLM_PORT', '8000'))
    return {
        'model': env['LLMPOD_MODEL'],
        'served_name': env['LLMPOD_SERVED_NAME'],
        'args': json.loads(env.get('LLMPOD_VLLM_ARGS', '[]')),
        'api_key': env['VLLM_API_KEY'],
        'idle_seconds': float(env.get('LLMPOD_IDLE_MINUTES', '30')) * 60,
        'max_seconds': float(env.get('LLMPOD_MAX_HOURS', '8')) * 3600,
        'check_seconds': float(env.get('LLMPOD_CHECK_SECONDS', '60')),
        'model_bytes': int(env.get('LLMPOD_MODEL_BYTES', '0')),
        'hf_home': env.get('HF_HOME', '/root/.cache/huggingface'),
        'pod_id': env.get('RUNPOD_POD_ID', ''),
        'runpod_key': env.get('RUNPOD_API_KEY', ''),
        'runpod_api': env.get('LLMPOD_RUNPOD_API', 'https://api.runpod.io/v2'),
        'vllm_port': port,
        'vllm_url': f'http://127.0.0.1:{port}',
        'vllm_cmd': json.loads(env['LLMPOD_VLLM_CMD']) if env.get('LLMPOD_VLLM_CMD') else ['vllm', 'serve'],
        'status_port': int(env.get('LLMPOD_STATUS_PORT', '8001')),
        'max_restarts': int(env.get('LLMPOD_MAX_RESTARTS', '1')),  # solo errori transitori prima dei pesi
        # riavvii dopo crash a runtime (vLLM era pronto) per tutta la vita del Pod; si azzera solo con reload/tune
        'max_runtime_restarts': int(env.get('LLMPOD_MAX_RUNTIME_RESTARTS', '2')),
        'state_dir': env.get('LLMPOD_STATE_DIR', '/root'),
        # vLLM fermo senza log dopo la lettura dei pesi: si dichiara bloccato (tipico di un problema NCCL/P2P tra le GPU)
        # (predefinito 30: la compilazione di vLLM su Blackwell a freddo può restare muta a lungo; llmpod lo passa dal profilo)
        'stall_seconds': float(env.get('LLMPOD_STALL_MINUTES', '30')) * 60,
        # un Pod in errore si elimina dopo questo tempo anche con l'inattività disattivata
        'error_seconds': float(env.get('LLMPOD_ERROR_MINUTES', '15')) * 60,
    }


def model_cache_bytes(hf_home, model):
    """Byte già scaricati del modello nella cache di Hugging Face (hub/models--org--nome).

    Solo i file regolari (blobs, anche .incomplete): i file in snapshots/ sono link ai blobs e non vanno contati due
    volte; gli altri modelli in cache (es. sul volume di rete) non contano."""
    path = os.path.join(hf_home, 'hub', 'models--' + model.replace('/', '--'))
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                st = os.lstat(os.path.join(root, name))
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                total += st.st_size
    return total


class Supervisor:
    def __init__(self, cfg, clock=time.time):
        self.cfg = cfg
        self.clock = clock
        self.lock = threading.Lock()
        self.proc_lock = threading.RLock()
        self.reloading = False
        self.logs = deque(maxlen=500)
        self.log_seq = 0
        self.started_at = self._load_started_at()
        self.idle_seconds = cfg['idle_seconds']
        self.max_seconds = cfg['max_seconds']
        self._load_watchdog()
        self.proc = None
        self.args = list(cfg['args'])
        self.phase = 'downloading' if cfg['model_bytes'] > 0 else 'loading'
        self.restarts = 0
        self.runtime_restarts = 0
        self.last_error = None
        self.error_cause = None
        self.error_since = None
        self.kv_tokens = None
        self.downloaded = 0
        self.tracker = None
        self.expected_exit = False
        self.terminate_reason = None
        self.reader = None
        self.meter = None
        self._reset_run()

    def _reset_run(self):
        """Stato del singolo processo vLLM: si azzera a ogni avvio (riavvio o ricarica)."""
        self.load_progress = None
        self.loading_started = False
        self.weights_loaded = False
        self.last_output_at = self.clock()
        self.fatal_cause = None
        self.transient_cause = None
        self.wrapper_cause = None
        self.last_cause = None

    def current_cause(self):
        """La causa più specifica vista: prima riga fatale, poi transitoria, poi il primo messaggio contenitore, poi l'ultima riga d'errore."""
        return self.fatal_cause or self.transient_cause or self.wrapper_cause or self.last_cause

    def fail(self, message, cause=None):
        """Passa a 'error' (una sola volta per evento): l'inattività inizia a contare e dopo error_seconds il Pod si elimina."""
        now = self.clock()
        self.phase = 'error'
        self.error_cause = cause
        self.last_error = message
        self.error_since = now
        self.log(f'[llmpod] {message}')
        if self.tracker is None:
            self.tracker = IdleTracker(now)

    def _load_started_at(self):
        """Istante di avvio persistito per Pod: se il container riparte la durata massima non si azzera."""
        now = self.clock()
        pod_id = self.cfg['pod_id']
        if not pod_id:
            return now
        path = os.path.join(self.cfg.get('state_dir', '/root'), f'.llmpod-started-{pod_id}')
        try:
            with open(path) as f:
                return float(f.read().strip())
        except (OSError, ValueError):
            pass
        try:
            with open(path, 'w') as f:
                f.write(repr(now))
        except OSError as e:
            self.log(f'[llmpod] impossibile salvare l\'ora di avvio: {e}')
        return now

    def _watchdog_path(self):
        return os.path.join(self.cfg.get('state_dir', '/root'), f'.llmpod-watchdog-{self.cfg["pod_id"] or "local"}')

    def _load_watchdog(self):
        """Limiti modificati con POST /watchdog: se il supervisore riparte restano quelli (non tornano a quelli dell'ambiente)."""
        try:
            with open(self._watchdog_path()) as f:
                data = json.load(f)
        except (OSError, ValueError):  # assente o corrotto: valgono i valori dell'ambiente
            return
        if not isinstance(data, dict):
            return
        for key, factor, attr in (('idleMinutes', 60, 'idle_seconds'), ('maxHours', 3600, 'max_seconds')):
            try:  # ogni valore si valida da solo: uno fuori intervallo non scarta l'altro
                value = [v for v in valid_watchdog({key: data.get(key)}) if v is not None][0]
            except (ValueError, IndexError):
                continue
            setattr(self, attr, value * factor)

    def set_watchdog(self, idle_minutes, max_hours):
        """Aggiorna i limiti di spegnimento (None = invariato) e li persiste. maxHours si misura sempre dall'avvio.
        Cambiando l'inattività si riparte da adesso, così riattivarla non spegne subito un Pod rimasto fermo."""
        persisted = True
        with self.lock:
            uptime = self.clock() - self.started_at
            if max_hours is not None and max_hours * 3600 <= uptime + MIN_REMAINING_SECONDS:
                raise ValueError(f'con questo massimo il Pod verrebbe eliminato subito: è acceso da {round(uptime)} s '
                                 f'(serve almeno {MIN_REMAINING_SECONDS} s di margine)')
            if idle_minutes is not None:
                self.idle_seconds = idle_minutes * 60
                if self.tracker is not None:
                    self.tracker.last_activity = self.clock()
            if max_hours is not None:
                self.max_seconds = max_hours * 3600
            data = {'idleMinutes': self.idle_seconds / 60, 'maxHours': self.max_seconds / 3600}
            path = self._watchdog_path()
            try:
                with open(path + '.tmp', 'w') as f:
                    json.dump(data, f)
                os.replace(path + '.tmp', path)
            except OSError:
                persisted = False
            result = {'ok': True, 'idleLimitSeconds': self.idle_seconds, 'maxSeconds': self.max_seconds,
                      'uptimeSeconds': round(self.clock() - self.started_at), 'persisted': persisted}
        self.log(f'[llmpod] limiti di spegnimento: inattività {data["idleMinutes"]:g} min, durata massima {data["maxHours"]:g} h'
                 + ('' if persisted else ' (non salvati su disco)'))
        return result

    # --- log ---
    def log(self, line):
        line = line.rstrip('\n')[:2000]
        with self.lock:
            self.log_seq += 1
            self.logs.append((self.log_seq, line))
        kv = parse_kv_tokens(line)
        if kv:
            self.kv_tokens = kv
        if not line.startswith('[llmpod]'):
            self._observe(line)

    def _observe(self, line):
        """Avanzamento del caricamento dei pesi e cause d'errore dalle righe di vLLM."""
        self.last_output_at = self.clock()
        progress = parse_load_progress(line)
        if progress:
            self.load_progress = progress
            if progress['total'] and progress['done'] >= progress['total']:
                self.weights_loaded = True
            if self.phase == 'downloading':
                self.phase = 'loading'  # vLLM sta leggendo i pesi: il download è concluso
        if LOAD_START.search(line):
            self.loading_started = True
        if LOAD_DONE.search(line):
            self.weights_loaded = True
        kind = classify_line(line)
        cause = cause_line(line)
        # Vince la PRIMA riga specifica: i messaggi successivi di EngineCore/APIServer la ripetono o la avvolgono.
        if kind == 'fatal' and self.fatal_cause is None:
            self.fatal_cause = cause
        elif kind == 'transient' and self.transient_cause is None:
            self.transient_cause = cause
        elif kind == 'wrapper' and self.wrapper_cause is None:
            self.wrapper_cause = cause
        if cause and not WARNING_RE.search(line):
            self.last_cause = cause

    def logs_since(self, since):
        with self.lock:
            return [{'n': n, 'line': text} for n, text in self.logs if n > since]

    def _read_output(self, proc):
        for line in proc.stdout:
            self.log(line)

    # --- vLLM ---
    def vllm_command(self):
        c = self.cfg
        return c['vllm_cmd'] + [c['model'], '--served-model-name', c['served_name'],
                                '--host', '0.0.0.0', '--port', str(c['vllm_port'])] + self.args

    def start_vllm(self):
        with self.proc_lock:
            self.expected_exit = False
            self._reset_run()
            # vLLM eredita l'ambiente del Pod, comprese le variabili NCCL (es. NCCL_P2P_DISABLE su GPU PCIe senza NVLink).
            nccl = sorted(f'{k}={v}' for k, v in os.environ.items() if k.startswith('NCCL_'))
            if nccl:
                self.log('[llmpod] ambiente NCCL: ' + ' '.join(nccl))
            self.proc = subprocess.Popen(self.vllm_command(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                         text=True, bufsize=1, env=dict(os.environ))
            self.reader = threading.Thread(target=self._read_output, args=(self.proc,), daemon=True)
            self.reader.start()
            self.log(f'[llmpod] vLLM avviato (pid {self.proc.pid})')

    def stop_vllm(self, timeout=30):
        with self.proc_lock:
            if self.proc and self.proc.poll() is None:
                self.expected_exit = True
                self.proc.terminate()
                try:
                    self.proc.wait(timeout)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    try:
                        self.proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        self.log('[llmpod] vLLM non risponde a SIGKILL')

    def try_begin_reload(self, args=None):
        """Prenota la ricarica: False se ce n'è già una in corso.

        Con `args` imposta nello stesso istante (sotto lock) i nuovi argomenti e la fase 'loading',
        prima che il vecchio processo venga fermato: lo stato non riporta mai 'ready' per il vecchio vLLM."""
        with self.lock:
            if self.reloading:
                return False
            self.reloading = True
            # Durante la riparazione l'inattività non conta: il watchdog non deve spegnere il Pod (resta la durata massima).
            self.tracker = None
            if args is not None:
                self.args = list(args)
                self.phase = 'loading'
                self.restarts = 0
                self.runtime_restarts = 0  # reload/tune esplicito: il conto dei crash a runtime riparte
                self.last_error = None
                self.error_cause = None
                self.error_since = None
            return True

    def reload(self, args):
        try:
            with self.proc_lock:
                self.log('[llmpod] ricarica di vLLM con nuovi argomenti')
                self.stop_vllm()
                self.args = list(args)
                self.phase = 'loading'
                self.restarts = 0
                self.runtime_restarts = 0  # reload/tune esplicito: il conto dei crash a runtime riparte
                self.last_error = None
                self.error_cause = None
                self.error_since = None
                self.start_vllm()
        except Exception as e:  # noqa: BLE001
            self.fail(f'ricarica fallita: {e}')
        finally:
            with self.lock:
                # Come al primo avvio: l'inattività si conta da 'ready' (lo imposta step) o subito in caso di errore.
                self.tracker = IdleTracker(self.clock()) if self.phase == 'error' else None
                self.reloading = False

    # --- HTTP verso vLLM e Runpod ---
    def _get(self, path, auth=False, timeout=5):
        headers = {'User-Agent': USER_AGENT}
        if auth:
            headers['Authorization'] = 'Bearer ' + self.cfg['api_key']
        req = urllib.request.Request(self.cfg['vllm_url'] + path, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode('utf-8', 'replace')

    def check_ready(self):
        try:
            return self._get('/v1/models', auth=True)[0] == 200
        except Exception:  # noqa: BLE001 — vLLM non ancora in ascolto
            return False

    def can_promote(self):
        """Vero se si può sondare vLLM per dichiararlo pronto: non durante una ricarica
        (il vecchio processo potrebbe ancora rispondere) e solo con un processo corrente vivo."""
        if self.reloading:
            return False
        proc = self.proc
        return proc is not None and proc.poll() is None

    def terminate_pod(self):
        c = self.cfg
        if not c['pod_id'] or not c['runpod_key']:
            self.last_error = 'RUNPOD_POD_ID o RUNPOD_API_KEY mancanti: impossibile terminare il Pod'
            return False
        ok, err = delete_pod(c['runpod_api'], c['pod_id'], c['runpod_key'])
        if not ok:
            self.last_error = err
        return ok

    # --- ciclo di controllo ---
    def step(self):
        """Un controllo: aggiorna fase e inattività, restituisce il motivo di terminazione o None."""
        now = self.clock()
        # Non attendere mai proc_lock: durante una ricarica si salta il rilevamento crash,
        # così il controllo di terminazione non resta bloccato.
        if self.proc_lock.acquire(blocking=False):
            try:
                # In 'error' il processo morto resta lì: il crash si gestisce una volta sola.
                if (self.phase not in ('terminating', 'error') and self.proc is not None
                        and self.proc.poll() is not None and not self.expected_exit):
                    code = self.proc.returncode
                    was_ready = self.phase == 'ready'
                    reader = self.reader
                    if reader is not None:
                        reader.join(5)  # le ultime righe (la causa) arrivano dopo la fine del processo
                    self.log(f'[llmpod] vLLM terminato con codice {code}')
                    restart, why = restart_decision(self.loading_started, self.fatal_cause is not None,
                                                    self.transient_cause is not None, self.restarts, self.cfg['max_restarts'],
                                                    was_ready=was_ready)
                    cause = self.current_cause()
                    if restart and was_ready and self.runtime_restarts >= self.cfg.get('max_runtime_restarts', 2):
                        # Ciclo pronto → crash → riavvio: ogni giro ricarica i pesi e costa. Limite per la vita del Pod.
                        crashes = self.runtime_restarts + 1
                        limit_cause = f"vLLM si è bloccato {crashes} volte dopo l'avvio"
                        self.fail(f'{limit_cause}: nessun altro riavvio automatico' + (f' — ultima causa: {cause[:300]}' if cause else ''), limit_cause)
                    elif restart:
                        if was_ready:
                            self.runtime_restarts += 1
                        self.restarts += 1
                        self.log(f'[llmpod] {why} ({cause}): nuovo tentativo {self.restarts}/{self.cfg["max_restarts"]}')
                        if was_ready:
                            self.tracker = None  # come in una ricarica: l'inattività riparte da 'ready'
                        self.phase = 'downloading' if self.cfg['model_bytes'] > 0 and not was_ready else 'loading'
                        self.start_vllm()
                        self._start_download_meter()
                    else:
                        self.fail(f'vLLM terminato con codice {code} {why}' + (f' — causa: {cause[:300]}' if cause else ''), cause)
                elif self._stalled(now):
                    compilers = self._compiling()
                    if compilers:
                        # Compilazione in corso (Inductor, JIT FlashInfer/Triton): non è un blocco, si riguarda tra 10 minuti.
                        self.last_output_at = now - self.cfg.get('stall_seconds', 1800) + STALL_POSTPONE_SECONDS
                        self.log(f'[llmpod] compilazione in corso ({", ".join(sorted(set(compilers)))}), attendo')
                    else:
                        cause = stall_cause(round(self.cfg.get('stall_seconds', 1800) / 60))
                        self.expected_exit = True
                        if self.proc is not None and self.proc.poll() is None:
                            self.proc.terminate()  # senza attendere: il controllo non si blocca
                        self.fail(cause, cause)
            finally:
                self.proc_lock.release()
        if self.phase in ('downloading', 'loading'):
            promoted = False
            if self.can_promote() and self.check_ready():
                # Un reload può essere partito dopo il sondaggio: sotto lock si riverifica prima di scrivere 'ready'.
                with self.lock:
                    if not self.reloading:
                        self.phase = 'ready'
                        self.tracker = IdleTracker(now)
                        # Di nuovo pronto dopo un riavvio: un crash successivo ha ancora diritto a un riavvio (mai due consecutivi).
                        self.restarts = 0
                        promoted = True
            if promoted:
                self.log('[llmpod] vLLM pronto')
            elif self.phase == 'downloading' and self.downloaded >= self.cfg['model_bytes'] * 0.98:
                self.phase = 'loading'
        if self.phase == 'ready':
            try:
                in_flight, success = parse_metrics(self._get('/metrics')[1])
                tracker = self.tracker  # può essere stato azzerato da un reload appena partito
                if tracker is not None:
                    tracker.observe(now, in_flight, success)
            except Exception as e:  # noqa: BLE001
                self.log(f'[llmpod] metriche non disponibili: {e}')
        return self._termination(now)

    def _termination(self, now):
        """Motivo di terminazione: durata massima, inattività o errore da error_seconds (anche con inattività "mai")."""
        tracker = self.tracker
        idle = tracker.idle_seconds(now) if tracker else None
        reason = termination_reason(now, self.started_at, self.max_seconds, idle, self.idle_seconds)
        if (reason is None and self.phase == 'error' and self.error_since is not None
                and now - self.error_since >= self.cfg.get('error_seconds', 900)):
            reason = 'error-timeout'
        return reason

    def _compiling(self):
        proc = self.proc
        if proc is None or proc.poll() is not None:
            return []
        return compiling_descendants(proc.pid, self.cfg.get('proc_root', '/proc'))

    def _stalled(self, now):
        """Vero se vLLM, dopo aver letto i pesi, non scrive più nulla da stall_seconds (es. NCCL bloccato tra le GPU)."""
        return (self.phase == 'loading' and self.weights_loaded and not self.reloading
                and now - self.last_output_at >= self.cfg.get('stall_seconds', 600))

    def status(self):
        now = self.clock()
        tracker = self.tracker
        return {
            'phase': self.phase, 'downloadedBytes': self.downloaded, 'totalBytes': self.cfg['model_bytes'],
            'idleSeconds': round(tracker.idle_seconds(now)) if tracker else None,
            'idleLimitSeconds': self.idle_seconds, 'uptimeSeconds': round(now - self.started_at),
            'maxSeconds': self.max_seconds, 'restarts': self.restarts, 'runtimeRestarts': self.runtime_restarts, 'lastError': self.last_error,
            'errorCause': self.error_cause, 'loadProgress': self.load_progress,
            'kvCacheTokens': self.kv_tokens, 'terminateReason': self.terminate_reason, 'args': self.args,
            'version': VERSION, 'features': ['watchdog', 'load-progress'],
        }

    def _measure_download(self):
        while self.phase == 'downloading':
            self.downloaded = model_cache_bytes(self.cfg['hf_home'], self.cfg['model'])
            time.sleep(10)

    def _start_download_meter(self):
        if self.phase == 'downloading' and (self.meter is None or not self.meter.is_alive()):
            self.meter = threading.Thread(target=self._measure_download, daemon=True)
            self.meter.start()

    def tick(self):
        """Un giro del loop: controllo e, se dovuto, terminazione. Un errore nel controllo non impedisce di spegnere il Pod."""
        try:
            reason = self.step()
        except Exception as e:  # noqa: BLE001
            self.log(f'[llmpod] errore nel controllo: {e}')
            reason = self._termination(self.clock())
        if reason:
            self.terminate_reason = reason
            self.phase = 'terminating'
            self.log(f'[llmpod] terminazione del Pod: {reason}')
            if self.terminate_pod():
                self.log('[llmpod] terminazione accettata da Runpod')
            else:
                self.log(f'[llmpod] {self.last_error}; nuovo tentativo al prossimo controllo')
        return reason

    def run(self):
        try:
            self.start_vllm()
        except Exception as e:  # noqa: BLE001
            self.fail(f'avvio di vLLM fallito: {e}')
        self._start_download_meter()
        while True:
            try:
                self.tick()
            except Exception as e:  # noqa: BLE001
                self.log(f'[llmpod] errore nel controllo: {e}')
            time.sleep(self.cfg['check_seconds'])


def make_server(sup):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'llmpod-supervisor'

        def log_message(self, *args):
            pass

        def _authorized(self):
            got = self.headers.get('Authorization', '').encode()
            return hmac.compare_digest(got, ('Bearer ' + sup.cfg['api_key']).encode())

        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self._authorized():
                return self._send(401, {'error': 'unauthorized'})
            url = urllib.parse.urlparse(self.path)
            if url.path == '/status':
                return self._send(200, sup.status())
            if url.path == '/logs':
                try:
                    since = int(urllib.parse.parse_qs(url.query).get('since', ['0'])[0])
                except ValueError:
                    since = 0
                return self._send(200, {'lines': sup.logs_since(since)})
            return self._send(404, {'error': 'not found'})

        def do_POST(self):
            if not self._authorized():
                return self._send(401, {'error': 'unauthorized'})
            if self.path not in ('/reload', '/watchdog'):
                return self._send(404, {'error': 'not found'})
            length = min(int(self.headers.get('Content-Length') or 0), 65536)
            try:
                payload = json.loads(self.rfile.read(length) or b'{}')
            except ValueError:
                return self._send(400, {'error': 'JSON non valido'})
            if self.path == '/watchdog':
                try:
                    idle, hours = valid_watchdog(payload)
                    if sup.phase == 'terminating':
                        return self._send(409, {'error': 'il Pod si sta già spegnendo'})
                    return self._send(200, sup.set_watchdog(idle, hours))
                except ValueError as e:
                    return self._send(400, {'error': str(e)})
            args = valid_reload_args(payload)
            if args is None:
                return self._send(400, {'error': 'args non validi'})
            if not sup.try_begin_reload(args):
                return self._send(409, {'error': 'ricarica già in corso'})
            threading.Thread(target=sup.reload, args=(args,), daemon=True).start()
            return self._send(202, {'ok': True})

    return ThreadingHTTPServer(('0.0.0.0', sup.cfg['status_port']), Handler)


def main():
    try:
        sup = Supervisor(env_config(os.environ))
        server = make_server(sup)
    except Exception as e:  # noqa: BLE001 — configurazione o porta non valide: il Pod a pagamento va comunque spento
        print(f'[llmpod] avvio fallito: {e}', file=sys.stderr, flush=True)
        while not emergency_terminate(os.environ):
            time.sleep(60)
        return
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def on_sigterm(*_args):
        sup.stop_vllm(10)
        sys.exit(0)

    signal.signal(signal.SIGTERM, on_sigterm)
    sup.run()


if __name__ == '__main__':
    main()
