import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmbedURL, createCreatorURL, createHostSelectionURL, readGameSelection, integrationOrigin, parseGameStudioEvent } from '../src/lib/integration.ts';
const gameId = '11111111-1111-4111-8111-111111111111';
test('common creator and embed links contain only public identifiers', () => {
  const embed = new URL(createEmbedURL('https://games.example.com',gameId,{hostId:'academy',channel:'test-channel'}));
  assert.equal(embed.pathname,`/embed/games/${gameId}`);assert.equal(embed.searchParams.get('host'),'academy');
  assert.equal(new URL(createCreatorURL(embed.origin,{gameId,hostId:'academy'})).searchParams.get('game'),gameId);
  assert.throws(()=>createCreatorURL(embed.origin,{hostId:'//evil.example'}));
  assert.throws(()=>createEmbedURL(embed.origin,'javascript:alert(1)'));
});
test('integration origins cannot inject credentials, queries or external redirects', () => {
  for(const url of ['http://production.example','https://user:pass@example.com','https://example.com/path','https://example.com?token=x','javascript:alert(1)'])assert.throws(()=>integrationOrigin(url));
  assert.equal(integrationOrigin('http://127.0.0.1:5180'),'http://127.0.0.1:5180');
});
test('events validate exact version, identity and bounded engine result without authority', () => {
  const event={source:'nce-game-studio',version:1,channel:'test-channel',type:'completed',gameId,publishedRevision:2,result:{outcome:'won',elapsed:40,score:10,points:210,reviewedLevelIds:['level-1']}};
  assert.ok(parseGameStudioEvent(event));assert.equal(parseGameStudioEvent({...event,token:'secret'}),undefined);
  assert.equal(parseGameStudioEvent({...event,version:2}),undefined);
  assert.equal(parseGameStudioEvent({...event,result:{...event.result,points:Infinity}}),undefined);
  assert.equal(parseGameStudioEvent({...event,result:{...event.result,reviewedLevelIds:['level-1','level-1']}}),undefined);
  assert.equal(parseGameStudioEvent({...event,result:{...event.result,grade:100}}),undefined);
});
test('published selection returns only public identity to an approved fixed host path',()=>{
  const url=createHostSelectionURL('https://school.example.com','/admin/games','https://games.example.com',gameId,3);
  assert.equal(new URL(url).origin,'https://school.example.com');
  assert.deepEqual(readGameSelection(url,'https://games.example.com'),{gameId,publishedRevision:3});
  assert.equal(readGameSelection(url,'https://other.example.com'),undefined);
  assert.equal(readGameSelection(url+'&gameStudioRevision=4','https://games.example.com'),undefined);
  assert.throws(()=>createHostSelectionURL('https://school.example.com','//evil.example.com','https://games.example.com',gameId,3));
  assert.throws(()=>createHostSelectionURL('https://school.example.com','/admin/../escape','https://games.example.com',gameId,3));
});
