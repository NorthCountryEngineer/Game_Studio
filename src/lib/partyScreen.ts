import catalog from '../../config/party-games.json';

/** Local in-person games are controlled by the lead; no provider or room API is used. */
export const SCREEN_GAMES = catalog.games;
export type ScreenKind = typeof catalog.games[number]['id'];
export const SCREEN_AVATARS = [['fox','🦊'],['bear','🐻'],['cat','🐱'],['dog','🐶'],['rabbit','🐰'],['panda','🐼'],['frog','🐸'],['owl','🦉'],['unicorn','🦄'],['robot','🤖'],['alien','👽'],['penguin','🐧']] as const;
export type ScreenPlayer = { id: string; name: string; avatar: string; score: number; alive: boolean };
export type ScreenSnapshot = {
  version: 1; id: string; viewToken: string; kind: string; revision: number; updatedAt: number;
  status: 'lobby'|'playing'|'finished'; phase: string; round: number; players: ScreenPlayer[]; result: string; log: string[];
  roles: Record<string,string>; prompt: string; question: string; options: string[]; answer: number; hands: Record<string,string>; revealed: boolean;
  board: (string|null)[]; turnId: string|null; artistId: string|null; taskProgress: number; taskGoal: number; sabotage: boolean;
  timerSeconds: number; deadlineAt: number|null;
};
export type ScreenSession = ScreenSnapshot & { history: ScreenSnapshot[] };
export type ScreenPublic = Pick<ScreenSnapshot,'version'|'id'|'kind'|'revision'|'updatedAt'|'status'|'phase'|'round'|'players'|'result'|'log'|'question'|'options'|'board'|'turnId'|'artistId'|'taskProgress'|'taskGoal'|'sabotage'|'timerSeconds'|'deadlineAt'> & { revealedRoles?: Record<string,string>; revealedPrompt?: string; revealedAnswer?: number; revealedHands?: Record<string,string> };
export type ScreenAction =
 | {type:'add';name:string;avatar:string} | {type:'remove';playerId:string} | {type:'start'} | {type:'next'}
 | {type:'score';playerId:string;amount:number} | {type:'alive';playerId:string;alive:boolean}
 | {type:'role';playerId:string;role:string} | {type:'shuffle-roles'}
 | {type:'result';text:string} | {type:'finish';text?:string} | {type:'reveal'} | {type:'reset'} | {type:'undo'}
 | {type:'prompt';text:string} | {type:'question';text:string;options:string[];answer:number}
 | {type:'hand';playerId:string;hand:string} | {type:'drop';column:number}
 | {type:'tasks';amount:number} | {type:'sabotage';enabled:boolean} | {type:'timer';seconds:number} | {type:'timer-stop'};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAP = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_PREFIX='game-studio-party-host-v1:', PUBLIC_PREFIX='game-studio-party-screen-v1:', RECENT_PREFIX='game-studio-party-recent-v1:';
