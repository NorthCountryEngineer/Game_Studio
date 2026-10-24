"""App-bound account proxy tests: synthetic sessions; no Core/AWS calls."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from urllib.error import HTTPError, URLError
from unittest.mock import Mock, patch

sys.modules.setdefault('boto3', types.SimpleNamespace())
sys.modules.setdefault('botocore', types.SimpleNamespace())
sys.modules.setdefault('botocore.config', types.SimpleNamespace(Config=lambda **kw: kw))
ROOT = Path(__file__).parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
api = load('axolotl_account_handler_test', 'backend/nce_api/handler.py')
accounts = load('axolotl_accounts_test', 'backend/nce_api/accounts.py')
ORG, SERVICE, SUBJECT = ['%s1111111-1111-4111-8111-111111111111' % value for value in '123']


class AccountProxyTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'CORE_ISSUER': 'https://core.example.test', 'CORE_ORGANIZATION_ID': ORG,
            'CORE_SERVICE_ID': SERVICE}); self.env.start(); self.addCleanup(self.env.stop)
        self.claims = {'sub': SUBJECT, 'permissions': ['games-create', 'games-publish', 'accounts-manage']}
        self.auth = patch.object(api, 'authorize', return_value=self.claims); self.auth.start(); self.addCleanup(self.auth.stop)
        self.credential = patch.object(api, 'credentials', return_value={'client_id': 'resource', 'client_secret': 'secret'})
        self.credential.start(); self.addCleanup(self.credential.stop)
        api._accounts = accounts
        self.result = {'organization_id': ORG, 'service_id': SERVICE, 'accounts': [], 'invitations': [],
            'roles': [{'id': 'creator', 'name': 'Creator', 'description': ''}]}
        self.response = Mock(); self.response.__enter__ = Mock(return_value=self.response); self.response.__exit__ = Mock(return_value=False)
        self.response.read = lambda count: json.dumps(self.result).encode()
        self.opener = Mock(); self.opener.open.return_value = self.response
        self.open = patch.object(accounts, 'build_opener', return_value=self.opener); self.open.start(); self.addCleanup(self.open.stop)

    def request(self, path='/admin/accounts', method='GET', body=None):
        return api.handler({'requestContext': {'http': {'method': method}}, 'rawPath': path,
            'headers': {'authorization': 'Bearer synthetic-token'}, 'body': json.dumps(body) if body is not None else None}, None)

    def test_list_uses_live_server_authority_and_private_client_without_returning_credentials(self):
        response = self.request()
        self.assertEqual(response['statusCode'], 200)
        self.assertEqual(json.loads(response['body']), {'accounts': [], 'invitations': [], 'roles': self.result['roles'], 'identityAuthority': 'core'})
        api.authorize.assert_called_once()
        request = self.opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://core.example.test/api/v1/application-accounts/')
        self.assertEqual(request.method, 'POST')
        self.assertIn(b'token=synthetic-token', request.data)
        self.assertNotIn('secret', response['body'])
        self.assertIn('no-store', response['headers']['Cache-Control'])

    def test_publish_permission_is_not_account_management(self):
        for permissions in [['games-create'], ['games-create', 'games-publish'], [], 'accounts-manage']:
            self.claims['permissions'] = permissions
            self.assertEqual(self.request()['statusCode'], 403)
        self.opener.open.assert_not_called()
        api.credentials.assert_not_called()

    def test_org_admin_or_explicit_account_manager_can_manage(self):
        for permission in ('accounts-manage',):
            self.claims['permissions'] = ['games-create', permission]
            self.assertEqual(self.request()['statusCode'], 200)

    def test_player_account_role_has_no_creation_or_administration_capabilities(self):
        self.assertEqual(accounts.create_fields({'email': 'player@example.test', 'name': 'Player', 'roleIds': ['player']})['roleIds'], ['player'])
        self.claims['permissions'] = ['games-play']
        response = self.request('/session')
        self.assertEqual(response['statusCode'], 200)
        session = json.loads(response['body'])
        for flag in ['canCreateGames', 'canPublishGames', 'canManageGames', 'canManageAccounts', 'canConfigureAgents']:
            self.assertFalse(session[flag])
        self.assertEqual(self.request()['statusCode'], 403)

    def test_invitation_creation_passes_only_safe_explicit_fields(self):
        invitation = {'id': '7', 'email': 'new@example.test', 'name': 'Reader', 'roleIds': ['creator'], 'status': 'pending', 'expiresAt': '2099-01-01'}
        self.result = {'organization_id': ORG, 'service_id': SERVICE, 'invitation': invitation,
            'invitationUrl': 'https://core.example.test/invitations/' + 'x'*43 + '/'}
        response = self.request('/admin/accounts/invitations', 'POST', {'email': 'New@Example.test', 'name': 'Reader', 'roleIds': ['creator']})
        self.assertEqual(response['statusCode'], 200, response)
        self.assertEqual(json.loads(response['body'])['invitation'], invitation)
        self.assertIn(b'new%40example.test', self.opener.open.call_args.args[0].data)

    def test_app_cannot_supply_password_org_id_core_admin_or_arbitrary_permissions(self):
        fields = {'email': 'new@example.test', 'name': '', 'roleIds': ['creator']}
        invalid = [{**fields, 'password': 'forged'}, {**fields, 'organization_id': ORG}, {**fields, 'roleIds': ['admin']},
            {**fields, 'roleIds': ['creator', 'administrator']}, {**fields, 'email': 'evil\n@host.test'}, {**fields, 'name': 'bad\nname'}]
        for body in invalid:
            self.assertEqual(self.request('/admin/accounts/invitations', 'POST', body)['statusCode'], 400)
        self.opener.open.assert_not_called()

    def test_core_response_bindings_and_link_origin_are_verified(self):
        for key in ['organization_id', 'service_id']:
            original = self.result[key]; self.result[key] = 'another-app'
            self.assertEqual(self.request()['statusCode'], 503); self.result[key] = original
        self.result = {'organization_id': ORG, 'service_id': SERVICE, 'invitation': {'id': '7'}}
        for link in ['https://evil.test/invitations/' + 'x'*43 + '/', 'https://core.example.test/invitations/x/',
                'https://core.example.test/invitations/' + 'x'*43 + '/?token=evil', None]:
            self.result['invitationUrl'] = link
            response = self.request('/admin/accounts/invitations', 'POST', {'email': 'new@example.test', 'name': '', 'roleIds': ['creator']})
            self.assertEqual(response['statusCode'], 503, response)

    def test_core_absent_unauthorized_or_outage_is_not_faked_as_success(self):
        for code, expected in [(404,404),(401,401),(403,403),(409,409),(500,503)]:
            self.opener.open.side_effect = HTTPError('https://core.example.test', code, 'hidden body', {}, None)
            response = self.request()
            self.assertEqual(response['statusCode'], expected)
            self.assertNotIn('hidden body', response['body'])
        self.opener.open.side_effect = URLError('hidden internal URL')
        self.assertEqual(self.request()['statusCode'], 503)

    def test_revoke_is_bounded_and_requires_current_account_authority(self):
        self.result = {'organization_id': ORG, 'service_id': SERVICE, 'revoked': True}
        self.assertEqual(self.request('/admin/accounts/invitations/7', 'DELETE')['statusCode'], 200)
        self.assertEqual(self.request('/admin/accounts/invitations/7', 'DELETE', {'password': 'x'})['statusCode'], 400)
        self.assertEqual(self.request('/admin/accounts/invitations/../7', 'DELETE')['statusCode'], 404)

    def test_preflight_does_not_authenticate_or_create_anything(self):
        self.assertEqual(self.request('/admin/accounts/invitations', 'OPTIONS')['statusCode'], 204)
        api.authorize.assert_not_called(); api.credentials.assert_not_called(); self.opener.open.assert_not_called()

    def test_session_exposes_account_management_only_for_explicit_core_authority(self):
        for permission, expected in [('games-publish',False),('accounts-manage',True),('admin',False)]:
            self.claims['permissions'] = ['games-create',permission]
            result = json.loads(self.request('/session')['body'])
            self.assertEqual(result['canManageAccounts'], expected)
    def test_session_separates_agent_management_from_publishing_and_accounts(self):
        for permission, expected in [('games-publish', False), ('accounts-manage', False), ('agents-manage', True), ('admin', False)]:
            self.claims['permissions'] = ['games-create', permission]
            result = json.loads(self.request('/session')['body'])
            self.assertEqual(result['canConfigureAgents'], expected)
            self.assertEqual(result['canManageAccounts'], permission == 'accounts-manage')

if __name__ == '__main__': unittest.main()
