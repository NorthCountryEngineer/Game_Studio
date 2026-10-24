import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountInvitationInput, safeInvitationUrl } from '../src/lib/account-types.ts';
import { LocalAccountDirectory, localAccountAdminId } from '../src/lib/account-local.ts';

function local() {
  const values = new Map<string, string>();
  return { directory: new LocalAccountDirectory({ getItem: name => values.get(name) || null, setItem: (name, value) => { values.set(name, value); } }), values };
}

test('account invitations accept only roles supplied by the current directory', () => {
  const roles = [{ id: 'creator', name: 'Editor' }];
  assert.deepEqual(accountInvitationInput('  Editor@Example.test ', ' Editor ', ['creator', 'creator'], roles), { email: 'editor@example.test', name: 'Editor', roleIds: ['creator'] });
  assert.throws(() => accountInvitationInput('editor@example.test', '', ['administrator'], roles), /available roles/);
  assert.throws(() => accountInvitationInput('editor@example.test', '', [], roles), /available roles/);
  assert.throws(() => accountInvitationInput('bad-address', '', ['creator'], roles), /valid email/);
  assert.throws(() => accountInvitationInput('editor@example.test', 'x'.repeat(101), ['creator'], roles), /100/);
});

test('invitation links are restricted to HTTPS on the configured Core issuer', () => {
  const issuer = 'https://core.example.test';
  assert.equal(safeInvitationUrl('https://core.example.test/accounts/app-signup/?invitation=synthetic', issuer), 'https://core.example.test/accounts/app-signup/?invitation=synthetic');
  for (const url of ['javascript:alert(1)', 'http://core.example.test/accounts/', 'https://other.example.test/accounts/', 'https://person:secret@core.example.test/accounts/', 'invalid']) assert.equal(safeInvitationUrl(url, issuer), undefined);
  assert.equal(safeInvitationUrl('https://core.example.test/accounts/', undefined), undefined);
});

test('local account administration stores previews without creating identities or functional links', () => {
  const { directory, values } = local(), before = directory.list();
  assert.equal(before.identityAuthority, 'local-preview');
  assert.equal(before.accounts[0].id, localAccountAdminId);
  const result = directory.invite({ email: 'writer@example.test', name: 'Writer', roleIds: ['creator'] });
  assert.equal(result.invitation.status, 'pending'); assert.equal(result.invitationUrl, undefined);
  assert.deepEqual(directory.list().accounts, before.accounts); assert.equal(directory.list().invitations.length, 1);
  assert.throws(() => directory.invite({ email: 'writer@example.test', name: 'Writer', roleIds: ['creator'] }), /already pending/);
  assert.throws(() => directory.invite({ email: 'admin@example.invalid', name: '', roleIds: ['creator'] }), /already has/);
  assert.ok(![...values.values()].some(value => /password|invitationUrl|access_token/.test(value)));
});

test('revocation preserves the invitation record and permits a fresh invitation', () => {
  const { directory } = local(), first = directory.invite({ email: 'writer@example.test', name: '', roleIds: ['creator'] });
  directory.revoke(first.invitation.id); assert.equal(directory.list().invitations[0].status, 'revoked');
  assert.throws(() => directory.revoke(first.invitation.id), /no longer pending/);
  const next = directory.invite({ email: 'writer@example.test', name: '', roleIds: ['publisher'] });
  assert.notEqual(next.invitation.id, first.invitation.id); assert.equal(directory.list().invitations.length, 2);
  assert.deepEqual(directory.list().invitations[0].roleIds, ['publisher']);
});

test('invalid preview storage is reported without overwriting other local data', () => {
  const { directory, values } = local();
  values.set('axolotl-news:v1', 'separate drafts'); values.set('game-studio-account-preview:v1', '{');
  assert.throws(() => directory.list(), /could not be read/); assert.equal(values.get('axolotl-news:v1'), 'separate drafts');
});
