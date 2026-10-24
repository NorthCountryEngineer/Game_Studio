import { coreRequest, isCore } from './core';
import { LocalAccountDirectory } from './account-local';
import type { AccountDirectory, AccountInvitationInput, AccountInvitationResult } from './account-types';

function local(): LocalAccountDirectory {
  if (import.meta.env.VITE_APP_MODE === 'cloud') throw new Error('Account administration requires the NCE Core API deployment.');
  return new LocalAccountDirectory(localStorage);
}
export async function getAccounts(): Promise<AccountDirectory> { return isCore ? coreRequest('/admin/accounts') : local().list(); }
export async function inviteAccount(input: AccountInvitationInput): Promise<AccountInvitationResult> { return isCore ? coreRequest('/admin/accounts/invitations', 'POST', input) : local().invite(input); }
export async function revokeAccountInvitation(id: string): Promise<void> {
  if (isCore) { await coreRequest(`/admin/accounts/invitations/${encodeURIComponent(id)}`, 'DELETE'); return; }
  local().revoke(id);
}
