import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountGame } from '../src/lib/integration.ts';

const gameId = '11111111-1111-4111-8111-111111111111';
test('host SDK accepts only its exact player window, origin, game and channel, then removes its listener', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const listeners = new Set<(event: MessageEvent) => void>();
  const flags: string[] = [], results: unknown[] = [];
  let appended = false, removed = false;
  const playerWindow = {}, frame = { src: '', title: '', referrerPolicy: '', style: { cssText: '' }, sandbox: { add: (...values: string[]) => flags.push(...values) }, contentWindow: playerWindow, remove: () => { removed = true; } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (name: string, listener: (event: MessageEvent) => void) => { assert.equal(name, 'message'); listeners.add(listener); }, removeEventListener: (name: string, listener: (event: MessageEvent) => void) => { assert.equal(name, 'message'); listeners.delete(listener); } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (name: string) => { assert.equal(name, 'iframe'); return frame; } } });
  try {
    const container = { append: (value: unknown) => { assert.equal(value, frame); appended = true; } } as unknown as HTMLElement;
    const mounted = mountGame(container, { studioOrigin: 'https://games.example', hostId: 'academy', gameId, onEvent: event => results.push(event) });
    assert.equal(appended, true); assert.equal(mounted.iframe, frame);
    assert.equal(frame.referrerPolicy, 'strict-origin'); assert.ok(flags.includes('allow-scripts')); assert.ok(!flags.includes('allow-top-navigation'));
    const channel = new URL(frame.src).searchParams.get('channel'); assert.ok(channel);
    const send = (data: unknown, origin = 'https://games.example', source: unknown = playerWindow) => { for (const listener of listeners) listener({ origin, source, data } as MessageEvent); };
    const ready = { source: 'nce-game-studio', version: 1, channel, type: 'ready', gameId };
    send(ready, 'https://evil.example'); send(ready, 'https://games.example', {}); send({ ...ready, channel: 'other-frame' }); send({ ...ready, gameId: '22222222-2222-4222-8222-222222222222' }); send({ ...ready, accessToken: 'never-accepted' });
    assert.equal(results.length, 0);
    send(ready); assert.equal(results.length, 1);
    const completed = { ...ready, type: 'completed', publishedRevision: 2, result: { outcome: 'won', elapsed: 35, score: 6, reviewedLevelIds: ['level-1'] } };
    send(completed); assert.equal(results.length, 2);
    completed.result.score = 999; assert.equal((results[1] as typeof completed).result.score, 6);
    mounted.destroy(); assert.equal(removed, true); assert.equal(listeners.size, 0);
    send(ready); assert.equal(results.length, 2);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
