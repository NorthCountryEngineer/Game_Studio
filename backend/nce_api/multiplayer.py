"""Idle-expiring, capability-scoped cooperative rooms. No identities or gameplay are retained.

The parent page relays bounded fixed-engine data; the sandbox never gains network
access. A browser host is the simulation authority, not an assessment authority.
"""
import hashlib
import hmac
import importlib.util
import json
import math
import os
from collections import OrderedDict
from pathlib import Path
import re
import secrets
import time
from urllib.parse import urlsplit
import uuid

ROOM_SECONDS = 1800
LOBBY_LIMIT = 20
PENDING_SECONDS = 45
HEARTBEAT_SECONDS = 45
DISCONNECT_GRACE = 60
MAX_STATE_BYTES = 24576
MAX_MESSAGE_BYTES = MAX_STATE_BYTES + 1024
PUBLICATION_VALIDATION_LIMIT = 32
INPUT_HISTORY_LIMIT = 8
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
TOKEN = re.compile(r'^[A-Za-z0-9_-]{43}$')
CONNECTION = re.compile(r'^[A-Za-z0-9_=+\-]{1,128}$')
_games = None
_callback = None
_database = None
_publication_validations = OrderedDict()


class MultiplayerError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def fail(message, status=400):
    raise MultiplayerError(status, message)


def fields(value, required, optional=()):
    if not isinstance(value, dict) or set(required) - set(value) or set(value) - set(required) - set(optional):
        fail('Unexpected or missing multiplayer fields.')


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        fail('A multiplayer number is outside its allowed range.')
    return value


def number(value, low, high):
    if type(value) not in {int, float} or not math.isfinite(value) or not low <= value <= high:
        fail('A multiplayer number is outside its allowed range.')


def boolean(value):
    if type(value) is not bool:
        fail('A multiplayer flag must be true or false.')


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        fail('Invalid multiplayer room or game identifier.')
    return value


def digest(token):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        fail('This room capability is invalid.', 403)
    return hashlib.sha256(token.encode('ascii')).hexdigest()


def canonical(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        fail('Invalid multiplayer data.')


def games():
    global _games
    if _games is None:
        spec = importlib.util.spec_from_file_location('game_studio_multiplayer_games', Path(__file__).with_name('games.py'))
        _games = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_games)
    return _games


def key(kind, value):
    return ':'.join(['multiplayer', os.environ['CORE_ORGANIZATION_ID'], os.environ['CORE_SERVICE_ID'], kind, value])


def database(api):
    if not os.environ.get('MULTIPLAYER_TABLE'):
        fail('Multiplayer is not configured for this installation.', 503)
    return api.clients()[0]


def load(api, kind, value):
    item = database(api).Table(os.environ['MULTIPLAYER_TABLE']).get_item(Key={'id': key(kind, value)}, ConsistentRead=True).get('Item')
    if item and (item.get('organization_id') != os.environ['CORE_ORGANIZATION_ID'] or item.get('service_id') != os.environ['CORE_SERVICE_ID']):
        fail('Multiplayer room not found.', 404)
    return item


def row(kind, value, **values):
    return {'id': key(kind, value), 'organization_id': os.environ['CORE_ORGANIZATION_ID'],
        'service_id': os.environ['CORE_SERVICE_ID'], 'version': 1, **values}


def put(value, previous=None):
    # TransactWriteItems requires expression strings; the resource client still
    # marshals native Python values. Membership changes span room + connection.
    options = {'TableName': os.environ['MULTIPLAYER_TABLE'], 'Item': value}
    if previous is None:
        options['ConditionExpression'] = 'attribute_not_exists(id)'
    else:
        options.update(ConditionExpression='#v = :version AND organization_id = :org AND service_id = :service',
            ExpressionAttributeNames={'#v': 'version'}, ExpressionAttributeValues={':version': int(previous['version']),
                ':org': os.environ['CORE_ORGANIZATION_ID'], ':service': os.environ['CORE_SERVICE_ID']})
    return {'Put': options}


def transaction(api, operations):
    client = database(api).meta.client
    try:
        client.transact_write_items(TransactItems=operations)
        return True
    except client.exceptions.TransactionCanceledException as error:
        reasons = getattr(error, 'response', {}).get('CancellationReasons')
        if reasons is not None:
            # Validation and unknown service failures are not contention. Never
            # disguise them as a successful commit or a recoverable busy frame.
            if (not isinstance(reasons, list) or len(reasons) != len(operations)
                    or any(not isinstance(reason, dict) or reason.get('Code') not in
                        {None, 'None', 'ConditionalCheckFailed', 'TransactionConflict'} for reason in reasons)
                    or not any(reason.get('Code') in {'ConditionalCheckFailed', 'TransactionConflict'} for reason in reasons)):
                raise
        return False


def revision(previous, **changes):
    return {**previous, **changes, 'version': int(previous['version']) + 1}


def room_check(room):
    return {'ConditionCheck': {'TableName': os.environ['MULTIPLAYER_TABLE'], 'Key': {'id': room['id']},
        'ConditionExpression': '#v = :version AND organization_id = :org AND service_id = :service',
        'ExpressionAttributeNames': {'#v': 'version'}, 'ExpressionAttributeValues': {':version': int(room['version']),
            ':org': os.environ['CORE_ORGANIZATION_ID'], ':service': os.environ['CORE_SERVICE_ID']}}}


