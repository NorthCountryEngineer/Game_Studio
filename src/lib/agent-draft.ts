import { cleanNodes, MAX_DOCUMENT_BYTES, parseDocument, safeLink, slugify, type Block, type Post } from './model';
import type { AgentSuggestion } from './agent-types';

export function hasAgentEdits(suggestion: AgentSuggestion): boolean {
  return suggestion.title !== undefined || suggestion.excerpt !== undefined || Boolean(suggestion.blocks?.length || suggestion.captions?.length);
}
/** Apply only explicitly reviewed editorial fields, without saving or publishing. */
export function applyAgentSuggestion(post: Post, suggestion: AgentSuggestion): Post {
  if (!hasAgentEdits(suggestion)) throw new Error('This result contains guidance rather than draft changes.');
  const result = { ...post }, doc = parseDocument(post.document);
  if (suggestion.title !== undefined) {
    if (typeof suggestion.title !== 'string' || !suggestion.title.trim() || suggestion.title.length > 120) throw new Error('The suggested title must contain 1–120 characters.');
    result.title = suggestion.title.trim(); result.slug = slugify(result.title);
  }
  if (suggestion.excerpt !== undefined) {
    if (typeof suggestion.excerpt !== 'string' || suggestion.excerpt.length > 300) throw new Error('The suggested description is too long.');
    result.excerpt = suggestion.excerpt;
  }
  if (suggestion.captions) {
    if (!Array.isArray(suggestion.captions) || suggestion.captions.length > 100) throw new Error('Invalid suggested captions.');
    const seen = new Set<string>();
    for (const caption of suggestion.captions) {
      const block = doc.blocks.find(item => item.id === caption.blockId && ['image', 'video'].includes(item.type));
      if (!block || seen.has(caption.blockId)) throw new Error('A suggested caption does not match a unique media block in this draft.');
      seen.add(caption.blockId);
      if (typeof caption.caption !== 'string' || caption.caption.length > 1000 || (caption.alt !== undefined && (typeof caption.alt !== 'string' || caption.alt.length > 300))) throw new Error('A suggested caption or image description is too long.');
      block.caption = caption.caption;
      if (caption.alt !== undefined && block.type === 'image') block.alt = caption.alt;
    }
  }
  if (suggestion.blocks) {
    if (!Array.isArray(suggestion.blocks) || doc.blocks.length + suggestion.blocks.length > 100) throw new Error('Keep a post under 100 blocks.');
    for (const proposed of suggestion.blocks) {
      if (proposed.type !== 'text' && proposed.type !== 'fact') throw new Error('Agents can suggest text and fact blocks. Add media yourself using Add files.');
      const block: Block = proposed.type === 'text' ? { id: crypto.randomUUID(), type: 'text', nodes: cleanNodes(proposed.nodes) } : { id: crypto.randomUUID(), type: 'fact', text: String(proposed.text || '').slice(0, 5000), source: safeLink(proposed.source) };
      doc.blocks.push(block);
    }
  }
  result.document = JSON.stringify(doc);
  if (new TextEncoder().encode(result.document).length > MAX_DOCUMENT_BYTES) throw new Error('These suggestions would make the draft too large.');
  return result;
}
