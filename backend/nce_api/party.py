"""Private, capability-bound online party rooms in the existing game table.

The server owns roles and transitions. Public catalogs never project these rows.
Only bounded room/index records are written; all capability values are hashed.
"""
from copy import deepcopy
import hashlib
import hmac
import importlib.util
import json
import math
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
_engine = _passphrases = _vision = None
RECOGNITION_INTERVAL = 3
RECOGNITION_PHASE_LIMIT = 20
RECOGNITION_JOB_SECONDS = 10
RECOGNITION_PRIVATE_BYTES = 3072


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


def passphrases():
    global _passphrases
    if _passphrases is None: _passphrases = load_module('room_passphrases')
    return _passphrases


def vision():
    """The inference runtime is never imported by ordinary room requests."""
    global _vision
    if _vision is None: _vision = load_module('sketch_vision')
    return _vision


def phrase_call(operation, *args):
    try: return getattr(passphrases(), operation)(*args)
    except passphrases().PassphraseError as error: fail(error.message, error.status)


def phrase_body(body):
    return {**body, 'passphrase': phrase_call('normalize', body['passphrase'])} if 'passphrase' in body else body


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
    if state.get('passphraseHash'): room['passphraseEnabled'] = True
    room['self']['actionSequence'] = state['members'][player_id].get('sequence', 0)
    return {'room': room}


def create(api, event, body):
    fields(body, {'requestId', 'kind', 'name', 'avatar', 'playerToken', 'inviteToken'}, {'settings', 'passphrase'})
    body = phrase_body(body)
    phrase_hash = phrase_call('digest', body['kind'], body['passphrase']) if 'passphrase' in body else None
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
        room_op = put('game-party-room', room_id, state, None)
        operations.extend([room_op, put('game-party-index', '', index, index_row)])
        if transact(api, operations):
            result = output(state, room_op['Put']['Item'], room_id, now)
            result['session'] = {'roomId': room_id, 'playerId': room_id, 'token': player_token, 'inviteToken': invite}
            return result
        pause(attempt)
    fail('The room service is busy. Retry the same request shortly.', 503)


def join(api, room_id, body, *, phrase_hash=None, phrase_kind=None):
    if phrase_hash:
        fields(body, {'requestId', 'name', 'avatar', 'playerToken', 'passphrase'}, {'kind'})
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
        except PartyError as error:
            if phrase_hash and error.status in {404, 410}: fail(passphrases().UNAVAILABLE, 404)
            raise
        if phrase_hash:
            if not hmac.compare_digest(phrase_hash, state.get('passphraseHash', '')) or state['game'].get('kind') != phrase_kind:
                fail(passphrases().UNAVAILABLE, 404)
        elif not hmac.compare_digest(digest(supplied), state['inviteHash']): fail('This invitation is not valid for this room.', 403)
        if player_id in state['members']:
            if state['members'][player_id].get('joinFingerprint') != fingerprint: fail('This join request has already been used.', 409)
            result = output(state, previous, player_id, now)
            result['session'] = {'roomId': room_id, 'playerId': player_id, 'token': player_token}
            return result
        if phrase_hash and (state['game']['phase'] != 'lobby' or len(state['members']) >= 24 or
                len([player for player in state['game']['players'] if not player.get('left')]) >= state['game']['settings']['maxPlayers']):
            fail(passphrases().UNAVAILABLE, 404)
        if len(state['members']) >= 24: fail('This room has reached its participant limit.', 409)
        if any(hmac.compare_digest(digest(player_token), entry['tokenHash']) for entry in state['members'].values()):
            fail('Use a new player session to join.', 409)
        try: state['game'] = engine().add_player(state['game'], {'id': player_id, 'name': body['name'], 'avatar': body['avatar']}, now=now)
        except engine().PartyError as error: raise PartyError(error.status, error.message)
        state['members'][player_id] = {'tokenHash': digest(player_token), 'joinFingerprint': fingerprint, 'sequence': 0}
        operation = put('game-party-room', room_id, state, previous)
        operations = [operation]
        if phrase_hash:
            index_row = read(api, 'game-party-index')
            if not index_row: fail(passphrases().UNAVAILABLE, 404)
            index = state_of(index_row)
            request = digest(canonical([phrase_kind, player_id]))
            phrase_call('remember', index, request, fingerprint, room_id, now + ROOM_SECONDS, now)
            operations.append(put('game-party-index', '', index, index_row))
        if transact(api, operations):
            result = output(state, operation['Put']['Item'], player_id, now)
            result['session'] = {'roomId': room_id, 'playerId': player_id, 'token': player_token}
            return result
        pause(attempt)
    fail('The room is busy. Retry joining shortly.', 503)


