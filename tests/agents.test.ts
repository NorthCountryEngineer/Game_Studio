import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { applyAgentSuggestion } from '../src/lib/agent-draft.ts';
import { canonicalJSON, contextFingerprint, defaultAgentSettings, modeAvailable, validateAgentConfig } from '../src/lib/agent-defaults.ts';
import { LOCAL_ASSISTANT_SUBJECT, LocalAgentRuntime, localMediaInventory } from '../src/lib/agent-local.ts';
import { parseDocument, type Post } from '../src/lib/model.ts';
import type { AgentContext, AgentSession } from '../src/lib/agent-types.ts';

const pid = '11111111-1111-4111-8111-111111111111';
const image = { id: 'photo', type: 'image', key: `drafts/${pid}/22222222-2222-4222-8222-222222222222.jpg`, mime: 'image/jpeg', name: 'Axolotl.jpg', caption: '', alt: '' };
function post(): Post { return { id: pid, title: 'Our axolotl', slug: 'our-axolotl', excerpt: 'A day in our aquarium.', category: 'Photos', status: 'Published', publishedAt: '2026-10-01T12:00:00Z', coverKey: image.key, document: JSON.stringify({ version: 1, theme: 'cream', layout: 'story', blocks: [image] }) }; }
function context(): AgentContext { const p = post(); return { title: p.title, excerpt: p.excerpt, category: p.category, document: p.document, mediaIds: ['photo'] }; }
function runtime() { const store = new Map<string, string>(); return { engine: new LocalAgentRuntime({ getItem: key => store.get(key) || null, setItem: (key, value) => { store.set(key, value); }, removeItem: key => { store.delete(key); } }), store }; }
async function session(engine: LocalAgentRuntime) { return engine.create(crypto.randomUUID(), pid, 'media-coach', context()); }
const turn = (engine: LocalAgentRuntime, session: AgentSession, action: 'message' | 'workflow' | 'advance', message?: string) => engine.turn(session.id, { requestId: crypto.randomUUID(), revision: session.revision, action, ...(message ? { message } : {}) });

