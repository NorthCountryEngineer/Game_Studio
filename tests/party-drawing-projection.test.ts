import * as roomPassphrases from '../src/lib/room-passphrases';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
function parser() {
  const exports: Record<string, any> = {};
  const source = ts.transpileModule(readFileSync(new URL('../src/lib/party.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  vm.runInNewContext(source, { exports, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, require(name: string) {
    if (name === './room-passphrases') return roomPassphrases; if (name === './core') return { isCore: false };
    if (name === './mafia') return { MAFIA_AVATARS: [['fox', 'Fox']], validateMafiaName: (value: string) => value };
    if (name.endsWith('party-games.json')) return JSON.parse(readFileSync(new URL('../config/party-games.json', import.meta.url), 'utf8'));
    throw new Error(name);
  } });
  return exports.parsePartyRoom;
}
function room(strokes: any[]) { return { version: 1, roomId: id(1), kind: 'sketch-guess', hostId: id(2), status: 'playing', phase: 'draw', phaseId: 1, round: 1, createdAt: 1800000000, deadlineAt: 1800000180, settings: {}, players: [{ id: id(2), name: 'Nova', avatar: 'fox', score: 0 }], winner: null, events: [], chat: [], self: { id: id(2), isHost: true, actionSequence: 1 }, game: { artistId: id(2), strokes, drawingEpoch: 0, drawingAckIds: [] } }; }
function stroke(n: number, count = 20) { return { id: id(n + 10), playerId: id(2), color: '#174a83', width: 4, points: Array.from({ length: count }, (_, index) => [index / count, index / count]) }; }

test('a dense streamed canvas remains readable beyond the old 150-array limit without relaxing other room arrays', () => {
  const parse = parser(), value = room(Array.from({ length: 384 }, (_, n) => stroke(n)));
  value.game.drawingAckIds = Array.from({ length: 128 }, (_, n) => id(n + 10)) as never[];
  assert.equal(parse(value).game.strokes.length, 384);
  assert.equal(parse(value).game.drawingAckIds.length, 128);
  assert.throws(() => parse({ ...value, game: { ...value.game, strokes: [...value.game.strokes, stroke(500)] } }), /unsupported response/);
  assert.throws(() => parse({ ...value, game: { ...value.game, other: Array(151).fill(0) } }), /unsupported response/);
  assert.throws(() => parse({ ...value, kind: 'trivia' }), /unsupported response/);
});

test('drawing projection enforces total geometry, coordinates, unique IDs and acknowledgment bounds', () => {
  const parse = parser(), value = room([stroke(0)]);
  const badStrokes = [[stroke(0), stroke(0)], [stroke(0, 121)], [stroke(0, 0)], [{ ...stroke(0), points: [[0, NaN]] }], [{ ...stroke(0), points: [[0, 1.01]] }], [{ ...stroke(0), width: Infinity }], [{ ...stroke(0), color: 'url(https://example.com)' }], [{ ...stroke(0), private: 'hidden' }], Array.from({ length: 67 }, (_, n) => stroke(n, 120))];
  for (const strokes of badStrokes) assert.throws(() => parse({ ...value, game: { ...value.game, strokes } }), /unsupported response/);
  for (const patch of [{ drawingEpoch: -1 }, { drawingAckIds: Array(129).fill(id(10)) }, { drawingAckIds: [id(10), id(10)] }, { drawingAckIds: ['invalid'] }]) assert.throws(() => parse({ ...value, game: { ...value.game, ...patch } }), /unsupported response/);
});

test('legacy drawing projections still parse without the new epoch or acknowledgment fields', () => {
  const value = room([{ ...stroke(0), id: 's42' }]);
  delete (value.game as any).drawingEpoch; delete (value.game as any).drawingAckIds;
  assert.equal(parser()(value).game.strokes[0].id, 's42');
});
