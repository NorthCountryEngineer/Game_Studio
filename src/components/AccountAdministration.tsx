import { useEffect, useId, useRef, useState } from 'react';
import { getAccounts, inviteAccount, revokeAccountInvitation } from '../lib/account-api';
import { accountInvitationInput, safeInvitationUrl, type AccountDirectory, type AccountInvitationResult } from '../lib/account-types';
import { coreConfig } from '../lib/core';
import { useBranding } from '../lib/branding';
import '../accounts.css';

function expiry(value: string | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function AccountAdministration({ onClose }: { onClose: () => void }) {
  const brand = useBranding();
  const dialog = useRef<HTMLDialogElement>(null), headingId = useId(), operation = useRef(false);
  const [directory, setDirectory] = useState<AccountDirectory>(), [loading, setLoading] = useState(true), [busy, setBusy] = useState('');
  const [email, setEmail] = useState(''), [name, setName] = useState(''), [roleId, setRoleId] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [created, setCreated] = useState<AccountInvitationResult>(), [copied, setCopied] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  useEffect(() => {
    let active = true;
    void getAccounts().then(result => { if (active) setDirectory(result); }).catch(reason => { if (active) setError((reason as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function reload() {
    if (operation.current) return;
    setLoading(true); setError('');
    try { setDirectory(await getAccounts()); } catch (reason) { setError((reason as Error).message); } finally { setLoading(false); }
  }
  async function invite() {
    if (!directory || operation.current) return;
    operation.current = true; setBusy('invite'); setError(''); setNotice(''); setCreated(undefined); setCopied(false);
    try {
      const input = accountInvitationInput(email, name, [roleId], directory.roles), result = await inviteAccount(input);
      setCreated(result); setEmail(''); setName('');
      setNotice(directory.identityAuthority === 'local-preview' ? 'Preview invitation created in this browser.' : 'Account invitation created. Share the invitation link with this person.');
      setDirectory(await getAccounts());
    } catch (reason) { setError((reason as Error).message); }
    finally { operation.current = false; setBusy(''); }
  }
  async function revoke(id: string) {
    if (operation.current) return;
    operation.current = true; setBusy(id); setError(''); setNotice('');
    try {
      await revokeAccountInvitation(id);
      if (created?.invitation.id === id) setCreated(undefined);
      setDirectory(await getAccounts()); setNotice('Invitation revoked.');
    } catch (reason) { setError((reason as Error).message); }
    finally { operation.current = false; setBusy(''); }
  }
  const invitationUrl = safeInvitationUrl(created?.invitationUrl, coreConfig?.issuer);
  const roles = (ids: string[]) => ids.map(id => directory?.roles.find(role => role.id === id)?.name || 'Unlisted role').join(', ') || 'No Game Studio role';
  function close() { if (!busy) { dialog.current?.close(); onClose(); } }
  return <dialog ref={dialog} className="account-admin-dialog" aria-labelledby={headingId} onCancel={event => { event.preventDefault(); close(); }}>
    <header className="account-admin-heading"><div><span className="eyebrow">SERVICE SETTINGS</span><h2 id={headingId}>Accounts</h2><p>Create invitations and manage access to {brand.appName}.</p></div><button type="button" className="account-close" disabled={!!busy} onClick={close} aria-label="Close account settings">×</button></header>
    <div className="account-admin-body">
      {error && <div className="account-alert" role="alert">{error}</div>}{notice && <p className="account-success" role="status">{notice}</p>}
      {loading ? <p role="status">Loading Game Studio accounts…</p> : directory && <>
        {directory.identityAuthority === 'local-preview' ? <p className="account-preview-notice">Local preview. Invitations stay in this browser and cannot create accounts or send email.</p> : <p className="account-help">People use one NCE Core account across connected apps. New users choose their password when they accept your invitation. Existing users sign in with their current account.</p>}
        <section className="account-invite-section" aria-labelledby={`${headingId}-invite`}><h3 id={`${headingId}-invite`}>Create an account invitation</h3><form onSubmit={event => { event.preventDefault(); void invite(); }}><fieldset disabled={!!busy || !directory.roles.length} className="account-form-fields"><div className="account-form-grid"><label>Name <span className="account-optional">(optional)</span><input autoComplete="off" maxLength={100} value={name} onChange={event => setName(event.target.value)}/></label><label>Email<input required type="email" autoComplete="off" maxLength={254} value={email} onChange={event => setEmail(event.target.value)}/></label></div><label>Game Studio access<select required value={roleId} onChange={event => setRoleId(event.target.value)}><option value="">Choose a role</option>{directory.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>{directory.roles.find(role => role.id === roleId)?.description && <p className="account-help">{directory.roles.find(role => role.id === roleId)?.description}</p>}<button className="button primary" disabled={!email.trim() || !directory.roles.some(role => role.id === roleId)}>{busy === 'invite' ? 'Creating invitation…' : 'Create invitation'}</button></fieldset></form>{!directory.roles.length && <p className="account-help">No assignable Game Studio roles are available. Check this app’s roles and your account-management permission in Core.</p>}</section>
        {created && <section className="account-invitation-result" aria-label="New account invitation"><strong>{created.invitation.email}</strong><p>{roles(created.invitation.roleIds)} · Expires {expiry(created.invitation.expiresAt)}</p>{invitationUrl ? <><label>Invitation link<input readOnly value={invitationUrl} autoComplete="off" onFocus={event => event.currentTarget.select()}/></label><button type="button" className="button secondary" disabled={!!busy} onClick={async () => { try { await navigator.clipboard.writeText(invitationUrl); setCopied(true); } catch { setError('Select and copy the invitation link above.'); } }}>{copied ? 'Link copied' : 'Copy invitation link'}</button><p className="account-help">Share this link privately. An email has not been sent.</p></> : <p className="account-help">{directory.identityAuthority === 'local-preview' ? 'Preview invitations do not have a sign-up link.' : 'The invitation was created, but no shareable Core link was returned. Open Core to retrieve it.'}</p>}</section>}
        <section className="account-list-section" aria-labelledby={`${headingId}-members`}><div className="account-section-heading"><h3 id={`${headingId}-members`}>Game Studio accounts</h3><span>{directory.accounts.length}</span></div>{directory.accounts.length ? <div className="account-table-scroll"><table><thead><tr><th scope="col">Account</th><th scope="col">Access</th><th scope="col">Status</th></tr></thead><tbody>{directory.accounts.map(account => <tr key={account.id}><td><strong>{account.name || account.email}</strong>{account.name && <small>{account.email}</small>}</td><td>{roles(account.roleIds)}</td><td><span className="account-status">{account.status}</span></td></tr>)}</tbody></table></div> : <p className="account-help">No accounts have Game Studio access yet.</p>}</section>
        <section className="account-list-section" aria-labelledby={`${headingId}-invitations`}><div className="account-section-heading"><h3 id={`${headingId}-invitations`}>Invitations</h3><span>{directory.invitations.length}</span></div>{directory.invitations.length ? <div className="account-table-scroll"><table><thead><tr><th scope="col">Email</th><th scope="col">Access</th><th scope="col">Status</th><th scope="col">Expires</th><th scope="col">Actions</th></tr></thead><tbody>{directory.invitations.map(invitation => <tr key={invitation.id}><td>{invitation.email}</td><td>{roles(invitation.roleIds)}</td><td><span className="account-status">{invitation.status}</span></td><td>{expiry(invitation.expiresAt)}</td><td>{invitation.status === 'pending' && <button type="button" className="text-button danger" disabled={!!busy} onClick={() => void revoke(invitation.id)} aria-label={`Revoke invitation for ${invitation.email}`}>{busy === invitation.id ? 'Revoking…' : 'Revoke'}</button>}</td></tr>)}</tbody></table></div> : <p className="account-help">No invitations yet.</p>}</section>
      </>}
    </div><footer className="account-admin-footer"><button type="button" className="button secondary" disabled={!!busy || loading} onClick={() => void reload()}>Reload accounts</button><button type="button" className="button primary" disabled={!!busy} onClick={close}>Done</button></footer>
  </dialog>;
}
