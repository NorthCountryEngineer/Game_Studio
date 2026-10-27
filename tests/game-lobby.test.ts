import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMultiplayerLobbyPath, watchMultiplayerLobbyEntry } from '../src/lib/game-lobby';

const game = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
function surface(search: string, hash = '', pathname = `/games/${game}`) {
  const joins: string[] = [], rejected: boolean[] = [], replacements: string[] = [];
  const listeners = new Set<() => void>();
  const location = { pathname, search, hash };
  const cleanup = watchMultiplayerLobbyEntry({ location, history: { state: null, replaceState: (_state, _title, url) => { replacements.push(String(url)); const next = new URL(String(url), 'https://games.example'); location.search = next.search; location.hash = next.hash; } }, addEventListener: (_event, listener) => { listeners.add(listener); }, removeEventListener: (_event, listener) => { listeners.delete(listener); } }, game, id => joins.push(id), () => rejected.push(true));
  return { joins, rejected, replacements, listeners, cleanup };
}
test('a public room navigation is consumed once and keeps unrelated navigation context', () => {
  assert.equal(createMultiplayerLobbyPath(game, room), `/games/${game}?room=${room}`);
  const entry = surface(`?host=axolotl-news&room=${room}`);
  assert.deepEqual(entry.joins, [room]); assert.deepEqual(entry.rejected, []);
  assert.deepEqual(entry.replacements, [`/games/${game}?host=axolotl-news`]);
  entry.listeners.forEach(listener => listener()); assert.equal(entry.joins.length, 1);
  entry.cleanup(); assert.equal(entry.listeners.size, 0);
});
test('malformed, ambiguous and mixed invitation links never claim a public seat', () => {
  for (const args of [[`?room=${room}&room=${room}`], ['?room=javascript:alert(1)'], [`?room=${room}`, '#coop=private-capability']]) {
    const entry = surface(...args as [string, string?, string?]);
    assert.deepEqual(entry.joins, []); assert.deepEqual(entry.rejected, [true]); entry.cleanup();
  }
  for (const invalid of ['../settings', 'ABCDEFAB-2222-4222-8222-222222222222', '', `${room}?token=private`]) assert.throws(() => createMultiplayerLobbyPath(game, invalid));
});
test('an old game listener cannot consume the destination game room hint during navigation', () => {
  const entry = surface(`?room=${room}`, '', `/games/${room}`);
  entry.listeners.forEach(listener => listener());
  assert.deepEqual(entry.joins, []); assert.deepEqual(entry.rejected, []); assert.deepEqual(entry.replacements, []);
  entry.cleanup();
});
