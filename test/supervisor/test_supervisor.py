import json
import os
import socket
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
            'LLMPOD_STATUS_PORT': str(free_port()), 'LLMPOD_MAX_RESTARTS': '1',
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
