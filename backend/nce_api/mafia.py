"""Private, capability-bound live Mafia rooms in the existing game table.

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
CREATE_LIMIT = 30
SOURCE_CREATE_LIMIT = 6
_engine = _narration = _passphrases = None


class MafiaError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def fail(message, status=400):
    raise MafiaError(status, message)


def load_module(name):
    spec = importlib.util.spec_from_file_location('game_studio_' + name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def engine():
    global _engine
    if _engine is None: _engine = load_module('mafia_engine')
    return _engine


def narration():
    global _narration
    if _narration is None: _narration = load_module('mafia_narration')
    return _narration


def cached_bank(api):
    try: return narration().load_bank(api)
    except narration().NarrationError as error: raise MafiaError(error.status, error.message)


def passphrases():
    global _passphrases
    if _passphrases is None: _passphrases = load_module('room_passphrases')
    return _passphrases


def phrase_call(operation, *args):
    try: return getattr(passphrases(), operation)(*args)
    except passphrases().PassphraseError as error: fail(error.message, error.status)


def phrase_body(body):
    return {**body, 'passphrase': phrase_call('normalize', body['passphrase'])} if 'passphrase' in body else body


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False)


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
        fail('Unexpected or missing Mafia request fields.')


def key(kind, suffix=''):
    return ':'.join([kind, os.environ['CORE_ORGANIZATION_ID'], os.environ['CORE_SERVICE_ID'], suffix])


def table(api):
    name = os.environ.get('GAME_PUBLIC_TABLE')
    if not name: fail('Live Mafia is not configured.', 503)
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
    revision = int(previous['revision']) + 1 if previous else 1
    item = {'id': key(kind, suffix), 'revision': revision,
        'organization_id': os.environ['CORE_ORGANIZATION_ID'], 'service_id': os.environ['CORE_SERVICE_ID'],
        'payload': canonical(state)}
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
    previous = read(api, 'game-mafia-room', identifier(room_id))
    if not previous: fail('This room is no longer available. Ask the host for a new invitation.', 404)
    state = state_of(previous)
    if state.get('roomId') != room_id or type(state.get('expiresAt')) is not int or state['expiresAt'] <= now:
        fail('This room has expired. Start a new room to play again.', 410)
    if not isinstance(state.get('members'), dict) or not isinstance(state.get('game'), dict):
        fail('This room could not be opened. Its stored data has been preserved.', 503)
    return state, previous


def output(state, previous, player_id, now):
    try: room = engine().project(state['game'], player_id, now=now)
    except engine().MafiaError as error: raise MafiaError(error.status, error.message)
    room.update(revision=int(previous['revision']), expiresAt=state['expiresAt'])
    if state.get('passphraseHash'): room['passphraseEnabled'] = True
    room['self']['actionSequence'] = state['members'][player_id].get('sequence', 0)
    return {'room': room}


def create(api, event, body):
    fields(body, {'requestId', 'name', 'avatar', 'playerToken', 'inviteToken'},
        {'narratorMode', 'maxPlayers', 'nightSeconds', 'discussionSeconds', 'votingSeconds', 'passphrase'})
    body = phrase_body(body)
    phrase_hash = phrase_call('digest', 'mafia', body['passphrase']) if 'passphrase' in body else None
    room_id = identifier(body['requestId'])
    player_token, invite = token(body['playerToken']), token(body['inviteToken'])
    if hmac.compare_digest(player_token, invite): fail('Use separate room and player capabilities.')
    fingerprint = digest(canonical(body))
    mode = body.get('narratorMode', 'human')
    settings = {key: body[key] for key in ['maxPlayers', 'nightSeconds', 'discussionSeconds', 'votingSeconds'] if key in body}
    try: game = engine().new_room({'id': room_id, 'name': body['name'], 'avatar': body['avatar']}, narrator_mode=mode, now=int(time.time()), settings=settings)
    except engine().MafiaError as error: raise MafiaError(error.status, error.message)
    game['roomId'] = room_id
    if mode == 'ai':
        bank = cached_bank(api)
        if not bank: fail('AI narration is not enabled yet. Choose a human narrator.', 409)
        game['narration'] = bank['phrases']
    source_ip = event.get('requestContext', {}).get('http', {}).get('sourceIp')
    if not isinstance(source_ip, str) or not 1 <= len(source_ip) <= 64: fail('Room admission is unavailable.', 503)
    for attempt in range(5):
        now = int(time.time())
        old = read(api, 'game-mafia-room', room_id)
        if old:
            state = state_of(old)
            if state.get('createFingerprint') != fingerprint: fail('This room request was already used with different settings.', 409)
            if state.get('expiresAt', 0) <= now: fail('This room has expired. Create a new room.', 410)
            result = output(state, old, room_id, now)
            result['session'] = {'roomId': room_id, 'playerId': room_id, 'token': player_token, 'inviteToken': invite}
            return result
        index_row = read(api, 'game-mafia-index')
        index = state_of(index_row) if index_row else {'rooms': {}, 'bucket': now // 600, 'sources': {}, 'count': 0}
        if not isinstance(index.get('rooms'), dict) or len(index['rooms']) > MAX_ROOMS: fail('Room admission needs administrator attention.', 503)
        expired = [rid for rid, expiry in index['rooms'].items() if expiry <= now]
        operations = []
        for expired_id in expired:
            identifier(expired_id)
            # The index and room renewal always commit in one transaction.
            if expired_id != room_id:
                operations.append({'Delete': {'TableName': os.environ['GAME_PUBLIC_TABLE'], 'Key': {'id': key('game-mafia-room', expired_id)}}})
            del index['rooms'][expired_id]
        phrase_call('prune', index)
        if phrase_hash: phrase_call('claim', index, phrase_hash, room_id)
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
        if phrase_hash: state['passphraseHash'] = phrase_hash
        room_op = put('game-mafia-room', room_id, state, None)
        operations.extend([room_op, put('game-mafia-index', '', index, index_row)])
        if transact(api, operations):
            result = output(state, room_op['Put']['Item'], room_id, now)
            result['session'] = {'roomId': room_id, 'playerId': room_id, 'token': player_token, 'inviteToken': invite}
            return result
        pause(attempt)
    fail('The room service is busy. Retry the same request shortly.', 503)


def join(api, room_id, body, *, phrase_hash=None, phrase_kind=None):
    if phrase_hash:
        fields(body, {'requestId', 'name', 'avatar', 'playerToken', 'passphrase'})
        body = phrase_body(body)
        player_id, supplied = identifier(body['requestId']), None
    else:
        fields(body, {'requestId', 'name', 'avatar', 'inviteToken', 'playerToken'})
        player_id, supplied = identifier(body['requestId']), token(body['inviteToken'])
    player_token = token(body['playerToken'])
    if supplied and hmac.compare_digest(player_token, supplied): fail('Use separate invitation and player capabilities.')
    fingerprint = digest(canonical(body))
    for attempt in range(5):
        now = int(time.time())
        try: state, previous = open_room(api, room_id, now)
        except MafiaError as error:
            if phrase_hash and error.status in {404, 410}: fail(passphrases().UNAVAILABLE, 404)
            raise
        if phrase_hash:
            if not hmac.compare_digest(phrase_hash, state.get('passphraseHash', '')):
                fail(passphrases().UNAVAILABLE, 404)
        elif not hmac.compare_digest(digest(supplied), state['inviteHash']): fail('This invitation is not valid for this room.', 403)
        if player_id in state['members']:
            if state['members'][player_id].get('joinFingerprint') != fingerprint: fail('This join request has already been used.', 409)
            result = output(state, previous, player_id, now)
            result['session'] = {'roomId': room_id, 'playerId': player_id, 'token': player_token}
            return result
        if phrase_hash and (state['game']['phase'] != 'lobby' or len(state['members']) >= 25 or
                len([player for player in state['game']['players'] if not player.get('left') and player['id'] != state['game']['narratorId']]) >= state['game']['settings']['maxPlayers']):
            fail(passphrases().UNAVAILABLE, 404)
        if len(state['members']) >= 25: fail('This room has reached its participant limit.', 409)
        if any(hmac.compare_digest(digest(player_token), entry['tokenHash']) for entry in state['members'].values()):
            fail('Use a new player session to join.', 409)
        try: state['game'] = engine().add_player(state['game'], {'id': player_id, 'name': body['name'], 'avatar': body['avatar']}, now=now)
        except engine().MafiaError as error: raise MafiaError(error.status, error.message)
        state['members'][player_id] = {'tokenHash': digest(player_token), 'joinFingerprint': fingerprint, 'sequence': 0}
        operation = put('game-mafia-room', room_id, state, previous)
        operations = [operation]
        if phrase_hash:
            index_row = read(api, 'game-mafia-index')
            if not index_row: fail(passphrases().UNAVAILABLE, 404)
            index = state_of(index_row)
            request = digest(canonical([phrase_kind, player_id]))
            phrase_call('remember', index, request, fingerprint, room_id, now + ROOM_SECONDS, now)
            operations.append(put('game-mafia-index', '', index, index_row))
        if transact(api, operations):
            result = output(state, operation['Put']['Item'], player_id, now)
            result['session'] = {'roomId': room_id, 'playerId': player_id, 'token': player_token}
            return result
        pause(attempt)
    fail('The room is busy. Retry joining shortly.', 503)


def join_by_passphrase(api, event, body):
    fields(body, {'requestId', 'name', 'avatar', 'playerToken', 'passphrase'})
    body = phrase_body(body)
    player_id = identifier(body['requestId'])
    token(body['playerToken'])
    try: engine().validate_player({'id': player_id, 'name': body['name'], 'avatar': body['avatar']})
    except engine().MafiaError as error: raise MafiaError(error.status, error.message)
    scope = 'mafia'
    hashed = phrase_call('digest', scope, body['passphrase'])
    source_ip = event.get('requestContext', {}).get('http', {}).get('sourceIp')
    if not isinstance(source_ip, str) or not 1 <= len(source_ip) <= 64: fail('Room admission is unavailable.', 503)
    for attempt in range(5):
        now = int(time.time())
        index_row = read(api, 'game-mafia-index')
        index = state_of(index_row) if index_row else {'rooms': {}, 'bucket': now // 600, 'sources': {}, 'count': 0}
        if not isinstance(index.get('rooms'), dict) or len(index['rooms']) > MAX_ROOMS: fail('Room admission needs administrator attention.', 503)
        source = digest(canonical([os.environ['CORE_ORGANIZATION_ID'], os.environ['CORE_SERVICE_ID'], now // 60, source_ip]))
        phrase_call('take_attempt', index, source, now)
        receipt = phrase_call('admissions', index, now).get(digest(canonical([scope, player_id])))
        room_id = receipt['roomId'] if receipt else phrase_call('registry', index).get(hashed)
        if not transact(api, [put('game-mafia-index', '', index, index_row)]): pause(attempt); continue
        if receipt and receipt['fingerprint'] != digest(canonical(body)):
            fail('This join request has already been used. Start a new request to join another room.', 409)
        if not room_id or index['rooms'].get(room_id, 0) <= now: fail(passphrases().UNAVAILABLE, 404)
        return join(api, room_id, body, phrase_hash=hashed, phrase_kind=scope)
    fail('The room service is busy. Retry the same request shortly.', 503)


def renew_operations(api, state, now):
    terminal = state['game']['phase'] in {'closed', 'finished'}
    if terminal and state.get('retiring') and not (state['game']['phase'] == 'closed' and state.get('passphraseHash') and not state.get('passphraseReleased')): return []
    if not terminal and not state.get('retiring') and state['expiresAt'] - now > ROOM_SECONDS // 2: return []
    index_row = read(api, 'game-mafia-index')
    if not index_row: fail('The room lease could not be renewed.', 503)
    index = state_of(index_row)
    if state['roomId'] not in index.get('rooms', {}): fail('The room is no longer active.', 410)
    state['expiresAt'] = min(state['expiresAt'], now + (60 if state['game']['phase'] == 'closed' else 600)) if terminal else now + ROOM_SECONDS
    if terminal: state['retiring'] = True
    else: state.pop('retiring', None)
    index['rooms'][state['roomId']] = state['expiresAt']
    phrase_call('admissions', index, now)
    if state['game']['phase'] == 'closed' and state.get('passphraseHash'):
        phrase_call('release', index, state['passphraseHash'], state['roomId'])
        state['passphraseReleased'] = True
    return [put('game-mafia-index', '', index, index_row)]


def room_request(api, event, room_id, body=None):
    if body is not None:
        fields(body, {'requestId', 'phaseId', 'sequence', 'type'}, {'targetId', 'text', 'force', 'settings', 'narratorMode', 'channel'})
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
        except engine().MafiaError as error: raise MafiaError(error.status, error.message)
        changed = reconciled != state['game']
        state['game'] = reconciled
        operations = renew_operations(api, state, now)
        if body is not None and body['phaseId'] != state['game']['phaseId']:
            if changed or operations:
                operations.insert(0, put('game-mafia-room', room_id, state, previous))
                if not transact(api, operations): pause(attempt); continue
            fail('The phase has changed. Read the current room before acting.', 409)
        if body is not None:
            minute = now // 60
            rate = session.get('rate', {'minute': minute, 'count': 0})
            if rate['minute'] != minute: rate = {'minute': minute, 'count': 0}
            if rate['count'] >= 90: fail('Please pause briefly before sending another action.', 429)
            action = {k: v for k, v in body.items() if k not in {'requestId', 'phaseId', 'sequence'}}
            if action.get('narratorMode') == 'ai':
                bank = cached_bank(api)
                if not bank: fail('AI narration is not enabled yet. Choose a human narrator.', 409)
                state['game']['narration'] = bank['phrases']
            # The pre-action reconciliation already spent this request's
            # bounded computer-player budget. Human choices can still resolve
            # a ready phase without running a second set of AI actions.
            try: state['game'] = engine().apply_action(state['game'], actor, action, now=now, ai_budget=0)
            except engine().MafiaError as error: raise MafiaError(error.status, error.message)
            rate['count'] += 1
            session.update(sequence=body['sequence'], lastFingerprint=fingerprint, rate=rate)
            changed = True
            if state['game']['phase'] in {'closed', 'finished'} and (not state.get('retiring') or state['game']['phase'] == 'closed' and state.get('passphraseHash') and not state.get('passphraseReleased')):
                operations = renew_operations(api, state, now)
            elif state['game']['phase'] == 'lobby' and state.get('retiring'):
                operations = renew_operations(api, state, now)
        if changed or operations:
            operation = put('game-mafia-room', room_id, state, previous)
            if not transact(api, [operation, *operations]): pause(attempt); continue
            previous = operation['Put']['Item']
        return output(state, previous, actor, now)
    fail('The room is busy. Your action was not discarded; retry shortly.', 503)


def dispatch(api, event, method, path, body):
    if len(canonical(body).encode()) > 12000: fail('This Mafia request is too large.', 413)
    if path == '/mafia/config' and method == 'GET':
        try: config = narration().public_config(api)
        except narration().NarrationError as error: raise MafiaError(error.status, error.message)
        return {'minPlayers': 5, 'maxPlayers': 24, **config}
    if path == '/mafia/rooms' and method == 'POST': return create(api, event, body)
    if path == '/mafia/join-by-passphrase' and method == 'POST': return join_by_passphrase(api, event, body)
    if path == '/mafia/narration' and method == 'POST':
        try: return narration().generate(api, event, body)
        except narration().NarrationError as error: raise MafiaError(error.status, error.message)
    if path == '/mafia/narration' and method == 'GET':
        try: return narration().admin_status(api, event)
        except narration().NarrationError as error: raise MafiaError(error.status, error.message)
    if path == '/mafia/narration/approve' and method == 'POST':
        try: return narration().approve(api, event, body)
        except narration().NarrationError as error: raise MafiaError(error.status, error.message)
    if path == '/mafia/narration/enabled' and method == 'PUT':
        try: return narration().set_enabled(api, event, body)
        except narration().NarrationError as error: raise MafiaError(error.status, error.message)
    match = re.fullmatch(r'/mafia/rooms/(' + UUID.pattern[1:-1] + r')(?:/(join|actions))?', path)
    if match:
        room_id, operation = match.groups()
        if operation == 'join' and method == 'POST': return join(api, room_id, body)
        if operation == 'actions' and method == 'POST': return room_request(api, event, room_id, body)
        if operation is None and method == 'GET': return room_request(api, event, room_id)
    fail('Mafia route not found.', 404)
