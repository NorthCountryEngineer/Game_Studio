"""One Core-bound Game Studio deployment. Public snapshots and private drafts never share a table.
No permission cache: each protected request uses current Core introspection.
"""
import base64
import json
import math
import os
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler

import boto3
from botocore.config import Config

UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
MEDIA = re.compile(rf'^(drafts|published)/({UUID})/(?:({UUID})/)?({UUID})\.(jpg|png|webp|gif|mp4|webm|pdf)$')
MIMES = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf'}
CATEGORIES = {'Stories', 'Fun facts', 'Photos', 'Videos', 'Newsletters', 'Presentation'}
_ddb = _s3 = _ssm = None
_secret = None
_assistant = None
_accounts = None
_games = None
_integration = None
_game_scores = None

class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise APIError(503, 'Core identity redirected unexpectedly. Check its issuer configuration.')


def clients():
    global _ddb, _s3, _ssm
    if _ddb is None:
        _ddb = boto3.resource('dynamodb')
        _s3 = boto3.client('s3', config=Config(signature_version='s3v4'))
        _ssm = boto3.client('ssm')
    return _ddb, _s3, _ssm


def table(published=False):
    return clients()[0].Table(os.environ['PUBLIC_TABLE' if published else 'PRIVATE_TABLE'])


def credentials():
    global _secret
    # Cache only the credential, never membership/permission decisions.
    if not _secret or _secret[0] < time.time() - 60:
        value = clients()[2].get_parameter(Name=os.environ['CORE_CREDENTIALS_PARAMETER'], WithDecryption=True)['Parameter']['Value']
        _secret = (time.time(), json.loads(value))
    return _secret[1]


