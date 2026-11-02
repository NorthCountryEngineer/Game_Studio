"""An administrator-reviewed, installation-wide Mafia narration vocabulary.

Only the protected generation operation can call a model. Anonymous rooms reuse
an approved inert text bank; player names, messages, roles and actions never
enter a model prompt. A durable reservation precedes every billable invocation.
"""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import re
import unicodedata

MODEL = 'amazon.nova-micro-v1:0'
MAX_ATTEMPTS = 3
PHRASES = ('night', 'discussion', 'voting', 'eliminated', 'protected', 'tie', 'townWin', 'mafiaWin')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
_framework = None


class NarrationError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def fail(message, status=400):
    raise NarrationError(status, message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False)


def framework():
    global _framework
    if _framework is None:
        spec = importlib.util.spec_from_file_location('mafia_narration_framework', Path(__file__).with_name('agent_framework.py'))
        _framework = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_framework)
    return _framework


def key():
    return ':'.join(('game-mafia-narration', os.environ['CORE_ORGANIZATION_ID'], os.environ['CORE_SERVICE_ID'], ''))


def table(api):
    name = os.environ.get('GAME_PUBLIC_TABLE')
    if not name:
        fail('The Mafia narrator has not been configured for this installation.', 503)
    return api.clients()[0].Table(name)


def fields(value, required, optional=()):
    if not isinstance(value, dict) or set(value) - set(required) - set(optional) or not set(required) <= set(value):
        fail('Unexpected or missing narrator fields.')


def integer(value, minimum=0, maximum=1000000000):
    if type(value) is not int or not minimum <= value <= maximum:
        fail('Invalid narrator revision or limit.')
    return value


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        fail('Invalid narrator request identifier.')
    return value


def validate_phrases(value):
    fields(value, PHRASES)
    for phrase in value.values():
        if (not isinstance(phrase, str) or not 8 <= len(phrase) <= 160 or phrase.strip() != phrase
                or any(unicodedata.category(char)[0] == 'C' or unicodedata.category(char) in {'Zl', 'Zp'} for char in phrase)
                or re.search(r'[<>{}`]|https?\s*:|javascript\s*:|data\s*:', phrase, re.I)):
            fail('Narration must contain eight short, plain-text atmosphere lines.')
    return deepcopy(value)


def validate_bank(value):
    fields(value, ('version', 'phrases', 'source'))
    if type(value['version']) is not int or value['version'] != 1 or value['source'] != MODEL:
        fail('Invalid cached narrator format.')
    validate_phrases(value['phrases'])
    return deepcopy(value)


def defaults():
    return {'version': 1, 'revision': 0, 'attempts': 0, 'enabled': False, 'approved': None, 'draft': None, 'requests': []}


def validate_state(value):
    fields(value, ('version', 'revision', 'attempts', 'enabled', 'approved', 'draft', 'requests'))
    if type(value['version']) is not int or value['version'] != 1 or type(value['enabled']) is not bool:
        fail('Invalid narrator storage version.')
    integer(value['revision']); integer(value['attempts'], 0, MAX_ATTEMPTS)
    if not isinstance(value['requests'], list) or len(value['requests']) != value['attempts']:
        fail('Invalid narrator request history.')
    seen = set()
    pending = 0
    for receipt in value['requests']:
        fields(receipt, ('requestId', 'owner', 'status'), ('phrases',))
        identifier(receipt['requestId']); identifier(receipt['owner'])
        if receipt['requestId'] in seen or receipt['status'] not in {'pending', 'complete', 'failed'}:
            fail('Invalid narrator receipt.')
        seen.add(receipt['requestId'])
        pending += receipt['status'] == 'pending'
        if receipt['status'] == 'complete':
            validate_phrases(receipt.get('phrases'))
        elif 'phrases' in receipt:
            fail('Invalid incomplete narrator receipt.')
    if pending > 1:
        fail('Invalid pending narrator history.')
    if value['approved'] is not None:
        validate_bank(value['approved'])
    if value['draft'] is not None:
        fields(value['draft'], ('requestId', 'phrases'))
        identifier(value['draft']['requestId']); validate_phrases(value['draft']['phrases'])
        receipt = next((entry for entry in value['requests'] if entry['requestId'] == value['draft']['requestId']), None)
        if not receipt or receipt['status'] != 'complete' or receipt['phrases'] != value['draft']['phrases']:
            fail('Narrator review is not bound to its completed request.')
    return deepcopy(value)


