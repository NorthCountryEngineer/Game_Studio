// Synthetic Vite-only rehearsal. Never imported by the production application.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WordGameEditor } from '../../src/components/WordGameEditor';
import { MultiGameEditor } from '../../src/components/MultiGameEditor';
import { defaultWordGameSpec } from '../../src/lib/word-game-design';
import { defaultMultiGameSpec } from '../../src/lib/multi-game';
import type { CrosswordSpec, GameSpec, MultiGameSpec } from '../../src/lib/game-types';
import type { CrosswordGenerator } from '../../src/components/CrosswordSuggestionsEditor';
import '../../src/styles.css';
import '../../src/games.css';
import '../../src/service.css';
import '../../src/service-app.css';

function Rehearsal() {
  const [kind, setKind] = useState<'standalone' | 'multi'>('standalone'), [revision, setRevision] = useState(0), [dirty, setDirty] = useState(false), [notice, setNotice] = useState(''), [calls, setCalls] = useState(0);
  const [spec, setSpec] = useState<GameSpec>(() => ({ ...defaultWordGameSpec('crossword', 'nature'), title: 'Our Solar System', description: 'Planets, spacecraft and the sky beyond Earth.' }));
  function change(next: GameSpec) { setSpec(next); setDirty(true); setNotice('Unsaved changes. Save and playtest before publishing.'); }
  function save() { setDirty(false); setRevision(value => value + 1); setNotice('Synthetic draft saved. A fresh playtest is still required.'); }
  function generator(path: string[]): CrosswordGenerator {
    return { status: { available: true, modeName: 'Synthetic crossword assistant', modelName: 'Mock provider' }, generate: async () => {
      const target = spec.version === 8 ? spec.steps.find(step => step.id === path[0]) : undefined;
      const crossword = spec.version === 3 && spec.genre === 'crossword' ? spec : target?.type === 'game' && target.spec.version === 3 && target.spec.genre === 'crossword' ? target.spec : undefined;
      if (!crossword) throw new Error('Select a saved crossword.');
      const nextRevision = revision + 2;
      await Promise.resolve();
      setRevision(nextRevision); setCalls(value => value + 1);
      return { revision: nextRevision, proposal: { requestId: crypto.randomUUID(), path, title: crossword.title, description: crossword.description, entries: (defaultWordGameSpec('crossword', 'space') as CrosswordSpec).puzzle.entries } };
    } };
  }
  function choose(next: 'standalone' | 'multi') { setKind(next); setDirty(false); setRevision(0); setNotice(''); setCalls(0); setSpec(next === 'multi' ? defaultMultiGameSpec() : { ...defaultWordGameSpec('crossword', 'nature'), title: 'Our Solar System', description: 'Planets, spacecraft and the sky beyond Earth.' }); }
  return <main className="game-workbench" style={{ maxWidth: 1050, padding: 24, margin: 'auto' }}><span className="eyebrow">LOCAL SYNTHETIC REHEARSAL</span><h1>Crossword word suggestions</h1><p>This fixture uses prewritten synthetic responses. No AI service is called.</p><div className="game-detail-actions"><button className="button secondary" onClick={() => choose('standalone')}>Standalone crossword</button><button className="button secondary" onClick={() => choose('multi')}>Multi-game crossword</button><span>Mock requests: {calls}</span></div><p role="status">{notice}</p>{kind === 'standalone' && spec.version === 3 ? <WordGameEditor key="standalone" spec={spec} disabled={false} dirty={dirty} revision={revision} change={change} save={save} crosswordGenerator={generator([])}/> : spec.version === 8 ? <MultiGameEditor key="multi" spec={spec as MultiGameSpec} library={[]} disabled={false} dirty={dirty} revision={revision} onChange={change} save={save} crosswordGenerator={generator}/> : null}</main>;
}
createRoot(document.getElementById('root')!).render(<Rehearsal/>);
