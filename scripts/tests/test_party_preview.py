"""Actual loopback HTTP rehearsal, using synthetic seats and no external calls."""
import json
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid

ROOT = Path(__file__).resolve().parents[2]


class PartyPreviewTests(unittest.TestCase):
    def test_new_client_query_reaches_real_room_gate_and_old_clients_preserve_their_ink(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        process = subprocess.Popen([sys.executable, str(ROOT / 'scripts/mafia-preview.py'), '--port', str(port)],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        base = 'http://127.0.0.1:' + str(port)
        token, invite, room_id = secrets.token_urlsafe(32), secrets.token_urlsafe(32), str(uuid.uuid4())
        sequence, phase = 0, 0
        def request(path, body=None, authenticated=True):
            headers = {'Authorization': 'Bearer ' + token} if authenticated else {}
            if body is not None: headers['Content-Type'] = 'application/json'
            message = Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
            try:
                with urlopen(message, timeout=3) as response: return response.status, json.load(response)
            except HTTPError as error:
                with error: return error.code, json.load(error)
        def action(kind, **values):
            nonlocal sequence, phase
            sequence += 1
            status, value = request('/party/rooms/' + room_id + '/actions', {'requestId': str(uuid.uuid4()),
                'sequence': sequence, 'phaseId': phase, 'type': kind, **values})
            self.assertEqual(status, 200, value)
            phase = value['room']['phaseId']
            return value['room']
        try:
            ready = False
            for _ in range(50):
                if process.poll() is not None: self.fail('Loopback preview stopped before becoming ready.')
                try:
                    ready = request('/party/config', authenticated=False)[0] == 200
                    if ready: break
                except OSError: time.sleep(.05)
            self.assertTrue(ready, 'Loopback preview did not start within its bounded wait.')
            status, created = request('/party/rooms', {'requestId': room_id, 'name': 'Preview host', 'avatar': 'fox',
                'kind': 'sketch-guess', 'playerToken': token, 'inviteToken': invite, 'settings': {'roundSeconds': 60}}, False)
            self.assertEqual(status, 200, created)
            phase = created['room']['phaseId']
            action('add-ai'); action('start')
            action('stroke', color='#244b50', width=5, points=[[.1, .2], [.3, .4]])
            path = '/party/rooms/' + room_id
            for query in ('', '?sketchRecognition=', '?sketchRecognition=1&sketchRecognition=0'):
                status, value = request(path + query)
                self.assertEqual(status, 426, value)
                self.assertIn('Refresh this page', value['error'])
            status, value = request(path + '?sketchRecognition=1')
            self.assertEqual(status, 200, value)
            self.assertEqual(len(value['room']['game']['strokes']), 1)
            self.assertEqual(value['room']['game']['aiDrawingStatus'], 'watching')
            self.assertEqual(action('close')['status'], 'closed')
        finally:
            process.terminate()
            try: process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill(); process.communicate(timeout=3)


if __name__ == '__main__':
    unittest.main()