def read_state(api):
    item = table(api).get_item(Key={'id': key()}, ConsistentRead=True).get('Item')
    if item is None:
        return defaults(), None
    try:
        if (item.get('id') != key() or item.get('organization_id') != os.environ['CORE_ORGANIZATION_ID']
                or item.get('service_id') != os.environ['CORE_SERVICE_ID']):
            raise ValueError()
        state = validate_state(json.loads(item['payload']))
        if state['revision'] != item['revision']:
            raise ValueError()
    except (KeyError, TypeError, ValueError, NarrationError):
        fail('The cached narrator is unavailable. Existing records have been preserved.', 503)
    return state, item


def load_bank(api):
    """Provider-free room input: an approved bank, or None when disabled."""
    state, _ = read_state(api)
    return deepcopy(state['approved']) if state['enabled'] and state['approved'] else None


def public_config(api):
    """Do not expose draft text, owner identifiers, receipts or usage history."""
    bank = load_bank(api)
    return {'aiAvailable': bank is not None, 'aiLabel': 'AI narrator' if bank else 'AI narrator not enabled'}


def admin_status(api, event):
    api.authorize(event, 'agents-manage')
    state, _ = read_state(api)
    return {'revision': state['revision'], 'attempts': state['attempts'],
        'aiAvailable': bool(state['enabled'] and state['approved']), 'draft': deepcopy(state['draft']),
        'requests': [{'requestId': entry['requestId'], 'status': entry['status']} for entry in state['requests']]}


def conditional(item):
    if item is None:
        return {'ConditionExpression': 'attribute_not_exists(id)'}
    return {'ConditionExpression': 'revision = :revision AND organization_id = :org AND service_id = :service AND payload = :payload',
        'ExpressionAttributeValues': {':revision': int(item['revision']), ':org': os.environ['CORE_ORGANIZATION_ID'],
            ':service': os.environ['CORE_SERVICE_ID'], ':payload': item['payload']}}


def save(api, state, previous, registry_item=None, guard_registry=False):
    validate_state(state)
    item = {'id': key(), 'organization_id': os.environ['CORE_ORGANIZATION_ID'],
        'service_id': os.environ['CORE_SERVICE_ID'], 'revision': state['revision'], 'payload': canonical(state)}
    operations = [{'Put': {'TableName': os.environ['GAME_PUBLIC_TABLE'], 'Item': item, **conditional(previous)}}]
    if guard_registry:
        af = framework()
        operations.append({'ConditionCheck': {'TableName': os.environ['ASSISTANT_TABLE'],
            'Key': {'id': af.scoped_key('config')}, **conditional(registry_item)}})
    try:
        api.clients()[0].meta.client.transact_write_items(TransactItems=operations)
    except Exception as error:
        code = getattr(error, 'response', {}).get('Error', {}).get('Code')
        if code in {'ConditionalCheckFailedException', 'TransactionCanceledException'}:
            fail('Narrator settings changed. Reload before continuing; no invocation is automatically replayed.', 409)
        raise


