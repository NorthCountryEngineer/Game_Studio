// Vite-only synthetic rehearsal entry. Not imported by the production application.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { GamePlayer } from '../../src/components/GamePlayer';
import { createPlatformerSpec } from '../../src/lib/game-flow';
import { parseFlowStudioEvent, requestHostMaterial } from '../../src/lib/game-flow-integration';
import '../../src/games.css';
import '../../src/service.css';

const spec = createPlatformerSpec();
spec.title = 'Synthetic Pixel Journey'; spec.levels = spec.levels!.slice(0, 2);
spec.levels.forEach(level => { level.rules.goal = 3; level.rules.difficulty = 1; });
spec.flow = { version: 1, nodes: [
  { id: 'step-1', type: 'menu', title: 'Choose a world' },
  { id: 'step-2', type: 'material', title: 'Warm-up exercise', kind: 'exercise', reference: 'demo:warm-up', required: true },
  { id: 'step-3', type: 'level', levelId: 'level-1' },
  { id: 'step-4', type: 'material', title: 'Optional video', kind: 'video', reference: 'demo:video', required: false },
  { id: 'step-5', type: 'level', levelId: 'level-2' },
] };
const channel = new URLSearchParams(location.search).get('channel') || 'synthetic-rehearsal';
const binding = { channel, gameId: '11111111-1111-4111-8111-111111111111', publishedRevision: 1 };
const hostOrigin = 'http://127.0.0.1:5181';
const connected = window.parent !== window && document.referrer && new URL(document.referrer).origin === hostOrigin;
createRoot(document.getElementById('root')!).render(<React.StrictMode><main style={{ padding: 24 }}><span className="eyebrow">LOCAL SYNTHETIC REHEARSAL · NO ACCOUNTS OR AWARDS</span><h1>{spec.title}</h1><GamePlayer spec={spec}
  onMaterialRequest={connected ? (request, signal) => requestHostMaterial(window.parent, hostOrigin, binding, request, signal) : undefined}
  onFlowProgress={(progress, result) => { if (!connected) return; const event = parseFlowStudioEvent({ source: 'nce-game-studio', version: 3, type: 'flow-progress', ...binding, progress, ...(result ? { result } : {}) }); if (event) window.parent.postMessage(event, hostOrigin); }}
/></main></React.StrictMode>);
