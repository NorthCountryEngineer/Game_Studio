import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { defaultGameSpec, designGame } from '../src/lib/game-design.ts';

test('browser and API planners return identical complete plans across new, legacy, and refined games', () => {
  const campaign = designGame('A blue pond platformer with four levels. Collect 20 bubbles, 90 seconds, 4 lives.').spec;
  const cases = [
    { message: 'A gentle garden collecting game with three levels and 10 flowers.' },
    { message: 'A space platformer, 8 levels, difficulty 4, 120 seconds, 5 lives. Title: Little moon' },
    { message: 'One level, collect 7, 30 seconds.' },
    { message: '9 levels and goal 99.' },
    { message: 'Title: Pink 🦎 explorer\nPlayer: Bubbles\nCollectible: star' },
    { message: 'Collect 15, 90 seconds.', current: defaultGameSpec() },
    { message: 'Add levels.', current: defaultGameSpec() },
    { message: 'Make level 2 harder, collect 10, 60 seconds.', current: campaign },
    { message: 'Level 4 difficulty 2, 5 lives, 2 minutes.', current: campaign },
    { message: 'Level 2 gentle and in space.', current: campaign },
    { message: 'Randomize level layouts for level 3.', current: campaign },
    { message: 'Shuffle layouts.', current: campaign },
    { message: 'Replan the progression with 5 levels, collect 18.', current: campaign },
    { message: 'Make the goal 22.', current: campaign },
    { message: 'Title: New name', current: campaign },
    { message: 'Tell me a joke.', current: campaign },
    { message: '4 gentle levels', current: campaign },
    { message: '99 levels', current: { ...campaign, levels: campaign.levels!.map((level, index) => ({ ...level, title: `Authored ${index}`, rules: { ...level.rules, goal: 17 } })) } },
    { message: 'Randomize level 2.', current: campaign },
    { message: 'Level 1 20 snacks, time 90, lives 3.', current: campaign },
    { message: 'Title: <script>\nAdd multiplayer and music.', current: campaign },
  ];
  const python = `import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('parity_games',Path.cwd()/'backend/nce_api/games.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps([m.design_game(c['message'],c.get('current')) for c in json.load(sys.stdin)],ensure_ascii=False))`;
  const actual = JSON.parse(execFileSync('python3', ['-c', python], { input: JSON.stringify(cases), encoding: 'utf8' }));
  cases.forEach((entry, index) => assert.deepEqual(actual[index], designGame(entry.message, entry.current), entry.message));
});
