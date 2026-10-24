import { cleanNodes, safeLink, type RichNode } from './model';
const tags=new Set(['p','h2','h3','strong','em','u','s','ul','ol','li','a','br','blockquote']);
const aliases:Record<string,string>={b:'strong',i:'em',strike:'s',div:'p'};
export function nodesFromElement(el:HTMLElement):RichNode[]{
  function read(n:Node,depth=0):RichNode[]{
    if(depth>12)return [];
    if(n.nodeType===Node.TEXT_NODE)return [{tag:'#text',text:(n.textContent||'').slice(0,30000)}];
    if(!(n instanceof HTMLElement))return [];
    if(['script','style','iframe','object','svg','img','video','audio'].includes(n.tagName.toLowerCase()))return [];
    const tag=aliases[n.tagName.toLowerCase()]||n.tagName.toLowerCase();
    const children=Array.from(n.childNodes).flatMap(c=>read(c,depth+1));
    if(!tags.has(tag))return children;
    const align=n.style.textAlign;
    return [{tag,children,href:tag==='a'?safeLink(n.getAttribute('href')||''):undefined,align:['left','center','right'].includes(align)?align as RichNode['align']:undefined}];
  }
  return cleanNodes(Array.from(el.childNodes).flatMap(n=>read(n)));
}
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function nodesToHTML(nodes:RichNode[]):string{
  return cleanNodes(nodes).map(n=>n.tag==='#text'?escape(n.text||''):`<${n.tag}${n.href?` href="${escape(n.href)}"`:''}${n.align?` style="text-align:${n.align}"`:''}>${n.tag==='br'?'':nodesToHTML(n.children||[])+`</${n.tag}>`}`).join('');
}
