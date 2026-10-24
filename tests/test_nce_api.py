"""Offline security/contract tests. No SDK install, network or AWS calls."""
import importlib.util
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

sys.modules.setdefault('boto3', types.SimpleNamespace())
sys.modules.setdefault('botocore', types.SimpleNamespace())
sys.modules.setdefault('botocore.config', types.SimpleNamespace(Config=lambda **kw: kw))
spec = importlib.util.spec_from_file_location('api', Path(__file__).parents[1] / 'backend/nce_api/handler.py')
api = importlib.util.module_from_spec(spec); spec.loader.exec_module(api)
PID = '11111111-1111-4111-8111-111111111111'
ORG = '22222222-2222-4222-8222-222222222222'
SERVICE = '33333333-3333-4333-8333-333333333333'
ASSET = '44444444-4444-4444-8444-444444444444'
REV = '55555555-5555-4555-8555-555555555555'
TARGET = '66666666-6666-4666-8666-666666666666'


class ConditionalFailure(Exception):
    response = {'Error': {'Code': 'ConditionalCheckFailedException'}}


class MemoryTable:
    """Exercise the actual transaction conditions without a cloud connection."""
    def __init__(self, database, name): self.database, self.name = database, name
    def get_item(self, Key, **kwargs):
        value = self.database.rows[self.name].get(Key['id'])
        return {'Item': deepcopy(value)} if value else {}
    def condition(self, expression, item, names=None, values=None):
        import re
        names, values = names or {}, values or {}
        tokens = re.findall(r'attribute_(?:not_)?exists\([#\w]+\)|[#:][\w]+|[\w]+|[()=<>]', expression)
        offset = 0
        def atom():
            nonlocal offset
            token = tokens[offset]; offset += 1
            if token == '(':
                value = either(); self_assert(tokens[offset] == ')'); offset += 1; return value
            if token.startswith('attribute_'):
                field = token[token.index('(') + 1:-1]; exists = names.get(field, field) in item
                return not exists if token.startswith('attribute_not') else exists
            field = names.get(token, token); operator = tokens[offset]; operand = values[tokens[offset + 1]]; offset += 2
            if operator == '=': return field in item and item[field] == operand
            if operator == '<': return field in item and item[field] < operand
            raise AssertionError('Unsupported condition comparison')
        def both():
            nonlocal offset
            value = atom()
            while offset < len(tokens) and tokens[offset] == 'AND': offset += 1; other = atom(); value = value and other
            return value
        def either():
            nonlocal offset
            value = both()
            while offset < len(tokens) and tokens[offset] == 'OR': offset += 1; other = both(); value = value or other
            return value
        def self_assert(value):
            if not value: raise AssertionError('Malformed expression')
        result = either(); self_assert(offset == len(tokens))
        return result
    def validate(self, item, options):
        if options.get('ConditionExpression') and not self.condition(options['ConditionExpression'], item,
                options.get('ExpressionAttributeNames'), options.get('ExpressionAttributeValues')): raise ConditionalFailure()
    def put_item(self, Item, **options):
        self.validate(self.database.rows[self.name].get(Item['id'], {}), options)
        self.database.rows[self.name][Item['id']] = deepcopy(Item)
        return {}
    def update_item(self, Key, UpdateExpression, **options):
        item = deepcopy(self.database.rows[self.name].get(Key['id'], {'id': Key['id']}))
        # An absent key does not satisfy attribute_exists(id).
        self.validate(self.database.rows[self.name].get(Key['id'], {}), options)
        values = options.get('ExpressionAttributeValues', {})
        if UpdateExpression.startswith('SET '):
            for clause in UpdateExpression[4:].split(','):
                field, value = clause.strip().split(' = '); field = options.get('ExpressionAttributeNames', {}).get(field, field); item[field] = deepcopy(values[value])
        elif UpdateExpression.startswith('REMOVE '):
            for field in UpdateExpression[7:].split(','): item.pop(field.strip(), None)
        else: raise AssertionError('Unsupported update')
        self.database.rows[self.name][Key['id']] = item
        return {}
    def delete_item(self, Key, **options):
        self.validate(self.database.rows[self.name].get(Key['id'], {}), options)
        self.database.rows[self.name].pop(Key['id'], None)
        return {}
    def scan(self, **options): return {'Items': deepcopy(list(self.database.rows[self.name].values()))}


