import { useEffect, useRef, type ReactNode } from 'react';
import { cleanNodes, type RichNode } from '../lib/model';
import { nodesFromElement, nodesToHTML } from '../lib/richtext';
export function RichText({nodes}:{nodes:RichNode[]}){
  function render(nodes:RichNode[]):ReactNode{return cleanNodes(nodes).map((n,i)=>{
    if(n.tag==='#text')return n.text;
    const children=render(n.children||[]),style=n.align?{textAlign:n.align}:undefined;
    const props={style};
    switch(n.tag){case 'p':return <p key={i} {...props}>{children}</p>;case 'h2':return <h2 key={i} {...props}>{children}</h2>;case 'h3':return <h3 key={i} {...props}>{children}</h3>;case 'strong':return <strong key={i}>{children}</strong>;case 'em':return <em key={i}>{children}</em>;case 'u':return <u key={i}>{children}</u>;case 's':return <s key={i}>{children}</s>;case 'ul':return <ul key={i}>{children}</ul>;case 'ol':return <ol key={i}>{children}</ol>;case 'li':return <li key={i}>{children}</li>;case 'br':return <br key={i}/>;case 'a':return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">{children}</a>;case 'blockquote':return <blockquote key={i} {...props}>{children}</blockquote>;default:return null;}
  });}
  return <div className="rich-text">{render(nodes)}</div>;
}
export function RichEditor({nodes,onChange,disabled=false}:{nodes:RichNode[];onChange:(nodes:RichNode[])=>void;disabled?:boolean}){
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(ref.current && JSON.stringify(nodesFromElement(ref.current))!==JSON.stringify(cleanNodes(nodes)))ref.current.innerHTML=nodesToHTML(nodes);},[nodes]);
  function command(cmd:string,value?:string){ref.current?.focus();document.execCommand(cmd,false,value);if(ref.current)onChange(nodesFromElement(ref.current));}
  return <div className="rich-editor"><div className="format-toolbar" role="toolbar" aria-label="Text formatting">
    <select aria-label="Text style" defaultValue="p" onChange={e=>command('formatBlock',e.target.value)}><option value="p">Paragraph</option><option value="h2">Heading</option><option value="h3">Subheading</option><option value="blockquote">Quote</option></select>
    {([['bold','B','Bold'],['italic','I','Italic'],['underline','U','Underline'],['insertUnorderedList','• List','Bullet list'],['insertOrderedList','1. List','Numbered list'],['justifyLeft','⇤','Align left'],['justifyCenter','↔','Align center'],['justifyRight','⇥','Align right'],['undo','↶','Undo'],['redo','↷','Redo']] as const).map(([cmd,text,title])=><button key={cmd} type="button" title={title} aria-label={title} onMouseDown={e=>e.preventDefault()} onClick={()=>command(cmd)}>{text}</button>)}
  </div><div ref={ref} className="editable rich-text" contentEditable={!disabled} aria-disabled={disabled} suppressContentEditableWarning role="textbox" aria-label="Story text" aria-multiline="true" onInput={()=>ref.current&&onChange(nodesFromElement(ref.current))} onPaste={e=>{e.preventDefault();document.execCommand('insertText',false,e.clipboardData.getData('text/plain'));if(ref.current)onChange(nodesFromElement(ref.current));}}/>
  </div>;
}
