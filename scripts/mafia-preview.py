"""Loopback-only party rehearsal using real rules and synthetic in-memory storage.

No AWS, Core or model calls. Stop this process to discard all temporary rooms.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8097)
    args = parser.parse_args()
    sys.path.insert(0, str(ROOT / 'tests'))
    from test_nce_api import ConditionalFailure, MemoryDatabase
    os.environ.update(CORE_ORGANIZATION_ID='22222222-2222-4222-8222-222222222222',
        CORE_SERVICE_ID='33333333-3333-4333-8333-333333333333', GAME_PUBLIC_TABLE='mafia-preview', AWS_EC2_METADATA_DISABLED='true')
    spec = importlib.util.spec_from_file_location('mafia_preview', ROOT / 'backend/nce_api/mafia.py')
    mafia = importlib.util.module_from_spec(spec); spec.loader.exec_module(mafia)
    party_spec = importlib.util.spec_from_file_location('party_preview', ROOT / 'backend/nce_api/party.py')
    party = importlib.util.module_from_spec(party_spec); party_spec.loader.exec_module(party)
    database = MemoryDatabase(); database.rows['mafia-preview'] = {}
    database.meta.client.exceptions = SimpleNamespace(TransactionCanceledException=ConditionalFailure)
    def deny(*args): raise mafia.MafiaError(403, 'Model generation is unavailable in the offline rehearsal.')
    api = SimpleNamespace(clients=lambda: (database, None, None), authorize=deny)
    # Clearly synthetic phrases exercise the cached-bank path without a provider.
    bank = mafia.narration().defaults()
    bank.update(revision=1, enabled=True, approved={'version': 1, 'source': mafia.narration().MODEL,
        'phrases': {key: 'A new chapter unfolds in the mysterious town.' for key in mafia.narration().PHRASES}})
    database.rows['mafia-preview'][mafia.narration().key()] = {'id': mafia.narration().key(),
        'revision': 1, 'organization_id': os.environ['CORE_ORGANIZATION_ID'], 'service_id': os.environ['CORE_SERVICE_ID'], 'payload': json.dumps(bank)}
    lock = threading.RLock()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self): self.handle_request('GET')
        def do_POST(self): self.handle_request('POST')
        def do_PUT(self): self.handle_request('PUT')
        def handle_request(self, method):
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length > 16000: raise mafia.MafiaError(413, 'Request is too large.')
                body = json.loads(self.rfile.read(length) or b'{}')
                with lock:
                    path = urlsplit(self.path).path
                    adapter = party if path.startswith('/party/') else mafia
                    result = adapter.dispatch(api, {'headers': dict(self.headers), 'requestContext': {'http': {'sourceIp': '127.0.0.1'}}}, method, path, body)
                status = 200
            except (mafia.MafiaError, party.PartyError) as error: result, status = {'error': error.message}, error.status
            except Exception as error:
                print('Offline party request failed:', type(error).__name__, file=sys.stderr)
                result, status = {'error': 'The offline room request failed.'}, 503
            data = json.dumps(result).encode()
            self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print('Synthetic party API ready on loopback port ' + str(args.port) + '; no AWS or model calls.', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()


if __name__ == '__main__':
    main()
