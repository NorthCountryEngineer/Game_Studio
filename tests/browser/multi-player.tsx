// Synthetic Vite-only rehearsal. Never imported by the production application.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { GamePlayer } from '../../src/components/GamePlayer';
import { validateMultiGameSpec } from '../../src/lib/multi-game';
import { defaultGameSpec, updateAsteroidSettings } from '../../src/lib/game-design';
import { parseMultiStudioEvent, requestMultiHostMaterial } from '../../src/lib/multi-game-integration';
import '../../src/games.css';
import '../../src/service.css';
import '../../src/service-app.css';

const spec = validateMultiGameSpec({ version: 8, genre: 'multi-game', title: 'Mixed Game Journey', description: 'Crossword, client object, word search and optional free play.', instructions: 'Complete each main step. Free play starts after the journey result is final.', steps: [
  { id: 'step-1', type: 'game', spec: { version: 3, genre: 'crossword', title: 'Three little words', description: '', instructions: 'Solve the three clues.', puzzle: { seed: 31, entries: [{ answer: 'CAT', clue: 'A small feline' }, { answer: 'CAR', clue: 'A road vehicle' }, { answer: 'ART', clue: 'Creative work' }] } } },
  { id: 'step-2', type: 'material', title: 'Client object', kind: 'interactive', reference: 'demo:object-1', required: true },
  { id: 'step-3', type: 'game', spec: { version: 3, genre: 'word-search', title: 'Find three words', description: '', instructions: 'Choose the first and last letter of each word.', puzzle: { seed: 71, size: 10, allowBackwards: false, words: ['CAT', 'DOG', 'SUN'] } } },
  { id: 'step-4', type: 'free-play', spec: updateAsteroidSettings({ ...defaultGameSpec(), title: 'Free-play Asteroids', genre: 'dodge', theme: 'space', arcade: { shooting: true, rotation: true, scoring: true, splitAsteroids: true, highScores: false } }, { endless: true }) },
] });
const channel = new URLSearchParams(location.search).get('channel') || 'synthetic-multi';
const binding = { channel, gameId: '11111111-1111-4111-8111-111111111111', publishedRevision: 1 };
const hostOrigin = 'http://127.0.0.1:5181';
const connected = window.parent !== window && !!document.referrer && new URL(document.referrer).origin === hostOrigin;
createRoot(document.getElementById('root')!).render(<React.StrictMode><main style={{ padding: 24 }}><span className="eyebrow">LOCAL SYNTHETIC REHEARSAL</span><h1>{spec.title}</h1><GamePlayer spec={spec}
  onMultiMaterialRequest={connected ? (request, signal) => requestMultiHostMaterial(window.parent, hostOrigin, binding, request, signal) : undefined}
  onMultiProgress={progress => { if (connected) { const event = parseMultiStudioEvent({ source: 'nce-game-studio', version: 4, type: 'multi-progress', ...binding, progress }); if (event) window.parent.postMessage(event, hostOrigin); } }}
/></main></React.StrictMode>);