const rolesByKind: Record<string,string[]> = {mafia:['mafia','detective','doctor','civilian'],'starship-suspects':['impostor','crew']};
const safeText=(v:unknown,max:number,min=0):v is string=>typeof v==='string'&&[...v].length>=min&&[...v].length<=max&&!/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(v);
const int=(v:unknown,min=0,max=1_000_000):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const obj=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const fail=(message='This local session cannot be read. Start a new session.') : never=>{throw new Error(message);};
export function screenGame(kind:string){ return SCREEN_GAMES.find(game=>game.id===kind); }
export function screenAvatar(id:string){ return SCREEN_AVATARS.find(avatar=>avatar[0]===id)?.[1]??'🙂'; }
export function screenSecret(){const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function emptyGame(){return {roles:{},prompt:'',question:'',options:[] as string[],answer:0,hands:{},revealed:false,board:Array(42).fill(null) as (string|null)[],turnId:null,artistId:null,taskProgress:0,taskGoal:12,sabotage:false,timerSeconds:60,deadlineAt:null};}
export function newScreenSession(kind:string,now=Date.now()):ScreenSession{
 if(!screenGame(kind))return fail('Choose a party game.');
 return {version:1,id:crypto.randomUUID(),viewToken:screenSecret(),kind,revision:0,updatedAt:now,status:'lobby',phase:'Lobby',round:0,players:[],result:'',log:[],...emptyGame(),history:[]};
}
function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}
function snapshot(session:ScreenSession):ScreenSnapshot{const {history,...value}=session;return clone(value);}
function requiredPlayer(state:ScreenSnapshot,id:string){const player=state.players.find(p=>p.id===id);if(!player)return fail('Choose a player in this game.');return player;}
function publicEvent(s:ScreenSnapshot,text:string){s.log=[...s.log,text].slice(-30);}
function clearRound(s:ScreenSnapshot){s.result='';s.hands={};s.revealed=false;s.deadlineAt=null;}
function assignRoles(s:ScreenSnapshot,rng:()=>number,preserve=false){
 const shuffled=[...s.players];for(let i=shuffled.length-1;i>0;i--){const j=Math.floor(Math.max(0,Math.min(.999999,rng()))*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
 const roles=s.kind==='mafia'?[...Array(Math.max(1,Math.floor(shuffled.length/4))).fill('mafia'),'detective','doctor']:['impostor'];
 const chosen=preserve?{...s.roles}:{};
 for(const role of Object.values(chosen)){const index=roles.indexOf(role);if(index>=0)roles.splice(index,1);}
 const fallback=s.kind==='mafia'?'civilian':'crew';
 for(const player of shuffled){if(!chosen[player.id])chosen[player.id]=roles.shift()??fallback;}
 s.roles=chosen;
}
function nextRound(s:ScreenSnapshot){
 clearRound(s);s.round++;s.phase=s.kind==='mafia'?'Night':s.kind==='starship-suspects'?'Tasks':s.kind==='sketch-guess'?'Drawing':s.kind==='trivia'?'Question':s.kind==='hand-duel'?'Choose hands':'Playing';
 if(s.kind==='sketch-guess'){s.artistId=s.players[(s.round-1)%s.players.length].id;if(s.round>1||!s.prompt)s.prompt=SCREEN_PROMPTS[(s.round-1)%SCREEN_PROMPTS.length];}
 if(s.kind==='trivia'&&(s.round>1||!s.question)){const q=SCREEN_TRIVIA[(s.round-1)%SCREEN_TRIVIA.length];s.question=q.question;s.options=[...q.options];s.answer=q.answer;}
 if(s.kind==='drop-four'){s.board=Array(42).fill(null);s.turnId=s.players[(s.round-1)%2].id;}
 publicEvent(s,`Round ${s.round} started.`);
}
export function applyScreenAction(current:ScreenSession,action:ScreenAction,now=Date.now(),rng=()=>Math.random()):ScreenSession{
 const s=clone(current), previous=snapshot(current);
 if(action.type==='undo'){const restored=s.history.pop();if(!restored)return fail('There is nothing to undo.');return {...restored,revision:current.revision+1,updatedAt:now,history:s.history};}
 if(action.type==='reset'){const clean={...s,...emptyGame(),status:'lobby' as const,phase:'Lobby',round:0,players:s.players.map(p=>({...p,score:0,alive:true})),result:'',log:[],history:[],revision:s.revision+1,updatedAt:now};return clean;}
 const metadata=screenGame(s.kind)!;
 if(action.type==='add'){
  if(s.status!=='lobby'||s.players.length>=metadata.maxPlayers)return fail('Add players in the lobby, up to the game limit.');
  const name=action.name.normalize('NFC').trim();if(!safeText(name,16,1)||!/[\p{L}\p{N}\p{P}\p{S}]/u.test(name)||s.players.some(p=>p.name.toLocaleLowerCase()===name.toLocaleLowerCase()))return fail('Choose a unique name with 1–16 visible characters.');
  if(!SCREEN_AVATARS.some(a=>a[0]===action.avatar))return fail('Choose one of the available avatars.');
  s.players.push({id:crypto.randomUUID(),name,avatar:action.avatar,score:0,alive:true});
 }else if(action.type==='remove'){
  if(s.status!=='lobby')return fail('Change the roster in the lobby.');requiredPlayer(s,action.playerId);s.players=s.players.filter(p=>p.id!==action.playerId);delete s.roles[action.playerId];
 }else if(action.type==='role'){
  if(s.status!=='lobby'||!rolesByKind[s.kind]?.includes(action.role))return fail('Assign a supported role in the lobby.');requiredPlayer(s,action.playerId);s.roles[action.playerId]=action.role;
 }else if(action.type==='shuffle-roles'){
  if(s.status!=='lobby'||!rolesByKind[s.kind]||s.players.length<metadata.minPlayers)return fail('Add the required players before dealing roles.');assignRoles(s,rng);
 }else if(action.type==='start'){
  if(s.status!=='lobby'||s.players.length<metadata.minPlayers||s.players.length>metadata.maxPlayers)return fail(`Add ${metadata.minPlayers}–${metadata.maxPlayers} players before starting.`);
  if(rolesByKind[s.kind]&&s.players.some(p=>!s.roles[p.id]))assignRoles(s,rng,true);
  s.status='playing';nextRound(s);
 }else if(action.type==='score'){
  if(!int(action.amount,-1000,1000)||!action.amount)return fail('Adjust a score by 1–1,000 points.');const p=requiredPlayer(s,action.playerId);p.score=Math.max(-100_000,Math.min(100_000,p.score+action.amount));
 }else if(action.type==='alive'){
  if(!rolesByKind[s.kind]||s.status==='lobby'||typeof action.alive!=='boolean')return fail('Start the game before updating player status.');const p=requiredPlayer(s,action.playerId);p.alive=action.alive;publicEvent(s,`${p.name} ${p.alive?'returns to play':'is out'}.`);
 }else if(action.type==='next'){
  if(s.status!=='playing')return fail('Start the game before advancing.');
  if(s.kind==='mafia'){
   clearRound(s);if(s.phase==='Night'){s.phase='Discussion';publicEvent(s,`Day ${s.round}: discuss the night.`);}else if(s.phase==='Discussion'){s.phase='Voting';publicEvent(s,'The town is voting.');}else nextRound(s);
  }else if(s.kind==='starship-suspects'){
   clearRound(s);if(s.phase==='Tasks')s.phase='Meeting';else if(s.phase==='Meeting')s.phase='Voting';else {s.phase='Tasks';s.round++;}publicEvent(s,`${s.phase} begins.`);
  }else nextRound(s);
 }else if(action.type==='result'){
  const text=action.text.trim();if(!safeText(text,180))return fail('Keep the public result under 180 characters.');s.result=text;if(text)publicEvent(s,text);
 }else if(action.type==='finish'){
  if(s.status!=='playing')return fail('Start this game before finishing.');const text=action.text?.trim()??s.result;if(!safeText(text,180))return fail('Keep the public result under 180 characters.');s.status='finished';s.phase='Finished';s.deadlineAt=null;s.result=text||'Game complete';publicEvent(s,s.result);
 }else if(action.type==='reveal'){
  if(s.status==='lobby')return fail('Start the game before revealing.');if(rolesByKind[s.kind]&&s.status!=='finished')return fail('Finish the game before revealing all secret roles.');
  if(s.kind==='hand-duel'){
   if(s.players.some(p=>!s.hands[p.id]))return fail('Record both hands before revealing.');
   if(s.revealed)return fail('These hands have already been scored.');
   const [a,b]=s.players,ah=s.hands[a.id],bh=s.hands[b.id];const winner=ah===bh?null:({rock:'scissors',paper:'rock',scissors:'paper'}[ah]===bh?a:b);if(winner)winner.score++;s.result=winner?`${winner.name} wins the round.`:'A tie!';publicEvent(s,s.result);
  }s.revealed=true;
 }else if(action.type==='prompt'){
  if(s.kind!=='sketch-guess'||!safeText(action.text.trim(),80,1))return fail('Enter a short drawing prompt.');s.prompt=action.text.trim();s.revealed=false;
 }else if(action.type==='question'){
  if(s.kind!=='trivia'||!safeText(action.text.trim(),200,1)||action.options.length!==4||action.options.some(o=>!safeText(o.trim(),80,1))||!int(action.answer,0,3))return fail('Enter a question, four choices and the correct choice.');s.question=action.text.trim();s.options=action.options.map(o=>o.trim());s.answer=action.answer;s.revealed=false;
 }else if(action.type==='hand'){
  if(s.kind!=='hand-duel'||s.status!=='playing'||s.revealed||!['rock','paper','scissors'].includes(action.hand))return fail('Record a hand before revealing this round.');requiredPlayer(s,action.playerId);s.hands[action.playerId]=action.hand;
 }else if(action.type==='drop'){
  if(s.kind!=='drop-four'||s.status!=='playing'||s.result||!int(action.column,0,6))return fail('Choose an available column during play.');
  let index=-1;for(let row=5;row>=0;row--){if(s.board[row*7+action.column]===null){index=row*7+action.column;break;}}if(index<0)return fail('That column is full.');const actor=requiredPlayer(s,s.turnId!);s.board[index]=actor.id;
  if(dropFourWinner(s.board,actor.id)){actor.score++;s.result=`${actor.name} connects four!`;publicEvent(s,s.result);s.turnId=null;}else if(s.board.every(Boolean)){s.result='The board is a draw.';s.turnId=null;publicEvent(s,s.result);}else s.turnId=s.players.find(p=>p.id!==actor.id)!.id;
 }else if(action.type==='tasks'){
  if(s.kind!=='starship-suspects'||s.status!=='playing'||!int(action.amount,-12,12))return fail('Update ship tasks during play.');s.taskProgress=Math.max(0,Math.min(s.taskGoal,s.taskProgress+action.amount));
 }else if(action.type==='sabotage'){
  if(s.kind!=='starship-suspects'||s.status!=='playing'||typeof action.enabled!=='boolean')return fail('Update sabotage during play.');s.sabotage=action.enabled;publicEvent(s,s.sabotage?'Sabotage! The crew must repair the ship.':'The ship is repaired.');
 }else if(action.type==='timer'){
  if(s.status!=='playing'||!int(action.seconds,10,900))return fail('Set a timer between 10 seconds and 15 minutes during play.');s.timerSeconds=action.seconds;s.deadlineAt=now+action.seconds*1000;
 }else if(action.type==='timer-stop'){s.deadlineAt=null;}
 s.revision++;s.updatedAt=now;s.history=[...s.history,previous].slice(-20);return s;
}
export function dropFourWinner(board:(string|null)[],id:string){for(let row=0;row<6;row++)for(let col=0;col<7;col++)for(const [dr,dc]of [[0,1],[1,0],[1,1],[1,-1]]){if(Array.from({length:4},(_,i)=>[row+i*dr,col+i*dc]).every(([r,c])=>r>=0&&r<6&&c>=0&&c<7&&board[r*7+c]===id))return true;}return false;}
/** Allowlist only display fields. Never send the host state or its history to a projector. */
export function projectScreen(s:ScreenSession):ScreenPublic{
 const p:ScreenPublic={version:1,id:s.id,kind:s.kind,revision:s.revision,updatedAt:s.updatedAt,status:s.status,phase:s.phase,round:s.round,players:s.players.map(({id,name,avatar,score,alive})=>({id,name,avatar,score,alive})),result:s.result,log:[...s.log],question:s.kind==='trivia'?s.question:'',options:s.kind==='trivia'?[...s.options]:[],board:s.kind==='drop-four'?[...s.board]:Array(42).fill(null),turnId:s.turnId,artistId:s.artistId,taskProgress:s.taskProgress,taskGoal:s.taskGoal,sabotage:s.sabotage,timerSeconds:s.timerSeconds,deadlineAt:s.deadlineAt};
 if(s.revealed){if(rolesByKind[s.kind]&&s.status==='finished')p.revealedRoles={...s.roles};if(s.kind==='sketch-guess')p.revealedPrompt=s.prompt;if(s.kind==='trivia')p.revealedAnswer=s.answer;if(s.kind==='hand-duel')p.revealedHands={...s.hands};}return p;
}
function validateBase(v:unknown):ScreenPublic{
 if(!obj(v)||v.version!==1||!UUID.test(v.id)||!screenGame(v.kind)||!int(v.revision)||!int(v.updatedAt,0,100_000_000_000_000)||!['lobby','playing','finished'].includes(v.status)||!safeText(v.phase,40,1)||!int(v.round,0,100_000)||!Array.isArray(v.players)||v.players.length>screenGame(v.kind)!.maxPlayers||!safeText(v.result,180)||!Array.isArray(v.log)||v.log.length>30||v.log.some((l:unknown)=>!safeText(l,200))||!safeText(v.question,200)||!Array.isArray(v.options)||![0,4].includes(v.options.length)||v.options.some((o:unknown)=>!safeText(o,80,1))||!Array.isArray(v.board)||v.board.length!==42||!int(v.taskProgress,0,12)||!int(v.taskGoal,1,12)||typeof v.sabotage!=='boolean'||!int(v.timerSeconds,10,900)||!(v.deadlineAt===null||int(v.deadlineAt,0,100_000_000_000_000)))return fail();
 const ids=new Set<string>();for(const p of v.players){if(!obj(p)||!UUID.test(p.id)||ids.has(p.id)||!safeText(p.name,16,1)||!SCREEN_AVATARS.some(a=>a[0]===p.avatar)||!int(p.score,-100_000,100_000)||typeof p.alive!=='boolean')return fail();ids.add(p.id);}
 if(v.board.some((id:unknown)=>id!==null&&!(typeof id==='string'&&ids.has(id)))||![null,...ids].includes(v.turnId)||![null,...ids].includes(v.artistId))return fail();
 return v as ScreenPublic;
}
export function parseScreenPublic(value:unknown):ScreenPublic{
 const v=validateBase(value) as ScreenPublic & Record<string,any>;
 // Reject private or unknown fields even if a transport sender accidentally serializes its host state.
 const allowed=new Set(['version','id','kind','revision','updatedAt','status','phase','round','players','result','log','question','options','board','turnId','artistId','taskProgress','taskGoal','sabotage','timerSeconds','deadlineAt','revealedRoles','revealedPrompt','revealedAnswer','revealedHands']);
 if(Object.keys(v).some(k=>!allowed.has(k))||v.players.some(p=>Object.keys(p).some(k=>!['id','name','avatar','score','alive'].includes(k))))return fail();
 const ids=new Set(v.players.map(p=>p.id));
 if(v.revealedRoles!==undefined&&(!rolesByKind[v.kind]||v.status!=='finished'||!obj(v.revealedRoles)||Object.entries(v.revealedRoles).some(([id,role])=>!ids.has(id)||!rolesByKind[v.kind].includes(role as string))))return fail();
 if(v.revealedPrompt!==undefined&&(v.kind!=='sketch-guess'||!safeText(v.revealedPrompt,80)))return fail();
 if(v.revealedAnswer!==undefined&&(v.kind!=='trivia'||!int(v.revealedAnswer,0,3)))return fail();
 if(v.revealedHands!==undefined&&(v.kind!=='hand-duel'||!obj(v.revealedHands)||Object.entries(v.revealedHands).some(([id,hand])=>!ids.has(id)||!['rock','paper','scissors'].includes(hand as string))))return fail();
 return clone(v);
}
export function parseScreenSession(value:unknown):ScreenSession{
 if(!obj(value)||!CAP.test(value.viewToken)||!obj(value.roles)||!obj(value.hands)||!safeText(value.prompt,80)||!int(value.answer,0,3)||typeof value.revealed!=='boolean'||!Array.isArray(value.history)||value.history.length>20)return fail();
 validateBase(value);const ids=new Set(value.players.map((p:ScreenPlayer)=>p.id));
 if(Object.entries(value.roles).some(([id,role])=>!ids.has(id)||!rolesByKind[value.kind]?.includes(role as string))||Object.entries(value.hands).some(([id,hand])=>!ids.has(id)||!['rock','paper','scissors'].includes(hand as string)))return fail();
 for(const history of value.history){if(!obj(history)||history.id!==value.id||history.viewToken!==value.viewToken||history.kind!==value.kind||'history'in history)return fail();parseScreenSession({...history,history:[]});}
 // Reconstruct from the schema, ignoring arbitrary local-storage properties.
 const fields=projectScreen({...value,history:[]} as unknown as ScreenSession);const {revealedRoles,revealedPrompt,revealedAnswer,revealedHands,...publicFields}=fields;
 return {...publicFields,viewToken:value.viewToken,roles:{...value.roles},prompt:value.prompt,answer:value.answer,hands:{...value.hands},revealed:value.revealed,history:value.history.map((h:ScreenSnapshot)=>{const {history,...s}=parseScreenSession({...h,history:[]});return s;})};
}
export type ScreenStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export function screenPublicKey(id:string,token:string){if(!UUID.test(id)||!CAP.test(token))return fail();return `${PUBLIC_PREFIX}${id}:${token}`;}
export function saveScreenSession(state:ScreenSession,storage:ScreenStorage=localStorage){const safe=parseScreenSession(state);storage.setItem(PRIVATE_PREFIX+safe.id,JSON.stringify(safe));storage.setItem(RECENT_PREFIX+safe.kind,safe.id);storage.setItem(screenPublicKey(safe.id,safe.viewToken),JSON.stringify(projectScreen(safe)));}
export function readScreenSession(kind:string,storage:ScreenStorage=localStorage):ScreenSession|undefined{try{if(!screenGame(kind))return;const id=storage.getItem(RECENT_PREFIX+kind);if(!id||!UUID.test(id))return;const text=storage.getItem(PRIVATE_PREFIX+id);if(!text||text.length>500_000)return;const s=parseScreenSession(JSON.parse(text));return s.kind===kind?s:undefined;}catch{return;}}
export function readScreenPublic(id:string,token:string,storage:Pick<Storage,'getItem'>=localStorage):ScreenPublic|undefined{try{const raw=storage.getItem(screenPublicKey(id,token));if(!raw||raw.length>30_000)return;const p=parseScreenPublic(JSON.parse(raw));return p.id===id?p:undefined;}catch{return;}}
export function forgetScreenSession(state:ScreenSession,storage:ScreenStorage=localStorage){storage.removeItem(PRIVATE_PREFIX+state.id);storage.removeItem(RECENT_PREFIX+state.kind);storage.removeItem(screenPublicKey(state.id,state.viewToken));}
export function screenPresentationURL(origin:string,state:ScreenSession){const url=new URL(origin);if(url.origin!==origin||!['http:','https:'].includes(url.protocol)||!UUID.test(state.id)||!CAP.test(state.viewToken))return fail('Open the game screen from this site.');return `${origin}/party/present/${state.id}#view=${state.viewToken}`;}
export function parseScreenViewToken(hash:string){const values=[...new URLSearchParams(hash.replace(/^#/,''))];return values.length===1&&values[0][0]==='view'&&CAP.test(values[0][1])?values[0][1]:undefined;}
export const SCREEN_PROMPTS=['A robot baking pancakes','A penguin on a skateboard','A dragon with a tiny umbrella','A pirate walking a dog','A castle made of pizza','A moon having a birthday','An octopus playing drums','A cat exploring space','A bicycle with square wheels','A sleeping volcano','A bear at the beach','A dancing cactus'];
export const SCREEN_TRIVIA=[
 {question:'Which planet is known for its rings?',options:['Mars','Saturn','Mercury','Venus'],answer:1},
 {question:'How many sides does a hexagon have?',options:['Five','Six','Seven','Eight'],answer:1},
 {question:'Which animal is a mammal?',options:['Shark','Octopus','Dolphin','Trout'],answer:2},
 {question:'What do you call a group of stars forming a pattern?',options:['Constellation','Continent','Current','Compass'],answer:0},
 {question:'What is the largest ocean on Earth?',options:['Arctic','Atlantic','Indian','Pacific'],answer:3},
 {question:'Which instrument usually has 88 keys?',options:['Guitar','Piano','Trumpet','Violin'],answer:1},
 {question:'Which of these is a primary color of light?',options:['Orange','Purple','Green','Brown'],answer:2},
 {question:'How many minutes are in two hours?',options:['90','100','120','180'],answer:2}
];
