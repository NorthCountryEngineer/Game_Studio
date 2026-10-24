export type RichNode = { tag: string; text?: string; children?: RichNode[]; href?: string; align?: 'left' | 'center' | 'right' };
export type Block = {
  id: string;
  type: 'text' | 'image' | 'video' | 'embed' | 'fact' | 'file';
  nodes?: RichNode[];
  key?: string;
  mime?: string;
  name?: string;
  caption?: string;
  alt?: string;
  url?: string;
  text?: string;
  source?: string;
};
export type StoryDocument = { version: 1; theme: 'cream' | 'pink' | 'green'; layout: 'story' | 'newsletter'; blocks: Block[] };
export type Post = {
  id: string; title: string; slug: string; excerpt: string; category: string;
  document: string; status: string; coverKey?: string; publishedAt?: string; createdAt?: string; updatedAt?: string;
  adminState?: 'copying' | 'deleting'; duplicateSourceId?: string;
};
export const categories = ['Stories', 'Fun facts', 'Photos', 'Videos', 'Newsletters', 'Presentation'];
export const emptyDocument = (): StoryDocument => ({version:1, theme:'cream', layout:'story', blocks:[{id:crypto.randomUUID(),type:'text',nodes:[{tag:'p',children:[{tag:'#text',text:'Once upon an axolotl…'}]}]}]});
export const slugify = (title: string) => title.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80) || 'axolotl-story';
const richTags = new Set(['#text','p','h2','h3','strong','em','u','s','ul','ol','li','a','br','blockquote']);
export function safeLink(value: string | undefined): string | undefined {
  if (!value || value.length > 2048) return;
  try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) ? url.href : undefined; } catch { return; }
}
export function embedUrl(value: string | undefined): string | undefined {
  const safe = safeLink(value); if (!safe) return;
  const u = new URL(safe); let id: string | undefined;
  if (['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname)) id = u.searchParams.get('v') || (u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : undefined);
  if (u.hostname === 'youtu.be') id=u.pathname.slice(1);
  if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
  if (['vimeo.com','www.vimeo.com'].includes(u.hostname) && /^\/\d+$/.test(u.pathname)) return `https://player.vimeo.com/video/${u.pathname.slice(1)}`;
}
export function safeMediaKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length>512 || value.includes('..') || value.includes('\\')) return;
  return /^(drafts|published)\/[a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+$/.test(value) ? value : undefined;
}
export function cleanNodes(value: unknown, depth=0): RichNode[] {
  if (!Array.isArray(value) || depth>12) return [];
  return value.slice(0,1000).flatMap((raw): RichNode[] => {
    if (!raw || typeof raw !== 'object') return [];
    const n=raw as RichNode; if (!richTags.has(n.tag)) return [];
    if(n.tag==='#text') return [{tag:'#text',text:String(n.text??'').slice(0,30000)}];
    return [{tag:n.tag, children:cleanNodes(n.children,depth+1), href:n.tag==='a'?safeLink(n.href):undefined,
      align:['left','center','right'].includes(n.align||'')?n.align:undefined}];
  });
}
export function parseDocument(value: string): StoryDocument {
  const d=JSON.parse(value) as StoryDocument;
  if(d.version!==1 || !Array.isArray(d.blocks) || d.blocks.length>100) throw new Error('This post has an unsupported document format.');
  const ids=new Set<string>();
  for(const b of d.blocks){
    if(!b || typeof b.id!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(b.id) || ids.has(b.id)) throw new Error('Every block needs a unique ID.');
    ids.add(b.id);
  }
  return {version:1, theme:['pink','green'].includes(d.theme)?d.theme:'cream',layout:d.layout==='newsletter'?'newsletter':'story',blocks:d.blocks.map((b) => {
    if(!b || !['text','image','video','embed','fact','file'].includes(b.type)) throw new Error('Unknown content block.');
    return {id:String(b.id).slice(0,80),type:b.type,nodes:cleanNodes(b.nodes),key:safeMediaKey(b.key),
      name:String(b.name??'').slice(0,200),mime:String(b.mime??'').slice(0,100),caption:String(b.caption??'').slice(0,1000),
      alt:String(b.alt??'').slice(0,300),url:safeLink(b.url),text:String(b.text??'').slice(0,5000),source:safeLink(b.source)};
  })};
}
export const MAX_DOCUMENT_BYTES = 250_000;
export function validatePost(post: Post): StoryDocument {
  if(!post.title.trim() || post.title.length>120) throw new Error('Add a title of 1–120 characters.');
  if(!/^[a-z0-9-]{1,100}$/.test(post.slug)) throw new Error('Use letters, numbers, and hyphens in the link.');
  if(post.excerpt.length>300) throw new Error('Keep the description under 300 characters.');
  if(new TextEncoder().encode(post.document).length>MAX_DOCUMENT_BYTES) throw new Error('This post is too large. Split it into more than one post.');
  const d=parseDocument(post.document);
  if(!d.blocks.length) throw new Error('Add some content before saving.');
  for(const b of d.blocks) {
    if(['image','video','file'].includes(b.type) && !b.key) throw new Error('Upload the file for every media block first.');
    if(b.type==='embed' && !embedUrl(b.url)) throw new Error('Use a YouTube or Vimeo video link.');
  }
  return d;
}
export function validateFile(file: Pick<File,'type'|'size'|'name'>): 'image'|'video'|'file' {
  const image=['image/jpeg','image/png','image/webp','image/gif']; const video=['video/mp4','video/webm'];
  const type=image.includes(file.type)?'image':video.includes(file.type)?'video':file.type==='application/pdf'?'file':undefined;
  if(!type) throw new Error('Choose a JPG, PNG, WebP, GIF, MP4, WebM, or PDF file.');
  const max=type==='video'?50*1024*1024:10*1024*1024;
  if(file.size===0 || file.size>max) throw new Error(type==='video'?'Videos must be under 50 MB.':'Images and PDFs must be under 10 MB.');
  return type;
}
export const extensionFor = (mime: string) => ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','video/mp4':'mp4','video/webm':'webm','application/pdf':'pdf'}[mime] || 'bin');
export function mediaKeys(d: StoryDocument): string[] { return [...new Set(d.blocks.map(b=>b.key).filter((k): k is string => Boolean(k)))]; }
export function publicDocument(d: StoryDocument, keys: Map<string,string>): StoryDocument {
  const copy={...d,blocks:d.blocks.map(b=>({...b,key:b.key?keys.get(b.key):undefined}))};
  for(const b of copy.blocks) if(['image','video','file'].includes(b.type) && (!b.key || !b.key.startsWith('published/'))) throw new Error('A media file could not be prepared for publication.');
  return copy;
}
