#!/usr/bin/env python3
"""A loopback-only desktop window for importing books and generating local narration."""
import argparse
import hmac
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit, unquote
import uuid
import webbrowser
import zipfile
from generate import atomic_json, validate_job

ROOT = Path(__file__).resolve().parents[2]
VOICES = [
    {'id': 'af_heart', 'name': 'Heart', 'description': 'American · warm, clear'},
    {'id': 'af_bella', 'name': 'Bella', 'description': 'American · expressive'},
    {'id': 'am_michael', 'name': 'Michael', 'description': 'American · low, steady'},
    {'id': 'am_adam', 'name': 'Adam', 'description': 'American · conversational'},
    {'id': 'bf_emma', 'name': 'Emma', 'description': 'British · measured'},
    {'id': 'bm_george', 'name': 'George', 'description': 'British · classic narration'},
]


class StudioServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, jobs, model_cache=None):
        super().__init__(address, Handler)
        self.jobs = jobs.resolve()
        self.jobs.mkdir(parents=True, exist_ok=True)
        self.token = secrets.token_urlsafe(32)
        self.processes = {}
        self.lock = threading.RLock()
        self.model_cache = model_cache

    def state(self, identifier):
        path = self.jobs / identifier / 'state.json'
        if not path.exists():
            raise ValueError('This generation job was not found.')
        state = json.loads(path.read_text(encoding='utf-8'))
        process = self.processes.get(identifier)
        if state['status'] in ('ready', 'paused', 'error') and process and process.poll() is None:
            return {**state, 'status': 'running', 'phase': 'finishing'}
        if state['status'] == 'running' and (not process or process.poll() is not None):
            state.update(status='paused', phase='paused')
            atomic_json(path, state)
        return state

    def start(self, identifier):
        with self.lock:
            if any(p.poll() is None for p in self.processes.values()):
                raise ValueError('Another voice job is running. Pause it before starting this one.')
            directory = self.jobs / identifier
            (directory / 'pause').unlink(missing_ok=True)
            state = self.state(identifier)
            state.update(status='running', phase='starting', error=None)
            atomic_json(directory / 'state.json', state)
            env = os.environ.copy()
            env['PYTHONUNBUFFERED'] = '1'
            if self.model_cache:
                env['HF_HOME'] = str(self.model_cache)
            with (directory / 'worker.log').open('a', encoding='utf-8') as log:
                self.processes[identifier] = subprocess.Popen(
                    [sys.executable, str(Path(__file__).with_name('studio_worker.py')), str(directory)],
                    stdout=log, stderr=log, env=env)

    def cancel_preview(self, identifier):
        with self.lock:
            state = self.state(identifier)
            if state.get('kind') != 'preview':
                raise ValueError('Only voice previews can be cancelled. Pause an audiobook to keep its progress.')
            process = self.processes.get(identifier)
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            if state['status'] != 'ready':
                state.update(status='cancelled', phase='cancelled', error=None)
                atomic_json(self.jobs / identifier / 'state.json', state)
            return state


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def allowed_host(self):
        port = self.server.server_address[1]
        return self.headers.get('Host', '') in (f'localhost:{port}', f'127.0.0.1:{port}')

    def json_response(self, data, status=200):
        raw = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def identifier(self, path):
        parts = path.strip('/').split('/')
        if len(parts) < 3 or len(parts[2]) != 32 or any(c not in '0123456789abcdef' for c in parts[2]):
            raise ValueError('Invalid generation job.')
        return parts[2]

    def do_GET(self):
        if not self.allowed_host():
            return self.send_error(403)
        path = urlsplit(self.path).path
        try:
            if path == '/api/status':
                return self.json_response({'ready': importlib.util.find_spec('kokoro') is not None,
                    'engine': 'Kokoro', 'voices': VOICES, 'token': self.server.token,
                    'jobs': sorted([self.server.state(p.name) for p in self.server.jobs.iterdir()
                             if p.is_dir() and (p / 'state.json').exists()], key=lambda job: job.get('createdAt', 0), reverse=True)})
            if path.startswith('/api/jobs/'):
                identifier = self.identifier(path)
                state = self.server.state(identifier)
                if path.endswith('/download') or path.endswith('/audio'):
                    if state['status'] != 'ready':
                        raise ValueError('This audiobook is not ready yet.')
                    output = self.server.jobs / identifier / 'audiobook.zip'
                    if path.endswith('/audio'):
                        with zipfile.ZipFile(output) as archive:
                            manifest = json.loads(archive.read('audiobook.json'))
                            entry = archive.getinfo(manifest['clips'][0]['file'])
                            size = entry.file_size
                            start, end = 0, size - 1
                            requested = self.headers.get('Range')
                            if requested:
                                match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
                                if not match or not any(match.groups()):
                                    return self.send_error(416)
                                left, right = match.groups()
                                if left:
                                    start = int(left)
                                    end = min(int(right), end) if right else end
                                else:
                                    start = max(0, size - int(right))
                                if start > end or start >= size:
                                    self.send_response(416)
                                    self.send_header('Content-Range', f'bytes */{size}')
                                    self.end_headers(); return
                            self.send_response(206 if requested else 200)
                            self.send_header('Content-Type', 'audio/mp4')
                            self.send_header('Accept-Ranges', 'bytes')
                            self.send_header('Cache-Control', 'no-store')
                            self.send_header('Content-Length', str(end - start + 1))
                            if requested:
                                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                            self.end_headers()
                            with archive.open(entry) as stream:
                                stream.seek(start)
                                remaining = end - start + 1
                                while remaining:
                                    chunk = stream.read(min(1024 * 1024, remaining))
                                    if not chunk:
                                        break
                                    self.wfile.write(chunk)
                                    remaining -= len(chunk)
                        return
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/zip')
                    self.send_header('Content-Disposition', 'attachment; filename="Stillpoint-audiobook.zip"')
                    self.send_header('Content-Length', str(output.stat().st_size))
                    self.end_headers()
                    with output.open('rb') as stream:
                        while chunk := stream.read(1024 * 1024):
                            self.wfile.write(chunk)
                    return
                return self.json_response(state)
            clean = unquote(path)
            allowed = clean in ('/', '/index.html', '/styles.css', '/manifest.webmanifest', '/sw.js') or clean.startswith(('/studio/', '/js/', '/vendor/', '/icons/'))
            if not allowed or '..' in Path(clean).parts:
                return self.send_error(404)
            return super().do_GET()
        except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
            return self.json_response({'error': str(error)}, 400)

    def do_POST(self):
        if not self.allowed_host() or not hmac.compare_digest(self.headers.get('X-Stillpoint-Token', ''), self.server.token):
            return self.send_error(403)
        origin = self.headers.get('Origin')
        if origin and origin != f'http://{self.headers.get("Host")}':
            return self.send_error(403)
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length <= 0 or length > 64 * 1024 * 1024 or not self.headers.get('Content-Type', '').startswith('application/json'):
                raise ValueError('The generation request is too large or unreadable.')
            request = json.loads(self.rfile.read(length))
            path = urlsplit(self.path).path
            if path == '/api/shutdown':
                self.json_response({'status': 'stopping'})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if path == '/api/jobs':
                if importlib.util.find_spec('kokoro') is None:
                    raise ValueError('The voice engine is not installed in this Python environment. Open Studio with its launcher.')
                validate_job(request['job'])
                if request.get('voice') not in {v['id'] for v in VOICES}:
                    raise ValueError('Choose a listed voice.')
                if not isinstance(request.get('speed'), (float, int)) or not 0.5 <= request['speed'] <= 2:
                    raise ValueError('Choose a narration speed between 0.5 and 2.')
                request['device'] = 'auto'
                with self.server.lock:
                    if any(process.poll() is None for process in self.server.processes.values()):
                        raise ValueError('Another voice job is running. Pause it before starting this one.')
                    identifier = uuid.uuid4().hex
                    directory = self.server.jobs / identifier
                    directory.mkdir()
                    atomic_json(directory / 'request.json', request)
                    atomic_json(directory / 'state.json', {'id': identifier, 'status': 'queued', 'phase': 'starting', 'createdAt': time.time(),
                        'title': request['job']['book']['title'], 'kind': request.get('kind', 'book'), 'voice': request['voice']})
                    self.server.start(identifier)
                return self.json_response(self.server.state(identifier), 201)
            if path.startswith('/api/jobs/'):
                identifier = self.identifier(path)
                if path.endswith('/cancel'):
                    return self.json_response(self.server.cancel_preview(identifier))
                if path.endswith('/pause'):
                    (self.server.jobs / identifier / 'pause').touch()
                    return self.json_response({'status': 'pausing'})
                if path.endswith('/resume'):
                    self.server.start(identifier)
                    return self.json_response(self.server.state(identifier))
            raise ValueError('Unknown action.')
        except (ValueError, OSError, KeyError, TypeError) as error:
            return self.json_response({'error': str(error)}, 400)

    def log_message(self, format, *args):
        if self.path.startswith('/api/'):
            return
        super().log_message(format, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--jobs', type=Path, default=ROOT / '.studio-jobs')
    parser.add_argument('--model-cache', type=Path)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    server = StudioServer(('127.0.0.1', args.port), args.jobs, args.model_cache)
    url = f'http://localhost:{server.server_address[1]}/studio/'
    print(f'Stillpoint Audiobook Studio: {url}', flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for identifier, process in server.processes.items():
            if process.poll() is None:
                (server.jobs / identifier / 'pause').touch()
        server.server_close()


if __name__ == '__main__':
    main()