def authorize(event, *permissions):
    header = event.get('headers', {}).get('authorization', '')
    if not header.startswith('Bearer ') or not 1 <= len(header[7:]) <= 4096:
        raise APIError(401, 'Sign in through Core to continue.')
    creds = credentials()
    basic = base64.b64encode((urlencode({'v': creds['client_id']})[2:] + ':' + urlencode({'v': creds['client_secret']})[2:]).encode()).decode()
    request = Request(os.environ['CORE_ISSUER'].rstrip('/') + '/oauth/introspect/', data=urlencode({'token': header[7:]}).encode(), headers={'Authorization': 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded'}, method='POST')
    try:
        with build_opener(NoRedirect).open(request, timeout=5) as response:
            raw = response.read(65537)
            if len(raw) > 65536: raise APIError(503, 'Core identity returned an invalid response.')
            claims = json.loads(raw)
    except APIError:
        raise
    except (HTTPError, URLError, TimeoutError, ValueError):
        raise APIError(503, 'Core identity is unavailable. Try again shortly.')
    expected = {'iss': os.environ['CORE_ISSUER'], 'organization_id': os.environ['CORE_ORGANIZATION_ID'], 'service_id': os.environ['CORE_SERVICE_ID'], 'aud': 'urn:core:service:' + os.environ['CORE_SERVICE_ID']}
    if not isinstance(claims, dict) or claims.get('active') is not True or any(claims.get(k) != v for k, v in expected.items()) or not isinstance(claims.get('exp'), (int, float)) or isinstance(claims.get('exp'), bool) or not math.isfinite(claims['exp']) or claims['exp'] <= time.time() or not isinstance(claims.get('sub'), str) or not re.fullmatch(UUID, claims['sub']) or 'authorization' not in str(claims.get('scope', '')).split() or str(claims.get('token_type', '')).lower() != 'bearer':
        raise APIError(401, 'This Core session is inactive or belongs to another application.')
    granted = claims.get('permissions', [])
    if not isinstance(granted, list) or any(not isinstance(p, str) for p in granted) or any(p not in granted for p in permissions):
        raise APIError(403, 'Your Core account does not have this Game Studio permission.')
    claims['permissions'] = granted
    return claims


def post_id(value):
    if not isinstance(value, str) or not re.fullmatch(UUID, value): raise APIError(400, 'Invalid story identifier.')
    return value


def media_key(value):
    match = MEDIA.fullmatch(value or '') if isinstance(value, str) else None
    if not match or (match[1] == 'drafts' and match[3]) or (match[1] == 'published' and not match[3]): raise APIError(400, 'Invalid media key.')
    return match


def get_post(pid, published=False):
    item = table(published).get_item(Key={'id': pid}, ConsistentRead=True).get('Item')
    if item and item.get('organization_id') != os.environ['CORE_ORGANIZATION_ID']: raise APIError(403, 'Story belongs to another organization.')
    return item


def changing(item):
    return item and (any(item.get(field) for field in ('contentDeleting', 'contentDeleted', 'duplicateState')) or
        item.get('mediaCleanup') and item.get('mediaCleanupExpires', int(time.time()) + 1) >= int(time.time()))


def dispatch(event):
    method = event['requestContext']['http']['method']
    path = event.get('rawPath', '/')
    query = event.get('queryStringParameters') or {}
    if method == 'GET' and path == '/health': return {'status': 'ok'}
    if method == 'GET' and path == '/integration':
        global _integration
        if _integration is None:
            import importlib.util
            from pathlib import Path
            spec = importlib.util.spec_from_file_location('game_studio_integration', Path(__file__).with_name('integration.py'))
            _integration = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(_integration)
        try: return _integration.public_configuration(__import__('types').SimpleNamespace(clients=clients))
        except _integration.ConfigurationError: raise APIError(503, 'Game Studio integration configuration is invalid. Contact its administrator.')
    if method == 'GET' and path == '/session':
        claims = authorize(event)
        permissions = claims['permissions']
        return {'subject': claims['sub'], 'permissions': permissions,
            'canCreateGames': 'games-create' in permissions,
            'canPublishGames': 'games-create' in permissions and 'games-publish' in permissions,
            'canManageGames': 'games-manage' in permissions,
            'canManageAccounts': 'accounts-manage' in permissions,
            'canConfigureAgents': 'agents-manage' in permissions}
    raw = event.get('body') or '{}'
    if event.get('isBase64Encoded'): raw = base64.b64decode(raw).decode()
    if len(raw.encode()) > 280000: raise APIError(413, 'Request is too large.')
    try: body = json.loads(raw)
    except ValueError: raise APIError(400, 'Invalid JSON.')
    if not isinstance(body, dict): raise APIError(400, 'Expected a JSON object.')
    if path == '/integration' and method == 'PUT':
        authorize(event, 'games-manage')
        # Load the same deployment-bound validator used by the public endpoint.
        if _integration is None:
            import importlib.util
            from pathlib import Path
            spec = importlib.util.spec_from_file_location('game_studio_integration', Path(__file__).with_name('integration.py'))
            _integration = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(_integration)
        from types import SimpleNamespace
        try: return _integration.update_branding(SimpleNamespace(clients=clients), body)
        except _integration.ConfigurationError as error: raise APIError(error.status, error.message)
    if path == '/game-scores' or path.startswith('/game-scores/'):
        global _game_scores
        if _game_scores is None:
            import importlib.util
            from pathlib import Path
            spec = importlib.util.spec_from_file_location('game_studio_scores', Path(__file__).with_name('game_scores.py'))
            _game_scores = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(_game_scores)
        from types import SimpleNamespace
        api = SimpleNamespace(authorize=authorize, clients=clients)
        try: return _game_scores.dispatch(api, event, method, path, body)
        except _game_scores.ScoreError as error: raise APIError(error.status, error.message)
    if path == '/games' or path.startswith('/games/'):
        global _games
        if _games is None:
            import importlib.util
            from pathlib import Path
            spec = importlib.util.spec_from_file_location('game_studio_games', Path(__file__).with_name('games.py'))
            _games = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(_games)
        from types import SimpleNamespace
        api = SimpleNamespace(authorize=authorize, clients=clients)
        try: return _games.dispatch(api, event, method, path, body)
        except _games.GameError as error: raise APIError(error.status, error.message)
    if path == '/admin/accounts' or path.startswith('/admin/accounts/'):
        global _accounts
        if _accounts is None:
            import importlib.util
            from pathlib import Path
            spec = importlib.util.spec_from_file_location('game_studio_accounts', Path(__file__).with_name('accounts.py'))
            _accounts = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(_accounts)
        from types import SimpleNamespace
        api = SimpleNamespace(authorize=authorize, credentials=credentials)
        try: return _accounts.dispatch(api, event, method, path, body)
        except _accounts.AccountError as error: raise APIError(error.status, error.message)
    if path.startswith('/assistant/'):
        # Keep assistant dependencies lazy so publishing remains independent.
        global _assistant
        if _assistant is None:
            import importlib.util
            from pathlib import Path
            spec = importlib.util.spec_from_file_location('game_studio_agent_framework', Path(__file__).with_name('agent_framework.py'))
            _assistant = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(_assistant)
        from types import SimpleNamespace
        api = SimpleNamespace(authorize=authorize, clients=clients, post_id=post_id,
            get_post=get_post, changing=changing, media_key=media_key, CATEGORIES=CATEGORIES, MIMES=MIMES)
        try: return _assistant.dispatch(api, event, method, path, body)
        except _assistant.FrameworkError as error: raise APIError(error.status, error.message)
    raise APIError(404, 'API route not found.')


def handler(event, context):
    # The HTTP API's $default route can forward browser preflights here.
    # API Gateway owns the exact-origin CORS policy and supplies its headers.
    # A preflight checks request capabilities; it must not introspect a token,
    # initialize SDK clients, or perform the requested data operation.
    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return {'statusCode': 204, 'headers': {'Cache-Control': 'no-store'}, 'body': ''}
    try:
        result = dispatch(event); status = 200
    except APIError as e:
        result, status = {'error': e.message}, e.status
    except Exception:
        # Keep tokens, secrets, document content and signed media URLs out of logs.
        print('Game Studio request failed; request id:', getattr(context, 'aws_request_id', 'local'))
        result, status = {'error': 'Game Studio could not complete the request. Reload and retry.'}, 503
    return {'statusCode': status, 'headers': {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}, 'body': json.dumps(result)}
