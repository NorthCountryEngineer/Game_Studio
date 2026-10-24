export type NewsroomRole = { id: string; name: string; description?: string };
export type NewsroomAccount = { id: string; email: string; name: string; status: string; roleIds: string[] };
export type NewsroomInvitation = { id: string; email: string; name?: string; status: string; roleIds: string[]; expiresAt?: string };
export type AccountDirectory = {
  identityAuthority: 'core' | 'local-preview';
  accounts: NewsroomAccount[];
  invitations: NewsroomInvitation[];
  roles: NewsroomRole[];
};
export type AccountInvitationInput = { email: string; name: string; roleIds: string[] };
export type AccountInvitationResult = { invitation: NewsroomInvitation; invitationUrl?: string };

export function accountInvitationInput(email: string, name: string, roleIds: string[], roles: NewsroomRole[]): AccountInvitationInput {
  const cleanEmail = email.trim().toLowerCase(), cleanName = name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) throw new Error('Enter a valid email address.');
  if (cleanName.length > 100) throw new Error('Keep the name under 100 characters.');
  const selected = [...new Set(roleIds)];
  if (selected.length !== 1 || selected.some(id => !roles.some(role => role.id === id))) throw new Error('Choose Game Studio access from the available roles.');
  return { email: cleanEmail, name: cleanName, roleIds: selected };
}

export function safeInvitationUrl(value: string | undefined, issuer: string | undefined): string | undefined {
  if (!value || !issuer) return;
  try {
    const url = new URL(value), origin = new URL(issuer);
    if (url.protocol !== 'https:' || url.origin !== origin.origin || url.username || url.password) return;
    return url.href;
  } catch { return; }
}
