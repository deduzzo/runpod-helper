import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'src', 'core', 'pod'))
import supervisor as sv  # noqa: E402

KEY = 'chiave-di-prova-1234567890'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def wait_until(cond, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.1)
    return False


class FakeRunpod:
    """Finta API Runpod che registra le DELETE ricevute."""

    def __init__(self):
        self.calls = []
        calls = self.calls

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_DELETE(self):
                calls.append({'path': self.path, 'auth': self.headers.get('Authorization'), 'ua': self.headers.get('User-Agent')})
                self.send_response(204)
                self.end_headers()

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/v2'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


class PureFunctions(unittest.TestCase):
    def test_parse_metrics_somma_le_etichette(self):
        text = (
            '# HELP x\n'
            'vllm:num_requests_running{engine="0",model_name="m"} 1.0\n'
            'vllm:num_requests_waiting{engine="0",model_name="m"} 2.0\n'
            'vllm:request_success_total{finished_reason="stop",model_name="m"} 3.0\n'
            'vllm:request_success_total{finished_reason="length",model_name="m"} 2.0\n'
            'altro_valore 9\n'
        )
        self.assertEqual(sv.parse_metrics(text), (3.0, 5.0))

    def test_parse_kv_tokens(self):
        line = 'INFO GPU KV cache size: 1,234,567 tokens, Maximum concurrency for 32,768 tokens per request: 37.68x'
        self.assertEqual(sv.parse_kv_tokens(line), 1234567)
        self.assertIsNone(sv.parse_kv_tokens('nessuna informazione'))

    def test_idle_tracker(self):
        t = sv.IdleTracker(100)
        t.observe(100, 0, 0)
        self.assertEqual(t.idle_seconds(160), 60)
        t.observe(160, 1, 0)  # richiesta in corso
        self.assertEqual(t.idle_seconds(200), 40)
        t.observe(200, 0, 0)
        t.observe(260, 0, 1)  # completata una richiesta tra due controlli
        self.assertEqual(t.idle_seconds(260), 0)

    def test_termination_reason(self):
        self.assertEqual(sv.termination_reason(100, 0, 100, 0, 1800), 'max-duration')
        self.assertEqual(sv.termination_reason(50, 0, 100, 1800, 1800), 'idle')
        self.assertIsNone(sv.termination_reason(50, 0, 100, 10, 1800))
        self.assertIsNone(sv.termination_reason(50, 0, 100, None, 1800))

    def test_termination_reason_inattivita_disattivata(self):
        # limite 0 = inattività disattivata: resta solo la durata massima
        self.assertIsNone(sv.termination_reason(50, 0, 100, 99999, 0))
        self.assertEqual(sv.termination_reason(100, 0, 100, 99999, 0), 'max-duration')

    def test_valid_watchdog(self):
        self.assertEqual(sv.valid_watchdog({'idleMinutes': 90, 'maxHours': 12}), (90.0, 12.0))
        self.assertEqual(sv.valid_watchdog({'idleMinutes': 0, 'maxHours': None}), (0.0, None))
        self.assertEqual(sv.valid_watchdog({'idleMinutes': None, 'maxHours': 0.25}), (None, 0.25))
        self.assertEqual(sv.valid_watchdog({'idleMinutes': 1440, 'maxHours': 168}), (1440.0, 168.0))
        self.assertEqual(sv.valid_watchdog({'idleMinutes': 5}), (5.0, None))
        self.assertEqual(sv.valid_watchdog({'idleMinutes': 90.0}), (90.0, None))
        for bad in (None, [], 'x', {}, {'idleMinutes': None, 'maxHours': None}, {'idleMinutes': 1}, {'idleMinutes': 4}, {'idleMinutes': 5.5},
                    {'idleMinutes': 10 ** 400}, {'maxHours': 10 ** 400}, {'maxHours': -10 ** 400}, {'idleMinutes': -1}, {'idleMinutes': 1441}, {'idleMinutes': '30'}, {'idleMinutes': True},
                    {'idleMinutes': float('nan')}, {'maxHours': 0.1}, {'maxHours': 169}, {'maxHours': 0}, {'maxHours': '8'},
                    {'maxHours': False}, {'maxHours': float('inf')}):
            with self.assertRaises(ValueError, msg=str(bad)):
                sv.valid_watchdog(bad)

    def test_valid_reload_args(self):
        self.assertEqual(sv.valid_reload_args({'args': ['--max-model-len', '4096']}), ['--max-model-len', '4096'])
        for bad in [{}, {'args': []}, {'args': 'x'}, {'args': [1]}, {'args': ['--api-key', 'x']},
                    {'args': ['--port=9000']}, {'args': ['x' * 2001]}, {'args': ['a'] * 201}]:
            self.assertIsNone(sv.valid_reload_args(bad), bad)

    def test_valid_reload_args_non_aggirabile(self):
        for bad in ['--api_key', '--API-KEY=x', '--served_model_name', '--served-model-name=x', '--por', '--hos=0.0.0.0',
                    '--serv', '--config', '--config=/tmp/x.yaml', '--api']:
            self.assertIsNone(sv.valid_reload_args({'args': [bad]}), bad)
        self.assertEqual(sv.valid_reload_args({'args': ['--max-model-len', '4096', '--enable-prefix-caching']}),
                         ['--max-model-len', '4096', '--enable-prefix-caching'])

    def test_parse_load_progress(self):
        line = '(Worker_TP0 pid=231) Loading safetensors checkpoint shards:  66% Completed | 135/206 [14:39<08:15, 6.98s/it]'
        self.assertEqual(sv.parse_load_progress(line), {'done': 135, 'total': 206, 'percent': 66, 'elapsedSeconds': 879, 'remainingSeconds': 495})
        self.assertEqual(sv.parse_load_progress('Loading safetensors checkpoint shards:   0% Completed | 0/206 [00:00<?, ?it/s]'),
                         {'done': 0, 'total': 206, 'percent': 0, 'elapsedSeconds': 0, 'remainingSeconds': None})
        self.assertEqual(sv.parse_load_progress('Loading safetensors checkpoint shards: 10% Completed | 20/206 [1:02:03<9:00:00, 7s/it]')['remainingSeconds'], 32400)
        self.assertIsNone(sv.parse_load_progress('INFO Loading weights took 12.3 seconds'))

    def test_classify_line(self):
        self.assertEqual(sv.classify_line("RuntimeError: Worker failed with error 'NCCL error: unhandled cuda error'"), 'fatal')
        self.assertEqual(sv.classify_line('torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB'), 'fatal')
        self.assertEqual(sv.classify_line('RuntimeError: CUDA error: an illegal memory access was encountered'), 'fatal')
        self.assertEqual(sv.classify_line("requests.exceptions.ReadTimeout: HTTPSConnectionPool(host='cas-bridge.xethub.hf.co')"), 'transient')
        self.assertEqual(sv.classify_line('huggingface_hub.errors.HfHubHTTPError: 503 Server Error: Service Unavailable'), 'transient')
        self.assertEqual(sv.classify_line('OSError: [Errno -3] Temporary failure in name resolution'), 'transient')
        self.assertIsNone(sv.classify_line('INFO Started server process'))
        self.assertIsNone(sv.classify_line('  File "/x/requests/exceptions.py", line 3, in ConnectionError'))

    def test_cause_line(self):
        self.assertEqual(sv.cause_line('(EngineCore_DP0 pid=120) RuntimeError: boom'), 'RuntimeError: boom')
        self.assertIsNone(sv.cause_line('  File "/x.py", line 1, in f'))
        self.assertIsNone(sv.cause_line('INFO tutto bene'))

    def test_restart_decision(self):
        # (riavviare?, motivo): solo errori transitori prima del caricamento dei pesi, entro max_restarts
        self.assertTrue(sv.restart_decision(loading_started=False, fatal=False, transient=True, restarts=0, max_restarts=1)[0])
        self.assertFalse(sv.restart_decision(loading_started=False, fatal=False, transient=True, restarts=1, max_restarts=1)[0])
        self.assertIn('dopo 1 riavvi', sv.restart_decision(loading_started=False, fatal=False, transient=True, restarts=1, max_restarts=1)[1])
        self.assertFalse(sv.restart_decision(loading_started=True, fatal=False, transient=True, restarts=0, max_restarts=1)[0])
        self.assertIn('caricamento dei pesi', sv.restart_decision(loading_started=True, fatal=False, transient=False, restarts=0, max_restarts=1)[1])
        self.assertFalse(sv.restart_decision(loading_started=False, fatal=True, transient=True, restarts=0, max_restarts=1)[0])
        self.assertFalse(sv.restart_decision(loading_started=False, fatal=False, transient=False, restarts=0, max_restarts=1)[0])

    def test_max_restarts_predefinito_uno(self):
        cfg = sv.env_config({'LLMPOD_MODEL': 'm', 'LLMPOD_SERVED_NAME': 'm', 'VLLM_API_KEY': 'k'})
        self.assertEqual(cfg['max_restarts'], 1)

    def test_model_cache_bytes_conta_solo_il_modello_e_non_i_link(self):
        tmp = tempfile.mkdtemp()
        hub = os.path.join(tmp, 'hub')
        mine = os.path.join(hub, 'models--org--modello')
        os.makedirs(os.path.join(mine, 'blobs'))
        os.makedirs(os.path.join(mine, 'snapshots', 'abc'))
        with open(os.path.join(mine, 'blobs', 'h1'), 'wb') as f:
            f.write(b'x' * 100)
        with open(os.path.join(mine, 'blobs', 'h2.incomplete'), 'wb') as f:
            f.write(b'x' * 30)
        os.symlink(os.path.join('..', '..', 'blobs', 'h1'), os.path.join(mine, 'snapshots', 'abc', 'model.safetensors'))
        other = os.path.join(hub, 'models--altro--modello', 'blobs')
        os.makedirs(other)
        with open(os.path.join(other, 'h'), 'wb') as f:
            f.write(b'x' * 1000)
        self.assertEqual(sv.model_cache_bytes(tmp, 'org/modello'), 130)
        self.assertEqual(sv.model_cache_bytes(tmp, 'org/assente'), 0)

    def test_emergency_terminate(self):
        runpod = FakeRunpod()
        try:
            self.assertFalse(sv.emergency_terminate({}))
            env = {'RUNPOD_POD_ID': 'POD9', 'RUNPOD_API_KEY': 'k', 'LLMPOD_RUNPOD_API': runpod.url}
            self.assertTrue(sv.emergency_terminate(env))
            self.assertEqual(runpod.calls, [{'path': '/v2/pods/POD9', 'auth': 'Bearer k', 'ua': 'llmpod-supervisor/' + sv.VERSION}])
        finally:
            runpod.close()


