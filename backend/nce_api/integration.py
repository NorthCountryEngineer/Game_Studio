"""Deployment-bound host integration and administrator-controlled plain branding.

Hosts are configured only in deployment configuration. A public request never
chooses its tenant, Core service, credentials, CORS policy, or iframe authority.
"""
from copy import deepcopy
import json
import os
import re
from urllib.parse import urlsplit

ROUTES = {'games': '/games', 'game': '/games/{gameId}', 'embed': '/embed/games/{gameId}', 'studio': '/game-studio'}
DEFAULTS = {'version': 1, 'branding': {'appName': 'Game Studio', 'badgeText': 'Powered by Game Studio', 'accentColor': '#176a63'}, 'hosts': []}
CONTROL = re.compile(r'[\x00-\x1f\x7f-\x9f<>]')


class ConfigurationError(Exception):
    def __init__(self, message='Invalid Game Studio integration configuration.', status=503):
        self.message, self.status = message, status


def require(value):
    if not value: raise ConfigurationError()


def label(value, maximum):
    require(isinstance(value, str) and 1 <= len(value) <= maximum and value == value.strip() and not CONTROL.search(value))
    return value


def safe_url(value, *, origin=False):
    require(isinstance(value, str) and 1 <= len(value) <= 2048 and not re.search(r'[\s\\<>\x00-\x1f\x7f-\x9f]', value))
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError: raise ConfigurationError() from None
    require(parsed.scheme in {'https', 'http'} and bool(parsed.hostname) and parsed.username is None and parsed.password is None)
    require(parsed.scheme == 'https' or parsed.hostname in {'localhost', '127.0.0.1', '::1'})
    require(port is None or 1 <= port <= 65535)
    require('?' not in value and '#' not in value)
    require(not origin or not parsed.path)
    # Authority must be a concrete DNS name, IP literal, or local preview host.
    require(bool(re.fullmatch(r'[a-zA-Z0-9.\-:]+', parsed.hostname or '')) and '..' not in parsed.hostname)
    if origin:
        host = '[' + parsed.hostname + ']' if ':' in parsed.hostname else parsed.hostname
        canonical = parsed.scheme + '://' + host + (':' + str(port) if port is not None and port != (443 if parsed.scheme == 'https' else 80) else '')
        require(value == canonical)
        if re.fullmatch(r'(?:[0-9]+|0x[0-9a-f]+)', parsed.hostname.rsplit('.', 1)[-1], re.I):
            import ipaddress
            try: require(str(ipaddress.ip_address(parsed.hostname)) == parsed.hostname)
            except ValueError: raise ConfigurationError() from None
    return value


def branding(value):
    require(isinstance(value, dict) and {'appName', 'badgeText', 'accentColor'} <= set(value) and not set(value) - {'appName', 'badgeText', 'accentColor', 'logoUrl'})
    result = {'appName': label(value['appName'], 80), 'badgeText': label(value['badgeText'], 80)}
    require(isinstance(value['accentColor'], str) and re.fullmatch(r'#[a-fA-F0-9]{6}', value['accentColor']))
    result['accentColor'] = value['accentColor']
    if 'logoUrl' in value: result['logoUrl'] = safe_url(value['logoUrl'])
    return result


def deployment_configuration():
    raw = os.environ.get('GAME_STUDIO_CONFIG_JSON')
    if raw is None: return deepcopy(DEFAULTS)
    require(len(raw.encode()) <= 16384)
    try: value = json.loads(raw)
    except (ValueError, TypeError): raise ConfigurationError() from None
    require(isinstance(value, dict) and set(value) == {'version', 'branding', 'hosts'})
    require(type(value['version']) is int and value['version'] == 1)
    result = {'version': 1, 'branding': branding(value['branding']), 'hosts': []}
    require(isinstance(value['hosts'], list) and len(value['hosts']) <= 20)
    ids = set()
    for host in value['hosts']:
        require(isinstance(host, dict) and set(host) == {'id', 'name', 'origin', 'returnPath'})
        require(isinstance(host['id'], str) and re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', host['id']) and host['id'] not in ids)
        ids.add(host['id'])
        path = host['returnPath']
        require(isinstance(path, str) and len(path) <= 500 and re.fullmatch(r'/(?:[A-Za-z0-9._~-]+/?)*', path) and not any(part in {'.', '..'} for part in path.split('/')))
        result['hosts'].append({'id': host['id'], 'name': label(host['name'], 80), 'origin': safe_url(host['origin'], origin=True), 'returnPath': path})
    return result


def scoped_key():
    return ':'.join(['integration-config', os.environ['CORE_ORGANIZATION_ID'], os.environ['CORE_SERVICE_ID'], ''])


def table(api):
    return api.clients()[0].Table(os.environ['GAME_DRAFT_TABLE'])


def stored_configuration(api):
    item = table(api).get_item(Key={'id': scoped_key()}, ConsistentRead=True).get('Item')
    if item:
        require(item.get('organization_id') == os.environ['CORE_ORGANIZATION_ID'] and item.get('service_id') == os.environ['CORE_SERVICE_ID'])
        require(type(item.get('revision')) is int and 1 <= item['revision'] <= 1000000000)
        require(isinstance(item.get('branding'), dict))
        branding(item['branding'])
    return item


def public_configuration(api):
    result = deployment_configuration()
    stored = stored_configuration(api)
    result['revision'] = stored['revision'] if stored else 0
    if stored: result['branding'] = branding(stored['branding'])
    result['routes'] = deepcopy(ROUTES)
    return result


def update_branding(api, body):
    if not isinstance(body, dict) or set(body) != {'branding', 'expectedRevision'} or type(body.get('expectedRevision')) is not int or not 0 <= body['expectedRevision'] < 1000000000:
        raise ConfigurationError('Supply branding and its expected revision.', 400)
    try: wanted = branding(body['branding'])
    except ConfigurationError: raise ConfigurationError('Branding needs plain labels, a six-digit color, and an optional HTTPS logo URL.', 400) from None
    deployment_configuration()
    current = stored_configuration(api)
    previous = current['revision'] if current else 0
    if body['expectedRevision'] != previous: raise ConfigurationError('Branding changed. Reload before saving.', 409)
    item = {'id': scoped_key(), 'organization_id': os.environ['CORE_ORGANIZATION_ID'], 'service_id': os.environ['CORE_SERVICE_ID'], 'revision': previous + 1, 'branding': wanted}
    condition = {'ConditionExpression': 'attribute_not_exists(id)'} if current is None else {
        'ConditionExpression': 'revision = :revision AND organization_id = :org AND service_id = :service',
        'ExpressionAttributeValues': {':revision': previous, ':org': os.environ['CORE_ORGANIZATION_ID'], ':service': os.environ['CORE_SERVICE_ID']}}
    try: table(api).put_item(Item=item, **condition)
    except Exception as error:
        if getattr(error, 'response', {}).get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            raise ConfigurationError('Branding changed. Reload before saving.', 409) from None
        raise
    return public_configuration(api)
