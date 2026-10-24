import { useEffect, useState } from 'react';
import { assetURL, isCloud } from '../lib/api';
import { embedUrl, parseDocument, type Block } from '../lib/model';
import { RichText } from './RichText';
export function Media({block,compact=false}:{block:Block;compact?:boolean}){
  const [url,setURL]=useState(''),[error,setError]=useState('');
  useEffect(()=>{let active=true,current='';const load=async()=>{try{const u=await assetURL(block.key!);if(!active){if(u.startsWith('blob:'))URL.revokeObjectURL(u);return;}if(current.startsWith('blob:'))URL.revokeObjectURL(current);current=u;setURL(u);}catch(e){if(active)setError((e as Error).message);}};if(block.key)void load();const timer=isCloud?setInterval(()=>void load(),9*60*1000):undefined;return()=>{active=false;if(current.startsWith('blob:'))URL.revokeObjectURL(current);clearInterval(timer);};},[block.key]);
  if(error)return <div className="media-placeholder" role="status">File unavailable: {error}</div>;
  if(!url)return <div className="media-placeholder">Loading file…</div>;
  if(block.type==='image')return <figure><img className={compact?'compact-image':''} src={url} alt={block.alt||block.caption||'Axolotl photo'} loading="lazy"/>{block.caption&&<figcaption>{block.caption}</figcaption>}</figure>;
  if(block.type==='video')return <figure><video src={url} controls preload="metadata" playsInline/>{block.caption&&<figcaption>{block.caption}</figcaption>}</figure>;
  return <a className="file-download" href={url} target="_blank" rel="noopener noreferrer" download={block.name}>↓ {block.name||'Download PDF'}</a>;
}
function VideoEmbed({block}:{block:Block}){const[play,setPlay]=useState(false);const url=embedUrl(block.url);if(!url)return <p>Add a YouTube or Vimeo video link.</p>;return <figure>{play?<iframe className="video-embed" src={url} title={block.caption||'Axolotl video'} allow="fullscreen; picture-in-picture" allowFullScreen sandbox="allow-scripts allow-same-origin allow-presentation"/>:<button className="embed-placeholder" onClick={()=>setPlay(true)}><span className="play-icon">▶</span><strong>{block.caption||'Watch this axolotl video'}</strong><small>Loads {url.includes('youtube')?'YouTube':'Vimeo'} when you play</small></button>}{block.caption&&<figcaption>{block.caption}</figcaption>}</figure>;}
export function BlockView({block}:{block:Block}){
  if(block.type==='text')return <RichText nodes={block.nodes||[]}/>;
  if(block.type==='embed')return <VideoEmbed block={block}/>;
  if(block.type==='fact')return <aside className="fact-block"><span className="eyebrow">DID YOU KNOW?</span><p>{block.text}</p>{block.source&&<a href={block.source} target="_blank" rel="noopener noreferrer">Check the source ↗</a>}</aside>;
  return <Media block={block}/>;
}
export function DocumentView({value}:{value:string}){
  try{const d=parseDocument(value);return <div className={`story-document theme-${d.theme} layout-${d.layout}`}>{d.blocks.map(b=><div className={`document-block block-${b.type}`} key={b.id}><BlockView block={b}/></div>)}</div>;}
  catch{return <p role="alert">This document could not be opened.</p>;}
}
