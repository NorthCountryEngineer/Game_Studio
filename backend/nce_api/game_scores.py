"""Bounded arcade boards for published games, using the existing game table.

Scores are client-reported, not an anti-cheat proof. Core authorizes every write;
the published spec bounds reports. Only nicknames, points and dates leave here.
"""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re


LIMIT = 10
MAX_RECEIPTS = 100
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
_games = None


class ScoreError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def fail(message, status=400):
    raise ScoreError(status, message)


def games():
    global _games
    if _games is None:
        spec = importlib.util.spec_from_file_location('game_studio_score_games', Path(__file__).with_name('games.py'))
        _games = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_games)
    return _games


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'), allow_nan=False)


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value): fail('Invalid game or score identifier.')
    return value


def integer(value, low, high, label):
    if type(value) is not int or not low <= value <= high: fail(label + ' is outside its allowed range.')
    return value


def validate_name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9 _-]{1,16}', value):
        fail('Choose an arcade name with 1–16 letters, numbers, spaces, underscores, or hyphens.')
    result = re.sub(' +', ' ', value.strip(' ')).upper()
    if not result: fail('Enter an arcade nickname.')
    return result


def key(kind, game_id):
    return ':'.join([kind, os.environ['CORE_ORGANIZATION_ID'], os.environ['CORE_SERVICE_ID'], game_id])


def table(api):
    name = os.environ.get('GAME_PUBLIC_TABLE')
    if not name: fail('The game studio has not been deployed yet.', 503)
    return api.clients()[0].Table(name)


def read(api, kind, game_id):
    item = table(api).get_item(Key={'id': key(kind, game_id)}, ConsistentRead=True).get('Item')
    if item and (item.get('organization_id') != os.environ['CORE_ORGANIZATION_ID'] or item.get('service_id') != os.environ['CORE_SERVICE_ID']):
        fail('Published game not found.', 404)
    return item


def publication(api, game_id, revision):
    integer(revision, 1, 1000000000, 'Published edition')
    item = read(api, 'game', identifier(game_id))
    if not item: fail('Published game not found.', 404)
    state = json.loads(item['payload'])
    if state.get('id') != game_id or state.get('status') != 'Published' or state.get('_deleted'):
        fail('Published game not found.', 404)
    if state.get('publishedRevision') != revision or state.get('revision') != revision:
        fail('A new edition was published. Reload this game before saving scores.', 409)
    try: spec = games().validate_spec(state['spec'])
    except (games().GameError, KeyError): fail('This game cannot accept arcade scores.', 409)
    if not spec.get('arcade', {}).get('scoring') or not spec['arcade']['highScores']:
        fail('High scores are not enabled for this game.', 404)
    return spec, item


def max_points(spec, levels):
    if not spec.get('arcade', {}).get('scoring'): return 0
    return sum(level['rules']['goal'] * 10 + (math.ceil(level['rules']['timeLimit'] / 0.5) + 8) *
        (120 if spec['arcade']['splitAsteroids'] else 20) for level in levels)


def validate_result(value, spec):
    required = {'outcome', 'elapsed', 'score', 'reviewedLevelIds', 'points'}
    if not isinstance(value, dict) or set(value) != required: fail('Unexpected or missing score report fields.')
    if not isinstance(value['outcome'], str) or value['outcome'] not in {'won', 'lost'}:
        fail('Finish a complete round before saving its score.')
    ids = value['reviewedLevelIds']
    levels = games().get_levels(spec)
    if not isinstance(ids, list) or not ids or any(not isinstance(item, str) for item in ids) or ids != [level['id'] for level in levels[:len(ids)]]:
        fail('The played levels do not match this published game.')
    played = levels[:len(ids)]
    maximum = sum(level['rules']['goal'] for level in played)
    score = integer(value['score'], 0, maximum, 'Collection progress')
    if score < sum(level['rules']['goal'] for level in played[:-1]): fail('Previous levels must be completed first.')
    if value['outcome'] == 'won' and (len(played) != len(levels) or score != maximum):
        fail('Complete every level before reporting a win.')
    elapsed = value['elapsed']
    if type(elapsed) not in {int, float} or not math.isfinite(elapsed) or not 0 < elapsed <= sum(level['rules']['timeLimit'] for level in played):
        fail('The round duration is outside its allowed range.')
    integer(value['points'], 1, max_points(spec, played), 'Points')
    return deepcopy(value)


def board_state(api, game_id, revision):
    stored = read(api, 'game-score', game_id)
    state = json.loads(stored['payload']) if stored else None
    if not state or state['publishedRevision'] != revision:
        state = {'publishedRevision': revision, 'entries': [], 'receipts': []}
    return state, stored


def output(state):
    return {'scope': 'shared', 'publishedRevision': state['publishedRevision'], 'limit': LIMIT,
        'entries': [{field: entry[field] for field in ('name', 'points', 'createdAt')} for entry in state['entries']]}


