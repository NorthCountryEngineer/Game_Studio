import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
const Context=createContext<(message:string)=>Promise<boolean>>(async()=>false);
export function ConfirmProvider({children}:{children:ReactNode}){
  const [question,setQuestion]=useState<{message:string;resolve:(value:boolean)=>void}|null>(null);
  const ref=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null);
  const ask=useCallback((message:string)=>new Promise<boolean>(resolve=>setQuestion({message,resolve})),[]);
  useEffect(()=>{if(question && ref.current){ref.current.showModal();cancel.current?.focus();}},[question]);
  function settle(result:boolean){question?.resolve(result);ref.current?.close();setQuestion(null);}
  return <Context.Provider value={ask}>{children}{question&&<dialog ref={ref} className="confirm-dialog" aria-labelledby="confirmation-title" onCancel={e=>{e.preventDefault();settle(false);}}><span className="eyebrow">ONE LITTLE CHECK</span><h2 id="confirmation-title">Ready to continue?</h2><p>{question.message}</p><div><button ref={cancel} className="button secondary" onClick={()=>settle(false)}>Cancel</button><button className="button primary" onClick={()=>settle(true)}>Continue</button></div></dialog>}</Context.Provider>;
}
export const useConfirm=()=>useContext(Context);
