import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanNodes, embedUrl, parseDocument, publicDocument, safeLink, safeMediaKey, validateFile, validatePost, type Post, type StoryDocument } from '../src/lib/model.ts';
import { nodesToHTML } from '../src/lib/richtext.ts';

const story = (blocks: StoryDocument['blocks']): StoryDocument => ({
  version: 1, theme: 'cream', layout: 'story', blocks,
});
const post = (document: StoryDocument): Post => ({
  id: 'story-1', title: 'An axolotl story', slug: 'an-axolotl-story', excerpt: '',
  category: 'Stories', status: 'Draft', document: JSON.stringify(document),
});

test('untrusted links cannot execute code or use a local file scheme', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://example.com/file', '/relative/path']) {
    assert.equal(safeLink(url), undefined);
  }
  assert.equal(safeLink('https://example.com/facts?q=axolotl'), 'https://example.com/facts?q=axolotl');
});

test('video embeds allow verified provider hosts and valid IDs only', () => {
  assert.equal(embedUrl('https://youtu.be/dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(embedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(embedUrl('https://vimeo.com/123456'), 'https://player.vimeo.com/video/123456');
  for (const url of ['https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'https://youtube.com@evil.example/watch?v=dQw4w9WgXcQ', 'javascript:alert(1)', 'https://youtu.be/invalid', 'https://vimeo.com/123<script>']) {
    assert.equal(embedUrl(url), undefined);
  }
});

test('imported rich text removes executable elements, unsafe hrefs, and unknown attributes', () => {
  const untrusted = [
    { tag: 'script', children: [{ tag: '#text', text: 'alert(1)' }] },
    { tag: 'p', onclick: 'alert(1)', align: 'expression(alert(1))', children: [
      { tag: 'a', href: 'javascript:alert(1)', children: [{ tag: '#text', text: '<img src=x onerror=alert(1)>' }] },
      { tag: 'iframe', src: 'https://evil.example' },
    ] },
  ];
  const clean = cleanNodes(untrusted);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].tag, 'p');
  assert.equal(clean[0].align, undefined);
  assert.equal(clean[0].children?.[0].href, undefined);
  assert.equal(clean[0].children?.length, 1);
  const html = nodesToHTML(clean);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<iframe'));
  assert.ok(!html.includes('href='));
  assert.ok(!html.includes('onclick='));
});

test('imported media cannot select traversal paths or external URLs', () => {
  assert.equal(safeMediaKey('drafts/story-1/asset-1.png'), 'drafts/story-1/asset-1.png');
  for (const key of ['../../secret.png', 'drafts/story-1/../secret.png', 'drafts/story-1/asset.png?token=1', 'drafts/story-1/asset%2epng', 'https://evil.example/a.png', 'drafts\\story-1\\asset.png']) {
    assert.equal(safeMediaKey(key), undefined);
  }
  const parsed = parseDocument(JSON.stringify(story([{ id: 'bad', type: 'image', key: 'https://evil.example/a.png' }])));
  assert.equal(parsed.blocks[0].key, undefined);
  assert.throws(() => validatePost(post(parsed)), /Upload the file/);
});

test('upload validation rejects active document types and oversized or empty files', () => {
  assert.equal(validateFile({ name: 'slide.png', type: 'image/png', size: 1024 }), 'image');
  assert.equal(validateFile({ name: 'story.pdf', type: 'application/pdf', size: 1024 }), 'file');
  assert.equal(validateFile({ name: 'axolotl.mp4', type: 'video/mp4', size: 1024 }), 'video');
  for (const type of ['image/svg+xml', 'text/html', 'application/javascript', 'application/octet-stream']) {
    assert.throws(() => validateFile({ name: 'unsafe.file', type, size: 1024 }), /Choose a/);
  }
  assert.throws(() => validateFile({ name: 'empty.png', type: 'image/png', size: 0 }), /10 MB/);
  assert.throws(() => validateFile({ name: 'big.png', type: 'image/png', size: 10 * 1024 * 1024 + 1 }), /10 MB/);
  assert.throws(() => validateFile({ name: 'big.mp4', type: 'video/mp4', size: 50 * 1024 * 1024 + 1 }), /50 MB/);
});

test('public document requires successful media copies and leaves its draft unchanged', () => {
  const key = 'drafts/story-1/asset.png';
  const target = 'published/story-1/revision-1/asset.png';
  const draft = story([{ id: 'image-1', type: 'image', key }, { id: 'text-1', type: 'text', nodes: [{ tag: '#text', text: 'Hello' }] }]);
  assert.throws(() => publicDocument(draft, new Map()), /prepared for publication/);
  assert.throws(() => publicDocument(draft, new Map([[key, key]])), /prepared for publication/);
  const published = publicDocument(draft, new Map([[key, target]]));
  assert.equal(published.blocks[0].key, target);
  assert.ok(!JSON.stringify(published).includes('drafts/'));
  assert.equal(draft.blocks[0].key, key);
});


test('imported block IDs must be unique and valid', () => {
  const doc={version:1,theme:'cream',layout:'story',blocks:[{id:'same',type:'text',nodes:[]},{id:'same',type:'text',nodes:[]}]};
  assert.throws(()=>parseDocument(JSON.stringify(doc)),/unique ID/);
  assert.throws(()=>parseDocument(JSON.stringify({...doc,blocks:[{type:'text',nodes:[]}]})),/unique ID/);
});