class SupervisorIntegration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state = os.path.join(self.tmp, 'state.json')
        self.set_state(0, 0, 0)
        self.runpod = FakeRunpod()
        self.port = free_port()
        os.environ['FAKE_VLLM_STATE'] = self.state
        os.environ['VLLM_API_KEY'] = KEY
        os.environ.pop('FAKE_VLLM_EXIT_AFTER', None)
        os.environ.pop('FAKE_VLLM_LINES', None)
        self.cfg = sv.env_config({
            'LLMPOD_MODEL': 'org/modello', 'LLMPOD_SERVED_NAME': 'modello', 'VLLM_API_KEY': KEY,
            'LLMPOD_VLLM_ARGS': '["--max-model-len","4096"]', 'LLMPOD_IDLE_MINUTES': '1', 'LLMPOD_MAX_HOURS': '1',
            'LLMPOD_CHECK_SECONDS': '0.1', 'HF_HOME': self.tmp, 'RUNPOD_POD_ID': 'POD123', 'RUNPOD_API_KEY': 'chiave-iniettata',
            'LLMPOD_RUNPOD_API': self.runpod.url, 'LLMPOD_VLLM_PORT': str(self.port),
            'LLMPOD_VLLM_CMD': json.dumps([sys.executable, os.path.join(HERE, 'fake_vllm.py')]),
            'LLMPOD_STATUS_PORT': str(free_port()), 'LLMPOD_MAX_RESTARTS': '1', 'LLMPOD_STATE_DIR': self.tmp,
        })
        self.now = [1000.0]
        self.sup = sv.Supervisor(self.cfg, clock=lambda: self.now[0])

    def tearDown(self):
        self.sup.stop_vllm(5)
        self.runpod.close()

    def set_state(self, running, waiting, success):
        with open(self.state, 'w') as f:
            json.dump({'running': running, 'waiting': waiting, 'success': success}, f)

    def test_comando_vllm(self):
        cmd = self.sup.vllm_command()
        self.assertEqual(cmd[-9:], ['org/modello', '--served-model-name', 'modello', '--host', '0.0.0.0',
                                    '--port', str(self.port), '--max-model-len', '4096'])

    def test_pronto_inattivita_e_terminazione(self):
        self.sup.start_vllm()
        self.assertTrue(wait_until(lambda: self.sup.step() is None and self.sup.phase == 'ready'))
        self.assertTrue(wait_until(lambda: self.sup.kv_tokens == 1000))
        self.set_state(1, 0, 0)
        self.assertIsNone(self.sup.step())
        self.now[0] += 59
        self.set_state(0, 0, 0)
        self.assertIsNone(self.sup.step())   # ultima attività 59 s fa: sotto il limite di 60 s
        self.now[0] += 61
        self.assertEqual(self.sup.step(), 'idle')
        self.assertTrue(self.sup.terminate_pod())
        self.assertEqual(self.runpod.calls, [{'path': '/v2/pods/POD123', 'auth': 'Bearer chiave-iniettata', 'ua': 'llmpod-supervisor/' + sv.VERSION}])

    def test_durata_massima(self):
        self.sup.start_vllm()
        self.now[0] += 3600
        self.assertEqual(self.sup.step(), 'max-duration')

    def test_crash_senza_errore_transitorio_nessun_riavvio(self):
        os.environ['FAKE_VLLM_EXIT_AFTER'] = '0.5'
        self.sup.start_vllm()
        self.assertTrue(wait_until(lambda: (self.sup.step(), self.sup.phase)[1] == 'error'))
        self.assertEqual(self.sup.restarts, 0)
        self.assertIn('codice 3', self.sup.last_error)
        self.assertIn('nessun riavvio automatico', self.sup.last_error)
        self.assertIsNotNone(self.sup.tracker)  # l'inattività continua a contare anche in errore

    def test_crash_transitorio_prima_del_caricamento_un_solo_riavvio(self):
        os.environ['FAKE_VLLM_EXIT_AFTER'] = '0.5'
        os.environ['FAKE_VLLM_LINES'] = json.dumps([
            "requests.exceptions.ConnectionError: HTTPSConnectionPool(host='huggingface.co', port=443): Max retries exceeded",
        ])
        self.sup.start_vllm()
        self.assertTrue(wait_until(lambda: (self.sup.step(), self.sup.restarts)[1] == 1))
        self.assertTrue(wait_until(lambda: (self.sup.step(), self.sup.phase)[1] == 'error'))
        self.assertEqual(self.sup.restarts, 1)
        self.assertIn('dopo 1 riavvi', self.sup.last_error)
        self.assertIn('ConnectionError', self.sup.status()['errorCause'])

    def test_errore_nccl_durante_il_caricamento_nessun_riavvio(self):
        os.environ['FAKE_VLLM_EXIT_AFTER'] = '0.5'
        os.environ['FAKE_VLLM_LINES'] = json.dumps([
            '(Worker_TP0 pid=231) Loading safetensors checkpoint shards:  66% Completed | 135/206 [14:39<08:15, 6.98s/it]',
            '(EngineCore_DP0 pid=120) WARNING SymmMemCommunicator: Device capability 12.0 not supported',
            "(EngineCore_DP0 pid=120) RuntimeError: Worker failed with error 'NCCL error: unhandled cuda error (run with NCCL_DEBUG=INFO for details)', please check the stack trace above for the root cause",
            '  File "/usr/lib/python3/site-packages/vllm/v1/engine/core.py", line 12, in run',
        ])
        self.sup.start_vllm()
        self.assertTrue(wait_until(lambda: (self.sup.step(), self.sup.phase)[1] == 'error'))
        self.assertEqual(self.sup.restarts, 0)
        st = self.sup.status()
        self.assertIn('caricamento dei pesi', st['lastError'])
        self.assertIn('NCCL error: unhandled cuda error', st['lastError'])
        self.assertTrue(st['errorCause'].startswith('RuntimeError: Worker failed'))
        self.assertEqual(st['restarts'], 0)
        self.assertEqual(st['loadProgress']['done'], 135)

    def test_avanzamento_del_caricamento_e_fase(self):
        self.sup.phase = 'downloading'
        self.sup.log('(Worker_TP0 pid=1) Loading safetensors checkpoint shards:  71% Completed | 147/206 [17:06<06:52, 6.99s/it]')
        st = self.sup.status()
        self.assertEqual(st['loadProgress'], {'done': 147, 'total': 206, 'percent': 71, 'elapsedSeconds': 1026, 'remainingSeconds': 412})
        self.assertEqual(st['phase'], 'loading')  # vLLM sta leggendo i pesi: il download è finito
        self.sup.log('[llmpod] Loading safetensors checkpoint shards: 1% Completed | 1/206 [00:01<00:10, 1s/it]')
        self.assertEqual(self.sup.status()['loadProgress']['done'], 147)  # le righe del supervisore non contano

    def test_variabili_nccl_nei_log_di_avvio(self):
        os.environ['NCCL_P2P_DISABLE'] = '1'
        try:
            self.sup.start_vllm()
        finally:
            os.environ.pop('NCCL_P2P_DISABLE', None)
        self.assertTrue(any('NCCL_P2P_DISABLE=1' in l['line'] for l in self.sup.logs_since(0)))

    def test_tick_sopravvive_a_eccezione_e_termina(self):
        def boom():
            raise RuntimeError('guasto simulato')
        self.sup.step = boom
        self.sup.tracker = sv.IdleTracker(self.now[0])
        self.assertIsNone(self.sup.tick())      # nessun motivo di terminazione: sopravvive
        self.assertEqual(self.runpod.calls, [])
        self.now[0] += 61
        self.assertEqual(self.sup.tick(), 'idle')  # eccezione in step(), ma il Pod viene comunque terminato
        self.assertEqual(self.sup.phase, 'terminating')
        self.assertEqual([c['path'] for c in self.runpod.calls], ['/v2/pods/POD123'])
        self.assertTrue(any('errore nel controllo' in l['line'] for l in self.sup.logs_since(0)))

    def test_watchdog_non_attende_proc_lock(self):
        self.sup.tracker = sv.IdleTracker(self.now[0])
        held, release = threading.Event(), threading.Event()

        def hold():
            with self.sup.proc_lock:
                held.set()
                release.wait(30)

        t = threading.Thread(target=hold, daemon=True)
        t.start()
        self.assertTrue(held.wait(5))
        result = []
        self.now[0] += 61
        w = threading.Thread(target=lambda: result.append(self.sup.tick()), daemon=True)
        w.start()
        w.join(5)
        release.set()
        self.assertFalse(w.is_alive(), 'tick() bloccato su proc_lock')
        self.assertEqual(result, ['idle'])
        self.assertEqual([c['path'] for c in self.runpod.calls], ['/v2/pods/POD123'])

    def test_stop_vllm_non_si_blocca_su_sigkill(self):
        class Stuck:
            killed = False
            def poll(self):
                return None
            def terminate(self):
                pass
            def kill(self):
                self.killed = True
            def wait(self, timeout=None):
                raise subprocess.TimeoutExpired('vllm', timeout)

        self.sup.proc = Stuck()
        self.sup.stop_vllm(0.01)
        self.assertTrue(self.sup.proc.killed)
        self.assertTrue(any('non risponde a SIGKILL' in l['line'] for l in self.sup.logs_since(0)))
        self.sup.proc = None

    def test_ora_di_avvio_persistita(self):
        self.assertEqual(self.sup.started_at, 1000.0)
        second = sv.Supervisor(self.cfg, clock=lambda: 9999.0)
        self.assertEqual(second.started_at, 1000.0)
        other = sv.Supervisor(dict(self.cfg, pod_id='ALTRO'), clock=lambda: 9999.0)
        self.assertEqual(other.started_at, 9999.0)

    def test_ora_di_avvio_errore_io(self):
        sup = sv.Supervisor(dict(self.cfg, state_dir=os.path.join(self.tmp, 'non', 'esiste')), clock=lambda: 42.0)
        self.assertEqual(sup.started_at, 42.0)

    def test_reload_concorrente_409(self):
        self.assertTrue(self.sup.try_begin_reload())
        self.assertFalse(self.sup.try_begin_reload())
        self.sup.reloading = False
        server = sv.make_server(self.sup)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            def post(args):
                r = urllib.request.Request(f'http://127.0.0.1:{self.cfg["status_port"]}/reload', method='POST',
                                           data=json.dumps({'args': args}).encode(), headers={'Authorization': 'Bearer ' + KEY})
                try:
                    with urllib.request.urlopen(r, timeout=5) as resp:
                        return resp.status
                except urllib.error.HTTPError as e:
                    return e.code
            self.sup.reloading = True
            self.assertEqual(post(['--max-model-len', '2048']), 409)
            self.sup.reloading = False
            self.assertEqual(post(['--max-model-len', '2048']), 202)
            self.assertTrue(wait_until(lambda: self.sup.args == ['--max-model-len', '2048'] and not self.sup.reloading))
        finally:
            server.shutdown()

    def test_reload_imposta_loading_subito_e_non_promuove_il_vecchio_processo(self):
        self.sup.start_vllm()
        self.assertTrue(wait_until(lambda: self.sup.step() is None and self.sup.phase == 'ready'))
        old_pid = self.sup.proc.pid
        new_args = ['--max-model-len', '2048']
        self.assertTrue(self.sup.try_begin_reload(new_args))
        # args e fase cambiano subito, prima che il vecchio processo venga fermato
        st = self.sup.status()
        self.assertEqual(st['phase'], 'loading')
        self.assertEqual(st['args'], new_args)
        # il vecchio vLLM risponde ancora: il controllo non deve riportare 'ready'
        self.assertIsNone(self.sup.proc.poll())
        self.assertTrue(self.sup.check_ready())
        self.sup.step()
        self.assertEqual(self.sup.phase, 'loading')
        self.sup.reload(new_args)
        self.assertNotEqual(self.sup.proc.pid, old_pid)
        self.assertTrue(wait_until(lambda: self.sup.step() is None and self.sup.phase == 'ready'))
        self.assertEqual(self.sup.args, new_args)

    def test_409_su_reload_concorrente_non_cambia_args_e_fase(self):
        self.sup.start_vllm()
        self.assertTrue(wait_until(lambda: self.sup.step() is None and self.sup.phase == 'ready'))
        first = ['--max-model-len', '2048']
        self.assertTrue(self.sup.try_begin_reload(first))
        server = sv.make_server(self.sup)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            r = urllib.request.Request(f'http://127.0.0.1:{self.cfg["status_port"]}/reload', method='POST',
                                       data=json.dumps({'args': ['--max-model-len', '1024']}).encode(), headers={'Authorization': 'Bearer ' + KEY})
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(r, timeout=5)
            self.assertEqual(ctx.exception.code, 409)
        finally:
            server.shutdown()
        self.assertFalse(self.sup.try_begin_reload(['--max-model-len', '512']))
        self.assertEqual(self.sup.args, first)
        self.assertEqual(self.sup.phase, 'loading')

    def test_reload_azzera_il_tracker_di_inattivita_fino_a_ready(self):
        self.sup.start_vllm()
        self.assertTrue(wait_until(lambda: self.sup.step() is None and self.sup.phase == 'ready'))
        self.assertIsNotNone(self.sup.tracker)
        self.assertTrue(self.sup.try_begin_reload(['--max-model-len', '2048']))
        self.assertIsNone(self.sup.tracker)
        self.assertIsNone(self.sup.status()['idleSeconds'])
        # durante la riparazione il watchdog di inattività non scatta, anche oltre il limite (60 s)
        self.now[0] += 500
        self.assertIsNone(self.sup.step())
        self.sup.reload(['--max-model-len', '2048'])
        # come al primo avvio: niente conteggio durante il caricamento, riparte da zero a 'ready'
        self.assertIsNone(self.sup.tracker)
        self.assertTrue(wait_until(lambda: self.sup.step() is None and self.sup.phase == 'ready'))
        self.assertIsNotNone(self.sup.tracker)
        self.assertEqual(self.sup.tracker.idle_seconds(self.now[0]), 0)
        # il limite di ore massime resta attivo anche durante il reload
        self.assertTrue(self.sup.try_begin_reload(['--max-model-len', '1024']))
        self.now[0] += 3600
        self.assertEqual(self.sup.step(), 'max-duration')
        self.sup.stop_vllm(5)

    def test_reload_fallito_ricrea_comunque_il_tracker(self):
        self.assertTrue(self.sup.try_begin_reload(['--max-model-len', '2048']))
        self.assertIsNone(self.sup.tracker)

        def boom():
            raise OSError('niente processo')
        self.sup.start_vllm = boom
        self.sup.reload(['--max-model-len', '2048'])
        self.assertEqual(self.sup.phase, 'error')
        self.assertIsNotNone(self.sup.tracker)
        self.assertFalse(self.sup.reloading)

    def test_ready_non_viene_scritto_se_un_reload_parte_dopo_check_ready(self):
        self.sup.start_vllm()
        self.assertTrue(wait_until(lambda: self.sup.check_ready()))
        real = self.sup.check_ready

        def check_then_reload():
            ok = real()
            self.sup.try_begin_reload(['--max-model-len', '2048'])  # il reload parte tra il sondaggio e la scrittura della fase
            return ok
        self.sup.check_ready = check_then_reload
        self.sup.step()
        self.assertEqual(self.sup.phase, 'loading')
        self.assertIsNone(self.sup.tracker)

    def test_watchdog_aggiorna_i_limiti_e_la_durata_si_misura_dall_avvio(self):
        self.assertEqual((self.sup.idle_seconds, self.sup.max_seconds), (60, 3600))
        self.now[0] += 3000
        self.assertEqual(self.sup.set_watchdog(None, 2)['maxSeconds'], 7200)
        self.assertEqual(self.sup.status()['maxSeconds'], 7200)
        self.assertEqual(self.sup.status()['idleLimitSeconds'], 60)   # None = invariato
        self.now[0] += 1000                                           # 4000 s dall'avvio: oltre la vecchia durata
        self.assertIsNone(self.sup.step())
        self.now[0] += 3200                                           # 7200 s dall'avvio
        self.assertEqual(self.sup.step(), 'max-duration')

    def test_watchdog_rifiuta_ore_massime_che_spegnerebbero_subito(self):
        self.now[0] += 3600                                           # 1 h dall'avvio
        before = (self.sup.idle_seconds, self.sup.max_seconds)
        with self.assertRaises(ValueError):
            self.sup.set_watchdog(None, 0.25)                         # 900 s <= 3600 + 300
        self.assertEqual((self.sup.idle_seconds, self.sup.max_seconds), before)
        self.now[0] = 1000.0 + 600
        with self.assertRaises(ValueError):
            self.sup.set_watchdog(None, 0.25)                         # 900 s <= 600 + 300: margine di 5 minuti
        self.now[0] = 1000.0 + 599
        self.assertEqual(self.sup.set_watchdog(None, 0.25)['maxSeconds'], 900)

    def test_watchdog_inattivita_disattivata_e_tolleranza_alla_riattivazione(self):
        self.sup.start_vllm()
        self.assertTrue(wait_until(lambda: self.sup.step() is None and self.sup.phase == 'ready'))
        self.sup.set_watchdog(0, None)
        self.assertEqual(self.sup.status()['idleLimitSeconds'], 0)
        self.now[0] += 1800
        self.assertIsNone(self.sup.step())                            # inattivo da 30 min ma il controllo è spento
        self.sup.set_watchdog(5, None)                                # riattivato: si riparte da adesso, non si spegne subito
        self.assertIsNone(self.sup.step())
        self.now[0] += 301
        self.assertEqual(self.sup.step(), 'idle')

    def test_watchdog_persistito_per_pod_e_riletto_al_riavvio(self):
        self.sup.set_watchdog(120, 24)
        second = sv.Supervisor(self.cfg, clock=lambda: 9999.0)
        self.assertEqual((second.idle_seconds, second.max_seconds), (7200, 86400))
        other = sv.Supervisor(dict(self.cfg, pod_id='ALTRO'), clock=lambda: 9999.0)
        self.assertEqual((other.idle_seconds, other.max_seconds), (60, 3600))
        # file corrotto: si ignora e valgono i valori dell'ambiente
        with open(os.path.join(self.tmp, '.llmpod-watchdog-POD123'), 'w') as f:
            f.write('{non json')
        third = sv.Supervisor(self.cfg, clock=lambda: 9999.0)
        self.assertEqual((third.idle_seconds, third.max_seconds), (60, 3600))
        # un solo valore non valido: l'altro si usa
        with open(os.path.join(self.tmp, '.llmpod-watchdog-POD123'), 'w') as f:
            json.dump({'idleMinutes': 2, 'maxHours': 24}, f)
        partial = sv.Supervisor(self.cfg, clock=lambda: 9999.0)
        self.assertEqual((partial.idle_seconds, partial.max_seconds), (60, 86400))
        # valori fuori intervallo nel file: ignorati
        with open(os.path.join(self.tmp, '.llmpod-watchdog-POD123'), 'w') as f:
            json.dump({'idleMinutes': -5, 'maxHours': 99999}, f)
        fourth = sv.Supervisor(self.cfg, clock=lambda: 9999.0)
        self.assertEqual((fourth.idle_seconds, fourth.max_seconds), (60, 3600))

    def test_watchdog_errore_io_applica_comunque_e_lo_dice(self):
        sup = sv.Supervisor(dict(self.cfg, state_dir=os.path.join(self.tmp, 'non', 'esiste')), clock=lambda: 42.0)
        r = sup.set_watchdog(10, 2)
        self.assertEqual((sup.idle_seconds, sup.max_seconds, r['persisted']), (600, 7200, False))

    def test_server_watchdog(self):
        server = sv.make_server(self.sup)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{self.cfg["status_port"]}'
        try:
            def req(path, method='GET', body=None, auth=True, raw=None):
                headers = {'Authorization': 'Bearer ' + KEY} if auth else {}
                data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
                r = urllib.request.Request(base + path, data=data, method=method, headers=headers)
                try:
                    with urllib.request.urlopen(r, timeout=5) as resp:
                        return resp.status, json.loads(resp.read())
                except urllib.error.HTTPError as e:
                    return e.code, None

            self.assertEqual(req('/watchdog', 'POST', {'maxHours': 12}, auth=False)[0], 401)
            self.assertEqual(self.sup.max_seconds, 3600)
            for bad in ({'maxHours': 500}, {'idleMinutes': 'tanti'}, {'idleMinutes': -1}, {'maxHours': True}, [1]):
                self.assertEqual(req('/watchdog', 'POST', bad)[0], 400, bad)
            self.assertEqual(req('/watchdog', 'POST', raw=b'{non json')[0], 400)
            self.assertEqual((self.sup.idle_seconds, self.sup.max_seconds), (60, 3600))   # nulla è cambiato
            code, body = req('/watchdog', 'POST', {'idleMinutes': 0, 'maxHours': 12})
            self.assertEqual(code, 200)
            self.assertEqual((body['idleLimitSeconds'], body['maxSeconds']), (0, 43200))
            code, status = req('/status')
            self.assertEqual((status['idleLimitSeconds'], status['maxSeconds']), (0, 43200))
            self.assertEqual(req('/watchdog', 'POST', {'idleMinutes': 45})[0], 200)
            self.assertEqual((self.sup.idle_seconds, self.sup.max_seconds), (2700, 43200))   # maxHours null/assente = invariato
            self.assertEqual(req('/watchdog')[0], 404)                                        # solo POST
            self.assertEqual(req('/watchdog', 'POST', {})[0], 400)                            # nessun valore
            self.assertEqual(req('/watchdog', 'POST', {'idleMinutes': None, 'maxHours': None})[0], 400)
            self.assertEqual(req('/watchdog', 'POST', {'idleMinutes': 3})[0], 400)            # intero 0 o 5..1440
            self.assertEqual(req('/watchdog', 'POST', {'maxHours': 10 ** 400})[0], 400)       # intero enorme: niente 500
            self.now[0] += 7200
            self.assertEqual(req('/watchdog', 'POST', {'maxHours': 2})[0], 400)               # spegnerebbe subito il Pod
            self.assertEqual((self.sup.idle_seconds, self.sup.max_seconds), (2700, 43200))
            self.sup.phase = 'terminating'
            self.assertEqual(req('/watchdog', 'POST', {'maxHours': 24})[0], 409)              # già in terminazione
            self.assertEqual(self.sup.max_seconds, 43200)
        finally:
            server.shutdown()

    def test_server_di_stato_autenticato(self):
        server = sv.make_server(self.sup)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{self.cfg["status_port"]}'
        try:
            def req(path, method='GET', body=None, auth=True):
                headers = {'Authorization': 'Bearer ' + KEY} if auth else {}
                data = json.dumps(body).encode() if body is not None else None
                r = urllib.request.Request(base + path, data=data, method=method, headers=headers)
                try:
                    with urllib.request.urlopen(r, timeout=5) as resp:
                        return resp.status, json.loads(resp.read())
                except urllib.error.HTTPError as e:
                    return e.code, None

            self.assertEqual(req('/status', auth=False)[0], 401)
            code, status = req('/status')
            self.assertEqual(code, 200)
            self.assertEqual(status['phase'], 'loading')
            self.assertNotIn(KEY, json.dumps(status))
            self.sup.log('riga uno')
            self.sup.log('riga due')
            code, logs = req('/logs?since=1')
            self.assertEqual([l['line'] for l in logs['lines']], ['riga due'])
            self.assertEqual(req('/reload', 'POST', {'args': ['--api-key', 'x']})[0], 400)
            self.assertEqual(req('/reload', 'POST', {'args': ['--max-model-len', '2048']})[0], 202)
            self.assertTrue(wait_until(lambda: self.sup.args == ['--max-model-len', '2048']))
        finally:
            server.shutdown()


if __name__ == '__main__':
    unittest.main()
