"""Private, capability-bound online party rooms in the existing game table.

The server owns roles and transitions. Public catalogs never project these rows.
Only bounded room/index records are written; all capability values are hashed.
"""
from copy import deepcopy
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import time

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
TOKEN = re.compile(r'^[A-Za-z0-9_-]{43}$')
ROOM_SECONDS = 7200
MAX_ROOMS = 32
CREATE_LIMIT = 40
SOURCE_CREATE_LIMIT = 16
_engine = None


class PartyError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def fail(message, status=400):
    raise PartyError(status, message)


def load_module(name):
    spec = importlib.util.spec_from_file_location('game_studio_' + name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def engine():
    global _engine
    if _engine is None: _engine = load_module('party_engine')
    return _engine


def canonical(value):
    try:
        return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False)
    except (ValueError, TypeError):
        fail('Party requests must contain valid finite JSON values.')


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value): fail('Invalid room or request identifier.')
    return value


def token(value):
    if not isinstance(value, str) or not TOKEN.fullmatch(value): fail('Use a complete private invitation or saved room session.', 401)
    return value


def fields(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) or set(value) - set(required) - set(optional):
        fail('Unexpected or missing Party request fields.')


def key(kind, suffix=''):
    return ':'.join([kind, os.environ['CORE_ORGANIZATION_ID'], os.environ['CORE_SERVICE_ID'], suffix])


def table(api):
    name = os.environ.get('GAME_PUBLIC_TABLE')
    if not name: fail('Live Party is not configured.', 503)
    return api.clients()[0].Table(name)


def read(api, kind, suffix=''):
    item = table(api).get_item(Key={'id': key(kind, suffix)}, ConsistentRead=True).get('Item')
    if item and (item.get('organization_id') != os.environ['CORE_ORGANIZATION_ID'] or item.get('service_id') != os.environ['CORE_SERVICE_ID']):
        fail('This room is not available.', 404)
    return item


def state_of(item):
    try:
        value = json.loads(item['payload'])
        if not isinstance(value, dict): raise ValueError()
        return value
    except (KeyError, TypeError, ValueError): fail('This room could not be opened. Its stored data has been preserved.', 503)


def put(kind, suffix, state, previous):
    payload = canonical(state)
    if len(payload.encode()) > 320000:
        fail('This room has reached its drawing limit. Clear the canvas before adding more.', 413)
    revision = int(previous['revision']) + 1 if previous else 1
    item = {'id': key(kind, suffix), 'revision': revision,
        'organization_id': os.environ['CORE_ORGANIZATION_ID'], 'service_id': os.environ['CORE_SERVICE_ID'],
        'payload': payload}
    condition = 'attribute_not_exists(id)'
    values = None
    if previous:
        condition = '#r = :revision AND #o = :org AND #s = :service AND #p = :payload'
        values = {':revision': previous['revision'], ':org': previous['organization_id'],
            ':service': previous['service_id'], ':payload': previous['payload']}
    options = {'TableName': os.environ['GAME_PUBLIC_TABLE'], 'Item': item, 'ConditionExpression': condition}
    if values:
        options.update(ExpressionAttributeNames={'#r': 'revision', '#o': 'organization_id', '#s': 'service_id', '#p': 'payload'}, ExpressionAttributeValues=values)
    return {'Put': options}


def transact(api, operations):
    client = api.clients()[0].meta.client
    try:
        client.transact_write_items(TransactItems=operations)
    except client.exceptions.TransactionCanceledException as error:
        reasons = error.response.get('CancellationReasons', [])
        if reasons and any(reason.get('Code') not in {'None', 'ConditionalCheckFailed', 'TransactionConflict'} for reason in reasons): raise
        return False
    return True


def pause(attempt):
    if attempt < 4: time.sleep((5 + secrets.randbelow(15)) / 1000)


def member(state, event):
    headers = {str(k).lower(): v for k, v in event.get('headers', {}).items()}
    header = headers.get('authorization', '')
    if not isinstance(header, str) or not header.startswith('Bearer '): fail('Rejoin using this browser’s saved room session.', 401)
    supplied = digest(token(header[7:]))
    for player_id, session in state['members'].items():
        if hmac.compare_digest(supplied, session['tokenHash']): return player_id
    fail('This room session is not valid. Use your invitation to join.', 401)


def open_room(api, room_id, now):
    previous = read(api, 'game-party-room', identifier(room_id))
    if not previous: fail('This room is no longer available. Ask the host for a new invitation.', 404)
    state = state_of(previous)
    if state.get('roomId') != room_id or type(state.get('expiresAt')) is not int or state['expiresAt'] <= now:
        fail('This room has expired. Start a new room to play again.', 410)
    if not isinstance(state.get('members'), dict) or not isinstance(state.get('game'), dict):
        fail('This room could not be opened. Its stored data has been preserved.', 503)
    return state, previous


def output(state, previous, player_id, now):
    try: room = engine().project(state['game'], player_id, now=now)
    except engine().PartyError as error: raise PartyError(error.status, error.message)
    room.update(revision=int(previous['revision']), expiresAt=state['expiresAt'])
    room['self']['actionSequence'] = state['members'][player_id].get('sequence', 0)
    return {'room': room}


