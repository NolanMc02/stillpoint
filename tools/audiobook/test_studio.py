import http.client
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import threading
import unittest
import zipfile

from generate import atomic_json
from studio import StudioServer


class StudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = StudioServer(('127.0.0.1', 0), Path(self.temp.name))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.identifier = 'a' * 32
        self.directory = Path(self.temp.name) / self.identifier
        self.directory.mkdir()
        atomic_json(self.directory / 'state.json', {'id': self.identifier, 'status': 'ready'})
        self.audio = b'local-audio-fixture'
        with zipfile.ZipFile(self.directory / 'audiobook.zip', 'w') as archive:
            archive.writestr('audiobook.json', json.dumps({'clips': [{'file': 'audio.m4a'}]}))
            archive.writestr('audio.m4a', self.audio)

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_address[1])
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_audio_supports_full_and_range_requests(self):
        path = f'/api/jobs/{self.identifier}/audio'
        status, headers, data = self.request('GET', path)
        self.assertEqual((status, data), (200, self.audio))
        self.assertEqual(headers['Content-Type'], 'audio/mp4')
        status, headers, data = self.request('GET', path, headers={'Range': 'bytes=0-1'})
        self.assertEqual((status, data), (206, self.audio[:2]))
        self.assertEqual(headers['Content-Range'], f'bytes 0-1/{len(self.audio)}')
        status, _, data = self.request('GET', path, headers={'Range': 'bytes=-3'})
        self.assertEqual((status, data), (206, self.audio[-3:]))
        status, _, _ = self.request('GET', path, headers={'Range': 'bytes=999-1000'})
        self.assertEqual(status, 416)

    def test_mutation_requires_token_and_matching_origin(self):
        path = f'/api/jobs/{self.identifier}/pause'
        headers = {'Content-Type': 'application/json'}
        self.assertEqual(self.request('POST', path, '{}', headers)[0], 403)
        headers['X-Stillpoint-Token'] = self.server.token
        headers['Origin'] = 'https://unrelated.example'
        self.assertEqual(self.request('POST', path, '{}', headers)[0], 403)
        self.assertFalse((self.directory / 'pause').exists())
        headers['Origin'] = f'http://127.0.0.1:{self.server.server_address[1]}'
        self.assertEqual(self.request('POST', path, '{}', headers)[0], 200)
        self.assertTrue((self.directory / 'pause').exists())

    def test_private_files_and_untrusted_hosts_are_rejected(self):
        self.assertEqual(self.request('GET', '/.studio-jobs/private/request.json')[0], 404)
        self.assertEqual(self.request('GET', '/api/status', headers={'Host': 'unrelated.example'})[0], 403)

    def test_worker_exit_precedes_ready_state_in_api(self):
        class Process:
            def poll(self):
                return None
        self.server.processes[self.identifier] = Process()
        state = self.server.state(self.identifier)
        self.assertEqual((state['status'], state['phase']), ('running', 'finishing'))
        self.server.processes.clear()
        self.assertEqual(self.server.state(self.identifier)['status'], 'ready')

    def test_cancel_preview_releases_the_worker_immediately(self):
        process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        self.server.processes[self.identifier] = process
        atomic_json(self.directory / 'state.json', {'id': self.identifier, 'kind': 'preview', 'status': 'running'})
        try:
            status, _, data = self.request('POST', f'/api/jobs/{self.identifier}/cancel', '{}',
                {'Content-Type': 'application/json', 'X-Stillpoint-Token': self.server.token})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(data)['status'], 'cancelled')
            self.assertIsNotNone(process.poll())
            self.assertTrue((self.directory / 'audiobook.zip').exists())
        finally:
            if process.poll() is None:
                process.kill(); process.wait()

    def test_cancel_cannot_discard_an_audiobook_job(self):
        atomic_json(self.directory / 'state.json', {'id': self.identifier, 'kind': 'book', 'status': 'paused'})
        status, _, _ = self.request('POST', f'/api/jobs/{self.identifier}/cancel', '{}',
            {'Content-Type': 'application/json', 'X-Stillpoint-Token': self.server.token})
        self.assertEqual(status, 400)
        self.assertEqual(self.server.state(self.identifier)['status'], 'paused')


if __name__ == '__main__':
    unittest.main()