def selected_model(api):
    af = framework()
    try:
        registry = af.validate_config(af.configuration(api))
        if not registry['enabled'] or not registry['allowPaidExecution'] or registry['limits']['maxModelCalls'] < 1:
            fail('An administrator must enable paid generation in Agent settings.', 403)
        models = [model for model in registry['models'] if model['enabled'] and model['provider'] == 'bedrock'
            and model['kind'] == 'generative' and model['target'] == MODEL and model['maxOutputTokens'] >= 512]
        if not models:
            fail('Enable the existing Nova Micro writing model with at least 512 output tokens in Agent settings.', 403)
        stored = af.read(api, af.scoped_key('config'))
        if (stored and json.loads(stored['payload']) != registry) or (stored is None and af.defaults() != registry):
            fail('Agent settings changed before narrator generation.', 409)
        return af, registry, sorted(models, key=lambda model: model['id'])[0], stored
    except af.FrameworkError as error:
        fail(error.message, error.status)


def model_phrases(af, model):
    """The fixed prompt has no caller-controlled text and no game-session data."""
    instruction = (
        'Write a friendly, mysterious text narrator vocabulary for a classic Mafia party game. '
        'Return exactly one compact JSON object with precisely these eight keys: '
        + ', '.join(PHRASES) + '. Each value must be one plain English atmosphere sentence of 8 to 160 characters. '
        'night means secret choices begin; discussion means townspeople discuss; voting means cast a vote; '
        'eliminated means a player leaves the round; protected means nobody leaves overnight; tie means no vote winner; '
        'townWin and mafiaWin are the two endings. Use non-graphic, playful suspense. '
        'Do not name or describe particular players, identify secret roles, invent a target, add rules, '
        'claim a particular action succeeded, include placeholders, instructions, code, HTML, URLs or extra fields. '
        'The deterministic game server adds the actual facts after your atmosphere text.')
    response = af.provider('bedrock-runtime').converse(modelId=MODEL,
        system=[{'text': instruction}],
        messages=[{'role': 'user', 'content': [{'text': 'Create the reusable eight-line narrator vocabulary now.'}]}],
        inferenceConfig={'maxTokens': min(800, model['maxOutputTokens']), 'temperature': 0.3})
    if not isinstance(response, dict) or response.get('stopReason') != 'end_turn':
        fail('The narrator generator did not finish a complete response. This request will not be replayed.', 502)
    parts = response.get('output', {}).get('message', {}).get('content', [])
    if not isinstance(parts, list) or not parts or any(not isinstance(part, dict) or set(part) != {'text'} or not isinstance(part['text'], str) for part in parts):
        fail('The narrator generator did not return plain JSON. This request will not be replayed.', 502)
    text = '\n'.join(part['text'] for part in parts)
    if len(text.encode('utf-8')) > 5000:
        fail('The narrator generator returned too much text. This request will not be replayed.', 502)
    fence = re.fullmatch(r'```(?:json)?\r?\n(.*)\r?\n```', text.strip(' \t\r\n'), re.S)
    if fence:
        text = fence[1]
    def unique(pairs):
        result = {}
        for name, value in pairs:
            if name in result:
                raise ValueError('Duplicate JSON field')
            result[name] = value
        return result
    try:
        value = json.loads(text, object_pairs_hook=unique,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        return validate_phrases(value)
    except (ValueError, TypeError, UnicodeError, NarrationError):
        fail('The narrator generator returned invalid atmosphere text. This request will not be replayed.', 502)


def receipt_response(state, receipt):
    result = {'revision': state['revision'], 'requestId': receipt['requestId'], 'status': receipt['status'],
        'attempts': state['attempts'], 'aiAvailable': bool(state['enabled'] and state['approved'])}
    if receipt['status'] == 'complete':
        result['draft'] = {'requestId': receipt['requestId'], 'phrases': deepcopy(receipt['phrases'])}
    return result


def generate(api, event, body):
    claims = api.authorize(event, 'agents-manage')
    fields(body, ('requestId', 'expectedRevision'))
    request_id = identifier(body['requestId']); integer(body['expectedRevision'])
    state, previous = read_state(api)
    prior = next((entry for entry in state['requests'] if entry['requestId'] == request_id), None)
    if prior:
        if prior['owner'] != claims['sub']:
            fail('That narrator request belongs to another administrator.', 409)
        return receipt_response(state, prior)
    if state['revision'] != body['expectedRevision']:
        fail('Narrator settings changed. Reload before generating.', 409)
    af, registry, model, stored = selected_model(api)
    if any(entry['status'] == 'pending' for entry in state['requests']):
        fail('A narrator invocation is unresolved. It will not be automatically retried.', 409)
    if state['attempts'] >= min(MAX_ATTEMPTS, registry['limits']['maxModelCalls']):
        fail('The installation narrator generation limit has been reached.', 409)
    next_state = deepcopy(state)
    next_state['revision'] += 1; next_state['attempts'] += 1
    next_state['requests'].append({'requestId': request_id, 'owner': claims['sub'], 'status': 'pending'})
    save(api, next_state, previous, stored, True)
    # Reassert live Core authority and exact registry after the reservation. An
    # interruption here leaves a bounded pending receipt rather than recharging.
    api.authorize(event, 'agents-manage')
    _, current_registry, current_model, _ = selected_model(api)
    if current_registry != registry or current_model != model:
        fail('Agent settings changed after the reserved narrator request.', 409)
    try:
        phrases = model_phrases(af, model)
    except Exception as error:
        state, item = read_state(api)
        receipt = next(entry for entry in state['requests'] if entry['requestId'] == request_id)
        receipt['status'] = 'failed'; state['revision'] += 1
        save(api, state, item)
        if isinstance(error, NarrationError):
            raise
        fail('The narrator provider did not return a usable response. This request will not be replayed.', 502)
    api.authorize(event, 'agents-manage')
    _, final_registry, final_model, final_stored = selected_model(api)
    if final_registry != registry or final_model != model:
        fail('Agent settings changed while the narrator text was generated. It has not been enabled.', 409)
    state, item = read_state(api)
    receipt = next(entry for entry in state['requests'] if entry['requestId'] == request_id)
    if receipt['status'] != 'pending' or receipt['owner'] != claims['sub']:
        fail('The reserved narrator request changed. Existing text has been preserved.', 409)
    receipt.update(status='complete', phrases=phrases)
    state['draft'] = {'requestId': request_id, 'phrases': phrases}; state['revision'] += 1
    save(api, state, item, final_stored, True)
    return receipt_response(state, receipt)


def approve(api, event, body):
    api.authorize(event, 'agents-manage')
    fields(body, ('requestId', 'expectedRevision', 'reviewed'))
    identifier(body['requestId']); integer(body['expectedRevision'])
    if body['reviewed'] is not True:
        fail('Review the exact generated narrator text before enabling it.')
    state, previous = read_state(api)
    if state['revision'] != body['expectedRevision'] or not state['draft'] or state['draft']['requestId'] != body['requestId']:
        fail('The reviewed narrator text changed. Reload it before enabling.', 409)
    state['approved'] = {'version': 1, 'source': MODEL, 'phrases': deepcopy(state['draft']['phrases'])}
    state['enabled'] = True; state['revision'] += 1
    save(api, state, previous)
    return {'revision': state['revision'], **public_config(api)}


def set_enabled(api, event, body):
    api.authorize(event, 'agents-manage')
    fields(body, ('expectedRevision', 'enabled'))
    integer(body['expectedRevision'])
    if type(body['enabled']) is not bool:
        fail('Narrator availability must be true or false.')
    state, previous = read_state(api)
    if state['revision'] != body['expectedRevision']:
        fail('Narrator settings changed. Reload before continuing.', 409)
    if body['enabled'] and not state['approved']:
        fail('Review a generated narrator before enabling it.', 409)
    state['enabled'] = body['enabled']; state['revision'] += 1
    save(api, state, previous)
    return {'revision': state['revision'], **public_config(api)}
