import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { buildAgentContext, contextFingerprint, createAgentSession, deleteAgentSession, getAgentSession, getAgentSettings, saveAgentSettings, sendAgentTurn } from '../lib/agent-api';
import { validateAgentConfig } from '../lib/agent-defaults';
import { addCrosswordAgentPreset, crosswordPresetIds } from '../lib/crossword-agent-preset';
import { addWordSearchAgentPreset, wordSearchPresetIds } from '../lib/word-search-agent-preset';
import { hasAgentEdits } from '../lib/agent-draft';
import { getAccounts } from '../lib/account-api';
import type { NewsroomAccount } from '../lib/account-types';
import { isCore } from '../lib/core';
import type { AgentConfig, AgentDefinition, AgentMode, AgentModel, AgentSession, AgentSettings, AgentSuggestion, AgentTurn, AgentWorkflow, WorkflowGraph, WorkflowNode } from '../lib/agent-types';
import { parseDocument, type Block, type Post, type RichNode } from '../lib/model';
import { useConfirm } from './Confirm';
import '../agent-workspace.css';

type AgentWorkspaceProps = { post: Post; onApply: (suggestion: AgentSuggestion) => void; onClose: () => void; canConfigure: boolean; busy?: boolean };
type SavedConversation = { id: string; mediaIds: string[] };
const sessionKey = (postId: string) => `game-studio-agent-session:${postId}`;
const messageFor = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please check the conversation status.';
const newId = () => crypto.randomUUID();
function remember(postId: string, value?: SavedConversation) { try { if (value) sessionStorage.setItem(sessionKey(postId), JSON.stringify(value)); else sessionStorage.removeItem(sessionKey(postId)); } catch { /* Conversations still work when browser storage is unavailable. */ } }
function readRemembered(postId: string): SavedConversation | undefined { try { const value = JSON.parse(sessionStorage.getItem(sessionKey(postId)) || 'null') as SavedConversation | null; if (value && typeof value.id === 'string' && Array.isArray(value.mediaIds) && value.mediaIds.every(id => typeof id === 'string')) return value; } catch { /* Ignore malformed or unavailable session storage. */ } }
function richText(nodes?: RichNode[]): string { return (nodes || []).map(node => node.tag === '#text' ? node.text || '' : richText(node.children)).join(' '); }
function blockText(block: Block) { return block.type === 'text' ? richText(block.nodes) : block.type === 'fact' ? block.text || '' : block.caption || block.name || block.type; }
function PlainResult({ value }: { value: unknown }) { return <pre className="agent-result">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>; }
function SuggestionPreview({ suggestion }: { suggestion: AgentSuggestion }) { return <div className="agent-suggestion-preview"><p>{suggestion.summary}</p>{suggestion.title !== undefined && <div><strong>Suggested title</strong><p>{suggestion.title}</p></div>}{suggestion.excerpt !== undefined && <div><strong>Suggested introduction</strong><p>{suggestion.excerpt}</p></div>}{suggestion.blocks?.map(block => <div key={block.id}><strong>{block.type === 'fact' ? 'Fun fact' : `${block.type} block`}</strong><p>{blockText(block)}</p></div>)}{suggestion.captions?.map(caption => <div key={caption.blockId}><strong>Caption · {caption.blockId}</strong><p>{caption.caption}</p>{caption.alt !== undefined && <p><strong>Image description:</strong> {caption.alt}</p>}</div>)}</div>; }

