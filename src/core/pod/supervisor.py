#!/usr/bin/env python3
"""Supervisore llmpod: avvia vLLM, espone lo stato su :8001 e termina il Pod per inattività.

Solo libreria standard. Configurazione tramite variabili d'ambiente (vedi env_config).
Il Pod si termina con la RUNPOD_API_KEY iniettata da Runpod, che può agire solo su questo Pod.
"""
import hmac
import json
import os
import re
import signal
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


def termination_reason(now, started_at, max_seconds, idle_seconds, idle_limit):
    if now - started_at >= max_seconds:
        return 'max-duration'
    if idle_seconds is not None and idle_seconds >= idle_limit:
        return 'idle'
    return None


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
        'max_restarts': int(env.get('LLMPOD_MAX_RESTARTS', '2')),
        'state_dir': env.get('LLMPOD_STATE_DIR', '/root'),
    }


def dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
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
        self.proc = None
        self.args = list(cfg['args'])
        self.phase = 'downloading' if cfg['model_bytes'] > 0 else 'loading'
        self.restarts = 0
        self.last_error = None
        self.kv_tokens = None
        self.downloaded = 0
        self.tracker = None
        self.expected_exit = False
        self.terminate_reason = None

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

    # --- log ---
    def log(self, line):
        line = line.rstrip('\n')[:2000]
        with self.lock:
            self.log_seq += 1
            self.logs.append((self.log_seq, line))
        kv = parse_kv_tokens(line)
        if kv:
            self.kv_tokens = kv

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
            self.proc = subprocess.Popen(self.vllm_command(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                         text=True, bufsize=1, env=dict(os.environ))
            threading.Thread(target=self._read_output, args=(self.proc,), daemon=True).start()
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
                self.last_error = None
            return True

    def reload(self, args):
        try:
            with self.proc_lock:
                self.log('[llmpod] ricarica di vLLM con nuovi argomenti')
                self.stop_vllm()
                self.args = list(args)
                self.phase = 'loading'
                self.restarts = 0
                self.last_error = None
                self.start_vllm()
        except Exception as e:  # noqa: BLE001
            self.phase = 'error'
            self.last_error = f'ricarica fallita: {e}'
            self.log(f'[llmpod] {self.last_error}')
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
                if (self.phase != 'terminating' and self.proc is not None
                        and self.proc.poll() is not None and not self.expected_exit):
                    code = self.proc.returncode
                    self.log(f'[llmpod] vLLM terminato con codice {code}')
                    if self.restarts < self.cfg['max_restarts']:
                        self.restarts += 1
                        self.phase = 'loading'
                        self.start_vllm()
                    else:
                        self.phase = 'error'
                        self.last_error = f'vLLM terminato con codice {code} dopo {self.restarts} riavvii'
                        if self.tracker is None:
                            self.tracker = IdleTracker(now)
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
        tracker = self.tracker
        idle = tracker.idle_seconds(now) if tracker else None
        return termination_reason(now, self.started_at, self.cfg['max_seconds'], idle, self.cfg['idle_seconds'])

    def status(self):
        now = self.clock()
        tracker = self.tracker
        return {
            'phase': self.phase, 'downloadedBytes': self.downloaded, 'totalBytes': self.cfg['model_bytes'],
            'idleSeconds': round(tracker.idle_seconds(now)) if tracker else None,
            'idleLimitSeconds': self.cfg['idle_seconds'], 'uptimeSeconds': round(now - self.started_at),
            'maxSeconds': self.cfg['max_seconds'], 'restarts': self.restarts, 'lastError': self.last_error,
            'kvCacheTokens': self.kv_tokens, 'terminateReason': self.terminate_reason, 'args': self.args,
            'version': VERSION,
        }

    def _measure_download(self):
        while self.phase == 'downloading':
            self.downloaded = dir_size(os.path.join(self.cfg['hf_home'], 'hub'))
            time.sleep(10)

    def tick(self):
        """Un giro del loop: controllo e, se dovuto, terminazione. Un errore nel controllo non impedisce di spegnere il Pod."""
        try:
            reason = self.step()
        except Exception as e:  # noqa: BLE001
            self.log(f'[llmpod] errore nel controllo: {e}')
            now = self.clock()
            idle = self.tracker.idle_seconds(now) if self.tracker else None
            reason = termination_reason(now, self.started_at, self.cfg['max_seconds'], idle, self.cfg['idle_seconds'])
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
            self.phase = 'error'
            self.last_error = f'avvio di vLLM fallito: {e}'
            self.log(f'[llmpod] {self.last_error}')
            self.tracker = IdleTracker(self.clock())
        threading.Thread(target=self._measure_download, daemon=True).start()
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
            if self.path != '/reload':
                return self._send(404, {'error': 'not found'})
            length = min(int(self.headers.get('Content-Length') or 0), 65536)
            try:
                payload = json.loads(self.rfile.read(length) or b'{}')
            except ValueError:
                return self._send(400, {'error': 'JSON non valido'})
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
