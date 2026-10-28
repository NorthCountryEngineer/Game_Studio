// Synthetic Vite-only rehearsal. Never imported by the production application.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WordGameEditor } from '../../src/components/WordGameEditor';
import { MultiGameEditor } from '../../src/components/MultiGameEditor';
import { GamePlayer } from '../../src/components/GamePlayer';
import { defaultWordGameSpec } from '../../src/lib/word-game-design';
import { defaultMultiGameSpec } from '../../src/lib/multi-game';
import { validateGameSpec } from '../../src/lib/game-design';
import { applyWordSearchSuggestions } from '../../src/lib/word-search-suggestions';
import type { GameSpec, WordSearchSpec } from '../../src/lib/game-types';
import type { WordSearchGenerator } from '../../src/components/WordSearchSuggestionsEditor';
import '../../src/styles.css';
import '../../src/games.css';
import '../../src/service.css';
import '../../src/service-app.css';

function standalone(): WordSearchSpec {
  const spec = defaultWordGameSpec('word-search', 'nature') as WordSearchSpec;
  return { ...spec, title: 'Our Solar System', description: 'Planets, spacecraft and the sky beyond Earth.', puzzle: { ...spec.puzzle, size: 14, seed: 4123, allowBackwards: false } };
}
function journey(): GameSpec {
  const spec = defaultMultiGameSpec();
  return { ...spec, steps: [{ id: 'step-1', type: 'game', spec: { ...standalone(), title: 'Weather Words', description: 'Clouds, rain and changes in the sky.' } }, { id: 'step-2', type: 'game', spec: defaultWordGameSpec('crossword', 'nature') }] };
}
function Rehearsal() {
  const [kind, setKind] = useState<'standalone' | 'multi'>('standalone'), [revision, setRevision] = useState(0), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''), [calls, setCalls] = useState(0), [failNext, setFailNext] = useState(false), [preview, setPreview] = useState(false);
  const [spec, setSpec] = useState<GameSpec>(standalone);
  function change(next: GameSpec) { setSpec(next); setDirty(true); setPreview(false); setNotice('Unsaved changes. Save and playtest before publishing.'); }
  function save() { setSpec(validateGameSpec(spec)); setDirty(false); setRevision(value => value + 1); setNotice('Synthetic draft saved. A fresh playtest is still required.'); }
  function generator(path: string[]): WordSearchGenerator {
    return { status: { available: true, modeName: 'Synthetic word search assistant', modelName: 'Mock provider' }, generate: async () => {
      const step = spec.version === 8 ? spec.steps.find(item => item.id === path[0]) : undefined;
      const target = spec.version === 3 && spec.genre === 'word-search' ? spec : step?.type === 'game' && step.spec.version === 3 && step.spec.genre === 'word-search' ? step.spec : undefined;
      if (!target) throw new Error('Select a saved word search.');
      setBusy(true); setPreview(false); setCalls(value => value + 1);
      try {
        await new Promise(resolve => setTimeout(resolve, 250));
        if (failNext) { setFailNext(false); throw new Error('Synthetic provider failure. Your words are unchanged; try Generate words again.'); }
        const candidates = target.title === 'Weather Words' ? ['RAIN', 'CLOUD', 'STORM', 'WIND', 'SNOW', 'SUN', 'FROST', 'THUNDER', 'LIGHTNING', 'WEATHER'] : ['PLANET', 'STAR', 'ORBIT', 'MOON', 'COMET', 'ROCKET', 'GALAXY', 'MARS', 'SATURN', 'VENUS'];
        const words = applyWordSearchSuggestions(target, candidates).puzzle.words, nextRevision = revision + 2;
        setRevision(nextRevision);
        return { revision: nextRevision, proposal: { requestId: crypto.randomUUID(), path, title: target.title, description: target.description, words } };
      } finally { setBusy(false); }
    } };
  }
  function choose(next: 'standalone' | 'multi') { setKind(next); setDirty(false); setRevision(0); setNotice(''); setCalls(0); setFailNext(false); setPreview(false); setSpec(next === 'multi' ? journey() : standalone()); }
  return <main className="game-workbench" style={{ maxWidth: 1050, padding: 24, margin: 'auto' }}>
    <span className="eyebrow">LOCAL SYNTHETIC REHEARSAL</span><h1>Word search suggestions</h1><p>This fixture uses prewritten synthetic responses. No AI service is called.</p>
    <div className="game-detail-actions"><button className="button secondary" disabled={busy} onClick={() => choose('standalone')}>Standalone word search</button><button className="button secondary" disabled={busy} onClick={() => choose('multi')}>Multi-game word search</button><button className="button secondary" disabled={busy} onClick={() => { setFailNext(true); setNotice('The next explicit mock generation will fail once.'); }}>Fail next mock request</button><span>Mock requests: {calls}</span></div>
    <p role="status">{notice}</p>
    {kind === 'standalone' && spec.version === 3 ? <WordGameEditor key="standalone" spec={spec} disabled={busy} dirty={dirty} revision={revision} change={change} save={save} wordSearchGenerator={generator([])}/> : spec.version === 8 ? <MultiGameEditor key="multi" spec={spec} library={[]} disabled={busy} dirty={dirty} revision={revision} onChange={change} save={save} wordSearchGenerator={generator}/> : null}
    <section className="game-playtest"><h2>Preview saved puzzle</h2><p>Starting or restarting this preview does not generate words or increase the mock request count.</p><button className="button secondary" disabled={busy || dirty} onClick={() => setPreview(value => !value)}>{preview ? 'Close preview' : 'Start saved preview'}</button>{preview && !dirty && <GamePlayer spec={spec} playtest onComplete={() => setNotice('Synthetic playtest complete. No additional generator request was made.')} />}</section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Rehearsal/>);
