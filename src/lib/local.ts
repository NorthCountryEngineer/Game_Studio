import type { Post } from './model';
const STORE='game-studio-support:v1';
type State={drafts:Post[];published:Post[]};
export function readState():State {
  try { const v=JSON.parse(localStorage.getItem(STORE)||'{}');return {drafts:Array.isArray(v.drafts)?v.drafts:[],published:Array.isArray(v.published)?v.published:[]}; }
  catch {throw new Error('Local browser storage could not be read. Export your drafts before clearing site data.');}
}
function writeState(s:State){localStorage.setItem(STORE,JSON.stringify(s));}
export const localPosts = {
  list:async (published=false) => readState()[published?'published':'drafts'],
  save:async(post:Post,published=false) => {const s=readState();const name=published?'published':'drafts';s[name]=[post,...s[name].filter(p=>p.id!==post.id)];writeState(s);},
  delete:async(id:string,published=false) => {const s=readState();const name=published?'published':'drafts';s[name]=s[name].filter(p=>p.id!==id);writeState(s);},
  deleteContent:async(id:string) => {const s=readState();writeState({drafts:s.drafts.filter(p=>p.id!==id),published:s.published.filter(p=>p.id!==id)});},
};
function database():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const r=indexedDB.open('axolotl-media',1);r.onupgradeneeded=()=>r.result.createObjectStore('files');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function putLocalAsset(key:string,blob:Blob){const db=await database();await new Promise<void>((resolve,reject)=>{const t=db.transaction('files','readwrite');t.objectStore('files').put(blob,key);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||new Error('Browser storage is full.'));});db.close();}
export async function localAsset(key:string):Promise<Blob>{const db=await database();try{return await new Promise((resolve,reject)=>{const r=db.transaction('files').objectStore('files').get(key);r.onsuccess=()=>r.result?resolve(r.result):reject(new Error('This file is missing from browser storage.'));r.onerror=()=>reject(r.error);});}finally{db.close();}}
export async function removeLocalAssets(prefix:string){const db=await database();await new Promise<void>((resolve,reject)=>{const t=db.transaction('files','readwrite'),s=t.objectStore('files');const r=s.openCursor();r.onsuccess=()=>{const c=r.result;if(c){if(String(c.key).startsWith(prefix))c.delete();c.continue();}};t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);});db.close();}
