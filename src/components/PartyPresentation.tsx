import { useEffect, useState } from 'react';
import { parseScreenPublic, parseScreenViewToken, readScreenPublic, screenAvatar, screenGame, screenPublicKey, type ScreenPublic } from '../lib/partyScreen';
import '../party-screen.css';

const handIcon:Record<string,string>={rock:'✊',paper:'✋',scissors:'✌️'};
const roleName=(role:string)=>({mafia:'Mafia',doctor:'Doctor',detective:'Detective',civilian:'Civilian',impostor:'Impostor',crew:'Crew'}[role]??role);
export function PartyPublicView({state,now=Date.now()}:{state:ScreenPublic;now?:number}){
 const game=screenGame(state.kind)!,turn=state.players.find(p=>p.id===state.turnId),artist=state.players.find(p=>p.id===state.artistId);
 const seconds=state.deadlineAt===null?null:Math.max(0,Math.ceil((state.deadlineAt-now)/1000));
 return <div className={`party-projector party-projector-${state.kind}`}>
  <header className="party-projector-top"><div className="party-projector-brand"><span>{game.symbol}</span> GAME STUDIO <em>IN PERSON</em></div><div className="party-phase">{state.round>0&&`ROUND ${state.round} · `}{state.phase}</div></header>
  <section className="party-projector-hero"><span className="party-projector-symbol" aria-hidden="true">{game.symbol}</span><div><p className="party-kicker">{game.category}</p><h1>{game.title}</h1><p>{state.status==='lobby'?'Get comfortable. Your host is gathering the players.':state.status==='finished'?'One more round? The host can start a fresh game.':state.kind==='mafia'?'Watch, listen, and decide who to trust.':state.kind==='starship-suspects'?'Keep the ship running. Someone has other plans.':state.kind==='sketch-guess'?`${artist?.name??'The artist'} draws on paper or a whiteboard. Everyone else guesses!`:state.kind==='trivia'?'Choose your answer, then wait for the reveal.':state.kind==='hand-duel'?'Choose your hand in secret. Reveal together!':`${turn?.name??'The host'} takes the next turn.`}</p></div>{seconds!==null&&<div className={`party-clock ${seconds===0?'expired':''}`} aria-live="off"><strong>{Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</strong><span>{seconds===0?'Time!':'remaining'}</span></div>}</section>
  {state.result&&<div className="party-public-result" role="status">✦ {state.result}</div>}
  {state.kind==='starship-suspects'&&state.status!=='lobby'&&<section className={`party-ship-progress ${state.sabotage?'sabotaged':''}`}><div><span>{state.sabotage?'⚠ SABOTAGE':'✦ SHIP TASKS'}</span><strong>{state.taskProgress} / {state.taskGoal}</strong></div><progress value={state.taskProgress} max={state.taskGoal}/><p>{state.sabotage?'The crew must repair the ship.':'The crew works together while the impostor stays hidden.'}</p></section>}
  {state.kind==='trivia'&&state.question&&<section className="party-public-question"><h2>{state.question}</h2><div className="party-answer-grid">{state.options.map((option,index)=><div key={index} className={state.revealedAnswer===index?'correct':''}><b>{'ABCD'[index]}</b><span>{option}</span>{state.revealedAnswer===index&&<strong>✓</strong>}</div>)}</div></section>}
  {state.kind==='sketch-guess'&&state.revealedPrompt!==undefined&&<section className="party-prompt-reveal"><p className="party-kicker">The drawing was</p><h2>{state.revealedPrompt}</h2></section>}
  {state.kind==='hand-duel'&&state.status!=='lobby'&&<section className="party-hand-reveal">{state.players.map(p=><div key={p.id}><span>{state.revealedHands?handIcon[state.revealedHands[p.id]]:'?'}</span><strong>{p.name}</strong><small>{state.revealedHands?state.revealedHands[p.id]:'Keep your choice secret'}</small></div>)}</section>}
  {state.kind==='drop-four'&&state.status!=='lobby'&&<section className="party-public-board" aria-label="Drop Four board">{state.board.map((id,index)=><div key={index} className={`party-screen-disc ${id?`player-${state.players.findIndex(p=>p.id===id)}`:''}`}><span className="sr-only">{id?state.players.find(p=>p.id===id)?.name:'Empty'}</span></div>)}</section>}
  <section className="party-public-roster" aria-label="Players and scores">{[...state.players].sort((a,b)=>b.score-a.score).map(p=><article key={p.id} className={`${p.alive?'':'out'} ${turn?.id===p.id||artist?.id===p.id?'active':''}`}><span className="party-player-avatar" aria-hidden="true">{screenAvatar(p.avatar)}</span><div><strong>{p.name}</strong><small>{state.revealedRoles?.[p.id]?roleName(state.revealedRoles[p.id]):!p.alive?'Out this round':artist?.id===p.id?'Drawing':turn?.id===p.id?'Your turn':'Ready to play'}</small></div><b className="party-player-score">{p.score}<small>points</small></b></article>)}</section>
  {state.players.length===0&&<div className="party-screen-empty">Your players will appear here.</div>}
  {state.log.length>0&&<footer className="party-public-ticker"><span>LAST UPDATE</span>{state.log.at(-1)}</footer>}
 </div>;
}
/** Standalone projector entry: reads only the redacted display key, with no auth or API imports. */
export function PartyPresentation({sessionId}:{sessionId:string}){
 const [token]=useState(()=>parseScreenViewToken(window.location.hash));
 const [state,setState]=useState<ScreenPublic|undefined>(()=>token?readScreenPublic(sessionId,token):undefined),[now,setNow]=useState(Date.now());
 useEffect(()=>{
  if(!token)return;
  let key:string;try{key=screenPublicKey(sessionId,token);}catch{return;}let channel:BroadcastChannel|undefined;
  const refresh=()=>setState(readScreenPublic(sessionId,token));
  const changed=(event:StorageEvent)=>{if(event.key===key||event.key===null)refresh();};
  window.addEventListener('storage',changed);
  try{channel=new BroadcastChannel(key);channel.onmessage=event=>{try{const next=parseScreenPublic(event.data);if(next.id!==sessionId)return;setState(previous=>!previous||next.revision>=previous.revision?next:previous);}catch{refresh();}};}catch{/* Storage events remain sufficient in browsers without BroadcastChannel. */}
  const timer=window.setInterval(()=>{setNow(Date.now());refresh();},1000);refresh();
  return()=>{window.removeEventListener('storage',changed);window.clearInterval(timer);channel?.close();};
 },[sessionId,token]);
 if(!state)return <main className="party-projector party-screen-unavailable"><span aria-hidden="true">✦</span><h1>This game screen is waiting.</h1><p>Open the game screen from the host controls on this browser. A new session needs a new screen.</p><a href="/party">Back to party games</a></main>;
 return <main><PartyPublicView state={state} now={now}/><button className="party-projector-fullscreen" onClick={()=>{if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{});else void document.documentElement.requestFullscreen().catch(()=>{});}}>Full screen</button></main>;
}