test('shared defaults distinguish local guidance, generative AI, and media ML with paid execution blocked', () => {
  const settings = defaultAgentSettings();
  assert.equal(settings.config.allowPaidExecution, false); assert.equal(settings.paidModelsAllowed, false);
  assert.deepEqual(new Set(settings.config.models.map(model => model.kind)), new Set(['local', 'generative', 'ml']));
  assert.equal(settings.config.models.find(model => model.provider === 'bedrock')!.enabled, false);
  assert.equal(settings.config.workflows.length, 3);
});
test('configuration validation rejects broken references, unknown fields and provider mismatches', () => {
  const cfg = defaultAgentSettings().config; cfg.agents[0].modelId = 'missing'; assert.throws(() => validateAgentConfig(cfg), /unknown model/);
  assert.throws(() => validateAgentConfig({ ...defaultAgentSettings().config, api_key: 'never-store-secrets-here' }), /Unexpected/);
  const badModel = defaultAgentSettings().config; badModel.models[0].kind = 'ml'; assert.throws(() => validateAgentConfig(badModel), /do not match/);
});
test('mode audiences accept legacy configurations and validate exact Core account grants', () => {
  const cfg = defaultAgentSettings().config, mode = cfg.modes[0]; delete mode.audience;
  assert.doesNotThrow(() => validateAgentConfig(cfg)); assert.equal(modeAvailable(mode, LOCAL_ASSISTANT_SUBJECT), true);
  mode.audience = { allEditors: false, userIds: [LOCAL_ASSISTANT_SUBJECT] };
  assert.doesNotThrow(() => validateAgentConfig(cfg)); assert.equal(modeAvailable(mode, LOCAL_ASSISTANT_SUBJECT), true); assert.equal(modeAvailable(mode, pid), false);
  mode.audience.userIds.push(LOCAL_ASSISTANT_SUBJECT); assert.throws(() => validateAgentConfig(cfg), /unique Core account/);
  mode.audience.userIds = ['not-a-core-account']; assert.throws(() => validateAgentConfig(cfg), /unique Core account/);
});
test('per-account mode grants filter choices and revocation stops existing conversations', async () => {
  const { engine } = runtime(), cfg = engine.settings().config;
  cfg.modes[0].audience = { allEditors: false, userIds: [pid] }; engine.save(cfg, 0);
  assert.equal(engine.settings().availableModeIds?.includes('media-coach'), false);
  await assert.rejects(() => session(engine), /unavailable for your account/);
  const grant = engine.settings().config; grant.modes[0].audience!.userIds = [LOCAL_ASSISTANT_SUBJECT]; engine.save(grant, grant.revision);
  const created = await session(engine), revoke = engine.settings().config;
  revoke.modes[0].audience!.userIds = []; engine.save(revoke, revoke.revision);
  assert.throws(() => turn(engine, created, 'message', 'Hello'), /unavailable for your account/);
});
test('changing an agent model revokes the old conversation capability', async () => {
  const { engine } = runtime(), created = await session(engine), cfg = engine.settings().config;
  cfg.agents[0].modelId = 'image-labels'; engine.save(cfg, cfg.revision);
  assert.throws(() => turn(engine, created, 'message', 'Hello'), /agent has been disabled or changed/);
});
test('changing a mode workflow prevents execution of its previous workflow', async () => {
  const { engine } = runtime(), created = await session(engine), cfg = engine.settings().config;
  cfg.modes[0].workflowId = 'image-analysis'; engine.save(cfg, cfg.revision);
  assert.throws(() => turn(engine, created, 'workflow'), /different agent or workflow/);
});
test('DAG validation rejects cycles, undeclared inputs and non-ancestor output bindings', () => {
  const cycle = defaultAgentSettings().config; cycle.workflows[0].graph.nodes[0].depends_on = ['review']; assert.throws(() => validateAgentConfig(cycle), /cycle/);
  const undeclared = defaultAgentSettings().config; undeclared.workflows[0].graph.nodes[0].inputs = { text: { $input: 'missing' } }; assert.throws(() => validateAgentConfig(undeclared), /undeclared/);
  const unrelated = defaultAgentSettings().config; unrelated.workflows[0].graph.nodes[1].inputs = { text: { $node: 'review' } }; assert.throws(() => validateAgentConfig(unrelated), /dependency/);
});
test('DAG bindings cannot evaluate code, mix operators or access prototype paths', () => {
  for (const value of [{ $eval: 'anything' }, { $node: 'inventory', $context: 'post' }, { $node: 'inventory', path: '__proto__.secret' }]) {
    const cfg = defaultAgentSettings().config; cfg.workflows[0].graph.nodes[1].inputs = { value }; assert.throws(() => validateAgentConfig(cfg));
  }
  const cfg = defaultAgentSettings().config; cfg.workflows[0].graph.nodes[0].inputs = { literal: '$context.media' }; assert.doesNotThrow(() => validateAgentConfig(cfg));
});
test('fingerprints use canonical UTF-8 JSON matching Python sorted JSON', async () => {
  const value = context(); value.title = 'Axolotl café';
  assert.equal(await contextFingerprint(value), createHash('sha256').update(canonicalJSON(value), 'utf8').digest('hex'));
  assert.equal(await contextFingerprint(value), await contextFingerprint({ mediaIds: value.mediaIds, document: value.document, category: value.category, excerpt: value.excerpt, title: value.title }));
  assert.notEqual(await contextFingerprint(value), await contextFingerprint({ ...value, title: 'A changed story' }));
});
test('media inventory reports missing captions without inventing image recognition', () => {
  const result = localMediaInventory(context()); assert.equal(result.items.length, 1); assert.equal(result.items[0].checks.length, 2); assert.match(result.summary, /does not recognize/);
});
test('configuration saves use revisions and preserve settings after a stale write', () => {
  const { engine } = runtime(), settings = engine.settings(); settings.config.modes[0].name = 'Our coach';
  assert.equal(engine.save(settings.config, 0).config.revision, 1);
  assert.throws(() => engine.save(defaultAgentSettings().config, 0), /changed/);
  assert.equal(engine.settings().config.modes[0].name, 'Our coach');
});
test('new sessions snapshot inputs and do not execute a workflow or model', async () => {
  const { engine } = runtime(), cfg = engine.settings().config; cfg.workflows[0].graph.inputs = [{ name: 'subject', label: 'Subject', type: 'string', required: false }]; engine.save(cfg, 0);
  const created = await session(engine); assert.deepEqual(created.steps, []); assert.equal(created.usage.modelCalls, 0); assert.equal(created.workflow?.inputs[0].name, 'subject');
  const next = engine.settings(); next.config.workflows[0].graph.inputs = []; engine.save(next.config, next.config.revision);
  assert.equal(engine.get(created.id).workflow?.inputs[0].name, 'subject');
});
test('one continuation executes one deterministic step and duplicates never rerun it', async () => {
  const { engine } = runtime(); let current = await session(engine); current = turn(engine, current, 'workflow');
  assert.ok(current.steps.every(step => step.status === 'pending'));
  const request = { requestId: crypto.randomUUID(), revision: current.revision, action: 'advance' as const };
  current = engine.turn(current.id, request); assert.equal(current.steps.filter(step => step.status === 'complete').length, 1);
  assert.deepEqual(engine.turn(current.id, request), current);
  assert.throws(() => engine.turn(current.id, { ...request, requestId: crypto.randomUUID() }), /changed/);
});
test('request IDs cannot be reused to smuggle a different message', async () => {
  const { engine } = runtime(), created = await session(engine), request = { requestId: crypto.randomUUID(), revision: created.revision, action: 'message' as const, message: 'Caption: Our aquarium.' };
  engine.turn(created.id, request);
  assert.throws(() => engine.turn(created.id, { ...request, message: 'Caption: Different text.' }), /different actions/);
});
test('local title syntax cannot consume the next line and alt-only edits preserve captions', async () => {
  const { engine } = runtime(), created = await session(engine);
  const result = turn(engine, created, 'message', 'Title:\nCaption: A quiet afternoon.');
  assert.equal(result.suggestion?.title, undefined);
  const alt = turn(engine, result, 'message', 'Alt: A pink axolotl near aquatic plants.');
  assert.equal(alt.suggestion?.captions?.[0].caption, '');
  assert.equal(alt.suggestion?.captions?.[0].alt, 'A pink axolotl near aquatic plants.');
});
test('local chat supplies only author wording as a reviewed caption, without publishing', async () => {
  const { engine } = runtime(), created = await session(engine), updated = turn(engine, created, 'message', 'Caption: Our axolotl exploring the aquarium.');
  assert.equal(updated.suggestion?.captions?.[0].caption, 'Our axolotl exploring the aquarium.'); assert.equal(updated.usage.modelCalls, 0);
  const before = post(), after = applyAgentSuggestion(before, updated.suggestion!);
  assert.equal(parseDocument(after.document).blocks[0].caption, 'Our axolotl exploring the aquarium.');
  assert.equal(after.status, before.status); assert.equal(after.publishedAt, before.publishedAt); assert.equal(after.coverKey, before.coverKey);
  assert.equal(parseDocument(before.document).blocks[0].caption, '');
});
test('workflow completes through explicit advances and preserves media references', async () => {
  const { engine } = runtime(); let current = await session(engine); current = turn(engine, current, 'message', 'Caption: Floating through the plants.'); current = turn(engine, current, 'workflow');
  for (let i = 0; i < 3; i++) current = turn(engine, current, 'advance');
  assert.equal(current.status, 'review'); assert.ok(current.steps.every(step => step.status === 'complete')); assert.equal(current.usage.modelCalls, 0);
  assert.equal(parseDocument(applyAgentSuggestion(post(), current.suggestion!).document).blocks[0].key, image.key);
});
test('local runtime blocks all paid providers even if an administrator checks the config switch', async () => {
  const { engine } = runtime(), cfg = engine.settings().config; cfg.allowPaidExecution = true; cfg.models[1].enabled = true; cfg.models[1].target = 'an-explicit-model-id'; cfg.agents[0].modelId = cfg.models[1].id; engine.save(cfg, 0);
  const created = await session(engine); assert.throws(() => turn(engine, created, 'message', 'Hello'), /do not run in local preview/); assert.equal(engine.get(created.id).usage.modelCalls, 0);
});
test('live mode and agent revocation also prevent local snapshot execution', async () => {
  const { engine } = runtime(), created = await session(engine), cfg = engine.settings().config; cfg.modes[0].enabled = false; engine.save(cfg, 0);
  assert.throws(() => turn(engine, created, 'message', 'Hello'), /disabled/);
});
test('draft suggestions cannot create media, inject HTML, or target missing captions', () => {
  assert.throws(() => applyAgentSuggestion(post(), { summary: 'Bad file', blocks: [{ id: 'bad', type: 'image', key: image.key }] }), /Add media yourself/);
  assert.throws(() => applyAgentSuggestion(post(), { summary: 'Bad caption', captions: [{ blockId: 'missing', caption: 'Oops' }] }), /unique media block/);
  const changed = applyAgentSuggestion(post(), { summary: 'Text', blocks: [{ id: 'not-reused', type: 'text', nodes: [{ tag: 'script', text: 'not rendered' }, { tag: 'p', children: [{ tag: '#text', text: '<b>literal text</b>' }] }] }] });
  const added = parseDocument(changed.document).blocks[1]; assert.notEqual(added.id, 'not-reused'); assert.equal(added.nodes?.length, 1); assert.equal(added.nodes?.[0].children?.[0].text, '<b>literal text</b>');
});
test('deleting a conversation removes its transcript while leaving the post unchanged', async () => {
  const { engine, store } = runtime(), created = await session(engine), before = post(); engine.delete(created.id);
  assert.throws(() => engine.get(created.id), /no longer available/); assert.equal(store.size, 0); assert.deepEqual(before, post());
});