export function AgentWorkspace({ post, onApply, onClose, canConfigure, busy = false }: AgentWorkspaceProps) {
  const headingId = useId(), confirm = useConfirm();
  const [settings, setSettings] = useState<AgentSettings | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [modeId, setModeId] = useState(''), [mediaIds, setMediaIds] = useState<string[]>([]), [session, setSession] = useState<AgentSession | null>(null);
  const [fingerprint, setFingerprint] = useState(''), [working, setWorking] = useState(false), [message, setMessage] = useState(''), [inputs, setInputs] = useState<Record<string, string>>({});
  const [adminOpen, setAdminOpen] = useState(false), [recovery, setRecovery] = useState<'none' | 'check' | 'retry'>('none'), [notice, setNotice] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const alive = useRef(true), currentPost = useRef(post.id), requestBusy = useRef(false), pendingTurn = useRef<AgentTurn | null>(null), transcript = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null);
  currentPost.current = post.id;
  const blocks = useMemo(() => { try { return parseDocument(post.document).blocks; } catch { return []; } }, [post.document]);
  const media = blocks.filter(block => ['image', 'video'].includes(block.type) && block.key);
  const selectedIds = mediaIds.filter(id => media.some(block => block.id === id));
  const context = useMemo(() => buildAgentContext(post, selectedIds), [post, selectedIds.join('|')]);
  const latestContext = useRef(context);
  latestContext.current = context;
  const enabledModes = settings?.config.modes.filter(mode => mode.enabled && (!settings.availableModeIds || settings.availableModeIds.includes(mode.id))) || [];
  const mode = settings?.config.modes.find(item => item.id === (session?.postId === post.id ? session.modeId : modeId));
  const activeSession = session?.postId === post.id ? session : null;
  const catalogWorkflow = settings?.config.workflows.find(item => item.id === mode?.workflowId);
  const workflow = activeSession ? activeSession.workflow : catalogWorkflow ? { id: catalogWorkflow.id, name: catalogWorkflow.name, description: catalogWorkflow.description, inputs: catalogWorkflow.graph.inputs } : undefined;
  const fresh = Boolean(activeSession && fingerprint && activeSession.contextFingerprint === fingerprint);
  const locked = busy || working || loading;
  const executionLocked = locked || !fresh || recovery !== 'none' || !settings?.config.enabled || Boolean(activeSession && ['uncertain', 'failed', 'running'].includes(activeSession.status));
  const stepsPending = activeSession?.steps.some(step => ['pending', 'waiting'].includes(step.status));
  useEffect(() => { alive.current = true; const opener = document.activeElement as HTMLElement | null; panel.current?.focus(); return () => { alive.current = false; if (opener?.isConnected) opener.focus(); }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setSettings(null); setError(''); setNotice(''); setSession(null); setMediaIds([]); setMessage(''); setRecovery('none'); pendingTurn.current = null;
    const remembered = readRemembered(post.id);
    const selected = remembered?.mediaIds || [];
    setMediaIds(selected);
    void (async () => {
      try {
        const loadedSettings = await getAgentSettings();
        if (!active) return;
        setSettings(loadedSettings);
        setModeId(loadedSettings.config.modes.find(item => item.enabled && (!loadedSettings.availableModeIds || loadedSettings.availableModeIds.includes(item.id)))?.id || '');
        if (remembered) {
          const restored = await getAgentSession(remembered.id);
          if (!active) return;
          if (restored.postId !== post.id) { remember(post.id); throw new Error('This saved conversation belongs to another post. Start a new conversation.'); }
          setSession(restored); setModeId(restored.modeId);
        }
      } catch (cause) { if (active) setError(messageFor(cause)); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [post.id, loadAttempt]);
  useEffect(() => { let active = true; setFingerprint(''); void contextFingerprint(context).then(value => { if (active) setFingerprint(value); }).catch(cause => { if (active) setError(messageFor(cause)); }); return () => { active = false; }; }, [context]);
  useEffect(() => { setInputs(Object.fromEntries((workflow?.inputs || []).map(input => [input.name, input.default || '']))); }, [workflow?.id, activeSession?.id]);
  useEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: 'smooth' }); }, [activeSession?.messages.length]);
  async function begin() {
    if (locked || requestBusy.current || !settings?.config.enabled || !modeId || selectedIds.length > 8 || (selectedIds.length > 0 && !post.updatedAt)) return;
    requestBusy.current = true; setWorking(true); setError(''); setNotice('');
    const postId = post.id;
    try {
      const created = await createAgentSession(newId(), postId, modeId, context);
      if (!alive.current || currentPost.current !== postId) return;
      if (created.postId !== postId) throw new Error('The conversation did not match this post. No result was applied.');
      setSession(created); setRecovery('none'); pendingTurn.current = null;
      remember(postId, { id: created.id, mediaIds: selectedIds });
    } catch (cause) { if (alive.current && currentPost.current === postId) setError(messageFor(cause)); }
    finally { requestBusy.current = false; if (alive.current) setWorking(false); }
  }
  async function submitTurn(turn: AgentTurn) {
    if (!activeSession || requestBusy.current || busy) return;
    const postId = post.id, conversationId = activeSession.id;
    pendingTurn.current = turn; requestBusy.current = true; setWorking(true); setError(''); setNotice('');
    try {
      const updated = await sendAgentTurn(conversationId, turn);
      if (!alive.current || currentPost.current !== postId) return;
      if (updated.id !== conversationId || updated.postId !== postId) throw new Error('The response did not match this conversation. No result was applied.');
      setSession(updated); setRecovery('none'); pendingTurn.current = null;
      if (turn.action === 'message') setMessage('');
    } catch (cause) { if (alive.current && currentPost.current === postId) { setError(messageFor(cause)); setRecovery('check'); } }
    finally { requestBusy.current = false; if (alive.current) setWorking(false); }
  }
  async function refreshConversation() {
    if (!activeSession || requestBusy.current || busy) return;
    const postId = post.id, conversationId = activeSession.id;
    requestBusy.current = true; setWorking(true); setError('');
    try {
      const updated = await getAgentSession(conversationId);
      if (!alive.current || currentPost.current !== postId) return;
      if (updated.postId !== postId || updated.id !== conversationId) throw new Error('The conversation did not match this post.');
      setSession(updated);
      const pending = pendingTurn.current;
      if (pending && updated.revision === pending.revision && !['uncertain', 'running', 'failed'].includes(updated.status)) setRecovery('retry');
      else { if (pending?.action === 'message' && updated.revision > pending.revision) setMessage(''); pendingTurn.current = null; setRecovery('none'); }
      setNotice('Conversation status refreshed. No model was called.');
    } catch (cause) { if (alive.current && currentPost.current === postId) setError(messageFor(cause)); }
    finally { requestBusy.current = false; if (alive.current) setWorking(false); }
  }
  async function removeConversation() {
    if (!activeSession || locked || !await confirm('Delete this conversation and its analysis results? Your post and uploaded files will remain available.')) return;
    const postId = post.id, conversationId = activeSession.id;
    requestBusy.current = true; setWorking(true); setError('');
    try {
      await deleteAgentSession(conversationId);
      if (!alive.current || currentPost.current !== postId) return;
      remember(postId); setSession(null); setRecovery('none'); pendingTurn.current = null; setMessage(''); setNotice('Conversation deleted. Your post was not changed.');
    } catch (cause) { if (alive.current && currentPost.current === postId) setError(messageFor(cause)); }
    finally { requestBusy.current = false; if (alive.current) setWorking(false); }
  }
  async function startAgain() {
    if (!activeSession || locked || requestBusy.current || !await confirm('Delete this conversation and its analysis results so you can begin a new one? Your post and uploaded files will be preserved. You will review the current draft and selected files before starting again.')) return;
    const postId = post.id, conversationId = activeSession.id;
    requestBusy.current = true; setWorking(true); setError(''); setNotice('');
    try {
      await deleteAgentSession(conversationId);
      if (!alive.current || currentPost.current !== postId) return;
      remember(postId); setSession(null); setRecovery('none'); pendingTurn.current = null; setMessage(''); setNotice('Previous conversation deleted. Your post and files were preserved. Review the current draft and files, then begin a new conversation.');
    } catch (cause) { if (alive.current && currentPost.current === postId) setError(messageFor(cause)); }
    finally { requestBusy.current = false; if (alive.current) setWorking(false); }
  }
  async function applySuggestion() {
    if (!activeSession?.suggestion || !hasAgentEdits(activeSession.suggestion) || executionLocked || requestBusy.current) return;
    const postId = post.id;
    requestBusy.current = true; setWorking(true); setError(''); setNotice('');
    try {
      const checked = await contextFingerprint(latestContext.current);
      if (currentPost.current !== postId || checked !== activeSession.contextFingerprint) throw new Error('The draft changed. Start a new conversation to review the current version.');
      if (!await confirm('Apply these reviewed suggestions to your draft? You can edit them before saving or publishing.')) return;
      const confirmed = await contextFingerprint(latestContext.current);
      if (currentPost.current !== postId || confirmed !== activeSession.contextFingerprint) throw new Error('The draft changed while you reviewed these suggestions. No changes were applied.');
      onApply(activeSession.suggestion);
      if (alive.current) setNotice('Suggestions applied to the draft. Review, save, and publish when you are ready.');
    } catch (cause) { if (alive.current) setError(messageFor(cause)); }
    finally { requestBusy.current = false; if (alive.current) setWorking(false); }
  }
  return <aside ref={panel} tabIndex={-1} className="agent-workspace" aria-labelledby={headingId} aria-busy={working || loading}>
    <header className="agent-panel-heading"><div><span className="eyebrow">A LITTLE HELP WITH YOUR STORY</span><h2 id={headingId}>Game Studio companion <span aria-hidden="true">✦</span></h2></div><button type="button" className="agent-icon-button" onClick={onClose} disabled={working} aria-label="Close Game Studio companion">×</button></header>
    <div className="agent-panel-scroll">
      <p className="agent-intro">Talk through an idea, review your media, and choose what belongs in your story. You stay the editor.</p>
      {canConfigure && <button type="button" className="text-button agent-configure" disabled={locked} onClick={() => setAdminOpen(true)}>Configure modes, agents & workflows →</button>}
      {loading && <p role="status">Opening your Game Studio tools…</p>}
      {error && <div className="agent-alert" role="alert">{error}</div>}
      {!loading && !settings && <button type="button" className="button secondary" disabled={busy} onClick={() => setLoadAttempt(value => value + 1)}>Try loading companion settings again</button>}
      {notice && <p className="agent-notice" role="status">{notice}</p>}
      {settings && <>
        <div className={`agent-service-state ${settings.config.enabled ? '' : 'is-disabled'}`}><strong>{settings.config.enabled ? 'Companion available' : 'Companion is switched off'}</strong><span>{!isCore ? 'Local preview uses rules and file metadata. It never calls paid AI or media services.' : settings.config.allowPaidExecution ? 'Your administrator has authorized configured AWS models for the modes assigned to your account. Sending a message or advancing a workflow may use them.' : 'Your administrator has not enabled paid models. Local tools use rules and file metadata.'}</span></div>
        {!activeSession ? <>
          <label className="agent-field">Choose a mode<select value={modeId} disabled={locked} onChange={event => setModeId(event.target.value)}><option value="">Select a mode</option>{enabledModes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          {mode && <div className="agent-mode-note"><strong>{mode.name}</strong><p>{mode.description}</p>{mode.welcome && <p>{mode.welcome}</p>}</div>}
          <section className="agent-context" aria-label="Review shared context"><h3>What the companion will receive</h3><p>Your current draft’s title, introduction, category, text, and captions. File contents are shared only for the images and videos you select below.</p><dl><dt>Title</dt><dd>{post.title || 'Untitled story'}</dd><dt>Introduction</dt><dd>{post.excerpt || 'No introduction yet'}</dd><dt>Category</dt><dd>{post.category}</dd></dl>
            <fieldset className="agent-media-picker" disabled={locked}><legend>Choose files to include <span>({selectedIds.length} of 8 selected)</span></legend>{media.length ? media.map(block => <label key={block.id}><input type="checkbox" checked={selectedIds.includes(block.id)} disabled={!selectedIds.includes(block.id) && selectedIds.length >= 8} onChange={event => setMediaIds(ids => event.target.checked ? [...ids.filter(id => media.some(item => item.id === id)), block.id].slice(0, 8) : ids.filter(id => id !== block.id))}/><span><strong>{block.name || `Untitled ${block.type}`}</strong><small>{block.type === 'image' ? 'Image' : 'Video'}{block.caption ? ` · ${block.caption}` : ' · No caption yet'}</small></span></label>) : <p>Add an image or video to your draft to include it here.</p>}</fieldset>
            <details><summary>Review draft text and captions</summary><div className="agent-context-text">{blocks.map((block, index) => <p key={block.id}><strong>{index + 1}. {block.type}</strong><br/>{blockText(block) || 'No text yet'}{block.alt && <><br/>Image description: {block.alt}</>}</p>)}</div></details>
          </section>
          <p className="agent-fine-print">After adding files, save your draft before selecting media for the companion. You can include up to eight images or videos.</p>{selectedIds.length > 0 && !post.updatedAt && <p className="agent-notice" role="status">Save this draft before beginning a conversation with selected files.</p>}<button type="button" className="button primary agent-full-button" disabled={locked || !modeId || !settings.config.enabled || !fingerprint || selectedIds.length > 8 || (selectedIds.length > 0 && !post.updatedAt)} onClick={() => void begin()}>{working ? 'Opening conversation…' : 'Begin conversation →'}</button><p className="agent-fine-print">Beginning a conversation saves this reviewed snapshot. Sending a message or starting a workflow is a separate action.</p>
        </> : <>
          <div className="agent-session-heading"><div><span className="eyebrow">YOUR CONVERSATION</span><h3>{activeSession.modeName}</h3></div><span className={`agent-status status-${activeSession.status}`}>{activeSession.status}</span></div>
          {!fresh && <div className="agent-alert" role="status">Your draft or selected files changed after this conversation began. Start a new conversation to work with the current version. Suggestions from the older version cannot be applied.</div>}
          <details className="agent-snapshot"><summary>Included files · {selectedIds.length}</summary>{selectedIds.length ? media.filter(block => selectedIds.includes(block.id)).map(block => <p key={block.id}>{block.name || block.type}{block.caption ? ` — ${block.caption}` : ''}</p>) : <p>No image or video files were selected.</p>}</details>
          <div ref={transcript} className="agent-transcript" role="log" aria-label="Conversation" aria-live="polite">{activeSession.messages.length ? activeSession.messages.map(item => <div key={item.id} className={`agent-message agent-message-${item.role}`}><strong>{item.role === 'user' ? 'You' : 'Game Studio companion'}</strong><p>{item.text}</p></div>) : <p className="agent-empty">Your conversation is ready. Ask a question or start the configured workflow below.</p>}</div>
          {activeSession.error && <div className="agent-alert" role="alert">{activeSession.error}</div>}
          {['uncertain', 'running'].includes(activeSession.status) && <div className="agent-alert">{activeSession.status === 'uncertain' ? 'The last execution could not be confirmed. New model calls are locked to avoid repeating a paid request. Check its status or contact your administrator.' : 'An execution is still in progress. Check its status before taking another action.'}</div>}
          {recovery !== 'none' && <div className="agent-recovery"><strong>Check before continuing</strong><p>The last request was not confirmed in this browser. Your message has been kept. Check the conversation status before trying it again.</p><button type="button" className="button secondary" disabled={locked} onClick={() => void refreshConversation()}>Check conversation status</button>{recovery === 'retry' && pendingTurn.current && <><p>The saved conversation has not advanced. You can explicitly retry the same request; its original request ID will be reused.</p><button type="button" className="button secondary" disabled={locked || !fresh} onClick={() => { if (pendingTurn.current) void submitTurn(pendingTurn.current); }}>Retry same request</button></>}</div>}
          <form className="agent-composer" onSubmit={event => { event.preventDefault(); if (!executionLocked && message.trim()) void submitTurn({ requestId: newId(), revision: activeSession.revision, action: 'message', message: message.trim() }); }}><label htmlFor={`${headingId}-message`}>What would you like help with?</label><textarea id={`${headingId}-message`} rows={3} value={message} maxLength={settings.config.limits.maxInputChars} disabled={locked} placeholder="Help me describe this axolotl…" onChange={event => setMessage(event.target.value)}/><div><small>{message.length}/{settings.config.limits.maxInputChars}</small><button className="button primary" type="submit" disabled={executionLocked || !message.trim()}>{working ? 'Working…' : 'Send message →'}</button></div></form>
          {(workflow || activeSession.steps.length > 0) && <section className="agent-workflow-run"><span className="eyebrow">STEP BY STEP</span><h3>{workflow?.name || 'Conversation workflow'}</h3><p>{workflow?.description || 'Continue the workflow saved with this conversation.'}</p>{workflow && !activeSession.steps.length && <>{workflow.inputs.map(input => <label className="agent-field" key={input.name}>{input.label}{input.required ? ' *' : ''}<input maxLength={2000} value={inputs[input.name] || ''} required={input.required} disabled={executionLocked} onChange={event => setInputs(values => ({ ...values, [input.name]: event.target.value }))}/></label>)}<button type="button" className="button secondary" disabled={executionLocked || workflow.inputs.some(input => input.required && !inputs[input.name]?.trim())} onClick={() => void submitTurn({ requestId: newId(), revision: activeSession.revision, action: 'workflow', inputs })}>Start workflow →</button></>}
            {activeSession.steps.length > 0 && <ol className="agent-steps">{activeSession.steps.map(step => <li key={step.nodeId} className={`agent-step step-${step.status}`}><div><strong>{step.name}</strong><span>{step.status}</span></div>{step.output !== undefined && <details open={step.status === 'complete'}><summary>Review result</summary><PlainResult value={step.output}/></details>}</li>)}</ol>}
            {stepsPending && <><p className="agent-fine-print">{activeSession.status === 'waiting' ? 'Video analysis is waiting for AWS. Continue checks its progress once; the browser does not poll automatically.' : 'Review the results above, then continue to the next step.'}</p><button type="button" className="button secondary" disabled={executionLocked} onClick={() => void submitTurn({ requestId: newId(), revision: activeSession.revision, action: 'advance' })}>{activeSession.status === 'waiting' ? 'Check video progress once' : 'Continue to next step →'}</button></>}
          </section>}
          {activeSession.suggestion && <section className="agent-review"><span className="eyebrow">YOUR EDITORIAL DECISION</span><h3>Review suggested changes</h3><SuggestionPreview suggestion={activeSession.suggestion}/>{hasAgentEdits(activeSession.suggestion) ? <><button type="button" className="button primary" disabled={executionLocked} onClick={() => void applySuggestion()}>Apply suggestions to draft</button><p className="agent-fine-print">Applying changes updates your draft. Review it before saving or publishing.</p></> : <p className="agent-fine-print">This result offers guidance. It contains no draft changes to apply.</p>}</section>}
          <div className="agent-usage" aria-label="Recorded usage"><span>{activeSession.usage.modelCalls} model calls</span><span>{activeSession.usage.inputTokens} input tokens</span><span>{activeSession.usage.outputTokens} output tokens</span></div>
          <div className="agent-session-actions"><button type="button" className="text-button" disabled={locked} onClick={() => void refreshConversation()}>Refresh status</button><button type="button" className="text-button" disabled={locked} onClick={() => void startAgain()}>New conversation</button><button type="button" className="text-button danger" disabled={locked} onClick={() => void removeConversation()}>Delete conversation</button></div>
        </>}
      </>}
    </div>
    {adminOpen && canConfigure && <AgentAdministration onClose={() => { setAdminOpen(false); void getAgentSettings().then(setSettings).catch(cause => setError(messageFor(cause))); }}/>}
  </aside>;
}