def create(api, event, body):
    fields(body, {'requestId', 'kind', 'name', 'avatar', 'playerToken', 'inviteToken'}, {'settings'})
    room_id = identifier(body['requestId'])
    player_token, invite = token(body['playerToken']), token(body['inviteToken'])
    if hmac.compare_digest(player_token, invite): fail('Use separate room and player capabilities.')
    fingerprint = digest(canonical(body))
    try: game = engine().new_room({'id': room_id, 'name': body['name'], 'avatar': body['avatar']}, body['kind'], settings=body.get('settings'), now=int(time.time()))
    except engine().PartyError as error: raise PartyError(error.status, error.message)
    game['roomId'] = room_id
    source_ip = event.get('requestContext', {}).get('http', {}).get('sourceIp')
    if not isinstance(source_ip, str) or not 1 <= len(source_ip) <= 64: fail('Room admission is unavailable.', 503)
    for attempt in range(5):
        now = int(time.time())
        old = read(api, 'game-party-room', room_id)
        if old:
            state = state_of(old)
            if state.get('createFingerprint') != fingerprint: fail('This room request was already used with different settings.', 409)
            if state.get('expiresAt', 0) <= now: fail('This room has expired. Create a new room.', 410)
            result = output(state, old, room_id, now)
            result['session'] = {'roomId': room_id, 'playerId': room_id, 'token': player_token, 'inviteToken': invite}
            return result
        index_row = read(api, 'game-party-index')
        index = state_of(index_row) if index_row else {'rooms': {}, 'bucket': now // 600, 'sources': {}, 'count': 0}
        if not isinstance(index.get('rooms'), dict) or len(index['rooms']) > MAX_ROOMS: fail('Room admission needs administrator attention.', 503)
        expired = [rid for rid, expiry in index['rooms'].items() if expiry <= now]
        operations = []
        for expired_id in expired:
            identifier(expired_id)
            # The index and room renewal always commit in one transaction.
            if expired_id != room_id:
                operations.append({'Delete': {'TableName': os.environ['GAME_PUBLIC_TABLE'], 'Key': {'id': key('game-party-room', expired_id)}}})
            del index['rooms'][expired_id]
        if len(index['rooms']) >= MAX_ROOMS: fail('All live rooms are in use. Try again after another room ends.', 429)
        bucket = now // 600
        if index.get('bucket') != bucket: index.update(bucket=bucket, sources={}, count=0)
        source = digest(canonical([os.environ['CORE_ORGANIZATION_ID'], os.environ['CORE_SERVICE_ID'], bucket, source_ip]))
        if index['count'] >= CREATE_LIMIT or index['sources'].get(source, 0) >= SOURCE_CREATE_LIMIT or source not in index['sources'] and len(index['sources']) >= 128:
            fail('A few rooms were just created. Please wait before starting another.', 429)
        index['count'] += 1
        index['sources'][source] = index['sources'].get(source, 0) + 1
        expires = now + ROOM_SECONDS
        index['rooms'][room_id] = expires
        state = {'roomId': room_id, 'game': game, 'members': {room_id: {'tokenHash': digest(player_token), 'sequence': 0}},
            'createFingerprint': fingerprint, 'inviteHash': digest(invite), 'expiresAt': expires}
        room_op = put('game-party-room', room_id, state, None)
        operations.extend([room_op, put('game-party-index', '', index, index_row)])
        if transact(api, operations):
            result = output(state, room_op['Put']['Item'], room_id, now)
            result['session'] = {'roomId': room_id, 'playerId': room_id, 'token': player_token, 'inviteToken': invite}
            return result
        pause(attempt)
    fail('The room service is busy. Retry the same request shortly.', 503)


def join(api, room_id, body):
    fields(body, {'requestId', 'name', 'avatar', 'inviteToken', 'playerToken'})
    player_id, supplied = identifier(body['requestId']), token(body['inviteToken'])
    player_token = token(body['playerToken'])
    if hmac.compare_digest(player_token, supplied): fail('Use separate invitation and player capabilities.')
    fingerprint = digest(canonical(body))
    for attempt in range(5):
        now = int(time.time())
        state, previous = open_room(api, room_id, now)
        if not hmac.compare_digest(digest(supplied), state['inviteHash']): fail('This invitation is not valid for this room.', 403)
        if player_id in state['members']:
            if state['members'][player_id].get('joinFingerprint') != fingerprint: fail('This join request has already been used.', 409)
            result = output(state, previous, player_id, now)
            result['session'] = {'roomId': room_id, 'playerId': player_id, 'token': player_token}
            return result
        if len(state['members']) >= 24: fail('This room has reached its participant limit.', 409)
        if any(hmac.compare_digest(digest(player_token), entry['tokenHash']) for entry in state['members'].values()):
            fail('Use a new player session to join.', 409)
        try: state['game'] = engine().add_player(state['game'], {'id': player_id, 'name': body['name'], 'avatar': body['avatar']}, now=now)
        except engine().PartyError as error: raise PartyError(error.status, error.message)
        state['members'][player_id] = {'tokenHash': digest(player_token), 'joinFingerprint': fingerprint, 'sequence': 0}
        operation = put('game-party-room', room_id, state, previous)
        if transact(api, [operation]):
            result = output(state, operation['Put']['Item'], player_id, now)
            result['session'] = {'roomId': room_id, 'playerId': player_id, 'token': player_token}
            return result
        pause(attempt)
    fail('The room is busy. Retry joining shortly.', 503)


def renew_operations(api, state, now):
    terminal = state['game']['phase'] in {'closed', 'finished'}
    if terminal and state.get('retiring'): return []
    if not terminal and not state.get('retiring') and state['expiresAt'] - now > ROOM_SECONDS // 2: return []
    index_row = read(api, 'game-party-index')
    if not index_row: fail('The room lease could not be renewed.', 503)
    index = state_of(index_row)
    if state['roomId'] not in index.get('rooms', {}): fail('The room is no longer active.', 410)
    state['expiresAt'] = min(state['expiresAt'], now + (60 if state['game']['phase'] == 'closed' else 600)) if terminal else now + ROOM_SECONDS
    if terminal: state['retiring'] = True
    else: state.pop('retiring', None)
    index['rooms'][state['roomId']] = state['expiresAt']
    return [put('game-party-index', '', index, index_row)]


def room_request(api, event, room_id, body=None):
    if body is not None:
        fields(body, {'requestId', 'phaseId', 'sequence', 'type'}, {'targetId', 'text', 'force', 'settings', 'room', 'taskId', 'step', 'answer', 'choice', 'column', 'stroke', 'color', 'points', 'width'})
        identifier(body['requestId'])
        if type(body['phaseId']) is not int or body['phaseId'] < 0 or type(body['sequence']) is not int or not 1 <= body['sequence'] <= 100000:
            fail('Reload the room before sending another action.')
    for attempt in range(5):
        now = int(time.time())
        state, previous = open_room(api, room_id, now)
        actor = member(state, event)
        if body is not None:
            session = state['members'][actor]
            fingerprint = digest(canonical(body))
            if body['sequence'] == session.get('sequence', 0):
                if session.get('lastFingerprint') != fingerprint: fail('This action sequence was already used. Reload the room.', 409)
                return output(state, previous, actor, now)
            if body['sequence'] != session.get('sequence', 0) + 1: fail('Your room changed in another tab. Reload before acting.', 409)
        try: reconciled = engine().reconcile(state['game'], now=now)
        except engine().PartyError as error: raise PartyError(error.status, error.message)
        changed = reconciled != state['game']
        state['game'] = reconciled
        operations = renew_operations(api, state, now)
        if body is not None and body['phaseId'] != state['game']['phaseId']:
            if changed or operations:
                operations.insert(0, put('game-party-room', room_id, state, previous))
                if not transact(api, operations): pause(attempt); continue
            fail('The phase has changed. Read the current room before acting.', 409)
        if body is not None:
            minute = now // 60
            rate = session.get('rate', {'minute': minute, 'count': 0})
            if rate['minute'] != minute: rate = {'minute': minute, 'count': 0}
            if rate['count'] >= 180: fail('Please pause briefly before sending another action.', 429)
            action = {k: v for k, v in body.items() if k not in {'requestId', 'phaseId', 'sequence'}}
            try: state['game'] = engine().apply_action(state['game'], actor, action, now=now)
            except engine().PartyError as error: raise PartyError(error.status, error.message)
            rate['count'] += 1
            session.update(sequence=body['sequence'], lastFingerprint=fingerprint, rate=rate)
            changed = True
            if state['game']['phase'] in {'closed', 'finished'} and not state.get('retiring'):
                operations = renew_operations(api, state, now)
            elif state['game']['phase'] == 'lobby' and state.get('retiring'):
                operations = renew_operations(api, state, now)
        if changed or operations:
            operation = put('game-party-room', room_id, state, previous)
            if not transact(api, [operation, *operations]): pause(attempt); continue
            previous = operation['Put']['Item']
        return output(state, previous, actor, now)
    fail('The room is busy. Your action was not discarded; retry shortly.', 503)


def dispatch(api, event, method, path, body):
    if len(canonical(body).encode()) > 16000: fail('This Party request is too large.', 413)
    if path == '/party/config' and method == 'GET': return {'games': engine().catalog()}
    if path == '/party/rooms' and method == 'POST': return create(api, event, body)
    match = re.fullmatch(r'/party/rooms/(' + UUID.pattern[1:-1] + r')(?:/(join|actions))?', path)
    if match:
        room_id, operation = match.groups()
        if operation == 'join' and method == 'POST': return join(api, room_id, body)
        if operation == 'actions' and method == 'POST': return room_request(api, event, room_id, body)
        if operation is None and method == 'GET': return room_request(api, event, room_id)
    fail('Party route not found.', 404)
