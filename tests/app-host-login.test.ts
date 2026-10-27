import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { defaultIntegrationConfig, parseIntegrationConfig } from '../src/lib/branding.ts';
import { hostLoginCandidate, hostLoginLaunch } from '../src/lib/host-login.ts';

type Node = {type:unknown;props:Record<string,any>};
function nodes(value:any):Node[]{return Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'type'in value?[value,...nodes(value.props.children)]:[];}
function text(value:any):string{return Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'&&'type'in value?text(value.props.children):typeof value==='string'?value:'';}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

function appHarness(){
  const configuration=deferred<unknown>(),store=new Map<string,string>([['game-studio-core-tokens','old-target-credentials']]);
  const authority={canCreateGames:true,canPublishGames:true,canManageGames:true,canManageAccounts:true,canConfigureAgents:true};
  const calls:string[]=[],logins:unknown[][]=[];
  const states:any[]=[],effects:{deps?:unknown[];cleanup?:()=>void}[]=[],memos:{deps:unknown[];value:any}[]=[];
  let index=0,effectIndex=0,memoIndex=0,dirty=false,tree:any,pending:(()=>void)[]=[];
  let url=new URL('https://studio.example/game-studio?host=academy&login=auto');
  const hooks={
    useState(initial:any){const at=index++;if(!(at in states))states[at]=typeof initial==='function'?initial():initial;return [states[at],(value:any)=>{const next=typeof value==='function'?value(states[at]):value;if(!Object.is(next,states[at])){states[at]=next;dirty=true;}}];},
    useRef(initial:any){const at=index++;if(!(at in states))states[at]={current:initial};return states[at];},
    useCallback(value:any,deps:unknown[]){const at=memoIndex++,previous=memos[at];if(!previous||deps.some((v,i)=>!Object.is(v,previous.deps[i])))memos[at]={value,deps};return memos[at].value;},
    useEffect(effect:()=>void|(()=>void),deps:unknown[]){const at=effectIndex++,previous=effects[at];if(!previous||deps.some((v,i)=>!Object.is(v,previous.deps?.[i]))){effects[at]={deps};pending.push(()=>{previous?.cleanup?.();const cleanup=effect();if(cleanup)effects[at].cleanup=cleanup;});}},
  };
  const core={isCore:true,coreConfig:{issuer:'https://core.example'},recoverExpiredCoreSession:()=>false,
    corePlayerSession:async()=>{calls.push('player-session');return {authenticated:true,canEdit:true};},
    coreRequest:async(path:string)=>{calls.push(path);return path==='/integration'?configuration.promise:authority;},
    beginCoreLogin:async(...args:unknown[])=>{logins.push(args);store.delete('game-studio-core-tokens');},
    completeCoreLogin:async()=>{},coreLogout:async()=>{},
  };
  const window:any={addEventListener(){},removeEventListener(){},scrollTo(){}};window.self=window;window.top=window;
  const modules:Record<string,any>={react:hooks,'react/jsx-runtime':{jsx:(type:unknown,props:Record<string,any>)=>({type,props}),jsxs:(type:unknown,props:Record<string,any>)=>({type,props})},
    './lib/core':core,'./lib/host-login':{hostLoginCandidate,hostLoginLaunch},'./lib/integration':{parseGameStudioEvent:()=>undefined},
    './lib/branding':{defaultIntegrationConfig,parseIntegrationConfig,BrandingProvider:'BRANDING'},
    './components/Confirm':{useConfirm:()=>async()=>true},'./components/GameStudio':{GameStudio:'PRIVATE_STUDIO'},
    './components/Games':{Games:'PUBLIC_GAMES',GamePage:'PUBLIC_GAME'},'./components/AgentWorkspace':{AgentAdministration:'PRIVATE_AGENTS'},
    './components/AccountAdministration':{AccountAdministration:'PRIVATE_ACCOUNTS'},'./components/IntegrationSettings':{IntegrationSettings:'PRIVATE_SETTINGS'},
  };
  const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8').replace("import.meta.glob('../game-studio-config.json',{eager:true,import:'default'})",'{}');
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const exports:any={};
  vm.runInNewContext(js,{exports,require:(name:string)=>modules[name]||{},URL,URLSearchParams,Map,Set,Boolean,Error,window,
    location:{get pathname(){return url.pathname;},get search(){return url.search;}},history:{replaceState(_a:unknown,_b:unknown,path:string){url=new URL(path,url);}},
    document:{documentElement:{style:{setProperty(){}}},title:''},
    localStorage:{getItem:()=>null},sessionStorage:{getItem:(key:string)=>store.get(key)||null,setItem:(key:string,value:string)=>store.set(key,value)},
  });
  function render(){index=0;effectIndex=0;memoIndex=0;dirty=false;tree=exports.default();const ready=pending;pending=[];for(const run of ready)run();return tree;}
  async function settle(){for(let turn=0;turn<16;turn++){await Promise.resolve();if(dirty)render();}}
  return {configuration,store,calls,logins,render,settle,get tree(){return tree;}};
}

function assertNoPreviousAuthority(tree:any){
  assert.equal(nodes(tree).some(node=>node.type==='PRIVATE_STUDIO'),false);
  for(const label of ['Create a game','Admin actions: Off','Branding & integration','Agents & workflows','Accounts']){
    assert.equal(nodes(tree).some(node=>node.type==='button'&&text(node)===label),false,label);
  }
}

test('old target session finishing before host configuration never renders its private workspace or admin actions',async()=>{
  const h=appHarness();h.render();await h.settle();
  assert.ok(h.calls.includes('/session'),'The previous target session completed first.');
  assertNoPreviousAuthority(h.tree);assert.match(text(h.tree),/Checking your Game Studio permissions/);
  assert.equal(h.logins.length,0);assert.equal(h.store.get('game-studio-core-tokens'),'old-target-credentials');
  assert.equal(h.store.has('game-studio-launch-host'),false);
  h.configuration.resolve({...structuredClone(defaultIntegrationConfig),hosts:[{id:'academy',name:'Academy',origin:'https://academy.example',returnPath:'/'}]});
  await h.settle();assertNoPreviousAuthority(h.tree);
  assert.equal(h.logins.length,1);assert.equal(h.store.has('game-studio-core-tokens'),false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.logins[0])),['login','/game-studio',{replaceSession:true,launchHostId:'academy'}]);
  await h.settle();assert.equal(h.logins.length,1);
});

test('unknown or invalid host configuration reports an error without clearing credentials or launching SSO',async()=>{
  for(const configuration of [structuredClone(defaultIntegrationConfig),{version:99}]){
    const h=appHarness();h.render();await h.settle();assertNoPreviousAuthority(h.tree);
    h.configuration.resolve(configuration);await h.settle();
    assertNoPreviousAuthority(h.tree);assert.equal(h.logins.length,0);
    assert.equal(h.store.get('game-studio-core-tokens'),'old-target-credentials');
    assert.ok(nodes(h.tree).some(node=>node.props.role==='alert'),'Configuration failure is visible.');
    assert.equal(h.store.has('game-studio-launch-host'),false);
  }
});
