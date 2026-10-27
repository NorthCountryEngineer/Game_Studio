"""Development adapter: real relay logic with synthetic, in-memory AWS ports.

The Node preview harness owns HTTP/WebSockets. This process invokes the same
room/admission/relay functions production uses. Nothing connects to AWS, Core,
models, or a production database. State disappears when this process exits.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import types

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
from test_nce_api import ConditionalFailure, MemoryDatabase


def load(name, path):
    source = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(source)
    source.loader.exec_module(result)
    return result


games = load('preview_games', ROOT / 'backend/nce_api/games.py')
relay = load('preview_relay', ROOT / 'backend/nce_api/multiplayer.py')
# Only the synthetic adapter can advance its clock. Production still uses real
# server time; this lets real local sockets cross lease boundaries without waits.
preview_offset = 0
relay.time = types.SimpleNamespace(time=lambda: time.time() + preview_offset)
frontend_origin = sys.argv[1]
socket_url = sys.argv[2]
organization = '22222222-2222-4222-8222-222222222222'
service = '33333333-3333-4333-8333-333333333333'
game_id = '11111111-1111-4111-8111-111111111111'
os.environ.update(CORE_ORGANIZATION_ID=organization, CORE_SERVICE_ID=service,
    GAME_PUBLIC_TABLE='preview-published', MULTIPLAYER_TABLE='preview-rooms',
    FRONTEND_ORIGIN=frontend_origin, AWS_EC2_METADATA_DISABLED='true')
database = MemoryDatabase()
database.rows.update({'preview-published': {}, 'preview-rooms': {}})
database.meta.client.exceptions = types.SimpleNamespace(TransactionCanceledException=ConditionalFailure)
outgoing, closures = [], []


class Gone(Exception):
    pass


class Callback:
    exceptions = types.SimpleNamespace(GoneException=Gone)

    def post_to_connection(self, *, ConnectionId, Data):
        outgoing.append({'connectionId': ConnectionId, 'message': json.loads(Data)})

    def delete_connection(self, *, ConnectionId):
        closures.append(ConnectionId)


api = types.SimpleNamespace(clients=lambda: (database, None, None), multiplayer_callback=Callback())
relay._games = games
# WSS remains mandatory in production. Only this loopback adapter substitutes
# the local URL; the frontend likewise explicitly allows WS only in preview.
relay.socket_url = lambda: socket_url
spec = games.design_game('Asteroids with one level. Collect 3 stars, 180 seconds, 5 lives, easy difficulty.')['spec']
spec.update(version=6, multiplayer={'mode': 'cooperative', 'maxPlayers': 2}, title='Two-player synthetic endless flight',
    powerUps={'spawnInterval': 5, 'duration': 10, 'types': ['triple-shot', 'rapid-fire', 'shield', 'speed-boost']},
    asteroids={'endless': True, 'difficultyInterval': 30, 'sizes': 3,
        'enemies': {'enabled': True, 'difficulty': 'hard', 'hitPoints': 2, 'spawnInterval': 15, 'maxShips': 2}})
spec['arcade']['rotation'] = False
spec['arcade']['highScores'] = False
spec = games.validate_spec(spec)
stamp = '2026-01-01T00:00:00+00:00'
published = {'id': game_id, 'status': 'Published', 'revision': 7, 'publishedRevision': 7, 'spec': spec,
    'createdAt': stamp, 'updatedAt': stamp, 'publishedAt': stamp}
public_key = games.key('game', game_id)
database.rows['preview-published'][public_key] = {'id': public_key, 'revision': 7,
    'organization_id': organization, 'service_id': service, 'payload': json.dumps(published)}
print(json.dumps({'ready': True, 'game': published}), flush=True)

for raw in sys.stdin:
    outgoing.clear(); closures.clear()
    try:
        command = json.loads(raw)
        if command['kind'] == 'advance-clock':
            if set(command) != {'kind', 'seconds'} or type(command['seconds']) is not int or not 1 <= command['seconds'] <= 30:
                raise ValueError('Invalid synthetic clock step.')
            preview_offset += command['seconds']
            print(json.dumps({'status': 200, 'result': {'now': int(relay.time.time())}, 'outgoing': [], 'closures': []}), flush=True)
            continue
        event = {'headers': {'origin': command.get('origin', '')}, 'requestContext': {
            'http': {'sourceIp': '127.0.0.1'}, 'identity': {'sourceIp': '127.0.0.1'}}}
        if command['kind'] == 'http':
            relay.origin(event)
            result = relay.dispatch(api, event, command['method'], command['path'], command['body'])
            response = {'status': 200, 'result': result}
        else:
            event['requestContext'].update(connectionId=command['connectionId'], routeKey=command['route'])
            if 'body' in command: event['body'] = json.dumps(command['body'], allow_nan=False)
            result = relay.websocket_handler(api, event)
            response = {'status': result['statusCode'], 'result': None}
    except relay.MultiplayerError as error:
        response = {'status': error.status, 'result': {'error': error.message}}
    except (ValueError, KeyError, TypeError):
        response = {'status': 400, 'result': {'error': 'Invalid local preview request.'}}
    except Exception:
        # Keep internal exceptions off the wire, including any environment data.
        response = {'status': 500, 'result': {'error': 'Local preview adapter failed.'}}
    print(json.dumps({**response, 'outgoing': outgoing, 'closures': closures}, allow_nan=False), flush=True)
