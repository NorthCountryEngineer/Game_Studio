import { useCallback, useEffect, useRef, useState } from 'react';
import { GameStudio } from './components/GameStudio';
import { Games, GamePage, type PublishedGameEvent } from './components/Games';
import { AgentAdministration } from './components/AgentWorkspace';
import { AccountAdministration } from './components/AccountAdministration';
import { IntegrationSettings } from './components/IntegrationSettings';
import { useConfirm } from './components/Confirm';
import { BrandingProvider, defaultIntegrationConfig, parseIntegrationConfig, type IntegrationConfig, type ServiceBranding } from './lib/branding';
import { beginCoreLogin, completeCoreLogin, coreConfig, coreLogout, corePlayerSession, coreRequest, isCore, recoverExpiredCoreSession } from './lib/core';
import { parseGameStudioEvent } from './lib/integration';
import { requestMultiHostMaterial } from './lib/multi-game-integration';
import { requestHostMaterial } from './lib/game-flow-integration';
import { hostLoginCandidate, hostLoginLaunch } from './lib/host-login';
import './games.css';
import './service.css';
import './service-app.css';
import './app-admin.css';

type Session = { canCreateGames: boolean; canPublishGames: boolean; canManageGames: boolean; canManageAccounts: boolean; canConfigureAgents: boolean };
const noSession: Session = { canCreateGames:false,canPublishGames:false,canManageGames:false,canManageAccounts:false,canConfigureAgents:false };
const previewSession: Session = { canCreateGames:true,canPublishGames:true,canManageGames:true,canManageAccounts:true,canConfigureAgents:true };
const readPath = () => location.pathname + location.search;
const inFrame = () => window.self !== window.top;
const message = (error:unknown) => error instanceof Error ? error.message : 'Game Studio could not complete the request.';
const configuredPreview = Object.values(import.meta.glob('../game-studio-config.json',{eager:true,import:'default'}))[0];
function initialConfig() {
  const base=configuredPreview?parseIntegrationConfig(configuredPreview):defaultIntegrationConfig;
  try {const stored=parseIntegrationConfig(JSON.parse(localStorage.getItem('game-studio-branding:v1')||'null'));return {...base,branding:stored.branding,revision:stored.revision};}catch{return base;}
}

function EmbeddedGame({id,config}:{id:string;config:IntegrationConfig}) {
  const query = new URLSearchParams(location.search), selected = config.hosts.find(host => host.id === query.get('host'));
  const channel = query.get('channel') || '';
  let parentOrigin = '';
  try { parentOrigin = new URL(document.referrer).origin; } catch { /* No referring parent means no trusted messaging channel. */ }
  const allowed = Boolean(selected && inFrame() && parentOrigin === selected.origin && /^[a-zA-Z0-9_-]{1,80}$/.test(channel));
  useEffect(() => {
    if (allowed) window.parent.postMessage({source:'nce-game-studio',version:1,type:'ready',channel,gameId:id},selected!.origin);
  },[allowed,channel,id,selected?.origin]);
  if (!allowed) return <main className="service-main"><h1>Open this game from a connected application.</h1><p>The host must be approved for this deployment.</p><a href={`/games/${encodeURIComponent(id)}`} target="_blank" rel="noopener noreferrer">Open the standalone player ↗</a></main>;
  const report = (event:PublishedGameEvent) => {
    if(event.type === 'completed' && event.result.outcome === 'level-complete') return;
    const clean = parseGameStudioEvent({...event,source:'nce-game-studio',version:event.type === 'multi-progress' ? 4 : event.type === 'flow-progress' ? 3 : event.specVersion === 6 ? 2 : 1,channel});
    if (clean) window.parent.postMessage(clean, selected!.origin);
  };
  return <GamePage id={id} embedded signed={false} playerSigned={false} adminMode={false} navigate={async path => { window.open(path,'_blank','noopener,noreferrer'); }} onGameEvent={report} onMultiMaterialRequest={(request, signal) => requestMultiHostMaterial(window.parent, selected!.origin, { channel, gameId: request.gameId, publishedRevision: request.publishedRevision }, { runId: request.runId, requestId: request.requestId, path: request.path, node: request.node }, signal)} onMaterialRequest={(request, signal) => requestHostMaterial(window.parent, selected!.origin, { channel, gameId: request.gameId, publishedRevision: request.publishedRevision }, { runId: request.runId, requestId: request.requestId, node: request.node }, signal)}/>;
}