def publication(api, game_id, edition, expected_hash=None):
    identifier(game_id)
    integer(edition, 1, 1000000000)
    public = api.clients()[0].Table(os.environ['GAME_PUBLIC_TABLE']).get_item(
        Key={'id': games().key('game', game_id)}, ConsistentRead=True).get('Item')
    if not public or public.get('organization_id') != os.environ['CORE_ORGANIZATION_ID'] or public.get('service_id') != os.environ['CORE_SERVICE_ID']:
        fail('Published multiplayer game not found.', 404)
    state = json.loads(public['payload'])
    if state.get('id') != game_id or state.get('status') != 'Published' or state.get('_deleted'):
        fail('Published multiplayer game not found.', 404)
    if state.get('publishedRevision') != edition or state.get('revision') != edition:
        fail('The published game changed. Start a new room.', 409)
    # Cache validation results, never publication authority or mutable specs.
    # The live record is still read and its exact payload fenced on every call.
    cache_key = (os.environ['CORE_ORGANIZATION_ID'], os.environ['CORE_SERVICE_ID'], game_id, edition,
        hashlib.sha256(public['payload'].encode('utf-8')).hexdigest())
    spec_hash = _publication_validations.get(cache_key)
    if spec_hash is None:
        try:
            spec = games().validate_spec(state['spec'])
        except (games().GameError, KeyError):
            fail('This edition does not support multiplayer.', 409)
        if spec.get('version') not in {4, 5, 6} or spec.get('multiplayer') != {'mode': 'cooperative', 'maxPlayers': 2}:
            fail('Two-player play is not enabled for this game.', 409)
        spec_hash = hashlib.sha256(canonical(spec).encode('utf-8')).hexdigest()
        _publication_validations[cache_key] = spec_hash
        if len(_publication_validations) > PUBLICATION_VALIDATION_LIMIT:
            _publication_validations.popitem(last=False)
    else:
        # json.loads above created a fresh object; callers cannot mutate a
        # cached object or another request's validated definition.
        spec = state['spec']
        _publication_validations.move_to_end(cache_key)
    if expected_hash is not None and not hmac.compare_digest(spec_hash, expected_hash):
        fail('The published game changed. Start a new room.', 409)
    check = {'ConditionCheck': {'TableName': os.environ['GAME_PUBLIC_TABLE'], 'Key': {'id': public['id']},
        'ConditionExpression': 'revision = :revision AND payload = :payload AND organization_id = :org AND service_id = :service',
        'ExpressionAttributeValues': {':revision': public['revision'], ':payload': public['payload'],
            ':org': os.environ['CORE_ORGANIZATION_ID'], ':service': os.environ['CORE_SERVICE_ID']}}}
    return spec, spec_hash, check


def callback(api):
    if hasattr(api, 'multiplayer_callback'):
        return api.multiplayer_callback
    global _callback
    if _callback is None:
        import boto3
        from botocore.config import Config
        endpoint = os.environ.get('MULTIPLAYER_CALLBACK_URL', '')
        parsed = urlsplit(endpoint)
        if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            fail('The multiplayer relay is not configured.', 503)
        _callback = boto3.client('apigatewaymanagementapi', endpoint_url=endpoint,
            config=Config(connect_timeout=3, read_timeout=3, retries={'total_max_attempts': 2, 'mode': 'standard'}))
    return _callback


def post(api, connection_id, message):
    if not connection_id:
        return False
    client = callback(api)
    try:
        client.post_to_connection(ConnectionId=connection_id, Data=canonical(message).encode('utf-8'))
        return True
    except client.exceptions.GoneException:
        return False


def disconnect_socket(api, connection_id):
    if not connection_id:
        return
    client = callback(api)
    try:
        client.delete_connection(ConnectionId=connection_id)
    except client.exceptions.GoneException:
        pass


