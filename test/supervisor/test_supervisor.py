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

    def test_crash_riavvio_poi_errore(self):
        os.environ['FAKE_VLLM_EXIT_AFTER'] = '0.5'
        self.sup.start_vllm()
        self.assertTrue(wait_until(lambda: (self.sup.step(), self.sup.restarts)[1] == 1))
        self.assertTrue(wait_until(lambda: (self.sup.step(), self.sup.phase)[1] == 'error'))
        self.assertIn('codice 3', self.sup.last_error)
        self.assertIsNotNone(self.sup.tracker)  # l'inattività continua a contare anche in errore

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

    def test_reload_azzera_il_tracker_di_inattivita_e_lo_ricrea_alla_fine(self):
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