type AdminTab = 'overview' | 'modes' | 'agents' | 'models' | 'workflows';
function ModeAudience({ mode, accounts, notice, onChange }: { mode: AgentMode; accounts: NewsroomAccount[]; notice: string; onChange: (value: NonNullable<AgentMode['audience']>) => void }) {
  const audience = mode.audience || { allEditors: true, userIds: [] };
  const missing = audience.userIds.filter(id => !accounts.some(account => account.id === id));
  const [accountId, setAccountId] = useState(''), [error, setError] = useState('');
  useEffect(() => { setAccountId(''); setError(''); }, [mode.id]);
  function addAccount() {
    const id = accountId.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) { setError('Enter the account’s Core user ID in UUID format.'); return; }
    if (audience.userIds.length >= 100 && !audience.userIds.includes(id)) { setError('A mode can be assigned to at most 100 accounts.'); return; }
    onChange({ ...audience, userIds: [...new Set([...audience.userIds, id])] }); setAccountId(''); setError('');
  }
  return <fieldset><legend>Who can use this mode</legend><label className="agent-checkbox"><input type="checkbox" checked={audience.allEditors} onChange={event => onChange({ ...audience, allEditors: event.target.checked })}/> All Game Studio editors</label><p className="agent-fine-print">This grants access to the mode’s conversation agent and workflow. Account permissions still control Game Studio access.</p>{!audience.allEditors && <><p>Choose accounts:</p>{notice && <><p role="status" className="agent-fine-print">{notice}</p><label className="agent-field">Add a Core account ID<input value={accountId} maxLength={36} onChange={event => setAccountId(event.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/></label><button type="button" className="button secondary" onClick={addAccount}>Add account to this mode</button><p className="agent-fine-print">Paste the user ID from Core. The account must also have Game Studio access to run this mode.</p>{error && <p role="alert" className="agent-alert">{error}</p>}</>}{accounts.map(account => <label className="agent-checkbox" key={account.id}><input type="checkbox" disabled={!audience.userIds.includes(account.id) && audience.userIds.length >= 100} checked={audience.userIds.includes(account.id)} onChange={event => onChange({ ...audience, userIds: event.target.checked ? [...audience.userIds, account.id] : audience.userIds.filter(id => id !== account.id) })}/><span>{account.name || account.email}{account.name && account.email ? ` · ${account.email}` : ''}{account.status !== 'active' ? ` (${account.status})` : ''}</span></label>)}{missing.map(id => <label className="agent-checkbox" key={id}><input type="checkbox" checked onChange={() => onChange({ ...audience, userIds: audience.userIds.filter(subject => subject !== id) })}/><span>Selected account · {id}</span></label>)}{!accounts.length && !notice && <p className="agent-fine-print">Create a Game Studio account in Accounts, then reload these settings to assign it.</p>}{!audience.userIds.length && <p className="agent-fine-print">No accounts are selected. This mode will be unavailable until you assign an account.</p>}</>}</fieldset>;
}
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
function workflowGraph(value: unknown): WorkflowGraph {
  const graph = value as WorkflowGraph;
  if (!graph || graph.version !== 1 || !Array.isArray(graph.inputs) || !Array.isArray(graph.nodes) || !Array.isArray(graph.outputs)) throw new Error('A graph needs version 1 and inputs, nodes, and outputs arrays.');
  if (graph.inputs.some(input => !input || typeof input.name !== 'string' || typeof input.label !== 'string' || input.type !== 'string' || typeof input.required !== 'boolean')) throw new Error('Every input needs a name, label, string type, and required flag.');
  if (graph.nodes.some(node => !node || typeof node.id !== 'string' || typeof node.name !== 'string' || typeof node.skill !== 'string' || typeof node.agent_id !== 'string' || !Array.isArray(node.depends_on) || node.depends_on.some(id => typeof id !== 'string') || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs))) throw new Error('Every node needs an ID, name, skill, agent_id, depends_on array, and inputs object.');
  if (graph.outputs.some(output => !output || typeof output.name !== 'string' || typeof output.node_id !== 'string')) throw new Error('Every output needs a name and node_id.');
  return graph;
}