def rate(api, event, operation, limit):
    now = int(time.time())
    context = event.get('requestContext') or {}
    source = (context.get('http') or context.get('identity') or {}).get('sourceIp', '')
    if not isinstance(source, str) or not 1 <= len(source) <= 128:
        source = 'unknown'
    # Rotate both identifier and retention every minute. Never store the raw IP.
    bucket = str(now // 60)
    identity = hashlib.sha256((key('rate', operation) + ':' + bucket + ':' + source).encode()).hexdigest()
    for _ in range(5):
        old = load(api, 'rate', identity)
        count = int(old['count']) if old else 0
        if count >= limit:
            fail('Too many multiplayer requests. Wait a minute and retry.', 429)
        value = revision(old, count=count + 1) if old else row('rate', identity, count=1, expiresAt=(now // 60 + 2) * 60)
        if transaction(api, [put(value, old)]):
            return
    fail('Multiplayer is busy. Retry shortly.', 409)


def frontend_origins():
    """At most one explicit compatibility alias; never derive trust from a request."""
    primary = os.environ.get('FRONTEND_ORIGIN', '')
    legacy = os.environ.get('LEGACY_FRONTEND_ORIGIN', '')
    application = os.environ.get('APPLICATION_ORIGIN')
    if application is not None and application != primary:
        fail('The multiplayer frontend origin is misconfigured.', 503)

    def exact(value, local=False):
        try:
            parsed = urlsplit(value)
            if local and parsed.scheme == 'http' and parsed.hostname in {'localhost', '127.0.0.1', '::1'}:
                return (parsed.username is None and parsed.password is None and not parsed.path and not parsed.query
                    and not parsed.fragment and '?' not in value and '#' not in value
                    and parsed.port is not None and 1 <= parsed.port <= 65535)
            return (isinstance(value, str) and len(value) <= 255 and parsed.scheme == 'https'
                and parsed.port is None and not parsed.path and not parsed.query and not parsed.fragment
                and '?' not in value and '#' not in value and value == 'https://' + parsed.netloc
                and re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*', parsed.netloc) is not None)
        except (ValueError, TypeError):
            return False

    # The loopback-only development adapter has no deployed application binding.
    if not exact(primary, local=application is None and not legacy) or legacy and (not exact(legacy) or legacy == primary):
        fail('The multiplayer frontend origin is misconfigured.', 503)
    return (primary, legacy) if legacy else (primary,)


def origin(event):
    supplied = [value for key, value in (event.get('headers') or {}).items() if str(key).lower() == 'origin']
    if len(supplied) != 1 or supplied[0] not in frontend_origins():
        fail('This page is not allowed to use the multiplayer relay.', 403)


def socket_url():
    value = os.environ.get('MULTIPLAYER_SOCKET_URL', '')
    parsed = urlsplit(value)
    if parsed.scheme != 'wss' or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        fail('Multiplayer is not configured for this installation.', 503)
    return value


def connection_record(api, connection_id, loaded=None):
    if not connection_id:
        return None
    if loaded is None:
        return load(api, 'connection', connection_id)
    if connection_id not in loaded:
        loaded[connection_id] = load(api, 'connection', connection_id)
    return loaded[connection_id]


def connected(api, room, seat, now=None, *, loaded=None):
    now = int(time.time()) if now is None else now
    connection_id = room.get('connection' + str(seat))
    connection = connection_record(api, connection_id, loaded)
    if not connection or connection.get('roomId') != room['roomId'] or connection.get('generation') != room.get('generation' + str(seat)):
        return False
    return int(connection.get('lastSeen', 0)) + HEARTBEAT_SECONDS > now and int(connection['expiresAt']) > now


def terminate(api, room, reason):
    for _ in range(5):
        if room.get('closed'):
            break
        changed = revision(room, closed=True, closedReason=reason)
        if transaction(api, [put(changed, room)]):
            room = changed
            break
        room = load(api, 'room', room['roomId'])
        if not room:
            return
    if not room.get('closed'):
        fail('This room is busy. Retry closing it shortly.', 409)
    for seat in (0, 1):
        connection_id = room.get('connection' + str(seat))
        if connection_id:
            post(api, connection_id, {'type': 'closed', 'reason': reason})
            disconnect_socket(api, connection_id)


def active_room(api, room_id, *, loaded=None):
    loaded = {} if loaded is None else loaded
    room = load(api, 'room', identifier(room_id))
    if not room:
        fail('This multiplayer room is unavailable.', 410)
    now = int(time.time())
    if room.get('closed'):
        fail('This multiplayer room is closed.', 410)
    if int(room['expiresAt']) <= now:
        terminate(api, room, 'expired')
        fail('This multiplayer room expired. Start a new room.', 410)
    if room.get('hostConnected'):
        absent = int(room.get('disconnectedAt0', 0))
        if not absent and not connected(api, room, 0, now, loaded=loaded):
            host = connection_record(api, room.get('connection0'), loaded)
            absent = int(host.get('lastSeen', room['createdAt'])) + HEARTBEAT_SECONDS if host else int(room['createdAt'])
        if absent and absent + DISCONNECT_GRACE <= now:
            terminate(api, room, 'host-disconnected')
            fail('The host disconnected. Start a new room.', 410)
    try:
        spec, _, check = publication(api, room['gameId'], int(room['publishedRevision']), room['specSha256'])
    except MultiplayerError as error:
        if error.status in {404, 409}:
            terminate(api, room, 'publication-changed')
            fail('The published game changed. Start a new room.', 410)
        raise
    return room, spec, check


def lobby_registry(api):
    value = load(api, 'lobby', 'waiting')
    if value and (not isinstance(value.get('roomIds'), list) or len(value['roomIds']) > LOBBY_LIMIT
            or any(not isinstance(item, str) or not UUID.fullmatch(item) for item in value['roomIds'])
            or len(set(value['roomIds'])) != len(value['roomIds'])):
        fail('The public lobby is unavailable. Retry shortly.', 503)
    return value


def lobby_write(previous, room_ids, expires_at):
    if len(room_ids) > LOBBY_LIMIT:
        fail('The public lobby is full. Use a private invitation or retry shortly.', 409)
    value = revision(previous, roomIds=room_ids, expiresAt=expires_at) if previous else row(
        'lobby', 'waiting', roomIds=room_ids, expiresAt=expires_at)
    return put(value, previous)


def pending_public_guest(room):
    return (room.get('visibility', 'private') == 'public' and room.get('guestHash')
        and not room.get('guestAdmitted') and int(room.get('guestReservationExpiresAt', 0)) > 0)


def waiting_public_room(api, room, now, host_required=True):
    if (not room or room.get('visibility', 'private') != 'public' or room.get('closed')
            or int(room['expiresAt']) <= now):
        return False
    if room.get('guestHash') and (not pending_public_guest(room)
            or host_required and int(room['guestReservationExpiresAt']) > now):
        # A pending public claimant temporarily hides the listing, but remains
        # in the registry so an abandoned reservation becomes discoverable again.
        return False
    if connected(api, room, 0, now):
        return True
    if host_required:
        return False
    # Keep an unconnected host's initial reservation, and keep a previously
    # connected host only for its existing bounded reconnect grace.
    if not room.get('hostConnected'):
        return int(room['createdAt']) + PENDING_SECONDS > now
    absent = int(room.get('disconnectedAt0', 0))
    if not absent:
        host = load(api, 'connection', room['connection0']) if room.get('connection0') else None
        absent = int(host.get('lastSeen', room['createdAt'])) + HEARTBEAT_SECONDS if host else int(room['createdAt'])
    return absent + DISCONNECT_GRACE > now


def public_rooms(api, event, body):
    fields(body, ())
    rate(api, event, 'lobby-list', 30)
    rate(api, {'requestContext': {}}, 'all-lobby-list', 240)
    registry = lobby_registry(api)
    now, result = int(time.time()), []
    for room_id in registry['roomIds'] if registry else []:
        room = load(api, 'room', room_id)
        if not waiting_public_room(api, room, now):
            continue
        try:
            spec, _, _ = publication(api, room['gameId'], int(room['publishedRevision']), room['specSha256'])
        except MultiplayerError as error:
            if error.status in {404, 409}:
                continue
            raise
        result.append({'roomId': room['roomId'], 'gameId': room['gameId'],
            'publishedRevision': int(room['publishedRevision']), 'specSha256': room['specSha256'],
            'title': spec['title'], 'expiresAt': int(room['expiresAt'])})
    return {'rooms': result}


def lobby_advertise(api, room, expires_at):
    """Renew only a live capability's existing public waiting-room listing."""
    if room.get('visibility', 'private') != 'public' or room.get('guestHash') and not pending_public_guest(room):
        return []
    registry = lobby_registry(api)
    ids = list(registry['roomIds']) if registry else []
    if room['roomId'] not in ids:
        if len(ids) >= LOBBY_LIMIT:
            now = int(time.time())
            ids = [value for value in ids if waiting_public_room(api, load(api, 'room', value), now, host_required=False)]
        if len(ids) >= LOBBY_LIMIT:
            # A revived room can still play through its existing capabilities.
            # Discovery capacity must never revoke an admitted host's lease.
            return []
        ids.append(room['roomId'])
    return [lobby_write(registry, ids, max(expires_at, int(registry['expiresAt']) if registry else 0))]


def lobby_remove(api, room):
    if room.get('visibility', 'private') != 'public':
        return []
    registry = lobby_registry(api)
    if not registry or room['roomId'] not in registry['roomIds']:
        return []
    return [lobby_write(registry, [value for value in registry['roomIds'] if value != room['roomId']], int(registry['expiresAt']))]


def create_room(api, event, body):
    fields(body, ('gameId', 'publishedRevision'), ('visibility',))
    visibility = body.get('visibility', 'private')
    if not isinstance(visibility, str) or visibility not in {'private', 'public'}:
        fail('Choose a private invitation or public partner lobby.')
    rate(api, event, 'create', 6)
    # Separate installation-wide bound also limits distributed room allocation.
    rate(api, {'requestContext': {}}, 'all-create', 120)
    endpoint = socket_url()
    spec, spec_hash, check = publication(api, body['gameId'], body['publishedRevision'])
    now = int(time.time())
    room_id = str(uuid.uuid4())
    host, invite = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    room = row('room', room_id, roomId=room_id, gameId=body['gameId'], publishedRevision=body['publishedRevision'],
        specSha256=spec_hash, hostHash=digest(host), inviteHash=digest(invite), guestHash='',
        createdAt=now, expiresAt=now + ROOM_SECONDS, legacyExpiresAt0=now + ROOM_SECONDS,
        legacyExpiresAt1=now + ROOM_SECONDS, closed=False, hostConnected=False, visibility=visibility,
        connection0='', connection1='', generation0='', generation1='', disconnectedAt0=0, disconnectedAt1=0)
    for _ in range(5):
        registry_operations = []
        if visibility == 'public':
            registry = lobby_registry(api)
            live = []
            for candidate_id in registry['roomIds'] if registry else []:
                candidate = load(api, 'room', candidate_id)
                if not waiting_public_room(api, candidate, now, host_required=False):
                    continue
                try:
                    publication(api, candidate['gameId'], int(candidate['publishedRevision']), candidate['specSha256'])
                except MultiplayerError as error:
                    if error.status in {404, 409}:
                        continue
                    raise
                live.append(candidate)
            registry_operations = [lobby_write(registry, [value['roomId'] for value in live] + [room['roomId']],
                max([room['expiresAt']] + [int(value['expiresAt']) for value in live]))]
        if transaction(api, [check, put(room), *registry_operations]):
            break
        if visibility == 'private':
            fail('The game changed while the room was created. Retry.', 409)
        # A registry race is retriable; a changed publication remains refused by
        # the same exact condition check in every attempted transaction.
    else:
        fail('The public lobby changed. Retry shortly.', 409)
    return {'roomId': room['roomId'], 'hostToken': host, 'inviteToken': invite, 'expiresAt': room['expiresAt'], 'socketUrl': endpoint,
        'gameId': room['gameId'], 'publishedRevision': int(room['publishedRevision']), 'specSha256': room['specSha256']}


def join_room(api, event, room_id, body, public=False):
    fields(body, ('gameId', 'publishedRevision', 'specSha256') if public else ('inviteToken', 'gameId', 'publishedRevision', 'specSha256'))
    supplied = None if public else digest(body['inviteToken'])
    identifier(body['gameId']); integer(body['publishedRevision'], 1, 1000000000)
    if not isinstance(body['specSha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', body['specSha256']):
        fail('An exact published game binding is required.')
    rate(api, event, 'lobby-join' if public else 'join', 20)
    if public:
        rate(api, {'requestContext': {}}, 'all-lobby-join', 120)
    endpoint = socket_url()
    for _ in range(5):
        room, _, check = active_room(api, room_id)
        if body['gameId'] != room['gameId'] or body['publishedRevision'] != int(room['publishedRevision']) or not hmac.compare_digest(body['specSha256'], room['specSha256']):
            fail('This invitation belongs to a different game edition. Open its original link.', 409)
        if public:
            if not waiting_public_room(api, room, int(time.time())):
                fail('This public room is no longer waiting for a partner.', 409)
        elif room['guestHash'] or not hmac.compare_digest(room['inviteHash'], supplied):
            fail('This invitation has been used or is invalid. Ask for a new room.', 403)
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        changed = revision(room, guestHash=digest(token), inviteHash='', guestAdmitted=False, guestClaimedAt=now,
            guestReservationExpiresAt=now + PENDING_SECONDS if public else 0,
            legacyExpiresAt0=int(room.get('legacyExpiresAt0', room['expiresAt'])), legacyExpiresAt1=int(room['expiresAt']))
        # Only WebSocket admission seals a public claimant's seat. Keep its
        # registry reservation until then; private invitations remain one-use.
        lobby_operations = [] if public else lobby_remove(api, room)
        if transaction(api, [check, put(changed, room), *lobby_operations]):
            return {'roomId': room_id, 'guestToken': token, 'expiresAt': int(room['expiresAt']), 'socketUrl': endpoint,
                'gameId': room['gameId'], 'publishedRevision': int(room['publishedRevision']), 'specSha256': room['specSha256']}
    fail('This room changed. Retry shortly.', 409)


def close_room(api, room_id, body):
    fields(body, ('hostToken',))
    supplied = digest(body['hostToken'])
    room = load(api, 'room', identifier(room_id))
    if not room or not hmac.compare_digest(room['hostHash'], supplied):
        fail('Only the room host can close this room.', 403)
    terminate(api, room, 'closed')
    return {'closed': True}


def dispatch(api, event, method, path, body):
    if method == 'GET' and path == '/multiplayer/lobby':
        return public_rooms(api, event, body)
    if method == 'POST' and path == '/multiplayer/rooms':
        return create_room(api, event, body)
    match = re.fullmatch(r'/multiplayer/rooms/([^/]+)(/join|/lobby-join)?', path)
    if match and method == 'POST' and match[2] == '/join':
        return join_room(api, event, match[1], body)
    if match and method == 'POST' and match[2] == '/lobby-join':
        return join_room(api, event, match[1], body, public=True)
    if match and method == 'DELETE' and not match[2]:
        rate(api, event, 'close', 30)
        return close_room(api, match[1], body)
    fail('Multiplayer route not found.', 404)


def validate_state(value, spec):
    advanced = spec['version'] == 6
    endless = advanced and spec['asteroids']['endless']
    prizes = spec['version'] == 5 or advanced and 'powerUps' in spec
    maximum_id = 2147483646 if advanced else 10000000
    fields(value, ('levelIndex', 'elapsed', 'outcome', 'running', 'paused', 'seed', 'nextId', 'nextSnack', 'nextHazard', 'players', 'entities', 'bullets', 'platforms') + (('powerUps',) if prizes else ()) + (('advanced',) if advanced else ()))
    if len(canonical(value).encode('utf-8')) > (24000 if advanced or prizes else MAX_STATE_BYTES):
        fail('The multiplayer snapshot is too large.', 413)
    level_index = integer(value['levelIndex'], 0, len(spec['levels']) - 1)
    if endless and level_index != 0: fail('Endless cooperation uses the first saved level.')
    rules = spec['levels'][level_index]['rules']
    number(value['elapsed'], 0, 2147483647 if endless else rules['timeLimit'])
    if not isinstance(value['outcome'], str) or value['outcome'] not in {'playing', 'won', 'lost'}:
        fail('Invalid multiplayer outcome.')
    if endless and value['outcome'] == 'won': fail('An endless game has no winning outcome.')
    boolean(value['running']); boolean(value['paused'])
    integer(value['seed'], 0, 4294967295); integer(value['nextId'], 1, 2147483647 if advanced else 10000000)
    number(value['nextSnack'], -1, 1); number(value['nextHazard'], -1, 2)
    if not isinstance(value['players'], list) or len(value['players']) != 2:
        fail('A cooperative game has exactly two players.')
    for player in value['players']:
        fields(player, ('x', 'y', 'vy', 'grounded', 'score', 'lives', 'invulnerable', 'angle', 'previousJump', 'fireCooldown', 'points') + (('effects',) if prizes else ()))
        number(player['x'], 0, 918); number(player['y'], -100, 600); number(player['vy'], -1000, 1000)
        boolean(player['grounded']); boolean(player['previousJump'])
        integer(player['score'], 0, min(2147483647, math.ceil(value['elapsed'] * 20) + 40) if endless else rules['goal']); integer(player['lives'], 0, rules['lives'])
        number(player['invulnerable'], 0, 2); number(player['angle'], -7, 7); number(player['fireCooldown'], 0, 1)
        integer(player['points'], 0, min(2147483647, math.ceil(value['elapsed'] * 2000) + 2000) if advanced else 1000000)
        if prizes:
            effects = player['effects']
            fields(effects, ('tripleShot', 'rapidFire', 'speedBoost', 'shield'))
            for field, kind in [('tripleShot', 'triple-shot'), ('rapidFire', 'rapid-fire'), ('speedBoost', 'speed-boost')]:
                number(effects[field], 0, spec['powerUps']['duration'])
                if kind not in spec['powerUps']['types'] and effects[field] != 0: fail('This prize effect is not enabled.')
            integer(effects['shield'], 0, 1)
            if 'shield' not in spec['powerUps']['types'] and effects['shield'] != 0: fail('This prize effect is not enabled.')
    if value['outcome'] == 'won' and any(player['score'] != rules['goal'] for player in value['players']):
        fail('Both players must complete the level before a cooperative win.')
    ids = set()
    for collection, limit in [('entities', 64 if prizes or advanced else 96), ('bullets', 64 if prizes or advanced else 32), ('platforms', 6)]:
        if not isinstance(value[collection], list) or len(value[collection]) > limit:
            fail('The multiplayer snapshot exceeds its entity limit.')
        for item in value[collection]:
            if collection == 'platforms':
                fields(item, ('x', 'y', 'w', 'h'))
                number(item['x'], 0, 960); number(item['y'], 0, 540); number(item['w'], 1, 960); number(item['h'], 1, 64)
                continue
            if collection == 'entities':
                fields(item, ('id', 'kind', 'x', 'y', 'w', 'h', 'vx', 'vy'), ('asteroid', 'grace'))
                if not isinstance(item['kind'], str) or item['kind'] not in {'snack', 'hazard'}:
                    fail('Invalid multiplayer entity.')
                number(item['x'], -64, 1024); number(item['y'], -128, 600); number(item['w'], 1, 64); number(item['h'], 1, 64)
                if 'asteroid' in item and (not isinstance(item['asteroid'], str) or item['asteroid'] not in ({'large', 'medium', 'small'} if advanced and spec['asteroids']['sizes'] == 3 else {'large', 'small'})):
                    fail('Invalid multiplayer asteroid.')
                if 'grace' in item:
                    number(item['grace'], 0, 1)
            else:
                fields(item, ('id', 'owner', 'x', 'y', 'vx', 'vy', 'ttl'))
                integer(item['owner'], 0, 1); number(item['x'], -30, 990); number(item['y'], -30, 570); number(item['ttl'], 0, 2)
            identity = integer(item['id'], 1, maximum_id)
            if identity in ids or identity >= value['nextId']:
                fail('Multiplayer entity identifiers must be unique and precede the next identifier.')
            ids.add(identity)
            number(item['vx'], -1000, 1000); number(item['vy'], -1000, 1000)
    if advanced:
        for entity in value['entities']:
            size = {'large': 42, 'medium': 30, 'small': 18}.get(entity.get('asteroid'))
            if entity['kind'] == 'snack':
                if 'asteroid' in entity or 'grace' in entity or entity['w'] != 22 or entity['h'] != 22: fail('Invalid advanced snack shape.')
            elif size is None or entity['w'] != size or entity['h'] != size: fail('Invalid advanced asteroid shape.')
        def weight(entity):
            if not spec['arcade']['splitAsteroids']: return 1
            return 4 if entity.get('asteroid') == 'large' and spec['asteroids']['sizes'] == 3 else 2 if entity.get('asteroid') in {'large', 'medium'} else 1
        if sum(weight(entity) for entity in value['entities']) > 64: fail('The multiplayer snapshot exceeds its descendant entity limit.')
    if prizes or advanced:
        if not advanced and sum(2 if entity.get('asteroid') == 'large' and spec.get('arcade', {}).get('splitAsteroids') else 1 for entity in value['entities']) > 64:
            fail('The multiplayer snapshot exceeds its weighted entity limit.')
        if any(sum(bullet['owner'] == owner for bullet in value['bullets']) > 32 for owner in (0, 1)):
            fail('The multiplayer snapshot exceeds its per-player projectile limit.')
    if prizes:
        settings = value['powerUps']
        fields(settings, ('pickups', 'nextSpawn'))
        number(settings['nextSpawn'], 0, spec['powerUps']['spawnInterval'])
        if not isinstance(settings['pickups'], list) or len(settings['pickups']) > 3: fail('The multiplayer snapshot exceeds its prize limit.')
        for pickup in settings['pickups']:
            fields(pickup, ('id', 'type', 'x', 'y', 'ttl'))
            identity = integer(pickup['id'], 1, maximum_id)
            if identity in ids or identity >= value['nextId']: fail('Multiplayer entity identifiers must be unique and precede the next identifier.')
            ids.add(identity)
            if not isinstance(pickup['type'], str) or pickup['type'] not in spec['powerUps']['types']: fail('This prize type is not enabled.')
            number(pickup['x'], 0, 932); number(pickup['y'], -28, 568); number(pickup['ttl'], 0, 12)
    if advanced:
        world, configured = value['advanced'], spec['asteroids']['enemies']
        fields(world, ('difficulty', 'nextEnemy', 'enemies', 'enemyBullets'))
        integer(world['difficulty'], 1, 214748365); number(world['nextEnemy'], 0, 60)
        if not endless and world['difficulty'] != rules['difficulty']: fail('Finite games use the authored level difficulty.')
        if not isinstance(world['enemies'], list) or len(world['enemies']) > configured['maxShips']: fail('The multiplayer snapshot exceeds its enemy ship limit.')
        if not isinstance(world['enemyBullets'], list) or len(world['enemyBullets']) > 24: fail('The multiplayer snapshot exceeds its hostile projectile limit.')
        if not configured['enabled'] and (world['enemies'] or world['enemyBullets']): fail('Enemy ships are not enabled.')
        if configured['difficulty'] != 'hard' and world['enemyBullets']: fail('Only hard enemy ships fire hostile projectiles.')
        for ship in world['enemies']:
            fields(ship, ('id', 'x', 'y', 'w', 'h', 'vx', 'vy', 'hp', 'maxHp', 'fireCooldown', 'phase'))
            if ship['w'] != 38 or ship['h'] != 28: fail('Invalid enemy ship dimensions.')
            number(ship['x'], -64, 1024); number(ship['y'], -64, 600)
            number(ship['vx'], -800, 800); number(ship['vy'], -800, 800)
            integer(ship['hp'], 1, configured['hitPoints']); integer(ship['maxHp'], configured['hitPoints'], configured['hitPoints'])
            number(ship['fireCooldown'], 0, 3); number(ship['phase'], 0, math.pi * 2)
        for bullet in world['enemyBullets']:
            fields(bullet, ('id', 'x', 'y', 'vx', 'vy', 'ttl'))
            number(bullet['x'], -30, 990); number(bullet['y'], -30, 570)
            number(bullet['vx'], -800, 800); number(bullet['vy'], -800, 800); number(bullet['ttl'], 0, 4)
        for entity in world['enemies'] + world['enemyBullets']:
            identity = integer(entity['id'], 1, maximum_id)
            if identity in ids or identity >= value['nextId']: fail('Multiplayer entity identifiers must be unique and precede the next identifier.')
            ids.add(identity)
    return value


def connection_id(event):
    value = (event.get('requestContext') or {}).get('connectionId')
    if not isinstance(value, str) or not CONNECTION.fullmatch(value):
        fail('Invalid relay connection.', 400)
    return value


def connect(api, event):
    origin(event)
    if event.get('queryStringParameters'):
        fail('Relay admission belongs in the first message, not the connection URL.')
    rate(api, event, 'connect', 30)
    value = connection_id(event)
    now = int(time.time())
    pending = row('connection', value, createdAt=now, lastSeen=now, expiresAt=now + PENDING_SECONDS)
    if not transaction(api, [put(pending)]):
        fail('This relay connection already exists.', 409)


def admit(api, connection, body):
    fields(body, ('type', 'roomId', 'token'), ('leaseVersion', 'flowVersion'))
    if 'leaseVersion' in body and (type(body['leaseVersion']) is not int or body['leaseVersion'] != 1):
        fail('Unsupported multiplayer lease protocol.')
    if 'flowVersion' in body and (type(body['flowVersion']) is not int or body['flowVersion'] not in {1, 2, 3}):
        fail('Unsupported multiplayer flow protocol.')
    renewable = body.get('leaseVersion') == 1
    identifier(body['roomId'])
    supplied = digest(body['token'])
    now = int(time.time())
    if 'roomId' in connection or int(connection['expiresAt']) <= now:
        fail('This relay admission expired. Reconnect.', 403)
    for _ in range(5):
        now = int(time.time())
        if int(connection['expiresAt']) <= now:
            fail('This relay admission expired. Reconnect.', 403)
        room, _, check = active_room(api, body['roomId'])
        if hmac.compare_digest(room['hostHash'], supplied):
            seat = 0
        elif room['guestHash'] and hmac.compare_digest(room['guestHash'], supplied):
            if pending_public_guest(room) and int(room['guestReservationExpiresAt']) <= now:
                fail('This public partner reservation expired. Choose the room again.', 410)
            seat = 1
        else:
            fail('This room capability is invalid.', 403)
        generation = str(uuid.uuid4())
        old_id = room.get('connection' + str(seat))
        expires_at = max(int(room['expiresAt']), now + ROOM_SECONDS) if renewable else int(room['expiresAt'])
        connection_expiry = expires_at if renewable else int(room.get('legacyExpiresAt' + str(seat), room['expiresAt']))
        if connection_expiry <= now:
            fail('This legacy room capability expired. Start a new room.', 410)
        changed_room = revision(room, **{'connection' + str(seat): connection['connectionId'], 'generation' + str(seat): generation,
            'disconnectedAt' + str(seat): 0}, expiresAt=expires_at,
            legacyExpiresAt0=int(room.get('legacyExpiresAt0', room['expiresAt'])),
            legacyExpiresAt1=int(room.get('legacyExpiresAt1', room['expiresAt'])),
            **({'hostConnected': True} if seat == 0 else {'guestAdmitted': True}))
        changed_connection = revision(connection, roomId=room['roomId'], seat=seat, generation=generation,
            lastSeen=now, expiresAt=connection_expiry, seq=-1, **({'leaseVersion': 1} if renewable else {}),
            **({'flowVersion': body['flowVersion']} if 'flowVersion' in body else {}))
        lobby_operations = lobby_advertise(api, changed_room, expires_at) if seat == 0 else lobby_remove(api, changed_room)
        if transaction(api, [check, put(changed_room, room), put(changed_connection, connection), *lobby_operations]):
            if old_id and old_id != connection['connectionId']:
                disconnect_socket(api, old_id)
            post(api, connection['connectionId'], {'type': 'ready', 'roomId': room['roomId'], 'seat': seat, 'expiresAt': connection_expiry,
                'gameId': room['gameId'], 'publishedRevision': int(room['publishedRevision']), 'specSha256': room['specSha256']})
            if renewable:
                post(api, connection['connectionId'], {'type': 'lease', 'expiresAt': expires_at})
            post(api, connection['connectionId'], {'type': 'peer', 'connected': connected(api, changed_room, 1 - seat)})
            if connected(api, changed_room, 1 - seat):
                post(api, changed_room['connection' + str(1 - seat)], {'type': 'peer', 'connected': True})
            return
        connection = load(api, 'connection', connection['connectionId'])
        if not connection or 'roomId' in connection:
            fail('This relay admission changed. Reconnect.', 409)
    fail('This room changed. Reconnect shortly.', 409)


def disconnect(api, value):
    connection = load(api, 'connection', value)
    if not connection or 'roomId' not in connection:
        return
    for _ in range(5):
        room = load(api, 'room', connection['roomId'])
        seat = int(connection['seat'])
        if not room or room.get('closed') or room.get('connection' + str(seat)) != value or room.get('generation' + str(seat)) != connection['generation']:
            return
        changed = revision(room, **{'connection' + str(seat): '', 'disconnectedAt' + str(seat): int(time.time())})
        if transaction(api, [put(changed, room)]):
            post(api, room.get('connection' + str(1 - seat)), {'type': 'peer', 'connected': False})
            return


def acknowledge(api, connection, kind, seq):
    if connection.get('flowVersion') in {1, 2, 3} and not post(api, connection['connectionId'], {'type': 'ack', 'kind': kind, 'seq': seq}):
        # Gone is definitive. An undeliverable acknowledgment must not leave
        # this generation looking connected while the peer keeps simulating.
        disconnect(api, connection['connectionId'])


def input_history(body):
    history = body['history']
    if not isinstance(history, list) or not 1 <= len(history) <= INPUT_HISTORY_LIMIT:
        fail('Multiplayer input history is outside its allowed range.')
    previous = 0
    for item in history:
        fields(item, ('seq', 'mask'))
        seq = integer(item['seq'], 1, 2147483647)
        integer(item['mask'], 0, 63)
        if seq <= previous:
            fail('Multiplayer input history must be ordered and unique.')
        previous = seq
    if history[-1]['seq'] != body['seq'] or history[-1]['mask'] != body['mask']:
        fail('Multiplayer input history must end with the current controls.')


def message(api, event):
    value = connection_id(event)
    raw = event.get('body', '')
    if event.get('isBase64Encoded') or not isinstance(raw, str) or len(raw.encode('utf-8')) > MAX_MESSAGE_BYTES:
        fail('The multiplayer message is invalid or too large.', 413)
    try:
        body = json.loads(raw)
    except (ValueError, RecursionError):
        fail('Invalid multiplayer JSON.')
    if not isinstance(body, dict) or not isinstance(body.get('type'), str):
        fail('Invalid multiplayer message.')
    for attempt in range(5):
        if attempt:
            # Shared publication/room condition checks can conflict even when
            # neither request modifies those rows. Avoid retrying in lockstep.
            time.sleep((5 + secrets.randbelow(16)) / 1000)
        connection = load(api, 'connection', value)
        if not connection or int(connection['expiresAt']) <= int(time.time()):
            fail('This relay connection expired. Reconnect.', 410)
        connection['connectionId'] = value
        if body['type'] == 'join':
            return admit(api, connection, body)
        if 'roomId' not in connection:
            fail('Join a room before playing.', 403)
        # Request-local reuse does not retain leases across messages. The room
        # generation and publication remain fenced in the transaction below.
        loaded = {value: connection}
        room, spec, check = active_room(api, connection['roomId'], loaded=loaded)
        seat = int(connection['seat'])
        if room.get('connection' + str(seat)) != value or room.get('generation' + str(seat)) != connection['generation']:
            fail('This player reconnected in another session.', 403)
        now = int(time.time())
        seq = int(connection['seq'])
        kind = body['type']
        if kind == 'ping':
            fields(body, ('type',))
            maximum = 2
        elif kind == 'input' and seat == 1:
            fields(body, ('type', 'seq', 'mask') + (('history',) if connection.get('flowVersion') in {2, 3} else ()))
            integer(body['mask'], 0, 63)
            seq = integer(body['seq'], 1, 10000000) if connection.get('flowVersion') == 3 else integer(body['seq'], 0, 2147483647)
            if connection.get('flowVersion') in {2, 3}:
                input_history(body)
            maximum = 30
        elif kind == 'state' and seat == 0:
            fields(body, ('type', 'seq', 'state'))
            validate_state(body['state'], spec)
            seq = integer(body['seq'], 1, 10000000) if connection.get('flowVersion') == 3 else integer(body['seq'], 0, 2147483647)
            maximum = 20
        else:
            fail('This player cannot send that multiplayer message.', 403)
        requested_seq = seq
        duplicate = kind != 'ping' and seq <= int(connection['seq'])
        if duplicate:
            # A concurrent Lambda may finish out of order. Duplicate/older input
            # must never overwrite the newest sequence or bypass its rate limit.
            seq = int(connection['seq'])
        second_key, count_key = 'rateSecond_' + kind, 'rateCount_' + kind
        count = int(connection.get(count_key, 0)) + 1 if int(connection.get(second_key, 0)) == now else 1
        if count > maximum:
            fail('Multiplayer messages arrived too quickly.', 429)
        renew = kind == 'ping' and connection.get('leaseVersion') == 1
        expires_at = max(int(room['expiresAt']), now + ROOM_SECONDS) if renew else int(connection['expiresAt'])
        changed = revision(connection, lastSeen=now, seq=seq, expiresAt=expires_at, **{second_key: now, count_key: count})
        lease_operations = [put(revision(room, expiresAt=expires_at,
            legacyExpiresAt0=int(room.get('legacyExpiresAt0', room['expiresAt'])),
            legacyExpiresAt1=int(room.get('legacyExpiresAt1', room['expiresAt']))), room),
            *lobby_advertise(api, room, expires_at)] if renew else [room_check(room)]
        if transaction(api, [check, *lease_operations, put(changed, connection)]):
            if duplicate:
                acknowledge(api, connection, kind, requested_seq)
                return
            if kind == 'ping':
                post(api, value, {'type': 'pong'})
                if renew:
                    post(api, value, {'type': 'lease', 'expiresAt': expires_at})
                post(api, value, {'type': 'peer', 'connected': connected(api, room, 1 - seat, now)})
            else:
                peer_id = room.get('connection' + str(1 - seat))
                peer = connection_record(api, peer_id, loaded)
                forwarded = body
                if kind == 'input' and 'history' in body and (not peer or peer.get('flowVersion') not in {2, 3}):
                    forwarded = {name: item for name, item in body.items() if name != 'history'}
                if not connected(api, room, 1 - seat, int(time.time()), loaded=loaded) or not post(api, peer_id, forwarded):
                    if peer_id:
                        # API Gateway can report Gone before its best-effort
                        # disconnect event arrives. Clear only that generation;
                        # a subsequent heartbeat must not resurrect the lease.
                        disconnect(api, peer_id)
                    post(api, value, {'type': 'peer', 'connected': False})
                acknowledge(api, connection, kind, requested_seq)
            return
    if connection.get('flowVersion') == 3:
        # A cancelled transaction forwarded nothing and established no lease or
        # sequence progress. Only an opted-in sender can interpret this retry
        # hint; legacy clients keep their original terminal response.
        response = {'type': 'busy', 'kind': kind, 'retryAfterMs': 200}
        if kind != 'ping': response['seq'] = requested_seq
        if not post(api, value, response): disconnect(api, value)
        return
    fail('The relay is busy. Reconnect shortly.', 409)


def websocket_handler(api, event):
    route = (event.get('requestContext') or {}).get('routeKey')
    value = None
    try:
        value = connection_id(event)
        if route == '$connect':
            connect(api, event)
        elif route == '$disconnect':
            disconnect(api, value)
        elif route == '$default':
            message(api, event)
        else:
            fail('Multiplayer route not found.', 404)
        return {'statusCode': 200, 'body': ''}
    except MultiplayerError as error:
        if route not in {'$connect', '$disconnect'} and value:
            post(api, value, {'type': 'error', 'message': error.message})
            disconnect(api, value)
            disconnect_socket(api, value)
        return {'statusCode': error.status, 'body': ''}


def clients():
    global _database
    if _database is None:
        import boto3
        from botocore.config import Config
        _database = boto3.resource('dynamodb', config=Config(connect_timeout=3, read_timeout=3,
            retries={'total_max_attempts': 2, 'mode': 'standard'}))
    return _database, None, None


def handler(event, context):
    """Independent relay entrypoint: no Core credentials or private game access."""
    from types import SimpleNamespace
    api = SimpleNamespace(clients=clients)
    context_data = event.get('requestContext') or {}
    try:
        if context_data.get('routeKey') in {'$connect', '$disconnect', '$default'} and 'connectionId' in context_data:
            return websocket_handler(api, event)
        method = (context_data.get('http') or {}).get('method')
        if method == 'OPTIONS':
            return {'statusCode': 204, 'body': ''}
        if method == 'GET' and event.get('rawPath') == '/health':
            result = {'status': 'ok'}
        else:
            # Browsers always send Origin on this separate API. No cookies,
            # bearer tokens or API keys are used by a public game room.
            origin(event)
            raw = event.get('body') or '{}'
            if event.get('isBase64Encoded') or not isinstance(raw, str) or len(raw.encode('utf-8')) > 2048:
                fail('The multiplayer request is invalid or too large.', 413)
            try:
                body = json.loads(raw)
            except (ValueError, RecursionError):
                fail('Invalid multiplayer JSON.')
            if not isinstance(body, dict):
                fail('Expected a multiplayer JSON object.')
            result = dispatch(api, event, method, event.get('rawPath', '/'), body)
        status = 200
    except MultiplayerError as error:
        result, status = {'error': error.message}, error.status
    except Exception:
        # Do not log capability-bearing messages, addresses or game snapshots.
        print('Game Studio relay request failed; request id:', getattr(context, 'aws_request_id', 'local'))
        result, status = {'error': 'The multiplayer relay is unavailable. Reconnect shortly.'}, 503
    return {'statusCode': status, 'headers': {'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'}, 'body': json.dumps(result)}
