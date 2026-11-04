import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinMultiplayerByPassphrase, MultiplayerAPIError, multiplayerRequest } from '../src/lib/game-multiplayer.ts';

const identity = { requestId: '22222222-2222-4222-8222-222222222222', guestToken: 'g'.repeat(43) };
const binding = { game_id: '11111111-1111-4111-8111-111111111111', published_revision: 7, spec_sha256: 'a'.repeat(64) };

test('passphrase admission sends the normalized phrase only in a credential-free body with the exact publication', async () => {
  const previous = globalThis.fetch, requests: { url: string; options: RequestInit }[] = [];
  try {
    globalThis.fetch = (async (url, options) => { requests.push({ url: String(url), options: options! }); return new Response('{"roomId":"accepted"}', { status: 200 }); }) as typeof fetch;
    assert.deepEqual(await joinMultiplayerByPassphrase('https://relay.example', binding, '  Purple   Comet  ', identity), { roomId: 'accepted' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://relay.example/multiplayer/join-by-passphrase');
    assert.equal(requests[0].options.credentials, 'omit');
    assert.equal(requests[0].options.referrerPolicy, 'no-referrer');
    assert.equal(requests[0].options.redirect, 'error');
    assert.deepEqual(requests[0].options.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(String(requests[0].options.body)), { requestId: identity.requestId, guestToken: identity.guestToken, passphrase: 'purple comet', gameId: binding.game_id, publishedRevision: 7, specSha256: binding.spec_sha256 });
    assert.throws(() => joinMultiplayerByPassphrase('https://relay.example', binding, 'short', identity));
    assert.throws(() => joinMultiplayerByPassphrase('https://relay.example', binding, 'secret\nphrase', identity));
    assert.throws(() => joinMultiplayerByPassphrase('https://relay.example', binding, 'purple comet', { ...identity, requestId: 'not-a-room-id' }));
    assert.throws(() => joinMultiplayerByPassphrase('https://relay.example', binding, 'purple comet', { ...identity, guestToken: 'short' }));
    assert.equal(requests.length, 1);
  } finally { globalThis.fetch = previous; }
});

test('phrase failures give bounded help without echoing response secrets or distinguishing missing and claimed seats', async () => {
  const previous = globalThis.fetch;
  try {
    const messages: string[] = [];
    for (const status of [401, 403, 404, 409, 410]) {
      globalThis.fetch = (async () => new Response('{"error":"private phrase or seat token"}', { status })) as typeof fetch;
      await assert.rejects(() => joinMultiplayerByPassphrase('https://relay.example', binding, 'purple comet', identity), error => {
        assert.ok(error instanceof MultiplayerAPIError); assert.equal(error.status, status); messages.push(error.message); assert.equal(error.message.includes('private phrase'), false); return true;
      });
    }
    assert.equal(new Set(messages).size, 1);
    globalThis.fetch = (async () => new Response('{}', { status: 409 })) as typeof fetch;
    await assert.rejects(() => multiplayerRequest('https://relay.example', '/multiplayer/rooms', 'POST', { passphrase: 'purple comet' }), /passphrase may already be in use/);
    await assert.rejects(() => multiplayerRequest('https://relay.example', '/multiplayer/join-by-passphrase?passphrase=purple', 'POST', {}), /request is invalid/);
    await assert.rejects(() => multiplayerRequest('https://relay.example', '/multiplayer/join-by-passphrase', 'DELETE', {}), /request is invalid/);
  } finally { globalThis.fetch = previous; }
});
