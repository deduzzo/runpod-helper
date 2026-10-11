"""Finto vLLM per i test del supervisore e per la prova e2e su CPU.

Espone /v1/models (protetto da VLLM_API_KEY), /metrics (valori da FAKE_VLLM_STATE)
e /stream (SSE per FAKE_STREAM_SECONDS secondi, per provare il proxy Runpod).
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


PORT = int(arg('--port', '8000'))
HOST = arg('--host', '127.0.0.1')
KEY = os.environ.get('VLLM_API_KEY', '')
STATE_FILE = os.environ.get('FAKE_VLLM_STATE', '')


def state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {'running': 0, 'waiting': 0, 'success': 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body, ctype='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/metrics':
            s = state()
            text = (
                '# HELP vllm:num_requests_running Requests running\n'
                f'vllm:num_requests_running{{engine="0",model_name="m"}} {s["running"]}\n'
                f'vllm:num_requests_waiting{{engine="0",model_name="m"}} {s["waiting"]}\n'
                f'vllm:request_success_total{{engine="0",finished_reason="stop",model_name="m"}} {s["success"]}\n'
            )
            return self.reply(200, text.encode(), 'text/plain')
        if self.path == '/v1/models':
            if self.headers.get('Authorization') != 'Bearer ' + KEY:
                return self.reply(401, b'{"error":"unauthorized"}')
            return self.reply(200, json.dumps({'data': [{'id': 'm'}]}).encode())
        if self.path == '/stream':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for i in range(int(os.environ.get('FAKE_STREAM_SECONDS', '150')) // 5):
                self.wfile.write(f'data: {i}\n\n'.encode())
                self.wfile.flush()
                time.sleep(5)
            self.wfile.write(b'data: [DONE]\n\n')
            return None
        return self.reply(404, b'{}')


print('GPU KV cache size: 1,000 tokens, Maximum concurrency for 32,768 tokens per request: 0.03x', flush=True)
if os.environ.get('FAKE_VLLM_EXIT_AFTER'):
    threading.Timer(float(os.environ['FAKE_VLLM_EXIT_AFTER']), lambda: os._exit(3)).start()
ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