export function AgentAdministration({ onClose }: { onClose: () => void }) {
  const headingId = useId(), confirm = useConfirm(), panel = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<AgentSettings | null>(null), [draft, setDraft] = useState<AgentConfig | null>(null), [tab, setTab] = useState<AdminTab>('overview');
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<NewsroomAccount[]>([]), [accountNotice, setAccountNotice] = useState('');
  const alive = useRef(true);
  const dirty = Boolean(draft && settings && (JSON.stringify(draft) !== JSON.stringify(settings.config) || Object.keys(jsonDrafts).length));
  useEffect(() => { alive.current = true; const opener = document.activeElement as HTMLElement | null; panel.current?.focus(); void reload(false); return () => { alive.current = false; if (opener?.isConnected) opener.focus(); }; }, []);
  useEffect(() => { if (!dirty) return; const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload); }, [dirty]);
  async function reload(ask = true) {
    if (saving || (ask && dirty && !await confirm('Discard your unsaved companion configuration and load the current saved settings?'))) return;
    setLoading(true); setError(''); setNotice('');
    try {
      const [loaded, directory] = await Promise.allSettled([getAgentSettings(), getAccounts()]);
      if (loaded.status === 'rejected') throw loaded.reason;
      if (alive.current) {
        setSettings(loaded.value); setDraft(structuredClone(loaded.value.config)); setJsonDrafts({});
        setAccounts(directory.status === 'fulfilled' ? directory.value.accounts : []);
        setAccountNotice(directory.status === 'rejected' ? 'The account list could not be loaded. Reload settings with account-management access to choose accounts. Existing selections are preserved.' : '');
      }
    }
    catch (cause) { if (alive.current) setError(messageFor(cause)); }
    finally { if (alive.current) setLoading(false); }
  }
  async function close() { if (!saving && (!dirty || await confirm('Close without saving your companion configuration changes?'))) onClose(); }
  async function save() {
    if (!draft || !settings || saving) return;
    if (Object.keys(jsonDrafts).length) { setError('Apply or discard the pending JSON edits before saving.'); return; }
    setSaving(true); setError(''); setNotice('');
    try { const clean = validateAgentConfig(draft); const saved = await saveAgentSettings(clean, settings.config.revision); if (alive.current) { setSettings(saved); setDraft(structuredClone(saved.config)); setNotice('Companion settings saved. New conversations use this configuration.'); } }
    catch (cause) { if (alive.current) setError(`${messageFor(cause)} Your edits are still here. If another administrator changed the settings, reload before saving again.`); }
    finally { if (alive.current) setSaving(false); }
  }
  function patch(patchValue: Partial<AgentConfig>) { setDraft(value => value ? { ...value, ...patchValue } : value); setNotice(''); }
  function patchMode(id: string, value: Partial<AgentMode>) { if (draft) patch({ modes: draft.modes.map(item => item.id === id ? { ...item, ...value } : item) }); }
  function patchAgent(id: string, value: Partial<AgentDefinition>) { if (draft) patch({ agents: draft.agents.map(item => item.id === id ? { ...item, ...value } : item) }); }
  function patchModel(id: string, value: Partial<AgentModel>) { if (draft) patch({ models: draft.models.map(item => item.id === id ? { ...item, ...value } : item) }); }
  function patchWorkflow(id: string, value: Partial<AgentWorkflow>) { if (draft) patch({ workflows: draft.workflows.map(item => item.id === id ? { ...item, ...value } : item) }); }
  function patchNode(workflow: AgentWorkflow, id: string, value: Partial<WorkflowNode>) { patchWorkflow(workflow.id, { graph: { ...workflow.graph, nodes: workflow.graph.nodes.map(item => item.id === id ? { ...item, ...value } : item) } }); }
  function moveNode(workflow: AgentWorkflow, index: number, delta: number) { const nodes = [...workflow.graph.nodes], next = index + delta; if (next < 0 || next >= nodes.length) return; [nodes[index], nodes[next]] = [nodes[next], nodes[index]]; patchWorkflow(workflow.id, { graph: { ...workflow.graph, nodes } }); }
  function removeNode(workflow: AgentWorkflow, id: string) {
    patchWorkflow(workflow.id, { graph: { ...workflow.graph, nodes: workflow.graph.nodes.filter(node => node.id !== id).map(node => ({ ...node, depends_on: node.depends_on.filter(dependency => dependency !== id) })), outputs: workflow.graph.outputs.filter(output => output.node_id !== id) } });
    setJsonDrafts(values => { const next = { ...values }; delete next[`node:${workflow.id}:${id}`]; return next; });
  }
  function add(kind: Exclude<AdminTab, 'overview'>) {
    if (!draft) return;
    if (kind === 'modes' && draft.modes.length < 24) { const id = uid('mode'); patch({ modes: [...draft.modes, { id, name: 'New mode', description: '', welcome: '', agentId: draft.agents[0]?.id || '', workflowId: draft.workflows[0]?.id || '', enabled: false, audience: { allEditors: false, userIds: [] } }] }); setSelected(value => ({ ...value, modes: id })); }
    if (kind === 'agents' && draft.agents.length < 24) { const id = uid('agent'); patch({ agents: [...draft.agents, { id, name: 'New agent', description: '', instructions: 'Help the editor review their post. Explain uncertainty and never publish automatically.', modelId: draft.models[0]?.id || '', enabled: false }] }); setSelected(value => ({ ...value, agents: id })); }
    if (kind === 'models' && draft.models.length < 24) { const id = uid('model'); patch({ models: [...draft.models, { id, name: 'New model', kind: 'local', provider: 'local', target: 'media-coach-v1', enabled: false, maxOutputTokens: 1024 }] }); setSelected(value => ({ ...value, models: id })); }
    if (kind === 'workflows' && draft.workflows.length < 24) { const id = uid('workflow'); patch({ workflows: [...draft.workflows, { id, name: 'New workflow', description: '', enabled: false, graph: { version: 1, inputs: [], nodes: [], outputs: [] } }] }); setSelected(value => ({ ...value, workflows: id })); }
  }
  function jsonField(key: string, value: unknown, label: string, apply: (value: unknown) => void) {
    const source = JSON.stringify(value, null, 2), pending = jsonDrafts[key] !== undefined;
    return <div className="agent-json-field"><label>{label}<textarea spellCheck={false} maxLength={key.startsWith('node:') ? 4000 : 48000} rows={Math.min(16, Math.max(5, source.split('\n').length))} value={jsonDrafts[key] ?? source} disabled={saving} onChange={event => setJsonDrafts(values => ({ ...values, [key]: event.target.value }))}/></label>{pending && <div><button type="button" className="button secondary" disabled={saving} onClick={() => { try { apply(JSON.parse(jsonDrafts[key])); setJsonDrafts(values => { const next = { ...values }; delete next[key]; return next; }); setError(''); } catch (cause) { setError(messageFor(cause)); } }}>Apply JSON to draft</button><button type="button" className="text-button" disabled={saving} onClick={() => setJsonDrafts(values => { const next = { ...values }; delete next[key]; return next; })}>Discard JSON edits</button></div>}</div>;
  }
  const mode = draft?.modes.find(item => item.id === selected.modes) || draft?.modes[0];
  const agent = draft?.agents.find(item => item.id === selected.agents) || draft?.agents[0];
  const model = draft?.models.find(item => item.id === selected.models) || draft?.models[0];
  const workflow = draft?.workflows.find(item => item.id === selected.workflows) || draft?.workflows[0];
  const collection = tab === 'overview' ? [] : draft?.[tab] || [];
  return <div className="agent-admin-backdrop"><div className="agent-admin-panel" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={headingId} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); void close(); } if (event.key === 'Tab') { const elements = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') || [])].filter(element => element.getClientRects().length > 0); if (!elements?.length) return; const first = elements[0], last = elements[elements.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } }}>
    <header className="agent-panel-heading"><div><span className="eyebrow">NEWSROOM SETTINGS</span><h2 id={headingId}>Companion workshop <span aria-hidden="true">✦</span></h2><p>Build the modes, agents, models, and workflows your editors can use.</p></div><button type="button" className="agent-icon-button" disabled={saving} onClick={() => void close()} aria-label="Close companion settings">×</button></header>
    {error && <div className="agent-alert" role="alert">{error}</div>}{notice && <p className="agent-notice" role="status">{notice}</p>}
    {loading ? <p role="status">Loading companion settings…</p> : draft && settings ? <>
      <nav className="agent-admin-tabs" aria-label="Companion configuration">{(['overview', 'modes', 'agents', 'models', 'workflows'] as const).map(item => <button key={item} type="button" disabled={saving} className={tab === item ? 'selected' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{item === 'overview' ? 'Controls' : item[0].toUpperCase() + item.slice(1)}{item !== 'overview' && <span>{draft[item].length}</span>}</button>)}</nav>
      <div className="agent-admin-body"><fieldset disabled={saving} className="agent-admin-fields">
        {tab === 'overview' ? <div className="agent-controls"><h3>Keep the editor in control</h3><label className="agent-switch"><input type="checkbox" checked={draft.enabled} onChange={event => patch({ enabled: event.target.checked })}/><span><strong>Enable the Game Studio companion</strong><small>Editors can start conversations and workflows when enabled.</small></span></label><label className="agent-switch"><input type="checkbox" checked={draft.allowPaidExecution} onChange={event => patch({ allowPaidExecution: event.target.checked })}/><span><strong>Allow configured paid models</strong><small>Saving this authorizes enabled AWS models for assigned users. Calls may incur provider charges when a user sends a message or advances a workflow.</small></span></label><div className={`agent-service-state ${settings.config.allowPaidExecution ? '' : 'is-disabled'}`}><strong>Saved model authorization: {settings.config.allowPaidExecution ? 'Enabled' : 'Disabled'}</strong><span>{!isCore ? 'Local preview never calls paid services, even when this configuration is enabled.' : settings.config.allowPaidExecution ? 'Assigned users may run enabled models through their modes and workflows. Disabling this setting stops further paid operations in existing conversations.' : 'Save the authorization above to allow paid operations. Saving settings itself makes no model call.'}</span></div><p>Local tools inspect text, captions, and file metadata using deterministic rules. They do not recognize what is pictured or transcribe a video.</p><h3>Crossword word generator</h3><p>Add a small Nova Micro model, word assistant, workflow and mode to this configuration. The mode starts disabled with no assigned users. Review its audience, model target, output limit and saved paid-model authorization before enabling it. Saving the preset makes no model call.</p><button type="button" className="button secondary" disabled={saving || draft.models.some(item => item.id === crosswordPresetIds.model)} onClick={() => { try { const next = addCrosswordAgentPreset(draft); setDraft(next); setTab('modes'); setSelected(value => ({ ...value, modes: crosswordPresetIds.mode })); setNotice('Crossword preset added to your unsaved configuration. Enable its mode and choose its audience before saving.'); setError(''); } catch (cause) { setError(messageFor(cause)); } }}>Add inexpensive crossword preset</button><h3>Word search word generator</h3><p>Add a word search assistant, workflow and mode using Nova Micro. An existing Nova Micro model is reused with its settings preserved. The new mode starts disabled with no assigned users; review and authorize its audience before saving.</p><button type="button" className="button secondary" disabled={saving || draft.modes.some(item => item.id === wordSearchPresetIds.mode)} onClick={() => { try { const next = addWordSearchAgentPreset(draft); setDraft(next); setTab('modes'); setSelected(value => ({ ...value, modes: wordSearchPresetIds.mode })); setNotice('Word search preset added to your unsaved configuration. Enable its mode and choose its audience before saving.'); setError(''); } catch (cause) { setError(messageFor(cause)); } }}>Add inexpensive word search preset</button><h3>Per-conversation limits</h3><div className="agent-form-grid">{([{ key: 'maxTurns', label: 'Maximum turns' }, { key: 'maxSteps', label: 'Maximum workflow steps' }, { key: 'maxInputChars', label: 'Maximum input characters' }, { key: 'maxModelCalls', label: 'Maximum model calls' }] as const).map(item => <label className="agent-field" key={item.key}>{item.label}<input type="number" min={item.key === 'maxModelCalls' ? 0 : item.key === 'maxInputChars' ? 100 : 1} max={item.key === 'maxModelCalls' ? 12 : item.key === 'maxInputChars' ? 12000 : 40} step={1} value={draft.limits[item.key]} onChange={event => patch({ limits: { ...draft.limits, [item.key]: Number(event.target.value) } })}/></label>)}</div><p className="agent-fine-print">Saved revision {settings.config.revision}. Conversations retain reviewed context and definitions. Current account access, model authorization, and disable controls apply before each operation.</p></div> : <div className="agent-admin-collection"><div className="agent-collection-list"><button type="button" className="button secondary" disabled={saving || collection.length >= 24} onClick={() => add(tab)}>＋ Add {tab === 'modes' ? 'mode' : tab === 'agents' ? 'agent' : tab === 'models' ? 'model' : 'workflow'}</button>{collection.map(item => <button type="button" key={item.id} className={(collection.some(row => row.id === selected[tab]) ? selected[tab] : collection[0]?.id) === item.id ? 'selected' : ''} onClick={() => setSelected(values => ({ ...values, [tab]: item.id }))}><strong>{item.name}</strong><small>{item.enabled ? 'Enabled' : 'Disabled'}</small></button>)}</div><div className="agent-collection-editor">
          {tab === 'modes' && mode && <><h3>Edit mode</h3><p>A mode is the editor’s entry point. It connects a conversational agent with a reusable workflow.</p><label className="agent-field">Name<input maxLength={100} value={mode.name} onChange={event => patchMode(mode.id, { name: event.target.value })}/></label><label className="agent-field">Description<textarea maxLength={500} value={mode.description} onChange={event => patchMode(mode.id, { description: event.target.value })}/></label><label className="agent-field">Welcome message<textarea maxLength={1000} value={mode.welcome} onChange={event => patchMode(mode.id, { welcome: event.target.value })}/></label><div className="agent-form-grid"><label className="agent-field">Conversation agent<select value={mode.agentId} onChange={event => patchMode(mode.id, { agentId: event.target.value })}><option value="">Select an agent</option>{draft.agents.map(item => <option key={item.id} value={item.id}>{item.name}{item.enabled ? '' : ' (disabled)'}</option>)}</select></label><label className="agent-field">Workflow<select value={mode.workflowId} onChange={event => patchMode(mode.id, { workflowId: event.target.value })}><option value="">Select a workflow</option>{draft.workflows.map(item => <option key={item.id} value={item.id}>{item.name}{item.enabled ? '' : ' (disabled)'}</option>)}</select></label></div><label className="agent-checkbox"><input type="checkbox" checked={mode.enabled} onChange={event => patchMode(mode.id, { enabled: event.target.checked })}/> Enable mode</label><ModeAudience mode={mode} accounts={accounts} notice={accountNotice} onChange={audience => patchMode(mode.id, { audience })}/><p className="agent-fine-print">ID: {mode.id}</p><button type="button" className="text-button danger" onClick={() => patch({ modes: draft.modes.filter(item => item.id !== mode.id) })}>Remove mode from configuration</button></>}
          {tab === 'agents' && agent && <><h3>Edit agent</h3><label className="agent-field">Name<input maxLength={100} value={agent.name} onChange={event => patchAgent(agent.id, { name: event.target.value })}/></label><label className="agent-field">Description<textarea maxLength={500} value={agent.description} onChange={event => patchAgent(agent.id, { description: event.target.value })}/></label><label className="agent-field">Instructions<textarea rows={8} maxLength={4000} value={agent.instructions} onChange={event => patchAgent(agent.id, { instructions: event.target.value })}/></label><label className="agent-field">Model<select value={agent.modelId} onChange={event => patchAgent(agent.id, { modelId: event.target.value })}><option value="">Select a model</option>{draft.models.map(item => <option key={item.id} value={item.id}>{item.name} · {item.kind}{item.enabled ? '' : ' (disabled)'}</option>)}</select></label><label className="agent-checkbox"><input type="checkbox" checked={agent.enabled} onChange={event => patchAgent(agent.id, { enabled: event.target.checked })}/> Enable agent</label><p className="agent-fine-print">ID: {agent.id}</p><button type="button" className="text-button danger" onClick={() => patch({ agents: draft.agents.filter(item => item.id !== agent.id) })}>Remove agent from configuration</button></>}
          {tab === 'models' && model && <><h3>Edit model</h3><label className="agent-field">Name<input maxLength={100} value={model.name} onChange={event => patchModel(model.id, { name: event.target.value })}/></label><label className="agent-field">Model approach<select value={`${model.provider}:${model.kind}`} onChange={event => { const [provider, kind] = event.target.value.split(':') as [AgentModel['provider'], AgentModel['kind']]; patchModel(model.id, { provider, kind, target: provider === 'local' ? 'media-coach-v1' : provider === 'rekognition' ? 'detect-labels' : '' }); }}><option value="local:local">Local rules and metadata · no model calls</option><option value="bedrock:generative">Amazon Bedrock · generative AI</option><option value="rekognition:ml">Amazon Rekognition · media ML</option></select></label>{model.provider === 'rekognition' ? <label className="agent-field">Media analysis target<select value={model.target} onChange={event => patchModel(model.id, { target: event.target.value })}><option value="detect-labels">Image labels</option><option value="video-labels">Video labels</option></select></label> : <label className="agent-field">{model.provider === 'local' ? 'Local implementation target' : 'Bedrock model ID or inference profile ARN'}<input maxLength={500} value={model.target} onChange={event => patchModel(model.id, { target: event.target.value })} spellCheck={false}/></label>}<label className="agent-field">Maximum output tokens<input type="number" min={64} max={2048} step={1} value={model.maxOutputTokens} onChange={event => patchModel(model.id, { maxOutputTokens: Number(event.target.value) })}/></label><label className="agent-checkbox"><input type="checkbox" checked={model.enabled} onChange={event => patchModel(model.id, { enabled: event.target.checked })}/> Enable model</label><p className="agent-fine-print">{model.provider === 'local' ? 'Local results come from deterministic rules and metadata; they are not AI recognition.' : 'Enable the model, choose it for an agent, and authorize paid models in Controls. Assigned users can run compatible workflow skills. Saving makes no provider call; AWS model availability and account access are checked when a user runs it.'}</p><p className="agent-fine-print">ID: {model.id}</p><button type="button" className="text-button danger" onClick={() => patch({ models: draft.models.filter(item => item.id !== model.id) })}>Remove model from configuration</button></>}
          {tab === 'workflows' && workflow && <><h3>Edit workflow</h3><label className="agent-field">Name<input maxLength={100} value={workflow.name} onChange={event => patchWorkflow(workflow.id, { name: event.target.value })}/></label><label className="agent-field">Description<textarea maxLength={500} value={workflow.description} onChange={event => patchWorkflow(workflow.id, { description: event.target.value })}/></label><label className="agent-checkbox"><input type="checkbox" checked={workflow.enabled} onChange={event => patchWorkflow(workflow.id, { enabled: event.target.checked })}/> Enable workflow</label><div className="agent-workflow-builder"><h4>Workflow inputs</h4>{workflow.graph.inputs.map((input, index) => <div className="agent-input-row" key={index}><label>Name<input maxLength={64} aria-label={`Input ${index + 1} name`} value={input.name} onChange={event => patchWorkflow(workflow.id, { graph: { ...workflow.graph, inputs: workflow.graph.inputs.map((item, i) => i === index ? { ...item, name: event.target.value } : item) } })}/></label><label>Label<input maxLength={100} aria-label={`Input ${index + 1} label`} value={input.label} onChange={event => patchWorkflow(workflow.id, { graph: { ...workflow.graph, inputs: workflow.graph.inputs.map((item, i) => i === index ? { ...item, label: event.target.value } : item) } })}/></label><label>Default<input maxLength={2000} aria-label={`Input ${index + 1} default`} value={input.default || ''} onChange={event => patchWorkflow(workflow.id, { graph: { ...workflow.graph, inputs: workflow.graph.inputs.map((item, i) => i === index ? { ...item, default: event.target.value } : item) } })}/></label><label className="agent-checkbox"><input type="checkbox" checked={input.required} onChange={event => patchWorkflow(workflow.id, { graph: { ...workflow.graph, inputs: workflow.graph.inputs.map((item, i) => i === index ? { ...item, required: event.target.checked } : item) } })}/> Required</label><button type="button" className="agent-icon-button" aria-label={`Remove input ${input.name}`} onClick={() => patchWorkflow(workflow.id, { graph: { ...workflow.graph, inputs: workflow.graph.inputs.filter((_, i) => i !== index) } })}>×</button></div>)}<button type="button" className="text-button" disabled={saving || workflow.graph.inputs.length >= 12} onClick={() => patchWorkflow(workflow.id, { graph: { ...workflow.graph, inputs: [...workflow.graph.inputs, { name: `input_${workflow.graph.inputs.length + 1}`, label: 'New input', type: 'string', required: false }] } })}>＋ Add workflow input</button><h4>Skill steps</h4><p className="agent-fine-print">Steps run in dependency order, one explicit continuation at a time.</p>{workflow.graph.nodes.map((node, index) => <section className="agent-node-card" key={node.id}><div className="agent-node-heading"><strong>Step {index + 1}</strong><div><button type="button" className="agent-icon-button" disabled={saving || index === 0} aria-label={`Move ${node.name} up`} onClick={() => moveNode(workflow, index, -1)}>↑</button><button type="button" className="agent-icon-button" disabled={saving || index === workflow.graph.nodes.length - 1} aria-label={`Move ${node.name} down`} onClick={() => moveNode(workflow, index, 1)}>↓</button><button type="button" className="agent-icon-button danger" aria-label={`Remove ${node.name}`} onClick={() => removeNode(workflow, node.id)}>×</button></div></div><label className="agent-field">Step name<input maxLength={100} value={node.name} onChange={event => patchNode(workflow, node.id, { name: event.target.value })}/></label><div className="agent-form-grid"><label className="agent-field">Skill<select value={node.skill} onChange={event => patchNode(workflow, node.id, { skill: event.target.value })}><option value="">Select a skill</option>{settings.skills.map(skill => <option key={skill.id} value={skill.id}>{skill.name}{skill.id === 'agent.respond' ? ' · configured agent' : skill.paid ? ' · AWS call' : ' · local'}</option>)}</select></label><label className="agent-field">Agent<select value={node.agent_id} onChange={event => patchNode(workflow, node.id, { agent_id: event.target.value })}><option value="">Select an agent</option>{draft.agents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div><fieldset className="agent-dependencies"><legend>Depends on</legend>{workflow.graph.nodes.filter(item => item.id !== node.id).map(item => <label className="agent-checkbox" key={item.id}><input type="checkbox" checked={node.depends_on.includes(item.id)} onChange={event => patchNode(workflow, node.id, { depends_on: event.target.checked ? [...node.depends_on, item.id] : node.depends_on.filter(id => id !== item.id) })}/>{item.name}</label>)}{workflow.graph.nodes.length < 2 && <p>No other steps yet.</p>}</fieldset>{jsonField(`node:${workflow.id}:${node.id}`, node.inputs, 'Step inputs (JSON)', value => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Step inputs must be a JSON object.'); patchNode(workflow, node.id, { inputs: value as Record<string, unknown> }); })}<small className="agent-code-id">Node ID: {node.id}</small></section>)}<button type="button" className="button secondary" disabled={saving || workflow.graph.nodes.length >= 12} onClick={() => { const previous = workflow.graph.nodes.at(-1); patchWorkflow(workflow.id, { graph: { ...workflow.graph, nodes: [...workflow.graph.nodes, { id: uid('step'), name: 'New step', skill: settings.skills[0]?.id || '', agent_id: draft.agents[0]?.id || '', depends_on: previous ? [previous.id] : [], inputs: {} }] } }); }}>＋ Add skill step</button><h4>Workflow outputs</h4>{workflow.graph.outputs.map((output, index) => <div className="agent-output-row" key={index}><label>Output name<input maxLength={64} value={output.name} onChange={event => patchWorkflow(workflow.id, { graph: { ...workflow.graph, outputs: workflow.graph.outputs.map((item, i) => i === index ? { ...item, name: event.target.value } : item) } })}/></label><label>Step<select value={output.node_id} onChange={event => patchWorkflow(workflow.id, { graph: { ...workflow.graph, outputs: workflow.graph.outputs.map((item, i) => i === index ? { ...item, node_id: event.target.value } : item) } })}><option value="">Select a step</option>{workflow.graph.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label><button type="button" className="agent-icon-button" aria-label={`Remove output ${output.name}`} onClick={() => patchWorkflow(workflow.id, { graph: { ...workflow.graph, outputs: workflow.graph.outputs.filter((_, i) => i !== index) } })}>×</button></div>)}<button type="button" className="text-button" disabled={saving || workflow.graph.outputs.length >= 12} onClick={() => patchWorkflow(workflow.id, { graph: { ...workflow.graph, outputs: [...workflow.graph.outputs, { name: `result_${workflow.graph.outputs.length + 1}`, node_id: workflow.graph.nodes.at(-1)?.id || '' }] } })}>＋ Add workflow output</button><details className="agent-binding-help"><summary>Bindings and advanced graph JSON</summary><p>Use Proposal Studio’s typed object bindings to pass reviewed context, workflow inputs, or an earlier step’s result.</p><pre>{'{ "media": { "$context": "media" },\n  "subject": { "$input": "subject" },\n  "labels": { "$node": "inventory", "path": "items" } }'}</pre>{jsonField(`graph:${workflow.id}`, workflow.graph, 'Complete workflow graph (JSON)', value => patchWorkflow(workflow.id, { graph: workflowGraph(value) }))}</details></div><p className="agent-fine-print">ID: {workflow.id}</p><button type="button" className="text-button danger" onClick={() => { patch({ workflows: draft.workflows.filter(item => item.id !== workflow.id) }); setJsonDrafts(values => Object.fromEntries(Object.entries(values).filter(([key]) => !key.includes(workflow.id)))); }}>Remove workflow from configuration</button></>}
          {!collection.length && <p className="agent-empty">Add your first {tab === 'modes' ? 'mode' : tab === 'agents' ? 'agent' : tab === 'models' ? 'model' : 'workflow'} to begin.</p>}
        </div></div>}
      </fieldset></div>
      <footer className="agent-admin-footer"><span role="status">{saving ? 'Saving settings…' : dirty ? 'Unsaved changes' : `Saved · revision ${settings.config.revision}`}</span><div><button type="button" className="button secondary" disabled={saving} onClick={() => void reload()}>Reload saved settings</button><button type="button" className="button primary" disabled={saving || !dirty} onClick={() => void save()}>Save configuration</button></div></footer>
    </> : <button type="button" className="button secondary" onClick={() => void reload(false)}>Try loading settings again</button>}
  </div></div>;
}
