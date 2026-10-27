import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostLoginLaunch } from '../src/lib/host-login.ts';
import { createCreatorURL } from '../src/lib/integration.ts';

const ready = { configured:true, checking:false, authenticated:false, framed:false, failed:false };
const game = '11111111-1111-4111-8111-111111111111';
const launch = (path:string, state=ready) => hostLoginLaunch(path,['axolotl-news','academy'],state);

test('an approved host can request one top-level sign-in using public navigation data only',()=>{
  const link = new URL(createCreatorURL('https://studio.example',{hostId:'academy',gameId:game,autoLogin:true}));
  assert.equal(link.searchParams.get('login'),'auto');
  const attempt = launch(link.pathname+link.search)!;
  assert.equal(attempt.hostId,'academy');
  assert.equal(attempt.destination,`/game-studio?game=${game}`);
  assert.equal(attempt.consumedPath,`/game-studio?host=academy&game=${game}`);
  assert.equal(launch(attempt.consumedPath),undefined);
  assert.equal(launch('/game-studio'),undefined);
  assert.deepEqual(launch('/game-studio?host=axolotl-news&login=auto'),{
    hostId:'axolotl-news',destination:'/game-studio',consumedPath:'/game-studio?host=axolotl-news',
  });
});

test('explicit host entry reasserts an authenticated account, while errors and consumed entries never restart',()=>{
  const path='/game-studio?host=academy&login=auto';
  assert.deepEqual(launch(path,{...ready,authenticated:true}),launch(path,ready));
  for(const state of [{...ready,configured:false},{...ready,checking:true},{...ready,framed:true},{...ready,failed:true}])assert.equal(launch(path,state),undefined);
  // The consumed path also survives full reload, callback cancellation and a failed exchange.
  const consumed=launch(path)!.consumedPath;
  for(const state of [ready,{...ready,failed:true},{...ready,authenticated:true}])assert.equal(launch(consumed,state),undefined);
});

test('unknown, repeated, malformed and external navigation cannot trigger host SSO',()=>{
  for(const path of ['/game-studio?host=unapproved&login=auto','/game-studio?login=auto','/games?host=academy&login=auto',
    '/oauth/callback?host=academy&login=auto','/game-studio?host=academy&host=axolotl-news&login=auto',
    '/game-studio?host=academy&login=auto&login=auto','/game-studio?host=academy&login=true',
    '/game-studio?host=academy&login=auto&returnTo=https://evil.example','//evil.example/game-studio?host=academy&login=auto',
    '/game-studio?host=academy&login=auto#fragment','/game-studio?host=academy&login=auto&game=',
    `/game-studio?host=academy&login=auto&game=${game}&game=${game}`,
    '/game-studio?host=academy&login=auto&access_token=forbidden'])assert.equal(launch(path),undefined,path);
  assert.throws(()=>createCreatorURL('https://studio.example',{autoLogin:true}),/host identifier/);
  assert.throws(()=>createCreatorURL('https://studio.example',{hostId:'academy',autoLogin:'true' as unknown as boolean}),/boolean/);
  assert.equal(new URL(createCreatorURL('https://studio.example',{hostId:'academy',autoLogin:false})).searchParams.has('login'),false);
});