class MemoryDatabase:
    def __init__(self, private=None, public=None):
        self.rows = {'private': deepcopy(private or {}), 'public': deepcopy(public or {})}
        self.meta = types.SimpleNamespace(client=types.SimpleNamespace(transact_write_items=Mock(side_effect=self.transact)))
    def Table(self, name): return MemoryTable(self, name)
    def transact(self, TransactItems):
        previous = deepcopy(self.rows)
        try:
            for operation in TransactItems:
                kind, options = next(iter(operation.items())); options = dict(options)
                table = self.Table(options.pop('TableName'))
                if kind == 'ConditionCheck':
                    item = self.rows[table.name].get(options.pop('Key')['id'], {}); table.validate(item, options)
                else: getattr(table, {'Put': 'put_item', 'Update': 'update_item', 'Delete': 'delete_item'}[kind])(**options)
        except Exception:
            self.rows = previous
            raise

class SecurityTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'CORE_ISSUER': 'https://core.example.com', 'CORE_ORGANIZATION_ID': ORG,
            'CORE_SERVICE_ID': SERVICE, 'GAME_DRAFT_TABLE': 'games', 'GAME_PUBLIC_TABLE': 'published-games',
            'CORE_CREDENTIALS_PARAMETER': '/test/secret'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.claims = {'active': True, 'iss': 'https://core.example.com', 'organization_id': ORG, 'service_id': SERVICE,
            'aud': 'urn:core:service:' + SERVICE, 'sub': PID, 'exp': 9999999999, 'scope': 'openid authorization', 'token_type': 'Bearer',
            'permissions': ['games-create', 'games-publish', 'games-manage', 'agents-manage', 'accounts-manage']}
        self.response = Mock(); self.response.__enter__ = Mock(return_value=self.response); self.response.__exit__ = Mock(return_value=False)
        self.response.read = lambda n: json.dumps(self.claims).encode()
        self.opener = Mock(); self.opener.open.return_value = self.response
        opened = patch.object(api, 'build_opener', return_value=self.opener); opened.start(); self.addCleanup(opened.stop)
        creds = patch.object(api, 'credentials', return_value={'client_id': 'private', 'client_secret': 'secret'})
        creds.start(); self.addCleanup(creds.stop)
        self.database = MemoryDatabase(); self.database.rows.update({'games': {}, 'published-games': {}})
        clients = patch.object(api, 'clients', return_value=(self.database, Mock(), Mock()))
        clients.start(); self.addCleanup(clients.stop)

    def event(self, path='/session', method='GET', body=None, token=True):
        return {'requestContext': {'http': {'method': method}}, 'rawPath': path,
            'headers': {'authorization': 'Bearer current'} if token else {},
            **({'body': json.dumps(body)} if body is not None else {})}

    def request(self, *args, **kwargs): return api.handler(self.event(*args, **kwargs), None)

    def test_reader_session_has_no_creation_or_administration_authority(self):
        self.claims['permissions'] = []
        response = self.request(); self.assertEqual(response['statusCode'], 200)
        value = json.loads(response['body'])
        self.assertEqual(value, {'subject': PID, 'permissions': [], 'canCreateGames': False, 'canPublishGames': False,
            'canManageGames': False, 'canManageAccounts': False, 'canConfigureAgents': False})
        self.assertNotIn('secret', response['body'])
        self.assertIn('no-store', response['headers']['Cache-Control'])

    def test_capabilities_require_the_explicit_app_permission(self):
        fields = {'games-create': 'canCreateGames', 'games-manage': 'canManageGames', 'agents-manage': 'canConfigureAgents', 'accounts-manage': 'canManageAccounts'}
        for permission, field in fields.items():
            self.claims['permissions'] = [permission]
            value = json.loads(self.request()['body'])
            self.assertTrue(value[field]); self.assertFalse(value['canPublishGames'])
            for other in set(fields.values()) - {field}: self.assertFalse(value[other])
        for old in ['admin', 'posts-write', 'posts-publish', 'games-publish', 'games-play']:
            self.claims['permissions'] = [old]
            value = json.loads(self.request()['body'])
            self.assertFalse(any(value[field] for field in (*fields.values(), 'canPublishGames')))
        self.claims['permissions'] = ['games-create', 'games-publish']
        self.assertTrue(json.loads(self.request()['body'])['canPublishGames'])

    def test_missing_permission_claim_is_a_reader_session(self):
        del self.claims['permissions']
        response = self.request()
        self.assertEqual(response['statusCode'], 200)
        self.assertEqual(json.loads(response['body'])['permissions'], [])

    def test_core_introspection_is_fresh_for_every_request(self):
        self.assertEqual(self.request()['statusCode'], 200)
        self.claims['active'] = False
        self.assertEqual(self.request()['statusCode'], 401)
        self.assertEqual(self.opener.open.call_count, 2)
        request = self.opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://core.example.com/oauth/introspect/')
        self.assertEqual(request.method, 'POST')

    def test_wrong_organization_service_issuer_audience_and_inactive_tokens_are_denied(self):
        valid = deepcopy(self.claims)
        for changes in [{'active': False}, {'iss': 'https://attacker.test'}, {'organization_id': PID}, {'service_id': PID},
                {'aud': 'urn:core:service:' + PID}, {'exp': 0}, {'exp': True}, {'exp': float('nan')}, {'exp': float('inf')}, {'sub': True}, {'sub': []}, {'sub': 'root'}, {'scope': 'openid'}, {'token_type': 'Basic'}]:
            self.claims = {**valid, **changes}
            response = self.request(); self.assertEqual(response['statusCode'], 401, changes)
        for permissions in ['games-create', None, [1], [{}]]:
            self.claims = {**valid, 'permissions': permissions}
            self.assertEqual(self.request()['statusCode'], 403)
        self.claims = []
        self.assertEqual(self.request()['statusCode'], 401)

    def test_missing_and_oversize_bearer_tokens_do_not_contact_core(self):
        self.assertEqual(self.request(token=False)['statusCode'], 401)
        event = self.event(); event['headers']['authorization'] = 'Bearer ' + 'x' * 4097
        self.assertEqual(api.handler(event, None)['statusCode'], 401)
        self.opener.open.assert_not_called()

    def test_preflight_is_independent_of_sdk_credentials_and_authorization(self):
        with patch.object(api, 'clients') as clients:
            self.assertEqual(self.request('/games', 'OPTIONS', token=False)['statusCode'], 204)
            clients.assert_not_called()
        self.opener.open.assert_not_called()

    def test_newsroom_media_and_feedback_routes_are_not_exposed(self):
        for path in ['/posts', '/published', '/posts/' + PID, '/media/read', '/media/upload', '/feedback', '/feedback/settings']:
            for method in ['GET', 'POST', 'PUT', 'DELETE']:
                self.assertEqual(self.request(path, method, {}, token=False)['statusCode'], 404, (path, method))
        self.opener.open.assert_not_called()
        self.assertFalse(any(self.database.rows.values()))

    def test_request_cannot_select_another_tenant_or_service(self):
        event = self.event(); event['queryStringParameters'] = {'organization_id': PID, 'service_id': PID}
        self.assertEqual(api.handler(event, None)['statusCode'], 200)
        self.claims['organization_id'] = PID
        self.assertEqual(api.handler(event, None)['statusCode'], 401)

    def test_integration_config_is_public_plain_and_has_no_identity_details(self):
        response = self.request('/integration', token=False)
        self.assertEqual(response['statusCode'], 200, response)
        value = json.loads(response['body'])
        self.assertEqual(set(value), {'version', 'revision', 'branding', 'hosts', 'routes'})
        self.assertEqual(value['version'], 1); self.assertEqual(value['revision'], 0)
        self.assertEqual(value['hosts'], []); self.assertEqual(value['routes']['embed'], '/embed/games/{gameId}')
        for hidden in [ORG, SERVICE, 'client_secret', 'authorization', 'credentials', 'CORE_']:
            self.assertNotIn(hidden, response['body'])
        self.opener.open.assert_not_called()

    def config(self):
        return {'version': 1, 'branding': {'appName': 'Academy Games', 'badgeText': 'Learning through play', 'accentColor': '#336699',
            'logoUrl': 'https://academy.example/logo.png'}, 'hosts': [{'id': 'academy', 'name': 'NCAcademy', 'origin': 'https://academy.example', 'returnPath': '/lessons/123/games'}]}

    def test_configured_https_and_local_preview_hosts_are_accepted(self):
        config = self.config()
        config['hosts'].append({'id': 'preview', 'name': 'Local preview', 'origin': 'http://localhost:5173', 'returnPath': '/'})
        with patch.dict(os.environ, {'GAME_STUDIO_CONFIG_JSON': json.dumps(config)}):
            result = self.request('/integration', token=False)
        self.assertEqual(result['statusCode'], 200, result)
        self.assertEqual(json.loads(result['body'])['hosts'], config['hosts'])

    def test_malformed_deployment_configuration_fails_closed(self):
        invalid = [None, [], {}, {**self.config(), 'version': True}, {**self.config(), 'secret': 'hidden'}, {**self.config(), 'hosts': [self.config()['hosts'][0]] * 21}]
        for value in invalid:
            with patch.dict(os.environ, {'GAME_STUDIO_CONFIG_JSON': json.dumps(value)}):
                response = self.request('/integration', token=False)
                self.assertEqual(response['statusCode'], 503, value)
                self.assertNotIn('hidden', response['body'])

    def test_hosts_cannot_supply_credentials_wildcards_remote_http_or_redirects(self):
        changes = [{'origin': value} for value in ['https://example.com/', 'http://evil.example', 'https://x:y@example.com', 'https://*.example.com', 'https://example.com?secret=x', 'https://example.com#secret', 'https://example.com/path', 'javascript:alert(1)', 'https://example.com:99999', 'https://example.com\\evil', 'https://EXAMPLE.com', 'https://example.com:443', 'https://@example.com', 'https://example.com?', 'https://example.com#', 'https://0177.0.0.1', 'https://2130706433']]
        changes += [{'returnPath': value} for value in ['//evil.example', '/ok?token=secret', '/ok#token', '/..', '/x/../y', '/%2f%2fevil.example', '/hello world']]
        for change in changes:
            config = self.config(); config['hosts'][0].update(change)
            with patch.dict(os.environ, {'GAME_STUDIO_CONFIG_JSON': json.dumps(config)}):
                response = self.request('/integration', token=False)
                self.assertEqual(response['statusCode'], 503, change)
                self.assertNotIn('secret', response['body'])

    def test_branding_update_is_game_manager_only_and_uses_revision(self):
        body = {'branding': self.config()['branding'], 'expectedRevision': 0}
        for permissions in [[], ['games-create'], ['games-create', 'games-publish'], ['agents-manage'], ['accounts-manage'], ['admin']]:
            self.claims['permissions'] = permissions
            self.assertEqual(self.request('/integration', 'PUT', body)['statusCode'], 403, permissions)
        self.assertFalse(self.database.rows['games'])
        self.claims['permissions'] = ['games-manage']
        result = self.request('/integration', 'PUT', body)
        self.assertEqual(result['statusCode'], 200, result)
        self.assertEqual(json.loads(result['body'])['revision'], 1)
        self.assertEqual(json.loads(self.request('/integration', token=False)['body'])['branding'], body['branding'])
        self.assertEqual(self.request('/integration', 'PUT', body)['statusCode'], 409)
        self.assertEqual(len(self.database.rows['games']), 1)

    def test_branding_updates_cannot_change_hosts_roles_or_tenant(self):
        body = {'branding': self.config()['branding'], 'expectedRevision': 0}
        for field in ['hosts', 'service_id', 'organization_id', 'permissions', 'routes', 'version']:
            response = self.request('/integration', 'PUT', {**body, field: []})
            self.assertEqual(response['statusCode'], 400, field)
        self.assertFalse(self.database.rows['games'])

    def test_branding_is_plain_text_and_safe_urls_only(self):
        for changes in [{'appName': '<script>alert(1)</script>'}, {'badgeText': 'bad\ntext'}, {'accentColor': 'red;display:none'},
                {'logoUrl': 'javascript:alert(1)'}, {'logoUrl': 'https://user:password@example.test/image.png'}, {'logoUrl': 'data:image/svg+xml,foo'}, {'logoUrl': 'http://remote.example/image.png'}, {'logoUrl': 'https://example.test/image.png?secret=x'}]:
            response = self.request('/integration', 'PUT', {'branding': {**self.config()['branding'], **changes}, 'expectedRevision': 0})
            self.assertEqual(response['statusCode'], 400, changes)
        self.assertFalse(self.database.rows['games'])

    def test_stored_branding_is_bound_to_the_deployed_organization_and_service(self):
        body = {'branding': self.config()['branding'], 'expectedRevision': 0}
        self.assertEqual(self.request('/integration', 'PUT', body)['statusCode'], 200)
        record = next(iter(self.database.rows['games'].values()))
        for field in ['organization_id', 'service_id']:
            original = record[field]; record[field] = PID
            self.assertEqual(self.request('/integration', token=False)['statusCode'], 503)
            self.assertEqual(self.request('/integration', 'PUT', {**body, 'expectedRevision': 1})['statusCode'], 503)
            record[field] = original

if __name__ == '__main__': unittest.main()
