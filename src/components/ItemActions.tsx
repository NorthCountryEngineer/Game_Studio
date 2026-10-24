import { useEffect, useRef, useState } from 'react';
import '../admin-actions.css';

type ItemActionsProps = {
  label: string;
  disabled?: boolean;
  onUpdate: () => void | Promise<void>;
  onDuplicate: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
};

export function ItemActions({label,disabled=false,onUpdate,onDuplicate,onDelete}:ItemActionsProps){
  const menu=useRef<HTMLDetailsElement>(null),trigger=useRef<HTMLElement>(null),panel=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false);
  function close(restoreFocus=false){if(menu.current)menu.current.open=false;setOpen(false);if(restoreFocus)trigger.current?.focus();}
  useEffect(()=>{if(disabled)close();},[disabled]);
  useEffect(()=>{
    if(!open)return;
    function position(){
      if(!trigger.current||!panel.current)return;
      const button=trigger.current.getBoundingClientRect(),popup=panel.current;
      popup.style.maxHeight=`${Math.max(120,window.innerHeight-24)}px`;
      const size=popup.getBoundingClientRect();
      popup.style.left=`${Math.max(12,Math.min(button.right-size.width,window.innerWidth-size.width-12))}px`;
      popup.style.top=`${button.bottom+6+size.height<=window.innerHeight-12?button.bottom+6:Math.max(12,button.top-size.height-6)}px`;
    }
    function outside(event:Event){if(!menu.current?.contains(event.target as Node))close();}
    function escape(event:KeyboardEvent){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}}
    position();
    document.addEventListener('pointerdown',outside);
    document.addEventListener('focusin',outside);
    document.addEventListener('keydown',escape);
    window.addEventListener('resize',position);
    document.addEventListener('scroll',position,true);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('focusin',outside);document.removeEventListener('keydown',escape);window.removeEventListener('resize',position);document.removeEventListener('scroll',position,true);};
  },[open]);
  function action(callback:()=>void|Promise<void>){if(disabled)return;close(true);void callback();}
  return <details ref={menu} className="item-actions" onClick={event=>event.stopPropagation()} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'&&open){event.preventDefault();close(true);}}} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary ref={trigger} aria-label={`Actions for ${label}`} aria-expanded={open} aria-disabled={disabled} tabIndex={disabled?-1:0} onClick={event=>{if(disabled)event.preventDefault();}}><span aria-hidden="true">…</span></summary>
    <div ref={panel} className="item-actions-panel" role="group" aria-label={`Admin actions for ${label}`}>
      <button type="button" disabled={disabled} onClick={()=>action(onUpdate)}>Update</button>
      <button type="button" disabled={disabled} onClick={()=>action(onDuplicate)}>Duplicate</button>
      <button type="button" className="item-action-delete" disabled={disabled} onClick={()=>action(onDelete)}>Delete</button>
    </div>
  </details>;
}