def get_scores(api, game_id, revision):
    publication(api, game_id, revision)
    state, _ = board_state(api, game_id, revision)
    # Do not return a board removed or superseded while it was being read.
    publication(api, game_id, revision)
    return output(state)


def condition(stored):
    # Transaction APIs require expression strings. The resource's client performs
    # native Python value marshalling, just as in the existing game transactions.
    if stored is None: return {'ConditionExpression': 'attribute_not_exists(id)'}
    return {'ConditionExpression': 'revision = :revision AND organization_id = :org AND service_id = :service',
        'ExpressionAttributeValues': {':revision': int(stored['revision']), ':org': os.environ['CORE_ORGANIZATION_ID'],
            ':service': os.environ['CORE_SERVICE_ID']}}


def submit_score(api, claims, game_id, body):
    if set(body) != {'publishedRevision', 'requestId', 'name', 'result'}: fail('Unexpected or missing score fields.')
    revision = body['publishedRevision']
    spec, published = publication(api, game_id, revision)
    request_id, name = identifier(body['requestId']), validate_name(body['name'])
    result = validate_result(body['result'], spec)
    subject = claims.get('sub')
    if not isinstance(subject, str) or not UUID.fullmatch(subject): fail('Sign in through Core to save a score.', 401)
    owner = hashlib.sha256((key('player', subject)).encode()).hexdigest()
    fingerprint = hashlib.sha256(canonical({'name': name, 'result': result, 'publishedRevision': revision}).encode()).hexdigest()
    state, stored = board_state(api, game_id, revision)
    for receipt in state['receipts']:
        if receipt['owner'] == owner and receipt['id'] == request_id:
            if receipt['fingerprint'] != fingerprint: fail('This score request was already used for a different round.', 409)
            publication(api, game_id, revision)
            return output(state)
    previous = next((entry for entry in state['entries'] if entry['owner'] == owner), None)
    if not previous or previous['points'] < result['points']:
        state['entries'] = [entry for entry in state['entries'] if entry['owner'] != owner]
        state['entries'].append({'owner': owner, 'name': name, 'points': result['points'],
            'createdAt': datetime.now(timezone.utc).isoformat()})
        state['entries'].sort(key=lambda entry: (-entry['points'], entry['createdAt'], entry['name'], entry['owner']))
        state['entries'] = state['entries'][:LIMIT]
    state['receipts'] = (state['receipts'] + [{'owner': owner, 'id': request_id, 'fingerprint': fingerprint}])[-MAX_RECEIPTS:]
    encoded = canonical(state)
    if len(encoded.encode()) > 80000: fail('The arcade board is full. Try again later.', 413)
    item = {'id': key('game-score', game_id), 'organization_id': os.environ['CORE_ORGANIZATION_ID'],
        'service_id': os.environ['CORE_SERVICE_ID'], 'revision': int(stored['revision']) + 1 if stored else 1, 'payload': encoded}
    client = api.clients()[0].meta.client
    try:
        client.transact_write_items(TransactItems=[
            {'ConditionCheck': {'TableName': os.environ['GAME_PUBLIC_TABLE'], 'Key': {'id': key('game', game_id)}, **condition(published)}},
            {'Put': {'TableName': os.environ['GAME_PUBLIC_TABLE'], 'Item': item, **condition(stored)}}])
    except Exception as error:
        # Preserve capacity, permission and availability errors; only conditional
        # conflicts invite a retry with the same report identity.
        details = getattr(error, 'response', {})
        code = details.get('Error', {}).get('Code')
        reasons = {reason.get('Code') for reason in details.get('CancellationReasons', [])}
        if code == 'ConditionalCheckFailedException' or code == 'TransactionCanceledException' and (not reasons or reasons <= {'None', 'ConditionalCheckFailed', 'TransactionConflict'}):
            fail('This game or its board changed. Reload scores and try again with the same arcade name.', 409)
        raise
    return output(state)


def dispatch(api, event, method, path, body):
    if path == '/game-scores/session' and method == 'GET':
        claims = api.authorize(event)
        return {'authenticated': True, 'canEdit': 'games-create' in claims.get('permissions', [])}
    match = re.fullmatch(r'/game-scores/([^/]+)', path)
    if not match: fail('Arcade route not found.', 404)
    game_id = identifier(match[1])
    if method == 'GET':
        revision = (event.get('queryStringParameters') or {}).get('revision', '')
        if not isinstance(revision, str) or not re.fullmatch(r'[1-9][0-9]{0,9}', revision): fail('A published edition is required.')
        return get_scores(api, game_id, int(revision))
    if method == 'POST':
        # Any current member of this application can play; editing permissions
        # are not required. Core still enforces account/app/organization access.
        return submit_score(api, api.authorize(event), game_id, body)
    fail('Arcade route not found.', 404)