export default function App() {
  const confirm = useConfirm();
  const [path,setPath] = useState(readPath),[config,setConfig] = useState<IntegrationConfig>(()=>isCore?defaultIntegrationConfig:initialConfig()),[configReady,setConfigReady] = useState(!isCore);
  const [session,setSession] = useState<Session>(isCore?noSession:previewSession),[playerSigned,setPlayerSigned] = useState(!isCore),[checking,setChecking] = useState(isCore);
  const [dirty,setDirty] = useState(false),[error,setError] = useState(''),[adminMode,setAdminMode] = useState(false),[dialog,setDialog] = useState<'accounts'|'agents'|'integration'>();
  const automaticLoginStarted = useRef(false);
  const sessionCheckGeneration = useRef(0);
  const pathname = path.split('?')[0], query = new URLSearchParams(path.split('?')[1] || '');
  const explicitHostEntry = isCore ? hostLoginCandidate(path,inFrame()) : undefined;
  const embedded = pathname.startsWith('/embed/games/'), privateRoute = ['/game-studio','/settings','/oauth/callback'].includes(pathname);
  const framedPrivate = inFrame() && !embedded;
  const refreshSession = useCallback(async () => {
    if (!isCore) return;
    const check = ++sessionCheckGeneration.current;
    try {
      const identity = await corePlayerSession();
      if (check !== sessionCheckGeneration.current) return;
      setPlayerSigned(identity.authenticated);
      if (!identity.authenticated) {setSession(noSession);setAdminMode(false);return;}
      const current = await coreRequest<Session>('/session');
      if (check !== sessionCheckGeneration.current) return;
      setSession(current); if (!current.canManageGames) setAdminMode(false);
    } catch (error) {
      if (check !== sessionCheckGeneration.current) return;
      if (!recoverExpiredCoreSession(error)) throw error;
      setPlayerSigned(false);setSession(noSession);setAdminMode(false);
    }
  },[]);
  useEffect(() => {
    let active = true;
    if (!isCore) return;
    void coreRequest('/integration','GET',undefined,false).then(value => {if(active){setConfig(parseIntegrationConfig(value));setConfigReady(true);}}).catch(error => {if(active){setError(message(error));setConfigReady(false);}});
    return () => {active=false;};
  },[]);
  useEffect(() => {
    if (!isCore || embedded || framedPrivate) {setChecking(false);return;}
    let active = true;
    void(async()=>{
      try {if(location.pathname === '/oauth/callback') {await completeCoreLogin(); if(active)setPath(readPath());} if(active)await refreshSession();}
      catch(error) {if(active){setError(message(error));setSession(noSession);setPlayerSigned(false);if(location.pathname==='/oauth/callback'){history.replaceState({},'','/game-studio');setPath('/game-studio');}}}
      finally {if(active)setChecking(false);}
    })();
    return () => {active=false;};
  },[refreshSession,embedded,framedPrivate]);
  useEffect(() => {
    if (!isCore || embedded || framedPrivate) return;
    const verify = () => {void refreshSession().catch(error => {setSession(noSession);setAdminMode(false);setError(message(error));});};
    window.addEventListener('focus',verify);return()=>window.removeEventListener('focus',verify);
  },[refreshSession,embedded,framedPrivate]);
  useEffect(() => {
    const pop = () => {const destination=readPath();if(dirty){history.pushState({},'',path);void navigate(destination);}else setPath(destination);};
    const before = (event:BeforeUnloadEvent) => {if(dirty){event.preventDefault();event.returnValue='';}};
    window.addEventListener('popstate',pop);window.addEventListener('beforeunload',before);
    return()=>{window.removeEventListener('popstate',pop);window.removeEventListener('beforeunload',before);};
  },[dirty,path]);
  const onDirty = useCallback((value:boolean)=>setDirty(value),[]);
  async function navigate(next:string) {
    if(next===path)return;
    if(dirty&&!await confirm('Leave these game changes without saving?'))return;
    history.pushState({},'',next);setPath(next);setDirty(false);setError('');window.scrollTo(0,0);
  }
  const currentHost = config.hosts.find(host=>host.id === query.get('host'));
  useEffect(()=>{if(currentHost&&!explicitHostEntry&&!embedded&&!framedPrivate)try{sessionStorage.setItem('game-studio-launch-host',currentHost.id);}catch{/* Return link remains optional when storage is blocked. */}},[currentHost?.id,Boolean(explicitHostEntry),embedded,framedPrivate]);
  let rememberedHost='';try{if(!embedded&&!framedPrivate)rememberedHost=sessionStorage.getItem('game-studio-launch-host')||'';}catch{/* Public play needs no storage permission. */}
  const savedHost = currentHost || config.hosts.find(host=>host.id === rememberedHost);
  const unapprovedHostEntry = Boolean(explicitHostEntry && configReady && !currentHost);
  const reassertingAccount = Boolean(explicitHostEntry);
  const waitingForHostLogin = reassertingAccount && !error && !unapprovedHostEntry;
  // Never render the previous target account while explicit connected entry
  // is waiting for its effect to start the current Core account's sign-in.
  const visibleSession = reassertingAccount ? noSession : session;
  const visiblePlayerSigned = playerSigned && !reassertingAccount;
  useEffect(()=>{if(unapprovedHostEntry)setError('This application is not a configured Game Studio host. Open Game Studio directly or ask an administrator to configure the connection.');},[unapprovedHostEntry]);
  useEffect(() => {
    if (!isCore || automaticLoginStarted.current) return;
    const launch = hostLoginLaunch(path, config.hosts.map(host=>host.id), { configured:configReady,checking,authenticated:playerSigned,framed:inFrame(),failed:Boolean(error) });
    if (!launch) return;
    automaticLoginStarted.current = true;
    // Consume the navigation flag before any storage, network or Core redirect.
    // Cancellation and a failed callback therefore cannot restart this flow.
    history.replaceState({},'',launch.consumedPath);setPath(launch.consumedPath);
    sessionCheckGeneration.current++;
    setPlayerSigned(false);setSession(noSession);setAdminMode(false);setChecking(true);
    void beginCoreLogin('login',launch.destination,{replaceSession:true,launchHostId:launch.hostId}).catch(error=>{setChecking(false);setError(message(error));});
  },[path,config,configReady,checking,playerSigned,error]);
  async function login() {setError('');if(!configReady){setError('Wait for deployment configuration before signing in.');return;}try {await beginCoreLogin('login', query.get('game') ? `/game-studio?game=${encodeURIComponent(query.get('game')!)}` : '/game-studio');}catch(error){setError(message(error));}}
  async function signOut() {if(dirty&&!await confirm('Sign out without saving your game?'))return;sessionCheckGeneration.current++;await coreLogout();setSession(noSession);setPlayerSigned(false);setAdminMode(false);setDirty(false);history.pushState({},'','/games');setPath('/games');}
  async function saveBranding(branding:ServiceBranding) {
    const next = isCore ? parseIntegrationConfig(await coreRequest('/integration','PUT',{branding,expectedRevision:config.revision ?? 0})) : parseIntegrationConfig({...config,branding,revision:(config.revision??0)+1});
    if(!isCore)localStorage.setItem('game-studio-branding:v1',JSON.stringify(next));
    setConfig(next);
  }
  useEffect(()=>{document.documentElement.style.setProperty('--service-accent',config.branding.accentColor);document.title=config.branding.appName+' — Imagine. Play. Publish.';},[config.branding.appName,config.branding.accentColor]);
  const badge = <span className="service-badge">{config.branding.badgeText}</span>;
  return <BrandingProvider config={config}>
    {framedPrivate ? <main className="service-main"><h1>Open Game Studio in its own tab.</h1><p>Creation, administration and sign-in run in a separate window.</p><a className="button primary" href={location.href} target="_blank" rel="noopener noreferrer">Open Game Studio ↗</a></main> : embedded ? configReady ? <EmbeddedGame id={pathname.split('/')[3] || ''} config={config}/> : <main className="service-main"><p role="status">{error || 'Loading deployment configuration…'}</p></main> : <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header service-header"><a className="brand" href="/games" onClick={event=>{event.preventDefault();void navigate('/games');}}><img src={config.branding.logoUrl || '/assets/game-studio-mark.svg'} alt=""/><span>{config.branding.appName}</span></a>
        <nav aria-label="Main navigation"><button className={pathname==='/games'||pathname==='/'?'active':''} onClick={()=>void navigate('/games')}>Games</button>{visibleSession.canCreateGames&&<button className={pathname==='/game-studio'?'active':''} onClick={()=>void navigate('/game-studio')}>Create a game</button>}</nav>
        {visibleSession.canManageGames&&<button className={`admin-toggle ${adminMode?'enabled':''}`} aria-pressed={adminMode} onClick={()=>setAdminMode(!adminMode)}>Admin actions: {adminMode?'On':'Off'}</button>}
        {visibleSession.canManageGames&&<button className="text-button" onClick={()=>setDialog('integration')}>Branding & integration</button>}
        {visibleSession.canConfigureAgents&&<button className="text-button" onClick={()=>setDialog('agents')}>Agents & workflows</button>}
        {visibleSession.canManageAccounts&&<button className="text-button" onClick={()=>setDialog('accounts')}>Accounts</button>}
        {isCore&&<button className="text-button" disabled={checking||waitingForHostLogin||!configReady} onClick={()=>void(visiblePlayerSigned?signOut():login())}>{checking||waitingForHostLogin?'Checking access…':visiblePlayerSigned?'Sign out':'Sign in'}</button>}
      </header>
      {!isCore&&<div className="local-banner"><span>LOCAL PREVIEW</span> Games and settings stay in this browser. No AWS or model calls.</div>}
      {savedHost&&<div className="service-host-strip"><span>Connected to {savedHost.name}</span><a href={new URL(savedHost.returnPath,savedHost.origin).href} onClick={event=>{if(dirty){event.preventDefault();void confirm('Leave these game changes without saving?').then(leave=>{if(leave)location.assign(new URL(savedHost.returnPath,savedHost.origin).href);});}}}>Return to {savedHost.name} ↗</a></div>}
      {error&&<p className="error service-message" role="alert">{error}</p>}
      {adminMode&&visibleSession.canManageGames&&<div className="admin-mode-strip" role="status">Admin actions are on. Use a game’s … menu to update, duplicate or delete it.</div>}
      {privateRoute ? checking||waitingForHostLogin ? <main id="main" className="service-main"><p role="status">Checking your Game Studio permissions…</p></main> : visibleSession.canCreateGames ? <GameStudio adminMode={adminMode&&visibleSession.canManageGames} onDirty={onDirty} navigate={navigate} initialGameId={query.get('game')||undefined}/> : <main id="main" className="service-login"><span className="eyebrow">ADMINISTRATIVE GAME CREATION</span><h1>Imagine it. Play it. Publish it.</h1><p>{visiblePlayerSigned?'Your account can play games. Ask an administrator for Game Studio creation access.':'Sign in with your shared Core account to use your assigned Game Studio permissions.'}</p>{!visiblePlayerSigned&&<button className="button primary" disabled={!configReady} onClick={()=>void login()}>Sign in with Core →</button>}<p>Accounts are invitation-only. Host applications cannot grant creator access through a URL.</p></main> : pathname.startsWith('/games/') ? <GamePage key={pathname} id={pathname.split('/')[2]} navigate={navigate} signed={visibleSession.canCreateGames} playerSigned={visiblePlayerSigned} adminMode={adminMode&&visibleSession.canManageGames}/> : pathname==='/'||pathname==='/games' ? <Games navigate={navigate} signed={visibleSession.canCreateGames} playerSigned={visiblePlayerSigned} adminMode={adminMode&&visibleSession.canManageGames}/> : <main className="service-main"><h1>Page not found.</h1><button className="button primary" onClick={()=>void navigate('/games')}>Open Games</button></main>}
      <footer className="service-footer">{badge}<span>Imagine. Playtest. Publish.</span>{isCore&&coreConfig&&<a href={coreConfig.issuer}>Core workspace ↗</a>}</footer>
      {dialog==='accounts'&&visibleSession.canManageAccounts&&<AccountAdministration onClose={()=>setDialog(undefined)}/>}
      {dialog==='agents'&&visibleSession.canConfigureAgents&&<AgentAdministration onClose={()=>setDialog(undefined)}/>}
      {dialog==='integration'&&visibleSession.canManageGames&&<IntegrationSettings config={config} onSave={saveBranding} onClose={()=>setDialog(undefined)}/>}
    </>}
  </BrandingProvider>;
}
