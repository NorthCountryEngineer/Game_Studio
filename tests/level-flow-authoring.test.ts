import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LevelFlowEditor, LevelSettings, moveFlowStep } from '../src/components/LevelFlowEditor';
import { AsteroidChallengeEditor } from '../src/components/AsteroidChallengeEditor';
import { gameFormatStarters, formatCreationPrompt, buildPlatformerStarter } from '../src/components/WordGameEditor';
import { createPlatformerSpec, defaultGameFlow } from '../src/lib/game-flow';
import { designArcadeGame, updateAsteroidSettings, validateArcadeGameSpec } from '../src/lib/game-design';
import type { GameFlowNode } from '../src/lib/game-types';

const render = (component: Parameters<typeof createElement>[0], props: any) => renderToStaticMarkup(createElement(component, props));

test('the platformer starter is distinct and creates a valid editable themed game', () => {
  const starter = gameFormatStarters.find(item => item.id === 'platformer'); assert.ok(starter);
  assert.equal(starter.label, '2D Platformer'); assert.match(starter.description, /player-chosen/);
  const parsed = designArcadeGame(formatCreationPrompt('platformer', starter.example)).spec;
  const spec = buildPlatformerStarter(parsed, starter.example); validateArcadeGameSpec(spec);
  assert.equal(spec.version, 7); assert.equal(spec.genre, 'platformer'); assert.ok(spec.levels!.length > 1);
  assert.deepEqual(spec.levels!.map(level => level.theme), ['garden', 'pond', 'space']);
  assert.deepEqual(parsed.levels!.map(level => level.seed), spec.levels!.map(level => level.seed));
});

test('custom platformer creation preserves authored worlds, titles, layouts and requirements', () => {
  const base = createPlatformerSpec();
  base.levels![0] = { ...base.levels![0], title: 'Custom moon landing', theme: 'space', seed: 8971 };
  base.levels![1] = { ...base.levels![1], title: 'My lakeside level', theme: 'pond', seed: 3172 };
  base.flow = { version: 1, nodes: [...defaultGameFlow(base).nodes, { id: 'step-9', type: 'material', title: 'My lesson', kind: 'lesson', reference: 'client:my-lesson', required: true }] };
  const before = structuredClone(base), spec = buildPlatformerStarter(base, 'My own two lakeside worlds and a moon landing');
  assert.deepEqual(spec.levels, before.levels); assert.deepEqual(spec.flow, before.flow); assert.deepEqual(base, before);
  validateArcadeGameSpec(spec);
});

test('reordering preserves every authored step and pins the level home first', () => {
  const spec = createPlatformerSpec(), flow = defaultGameFlow(spec);
  const nodes: GameFlowNode[] = [{ id: 'step-9', type: 'menu', title: 'My worlds' }, flow.nodes[0], { id: 'step-10', type: 'material', title: 'A real client lesson', kind: 'lesson', reference: 'ncacademy:lesson-123', required: true }, ...flow.nodes.slice(1)];
  const original = structuredClone(nodes), moved = moveFlowStep(nodes, 'step-10', 0);
  assert.equal(moved[0].type, 'menu'); assert.equal(moved[1].id, 'step-10');
  assert.deepEqual([...moved].sort((a, b) => a.id.localeCompare(b.id)), [...nodes].sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(nodes, original); assert.deepEqual(moveFlowStep(nodes, 'step-9', 3), original);
});

test('flow authoring exposes a selected-step editor and accessible alternatives to dragging', () => {
  const spec = createPlatformerSpec(), markup = render(LevelFlowEditor, { spec, disabled: false, onChange() {} });
  for (const text of ['Your game flow.', 'Ordered game flow', 'Game level', 'Lesson', 'Video', 'Exercise', 'Level home', 'Move step 1 later', 'Level title', 'Theme', 'Layout seed']) assert.ok(markup.includes(text), text);
  assert.match(markup, /draggable="true"/); assert.doesNotMatch(markup, /Player color/);
});

test('unfinished material fields remain editable until explicit save validation', () => {
  const spec = createPlatformerSpec(); spec.flow = { version: 1, nodes: [...defaultGameFlow(spec).nodes, { id: 'step-9', type: 'material', title: '', kind: 'video', reference: '', required: false }] };
  assert.throws(() => validateArcadeGameSpec(spec));
  assert.doesNotThrow(() => render(LevelFlowEditor, { spec, disabled: false, onChange() {} }));
});

test('continuous settings omit finite objectives, level titles and countdowns', () => {
  const level = createPlatformerSpec().levels![0], markup = render(LevelSettings, { level, continuous: true, onChange() {} });
  for (const text of ['Starting world', 'Starting difficulty', 'Starting lives', 'Shuffle layout']) assert.ok(markup.includes(text), text);
  for (const text of ['Level title', 'Level description', 'Collectible goal', 'Time limit', 'Ordered game flow']) assert.ok(!markup.includes(text), text);
});

test('continuous mode cannot silently erase a custom material flow', () => {
  const spec = updateAsteroidSettings(designArcadeGame('Asteroids with 3 levels and shooting').spec, {});
  spec.flow = { version: 1, nodes: [...defaultGameFlow(spec).nodes, { id: 'step-9', type: 'material', title: 'A client lesson', kind: 'lesson', reference: 'client:lesson', required: true }] };
  const before = structuredClone(spec), markup = render(AsteroidChallengeEditor, { spec, change() {} });
  assert.match(markup, /type="checkbox" disabled=""/); assert.match(markup, /before switching to continuous play/);
  assert.throws(() => updateAsteroidSettings(spec, { endless: true })); assert.deepEqual(spec, before);
});
