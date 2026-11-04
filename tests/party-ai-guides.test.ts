import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import * as runtime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { PartyPlayerName, partyPlayerLabel } from '../src/components/PartyPlayerName';

test('AI names have a visible accessible badge while legacy human names stay ordinary text', () => {
  const ai = { name: '<Nova>', isAI: true }, human = { name: 'Nova' };
  const markup = renderToStaticMarkup(createElement(PartyPlayerName, { player: ai }));
  assert.match(markup, /&lt;Nova&gt;/); assert.match(markup, /class="party-ai-badge"/); assert.match(markup, /aria-label="AI player"/);
  assert.equal(renderToStaticMarkup(createElement(PartyPlayerName, { player: human })), 'Nova');
  assert.equal(partyPlayerLabel(ai), '<Nova> · AI'); assert.equal(partyPlayerLabel(human), 'Nova'); assert.equal(partyPlayerLabel(undefined, 'A player'), 'A player');
});

test('all six online game guides explain explicit AI seats and Mafia automatic narration without changing manual hosting', () => {
  const catalog = JSON.parse(readFileSync(new URL('../config/party-games.json', import.meta.url), 'utf8')), exports: Record<string, any> = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/components/PartyInstructions.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { exports, require(name: string) { if (name === 'react/jsx-runtime') return runtime; if (name === '../../config/party-games.json') return { default: catalog }; if (name === '../party-instructions.css') return {}; throw new Error(name); } });
  for (const game of catalog.games) {
    const online = renderToStaticMarkup(createElement(exports.PartyInstructions, { kind: game.id }));
    assert.match(online, /Playing with AI/); assert.match(online, /AI badge/); assert.match(online, /never replaced automatically/);
    if (game.id === 'mafia') { assert.match(online, /use automatic narrator/); assert.match(online, /Start remains a separate choice/); }
    const manual = renderToStaticMarkup(createElement(exports.PartyInstructions, { kind: game.id, mode: 'in-person' }));
    assert.doesNotMatch(manual, /Playing with AI|AI badge|Fill with AI/); assert.match(manual, /the lead controls the game/);
  }
});
