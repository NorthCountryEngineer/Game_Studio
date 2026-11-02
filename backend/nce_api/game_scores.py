"""Bounded anonymous, edition-specific casual leaderboards.

Reports are client-reported observations, not identity or anti-cheat proof. Every
write is fenced to the current public snapshot; drafts and Core are untouched.
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
import time
import unicodedata

LIMIT = 10
MAX_RECEIPTS = 100
MAX_POINTS = 2147483647
SOURCE_LIMIT = 120
INSTALLATION_LIMIT = 600
MAX_SOURCES = 128
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
        source = importlib.util.spec_from_file_location('game_studio_score_games', Path(__file__).with_name('games.py'))
        _games = importlib.util.module_from_spec(source)
        source.loader.exec_module(_games)
    return _games


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'), allow_nan=False)


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value): fail('Invalid game or score identifier.')
    return value


def integer(value, low, high, label):
    if type(value) is not int or not low <= value <= high: fail(label + ' is outside its allowed range.')
    return value


def number(value, low, high, label):
    if type(value) not in {int, float} or not low <= value <= high or not math.isfinite(value):
        fail(label + ' is outside its allowed range.')
    return value


def fields(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) or set(value) - set(required) - set(optional):
        fail('Unexpected or missing score report fields.')


def validate_name(value):
    if not isinstance(value, str): fail('Choose an arcade name with 1–8 characters.')
    # Check controls before trimming: a line break must not become a valid name.
    if any(unicodedata.category(char) in {'Cc', 'Cs', 'Zl', 'Zp'} or '\u202a' <= char <= '\u202e' or '\u2066' <= char <= '\u2069' for char in value):
        fail('Choose an arcade name without control or direction-changing characters.')
    # Match browser String.trim(), including its zero-width no-break space.
    result = unicodedata.normalize('NFC', value).strip(' \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000\ufeff')
    if not 1 <= len(result) <= 8 or not any(unicodedata.category(char)[0] in 'LNPS' for char in result):
        fail('Choose an arcade name with 1–8 visible characters.')
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


def payload(item):
    try:
        state = json.loads(item['payload'])
        if not isinstance(state, dict): raise ValueError()
        return state
    except (KeyError, TypeError, ValueError): fail('The leaderboard is unavailable. Existing records have been preserved.', 503)


def publication(api, game_id, revision):
    integer(revision, 1, 1000000000, 'Published edition')
    item = read(api, 'game', identifier(game_id))
    if not item: fail('Published game not found.', 404)
    state = payload(item)
    if state.get('id') != game_id or state.get('status') != 'Published' or state.get('_deleted'):
        fail('Published game not found.', 404)
    if state.get('publishedRevision') != revision or state.get('revision') != revision:
        fail('A new edition was published. Reload this game before saving scores.', 409)
    try: spec = games().validate_spec(state['spec'])
    except (games().GameError, KeyError): fail('This game cannot accept leaderboard reports.', 409)
    return spec, item


def ranking(spec):
    if games().is_endless_asteroids(spec) and not spec.get('arcade', {}).get('scoring'): return 'survival'
    return 'points' if spec['version'] in {7, 8} or spec.get('arcade', {}).get('scoring') else 'time'


def max_points(spec, levels, elapsed=None):
    if spec['version'] == 7: return sum(level['rules']['goal'] * 10 for level in levels)
    if not spec.get('arcade', {}).get('scoring'): return 0
    if spec.get('multiplayer') and spec['version'] in {4, 5}: return 1000000 * len(levels)
    if spec['version'] == 6:
        duration = elapsed if elapsed is not None else MAX_POINTS if games().is_endless_asteroids(spec) else sum(level['rules']['timeLimit'] for level in levels)
        extra = 2000 * len(levels) + len(levels) - 1 if spec.get('multiplayer') and not games().is_endless_asteroids(spec) else 2000
        return min(MAX_POINTS, math.ceil(duration * 2000) + extra)
    return sum(level['rules']['goal'] * 10 + (math.ceil(level['rules']['timeLimit'] / 0.5) + 8) *
        (120 if spec['arcade']['splitAsteroids'] else 20) for level in levels)


def validate_result(value, spec):
    if spec['version'] == 8: return validate_multi_result(value, spec)
    points = ranking(spec) == 'points'
    fields(value, {'outcome', 'elapsed', 'score', 'reviewedLevelIds'} | ({'points'} if points else set()))
    if not isinstance(value['outcome'], str) or value['outcome'] not in {'won', 'lost'}:
        fail('Finish a complete round before saving its score.')
    ids = value['reviewedLevelIds']
    if spec['version'] == 3:
        if ids != ['level-1']: fail('The played puzzle does not match this published game.')
        maximum = len(spec['puzzle']['entries' if spec['genre'] == 'crossword' else 'words' if spec['genre'] == 'word-search' else 'blanks'])
        score = integer(value['score'], 0, maximum, 'Puzzle progress')
        number(value['elapsed'], 0, 86400, 'Round duration')
        if value['outcome'] == 'won' and score != maximum or spec['genre'] != 'crossword' and value['outcome'] == 'lost':
            fail('Complete the puzzle before reporting a win.')
        return deepcopy(value)
    levels = games().get_levels(spec)
    if 'flow' in spec:
        by_id = {level['id']: level for level in levels}
        levels = [by_id[node['levelId']] for node in spec['flow']['nodes'] if node['type'] == 'level']
    if not isinstance(ids, list) or not ids or any(not isinstance(item, str) for item in ids) or ids != [level['id'] for level in levels[:len(ids)]]:
        fail('The played levels do not match this published game.')
    played = levels[:len(ids)]
    if games().is_endless_asteroids(spec):
        if value['outcome'] != 'lost' or ids != [levels[0]['id']]: fail('Endless rounds end with lost lives on the first saved level.')
        elapsed = number(value['elapsed'], 0, MAX_POINTS, 'Round duration')
        integer(value['score'], 0, min(MAX_POINTS, math.ceil(elapsed * 20) + 40), 'Collection progress')
    else:
        maximum = sum(level['rules']['goal'] for level in played)
        score = integer(value['score'], 0, maximum, 'Collection progress')
        if score < sum(level['rules']['goal'] for level in played[:-1]): fail('Previous levels must be completed first.')
        if value['outcome'] == 'won' and (len(played) != len(levels) or score != maximum):
            fail('Complete every level before reporting a win.')
        elapsed = number(value['elapsed'], 0, sum(level['rules']['timeLimit'] for level in played), 'Round duration')
    if points:
        integer(value['points'], 0, max_points(spec, played, elapsed), 'Points')
        if spec['version'] == 7 and value['points'] != value['score'] * 10: fail('Platformer points do not match collected rewards.')
    return deepcopy(value)


def validate_flow(value, spec, result):
    fields(value, {'runId', 'status', 'completedLevelIds', 'materials', 'gameplayElapsed', 'wallElapsed', 'score'}, {'activeNodeId', 'points'})
    if not isinstance(value['runId'], str) or not UUID.fullmatch(value['runId'].lower()) or value['status'] != result['outcome']:
        fail('The flow does not match this game result.')
    if 'activeNodeId' in value and (not isinstance(value['activeNodeId'], str) or not re.fullmatch(r'step-(?:[1-9]|1[0-9]|2[0-4])', value['activeNodeId'])):
        fail('Invalid active flow step.')
    number(value['gameplayElapsed'], 0, 1440, 'Flow gameplay duration')
    number(value['wallElapsed'], value['gameplayElapsed'], 86400, 'Flow duration')
    integer(value['score'], 0, 320, 'Flow progress')
    if 'points' in value: integer(value['points'], 0, MAX_POINTS, 'Flow points')
    if value['gameplayElapsed'] != result['elapsed'] or value['score'] != result['score'] or ('points' in value) != ('points' in result) or value.get('points') != result.get('points'):
        fail('The flow and game observations disagree.')
    played = result['reviewedLevelIds']
    if value['completedLevelIds'] != (played[:-1] if result['outcome'] == 'lost' else played):
        fail('The flow has an invalid level completion order.')
    nodes = spec['flow']['nodes']
    last = next(index for index, node in enumerate(nodes) if node['type'] == 'level' and node['levelId'] == played[-1])
    materials = [node for node in (nodes if result['outcome'] == 'won' else nodes[:last]) if node['type'] == 'material']
    if not isinstance(value['materials'], list) or len(value['materials']) != len(materials): fail('The flow is missing material observations.')
    for observation, node in zip(value['materials'], materials):
        fields(observation, {'nodeId', 'status', 'elapsed'})
        if observation['nodeId'] != node['id'] or observation['status'] not in ('completed', 'skipped') or node['required'] and observation['status'] != 'completed':
            fail('The flow is missing a required completion.')
        number(observation['elapsed'], 0, 86400, 'Material duration')
    if sum(item['elapsed'] for item in value['materials']) + value['gameplayElapsed'] > value['wallElapsed'] + 0.001:
        fail('Material timing exceeds the observed run duration.')


def validate_multi_result(value, spec):
    fields(value, {'outcome', 'elapsed', 'wallElapsed', 'score', 'points', 'games', 'materials'})
    if not isinstance(value['outcome'], str) or value['outcome'] not in {'won', 'lost'}: fail('Finish a complete journey before saving its score.')
    number(value['elapsed'], 0, 86400, 'Journey gameplay duration')
    number(value['wallElapsed'], value['elapsed'], 86400, 'Journey duration')
    integer(value['score'], 0, 2560, 'Journey progress'); integer(value['points'], 0, MAX_POINTS, 'Journey points')
    steps = [step for step in spec['steps'] if step['type'] == 'game']
    observations = value['games']
    if not isinstance(observations, list) or not 1 <= len(observations) <= len(steps) or value['outcome'] == 'won' and len(observations) != len(steps):
        fail('The journey does not match its finite games.')
    results = []
    for index, observation in enumerate(observations):
        fields(observation, {'stepId', 'result'}, {'flow'})
        step = steps[index]
        if observation['stepId'] != step['id']: fail('The journey games are out of order.')
        result = validate_result(observation['result'], step['spec'])
        if result['outcome'] != ('lost' if value['outcome'] == 'lost' and index == len(observations) - 1 else 'won'):
            fail('The journey has an invalid terminal outcome.')
        if result['elapsed'] > 86400: fail('The journey game duration is outside its allowed range.')
        has_flow = 'flow' in step['spec']
        if has_flow != ('flow' in observation): fail('The journey flow observations are incomplete.')
        if has_flow: validate_flow(observation['flow'], step['spec'], result)
        results.append(result)
    last = next(index for index, step in enumerate(spec['steps']) if step['id'] == observations[-1]['stepId'])
    materials = [step for step in (spec['steps'] if value['outcome'] == 'won' else spec['steps'][:last]) if step['type'] == 'material']
    if not isinstance(value['materials'], list) or len(value['materials']) != len(materials): fail('The journey is missing material observations.')
    for observation, node in zip(value['materials'], materials):
        fields(observation, {'path', 'status', 'elapsed'})
        if observation['path'] != [node['id']] or observation['status'] not in ('completed', 'skipped') or node['required'] and observation['status'] != 'completed':
            fail('The journey is missing a required completion.')
        number(observation['elapsed'], 0, 86400, 'Material duration')
    elapsed = sum(result['elapsed'] for result in results)
    wall = sum(observation.get('flow', {}).get('wallElapsed', result['elapsed']) for observation, result in zip(observations, results)) + sum(material['elapsed'] for material in value['materials'])
    if abs(value['elapsed'] - elapsed) >= 0.001 or value['score'] != sum(result['score'] for result in results) or value['points'] != sum(result.get('points', result['score'] * 10) for result in results) or wall > value['wallElapsed'] + 0.001:
        fail('The journey totals do not match its finite games.')
    return deepcopy(value)


def board_state(api, game_id, revision):
    stored = read(api, 'game-score', game_id)
    state = payload(stored) if stored else None
    if not state or state.get('publishedRevision') != revision:
        state = {'publishedRevision': revision, 'entries': [], 'receipts': []}
    if not isinstance(state.get('entries'), list) or len(state['entries']) > LIMIT or not isinstance(state.get('receipts'), list) or len(state['receipts']) > MAX_RECEIPTS:
        fail('The leaderboard is unavailable. Existing records have been preserved.', 503)
    return state, stored


def prepare_board(state, metric):
    if state.get('ranking', 'points' if state['entries'] else metric) != metric:
        fail('The leaderboard metric differs from this published game.', 409)
    state['ranking'] = metric
    try:
        for entry in state['entries']:
            if not isinstance(entry, dict) or not isinstance(entry.get('name'), str) or not isinstance(entry.get('createdAt'), str): raise ValueError()
            name = entry['name']
            legacy = bool(re.fullmatch(r'[A-Z0-9 _-]{1,16}', name)) and name == re.sub(' +', ' ', name.strip(' '))
            if not legacy and validate_name(name) != name: raise ValueError()
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)', entry['createdAt']): raise ValueError()
            datetime.fromisoformat(entry['createdAt'].replace('Z', '+00:00'))
            if metric == 'points': integer(entry.get('points'), 0, MAX_POINTS, 'Stored points')
            if metric != 'points' or 'elapsed' in entry: number(entry.get('elapsed'), 0 if metric == 'points' else 0.000000001, MAX_POINTS, 'Stored duration')
            if 'requestId' in entry:
                identifier(entry['requestId'])
                if not isinstance(entry.get('fingerprint'), str) or not re.fullmatch('[a-f0-9]{64}', entry['fingerprint']): raise ValueError()
        if state['entries'] != sorted(state['entries'], key=lambda entry: entry_key(entry, metric)): raise ValueError()
        for receipt in state['receipts']:
            if not isinstance(receipt, dict): raise ValueError()
            identifier(receipt.get('id'))
            if not isinstance(receipt.get('fingerprint'), str) or not re.fullmatch('[a-f0-9]{64}', receipt['fingerprint']): raise ValueError()
            if 'qualified' in receipt and type(receipt['qualified']) is not bool: raise ValueError()
    except (ScoreError, ValueError, TypeError):
        fail('The leaderboard is unavailable. Existing records have been preserved.', 503)
    return state


def output(state):
    metric = state['ranking']
    return {'scope': 'shared', 'publishedRevision': state['publishedRevision'], 'limit': LIMIT, 'ranking': metric,
        'entries': [{field: entry[field] for field in ('name', 'points', 'elapsed', 'createdAt') if field in entry and (field != 'points' or metric == 'points')} for entry in state['entries']]}


def get_scores(api, game_id, revision):
    spec, published = publication(api, game_id, revision)
    state, _ = board_state(api, game_id, revision)
    prepare_board(state, ranking(spec))
    if publication(api, game_id, revision)[1]['payload'] != published['payload']:
        fail('This published game changed. Reload before viewing scores.', 409)
    return output(state)


def condition(stored):
    # Transaction APIs require strings; this resource client auto-marshals values.
    if stored is None: return {'ConditionExpression': 'attribute_not_exists(id)'}
    return {'ConditionExpression': 'revision = :revision AND organization_id = :org AND service_id = :service AND payload = :payload',
        'ExpressionAttributeValues': {':revision': int(stored['revision']), ':org': os.environ['CORE_ORGANIZATION_ID'],
            ':service': os.environ['CORE_SERVICE_ID'], ':payload': stored['payload']}}


def envelope(kind, suffix, state, stored):
    encoded = canonical(state)
    if len(encoded.encode()) > 80000: fail('The leaderboard is full. Existing records have been preserved.', 413)
    return {'id': key(kind, suffix), 'organization_id': os.environ['CORE_ORGANIZATION_ID'],
        'service_id': os.environ['CORE_SERVICE_ID'], 'revision': int(stored['revision']) + 1 if stored else 1, 'payload': encoded}


def rate_state(api, event):
    stored = read(api, 'game-score-rate', '')
    old = payload(stored) if stored else {}
    minute = int(time.time()) // 60
    state = old if old.get('minute') == minute else {'minute': minute, 'count': 0, 'sources': {}}
    if type(state.get('count')) is not int or not isinstance(state.get('sources'), dict) or len(state['sources']) > MAX_SOURCES or not 0 <= state['count'] <= INSTALLATION_LIMIT or any(not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest) or type(count) is not int or not 1 <= count <= SOURCE_LIMIT for digest, count in state['sources'].items()) or sum(state['sources'].values()) != state['count']:
        fail('Score admission is unavailable. Existing records have been preserved.', 503)
    source = event.get('requestContext', {}).get('http', {}).get('sourceIp', 'unknown')
    if not isinstance(source, str) or not 1 <= len(source) <= 128: fail('Invalid score request source.')
    digest = hashlib.sha256((key('score-source', str(minute)) + ':' + source).encode()).hexdigest()
    count = state['sources'].get(digest, 0)
    if state['count'] >= INSTALLATION_LIMIT or count >= SOURCE_LIMIT or digest not in state['sources'] and len(state['sources']) >= MAX_SOURCES:
        fail('Too many scores were submitted. Wait a moment before trying again.', 429)
    state['count'] += 1; state['sources'][digest] = count + 1
    return envelope('game-score-rate', '', state, stored), stored


def entry_key(entry, metric):
    return (-entry['points'] if metric == 'points' else -entry['elapsed'] if metric == 'survival' else entry['elapsed'], entry['createdAt'], entry['name'], entry.get('requestId', entry.get('owner', '')))


def submit_score(api, event, game_id, body):
    fields(body, {'publishedRevision', 'requestId', 'name', 'result'})
    revision = body['publishedRevision']
    spec, published = publication(api, game_id, revision)
    request_id, name = identifier(body['requestId']), validate_name(body['name'])
    result = validate_result(body['result'], spec)
    metric = ranking(spec)
    if result['elapsed'] <= 0: fail('Finish a round with positive play time before saving its score.')
    if metric == 'time' and result['outcome'] != 'won': fail('Finish a successful round before saving a completion time.')
    fingerprint = hashlib.sha256(canonical({'name': name, 'result': result, 'publishedRevision': revision}).encode()).hexdigest()
    state, stored = board_state(api, game_id, revision)
    prepare_board(state, metric)
    receipts = [receipt for receipt in state['receipts'] if receipt.get('id') == request_id]
    entries = [entry for entry in state['entries'] if entry.get('requestId') == request_id]
    for receipt in receipts + entries:
        if receipt.get('fingerprint') != fingerprint: fail('This score request was already used for a different round or arcade name.', 409)
        if publication(api, game_id, revision)[1]['payload'] != published['payload']:
            fail('This published game changed. Reload before saving scores.', 409)
        qualified = receipt.get('qualified', bool(entries) or any(entry.get('owner') == receipt.get('owner') and entry.get('points') == result.get('points') for entry in state['entries']))
        return {**output(state), 'qualified': bool(qualified)}
    rate_item, rate_old = rate_state(api, event)
    entries = state['entries']
    qualified = len(entries) < LIMIT or (result['points'] > entries[-1]['points'] if metric == 'points' else result['elapsed'] > entries[-1]['elapsed'] if metric == 'survival' else result['elapsed'] < entries[-1]['elapsed'])
    if qualified:
        entry = {'requestId': request_id, 'fingerprint': fingerprint, 'name': name, 'elapsed': result['elapsed'], 'createdAt': datetime.now(timezone.utc).isoformat()}
        if metric == 'points': entry['points'] = result['points']
        state['entries'] = sorted(entries + [entry], key=lambda value: entry_key(value, metric))[:LIMIT]
    state['receipts'] = (state['receipts'] + [{'id': request_id, 'fingerprint': fingerprint, 'qualified': qualified}])[-MAX_RECEIPTS:]
    item = envelope('game-score', game_id, state, stored)
    try:
        api.clients()[0].meta.client.transact_write_items(TransactItems=[
            {'ConditionCheck': {'TableName': os.environ['GAME_PUBLIC_TABLE'], 'Key': {'id': key('game', game_id)}, **condition(published)}},
            {'Put': {'TableName': os.environ['GAME_PUBLIC_TABLE'], 'Item': item, **condition(stored)}},
            {'Put': {'TableName': os.environ['GAME_PUBLIC_TABLE'], 'Item': rate_item, **condition(rate_old)}}])
    except Exception as error:
        details = getattr(error, 'response', {})
        code = details.get('Error', {}).get('Code')
        reasons = {reason.get('Code') for reason in details.get('CancellationReasons', [])}
        if code == 'ConditionalCheckFailedException' or code == 'TransactionCanceledException' and (not reasons or reasons <= {'None', 'ConditionalCheckFailed', 'TransactionConflict'}):
            fail('This game or its board changed. Reload scores and try again with the same arcade name.', 409)
        raise
    return {**output(state), 'qualified': qualified}


def dispatch(api, event, method, path, body):
    if path == '/game-scores/session' and method == 'GET':
        claims = api.authorize(event)
        return {'authenticated': True, 'canEdit': 'games-create' in claims.get('permissions', [])}
    match = re.fullmatch(r'/game-scores/([^/]+)', path)
    if not match: fail('Leaderboard route not found.', 404)
    game_id = identifier(match[1])
    if method == 'GET':
        revision = (event.get('queryStringParameters') or {}).get('revision', '')
        if not isinstance(revision, str) or not re.fullmatch(r'[1-9][0-9]{0,9}', revision): fail('A published edition is required.')
        return get_scores(api, game_id, int(revision))
    if method == 'POST': return submit_score(api, event, game_id, body)
    fail('Leaderboard route not found.', 404)
