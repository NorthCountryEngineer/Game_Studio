"""App-scoped Core account administration. Game Studio never stores passwords/users."""
import base64
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

ROLES = {'player', 'creator', 'publisher', 'administrator'}


class AccountError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise AccountError(503, 'Core account management redirected unexpectedly.')


def can_manage(claims):
    permissions = claims.get('permissions', [])
    return isinstance(permissions, list) and any(value in permissions for value in ('accounts-manage',))


def create_fields(body):
    if set(body) != {'email', 'name', 'roleIds'}:
        raise AccountError(400, 'Supply an email, name, and one application role.')
    email, name, roles = body.get('email'), body.get('name'), body.get('roleIds')
    if not isinstance(email, str) or not 3 <= len(email) <= 254 or not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', email):
        raise AccountError(400, 'Enter a valid email address.')
    if not isinstance(name, str) or len(name) > 160 or any(ord(char) < 32 for char in name):
        raise AccountError(400, 'The account name must be at most 160 characters.')
    if not isinstance(roles, list) or len(roles) != 1 or not isinstance(roles[0], str) or roles[0] not in ROLES:
        raise AccountError(400, 'Choose one application role.')
    return {'email': email.strip().lower(), 'name': name.strip(), 'roleIds': roles}


def core_operation(api, event, operation, payload):
    creds = api.credentials()
    basic = base64.b64encode((urlencode({'v': creds['client_id']})[2:] + ':' + urlencode({'v': creds['client_secret']})[2:]).encode()).decode()
    token = event['headers']['authorization'][7:]
    data = urlencode({'token': token, 'operation': operation, 'payload': json.dumps(payload, separators=(',', ':'))}).encode()
    request = Request(os.environ['CORE_ISSUER'].rstrip('/') + '/api/v1/application-accounts/', data=data,
        headers={'Authorization': 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded'}, method='POST')
    try:
        with build_opener(NoRedirect).open(request, timeout=10) as response:
            raw = response.read(262145)
            if len(raw) > 262144: raise AccountError(503, 'Core returned an invalid account response.')
            result = json.loads(raw)
    except HTTPError as error:
        messages = {
            400: 'Core rejected the account details. Check the email and selected application role.',
            401: 'This Core session is no longer valid. Sign in again.',
            403: 'Your current Core account cannot manage accounts for this application.',
            404: 'Core account management requires the application-account update.',
            409: 'This account already has application access or a pending invitation. Reload the account list; Core administrators can review inactive access.',
        }
        raise AccountError(error.code if error.code in messages else 503,
            messages.get(error.code, 'Core account management is unavailable. Try again shortly.')) from None
    except (URLError, TimeoutError, ValueError):
        raise AccountError(503, 'Core account management is unavailable. Try again shortly.') from None
    if not isinstance(result, dict) or result.get('organization_id') != os.environ['CORE_ORGANIZATION_ID'] or result.get('service_id') != os.environ['CORE_SERVICE_ID']:
        raise AccountError(503, 'Core returned an account response for an unexpected application.')
    # Return only the public result. Core has no authority to replace the token or credentials.
    if operation == 'list':
        if any(not isinstance(result.get(key), list) for key in ('accounts', 'invitations', 'roles')):
            raise AccountError(503, 'Core returned an invalid account list.')
        return {key: result[key] for key in ('accounts', 'invitations', 'roles')} | {'identityAuthority': 'core'}
    if operation == 'invite':
        from urllib.parse import urlsplit
        link, invitation = result.get('invitationUrl'), result.get('invitation')
        if not isinstance(link, str): raise AccountError(503, 'Core returned an invalid invitation link.')
        expected, actual = urlsplit(os.environ['CORE_ISSUER']), urlsplit(link)
        if (not isinstance(invitation, dict) or actual.scheme != expected.scheme or actual.netloc != expected.netloc or
                not re.fullmatch(r'/invitations/[A-Za-z0-9_-]{32,128}/', actual.path) or actual.query or actual.fragment):
            raise AccountError(503, 'Core returned an invalid invitation link.')
        return {'invitation': invitation, 'invitationUrl': link}
    if result.get('revoked') is not True: raise AccountError(503, 'Core did not confirm invitation revocation.')
    return {'revoked': True}


def dispatch(api, event, method, path, body):
    claims = api.authorize(event, 'accounts-manage')
    if not can_manage(claims):
        raise AccountError(403, 'Your Core account cannot manage Game Studio accounts.')
    if method == 'GET' and path == '/admin/accounts':
        return core_operation(api, event, 'list', {})
    if method == 'POST' and path == '/admin/accounts/invitations':
        return core_operation(api, event, 'invite', create_fields(body))
    match = re.fullmatch(r'/admin/accounts/invitations/([1-9][0-9]{0,18})', path)
    if method == 'DELETE' and match:
        if body: raise AccountError(400, 'Invitation revocation does not accept account changes.')
        return core_operation(api, event, 'revoke', {'id': match[1]})
    raise AccountError(404, 'Account administration route not found.')