def join_by_passphrase(api, event, body):
    fields(body, {'requestId', 'name', 'avatar', 'playerToken', 'passphrase', 'kind'})
    body = phrase_body(body)
    player_id = identifier(body['requestId'])
    token(body['playerToken'])
    try: engine().validate_player({'id': player_id, 'name': body['name'], 'avatar': body['avatar']})
    except engine().PartyError as error: raise PartyError(error.status, error.message)
    if not isinstance(body['kind'], str) or body['kind'] not in {game['id'] for game in engine().catalog() if game['id'] != 'mafia'}:
        fail('Choose an available party game.')
    scope = body['kind']
    hashed = phrase_call('digest', scope, body['passphrase'])
    source_ip = event.get('requestContext', {}).get('http', {}).get('sourceIp')
    if not isinstance(source_ip, str) or not 1 <= len(source_ip) <= 64: fail('Room admission is unavailable.', 503)
    for attempt in range(5):
        now = int(time.time())
        index_row = read(api, 'game-party-index')
        index = state_of(index_row) if index_row else {'rooms': {}, 'bucket': now // 600, 'sources': {}, 'count': 0}
        if not isinstance(index.get('rooms'), dict) or len(index['rooms']) > MAX_ROOMS: fail('Room admission needs administrator attention.', 503)
        source = digest(canonical([os.environ['CORE_ORGANIZATION_ID'], os.environ['CORE_SERVICE_ID'], now // 60, source_ip]))
        phrase_call('take_attempt', index, source, now)
        receipt = phrase_call('admissions', index, now).get(digest(canonical([scope, player_id])))
        room_id = receipt['roomId'] if receipt else phrase_call('registry', index).get(hashed)
        if not transact(api, [put('game-party-index', '', index, index_row)]): pause(attempt); continue
        if receipt and receipt['fingerprint'] != digest(canonical(body)):
            fail('This join request has already been used. Start a new request to join another room.', 409)
        if not room_id or index['rooms'].get(room_id, 0) <= now: fail(passphrases().UNAVAILABLE, 404)
        return join(api, room_id, body, phrase_hash=hashed, phrase_kind=scope)
    fail('The room service is busy. Retry the same request shortly.', 503)


def renew_operations(api, state, now):
    terminal = state['game']['phase'] in {'closed', 'finished'}
    if terminal and state.get('retiring') and not (state['game']['phase'] == 'closed' and state.get('passphraseHash') and not state.get('passphraseReleased')): return []
    if not terminal and not state.get('retiring') and state['expiresAt'] - now > ROOM_SECONDS // 2: return []
    index_row = read(api, 'game-party-index')
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
    return [put('game-party-index', '', index, index_row)]


def room_request(api, event, room_id, body=None):
    if body is not None:
        fields(body, {'requestId', 'phaseId', 'sequence', 'type'}, {'targetId', 'text', 'force', 'settings', 'room', 'taskId', 'step', 'answer', 'choice', 'column', 'stroke', 'color', 'points', 'width', 'drawingEpoch', 'segments'})
        identifier(body['requestId'])
        if type(body['phaseId']) is not int or body['phaseId'] < 0 or type(body['sequence']) is not int or not 1 <= body['sequence'] <= 100000:
            fail('Reload the room before sending another action.')
    for attempt in range(5):
        now = int(time.time())
        state, previous = open_room(api, room_id, now)
        actor = member(state, event)
        seat = next((player for player in state['game']['players'] if player['id'] == actor), {})
        if (body is None and engine().recognition_guessers(state['game'])
                and state['game'].get('deadlineAt', 0) > now
                and seat and not seat.get('left') and not seat.get('isAI')
                and (event.get('queryStringParameters') or {}).get('sketchRecognition') != '1'):
            fail('Refresh this page to enable AI guesses. Your room is saved.', 426)
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
            if state['game']['phase'] in {'closed', 'finished'} and (not state.get('retiring') or state['game']['phase'] == 'closed' and state.get('passphraseHash') and not state.get('passphraseReleased')):
                operations = renew_operations(api, state, now)
            elif state['game']['phase'] == 'lobby' and state.get('retiring'):
                operations = renew_operations(api, state, now)
        # Computer turns are driven only by an authenticated human request and
        # share its CAS. Exact sequence retries return above without ticking.
        try: advanced = engine().tick(state['game'], now=now)
        except engine().PartyError as error: raise PartyError(error.status, error.message)
        if advanced != state['game']:
            state['game'] = advanced
            changed = True
            if state['game']['phase'] in {'closed', 'finished'} and (not state.get('retiring') or state['game']['phase'] == 'closed' and state.get('passphraseHash') and not state.get('passphraseReleased')):
                operations = renew_operations(api, state, now)
        if changed or operations:
            operation = put('game-party-room', room_id, state, previous)
            if not transact(api, [operation, *operations]): pause(attempt); continue
            previous = operation['Put']['Item']
        return output(state, previous, actor, now)
    fail('The room is busy. Your action was not discarded; retry shortly.', 503)


def recognition_ack(room_id, body, status):
    return {'version': 1, 'roomId': room_id, **body, 'status': status,
        'retryAfterMs': 10000 if status == 'unavailable' else RECOGNITION_INTERVAL * 1000}


def recognition_human(state, event):
    actor_id = member(state, event)
    actor = next((player for player in state['game']['players'] if player['id'] == actor_id), None)
    if not actor or actor.get('left') or actor.get('isAI'):
        fail('Only an active human room seat can request recognition.', 403)
    return actor_id


def recognition_private_bound(game):
    value = {key: game[key] for key in ('_recognition', '_recognitionJob', '_recognitionBudget', '_recognitionGeneration', '_recognitionFailure') if key in game}
    if len(canonical(value).encode()) > RECOGNITION_PRIVATE_BYTES:
        fail('The drawing observation is outside its allowed size.', 503)


def recognition_candidates(value):
    if not isinstance(value, list) or len(value) > 5:
        raise ValueError('Invalid drawing classifier candidates.')
    clean, seen = [], set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {'label', 'score'}:
            raise ValueError('Invalid drawing classifier candidate.')
        label, score = item['label'], item['score']
        if (not isinstance(label, str) or not 1 <= len(label) <= 80 or re.search(r'[\x00-\x1f\x7f]', label)
                or label in seen or type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1):
            raise ValueError('Invalid drawing classifier value.')
        seen.add(label); clean.append({'label': label, 'score': round(float(score), 8)})
    return sorted(clean, key=lambda item: (-item['score'], item['label']))


def recognize_drawing(api, event, room_id, body):
    """Bounded CPU work on a separate request; drawing requests never wait here.

    The first CAS claims one authoritative public-ink snapshot. After inference,
    a second CAS can publish only in the same phase/epoch and append-only ink
    generation. Erasers and compacted/dropped ink invalidate that generation.
    Neither
    transaction changes a player's sequence, room lease or game progression.
    """
    fields(body, {'phaseId', 'drawingEpoch', 'inkSha256'})
    if (type(body['phaseId']) is not int or not 0 <= body['phaseId'] <= 2147483647
            or type(body['drawingEpoch']) is not int or not 0 <= body['drawingEpoch'] <= 2147483647
            or not isinstance(body['inkSha256'], str) or not re.fullmatch('[a-f0-9]{64}', body['inkSha256'])):
        fail('Use the current drawing observation.')
    identifier(room_id)
    claim_id = secrets.token_hex(16)
    snapshot = None
    for _ in range(2):
        now = int(time.time())
        state, previous = open_room(api, room_id, now)
        recognition_human(state, event)
        game = state['game']
        binding = engine().recognition_binding(game)
        if not binding or game.get('deadlineAt', 0) <= now:
            return recognition_ack(room_id, body, 'idle')
        if binding != body:
            return recognition_ack(room_id, body, 'stale')
        # A usable prefix can inform an agent, but only an exact cache can
        # satisfy this request: new ink must still receive its own CPU turn.
        if engine().recognition_observation(game, now, exact=True):
            return recognition_ack(room_id, body, 'cached')
        private = game['_game']
        job = private.get('_recognitionJob')
        if job and int(job.get('expiresAt', 0)) > now:
            return recognition_ack(room_id, body, 'busy')
        budget = private.get('_recognitionBudget', {'phaseId': game['phaseId'], 'count': 0, 'nextAt': 0})
        if (not isinstance(budget, dict) or set(budget) != {'phaseId', 'count', 'nextAt'}
                or type(budget['phaseId']) is not int or type(budget['count']) is not int
                or type(budget['nextAt']) is not int or not 0 <= budget['count'] <= RECOGNITION_PHASE_LIMIT):
            fail('The drawing observer is temporarily unavailable.', 503)
        if budget['phaseId'] != game['phaseId']:
            budget = {'phaseId': game['phaseId'], 'count': 0, 'nextAt': 0}
        if budget['count'] >= RECOGNITION_PHASE_LIMIT:
            return recognition_ack(room_id, body, 'idle')
        if budget['nextAt'] > now:
            return recognition_ack(room_id, body, 'busy')
        generation = private.get('_recognitionGeneration', 0)
        private['_recognitionJob'] = {'owner': claim_id, **binding, 'generation': generation,
            'startedAt': now, 'expiresAt': now + RECOGNITION_JOB_SECONDS}
        interval = max(RECOGNITION_INTERVAL, math.ceil(game['settings']['roundSeconds'] / RECOGNITION_PHASE_LIMIT))
        private['_recognitionBudget'] = {'phaseId': game['phaseId'], 'count': budget['count'] + 1, 'nextAt': now + interval}
        recognition_private_bound(private)
        if transact(api, [put('game-party-room', room_id, state, previous)]):
            snapshot = engine().recognition_strokes(game)
            break
    if snapshot is None:
        return recognition_ack(room_id, body, 'busy')

    candidates, model_version, unavailable = [], '', False
    try:
        model = vision()
        model_version = model.MODEL_VERSION
        if not isinstance(model_version, str) or not 1 <= len(model_version) <= 120 or re.search(r'[\x00-\x1f\x7f]', model_version):
            raise ValueError('Invalid drawing classifier version.')
        candidates = recognition_candidates(model.predict(deepcopy(snapshot)))
    except Exception as error:
        # Optional recognition failure does not fail a drawing action or expose
        # room ink, secrets, labels or credentials in an error/log message.
        print('Game Studio drawing recognition unavailable:', type(error).__name__)
        unavailable = True

    for _ in range(2):
        now = int(time.time())
        try:
            state, previous = open_room(api, room_id, now)
            recognition_human(state, event)
        except PartyError:
            return recognition_ack(room_id, body, 'stale')
        game, private = state['game'], state['game'].get('_game', {})
        job = private.get('_recognitionJob', {})
        if job.get('owner') != claim_id:
            return recognition_ack(room_id, body, 'stale')
        binding = engine().recognition_binding(game)
        fresh = (binding is not None and binding['phaseId'] == body['phaseId']
            and binding['drawingEpoch'] == body['drawingEpoch']
            and private.get('_recognitionGeneration', 0) == generation
            and int(job.get('expiresAt', 0)) > now and game.get('deadlineAt', 0) > now)
        private.pop('_recognitionJob', None)
        if fresh and not unavailable:
            private['_recognition'] = {**body, 'generation': generation, 'modelVersion': model_version,
                'candidates': candidates, 'capturedAt': job['startedAt'], 'completedAt': now}
            private.pop('_recognitionFailure', None)
        elif unavailable and fresh:
            private['_recognitionBudget']['nextAt'] = now + 10
            private['_recognitionFailure'] = {'generation': generation, 'at': now}
        recognition_private_bound(private)
        if transact(api, [put('game-party-room', room_id, state, previous)]):
            return recognition_ack(room_id, body, 'stale' if not fresh else 'unavailable' if unavailable else 'ready')
    return recognition_ack(room_id, body, 'stale')


def dispatch(api, event, method, path, body):
    if len(canonical(body).encode()) > 16000: fail('This Party request is too large.', 413)
    if path == '/party/config' and method == 'GET': return {'games': engine().catalog()}
    if path == '/party/rooms' and method == 'POST': return create(api, event, body)
    if path == '/party/join-by-passphrase' and method == 'POST': return join_by_passphrase(api, event, body)
    match = re.fullmatch(r'/party/rooms/(' + UUID.pattern[1:-1] + r')(?:/(join|actions|recognition))?', path)
    if match:
        room_id, operation = match.groups()
        if operation == 'join' and method == 'POST': return join(api, room_id, body)
        if operation == 'actions' and method == 'POST': return room_request(api, event, room_id, body)
        if operation == 'recognition' and method == 'POST': return recognize_drawing(api, event, room_id, body)
        if operation is None and method == 'GET': return room_request(api, event, room_id)
    fail('Party route not found.', 404)
