"""Provider-free opponents, fair observations and bounded server scheduling."""
from copy import deepcopy
import json
import socket
import unittest
import uuid
from unittest.mock import patch

from test_party_engine import engine, pid, player


class PartyAITests(unittest.TestCase):
    def setUp(self):
        for name in ('socket', 'create_connection'):
            guard = patch.object(socket, name, side_effect=AssertionError('AI opponents must not use a network.'))
            guard.start(); self.addCleanup(guard.stop)
        self.ai = engine.ai_rules()

    def act(self, state, actor, kind, now=1000, **fields):
        return engine.apply_action(state, actor, {'type': kind, 'phaseId': state['phaseId'], **fields}, now=now)

    def begin(self, kind, **settings):
        state = engine.new_room(player(1), kind, settings=settings, now=1000)
        state['roomId'] = pid(99)
        state = self.act(state, pid(1), 'fill-ai')
        with patch.object(engine, '_shuffle', lambda items: items):
            state = self.act(state, pid(1), 'start')
        return engine.tick(state, 1000)

    def error(self, status, callback):
        with self.assertRaises(engine.PartyError) as raised:
            callback()
        self.assertEqual(raised.exception.status, status)

    def test_explicit_host_lobby_admission_is_badged_bounded_and_removable(self):
        for kind, metadata in engine.GAMES.items():
            state = engine.new_room(player(1), kind, now=1000)
            before = deepcopy(state)
            state = self.act(state, pid(1), 'fill-ai')
            self.assertEqual(before['players'], [before['players'][0]])
            self.assertEqual(len(state['players']), metadata['minPlayers'])
            self.assertTrue(all(item.get('isAI') is True for item in state['players'][1:]))
            self.assertEqual(len({item['id'] for item in state['players']}), len(state['players']))
            view = engine.project(state, pid(1))
            self.assertNotIn('isAI', view['players'][0])
            self.assertTrue(view['players'][1]['isAI'])
            self.assertNotIn('_ai', view)
            self.error(409, lambda: self.act(state, pid(1), 'fill-ai'))
            self.error(400, lambda: self.act(state, pid(1), 'add-ai', name='Impersonated'))
            state = self.act(state, pid(1), 'kick', targetId=state['players'][-1]['id'])
            state = self.act(state, pid(1), 'add-ai')
            self.assertEqual(len({item['name'] for item in state['players']}), len(state['players']))
        state = engine.add_player(engine.new_room(player(1), 'trivia', now=1000), player(2), now=1000)
        self.error(403, lambda: self.act(state, pid(2), 'add-ai'))
        self.error(400, lambda: engine.add_player(state, {**player(3), 'isAI': True}, now=1000))
        state = self.act(state, pid(1), 'start')
        self.error(409, lambda: self.act(state, pid(1), 'add-ai'))

    def test_tick_is_delayed_persistent_immutable_and_not_a_catch_up_loop(self):
        state = self.begin('hand-duel')
        ai_id = state['players'][1]['id']
        self.assertEqual(state['_game']['choices'], {})
        before = deepcopy(state)
        self.assertEqual(engine.tick(state, 1001), before)
        with patch.object(self.ai.secrets, 'choice', lambda choices: choices[0]):
            advanced = engine.tick(state, 1002)
        self.assertEqual(state, before)
        self.assertEqual(advanced['_game']['choices'], {ai_id: 'rock'})
        self.assertEqual(engine.project(advanced, pid(1))['game']['choices'], {})
        self.assertEqual(engine.tick(advanced, 1002), advanced)
        far = engine.tick(advanced, 1000000)
        self.assertLessEqual(far['round'], 2)

    def test_ai_uuid_collisions_never_duplicate_an_existing_human(self):
        state = engine.new_room(player(1), 'trivia', now=1000)
        state = engine.add_player(state, player(2), now=1000)
        before = deepcopy(state)
        with patch.object(engine.uuid, 'uuid4', side_effect=[uuid.UUID(pid(2)), uuid.UUID(pid(3))]):
            result = self.act(state, pid(1), 'add-ai')
        self.assertEqual(len({item['id'] for item in result['players']}), 3)
        self.assertEqual(result['players'][-1]['id'], pid(3))
        with patch.object(engine.uuid, 'uuid4', return_value=uuid.UUID(pid(2))):
            self.error(503, lambda: self.act(state, pid(1), 'add-ai'))
        self.assertEqual(state, before)

    def test_policy_receives_only_own_projection_and_cannot_bypass_game_authority(self):
        for kind in engine.GAMES:
            state = self.begin(kind)
            seen = []
            def policy(view, memory, now):
                seen.append(deepcopy(view))
                self.assertNotIn('_ai', view); self.assertNotIn('_game', view)
                self.assertNotIn('roles', view['game']); self.assertNotIn('order', view['game'])
                self.assertNotIn('correctIndex', view['game'])
                return {'type': 'close'}, {'tooLarge': 'x' * 1100}
            with patch.object(self.ai, 'decide', side_effect=policy):
                result = engine.tick(state, 1002)
            for view in seen:
                self.assertEqual(view, engine.project(state, view['self']['id'], now=1002))
            self.assertEqual(result['status'], 'playing')
            self.assertTrue(all(agent['memory'] == {} for agent in result['_ai'].values()))

    def test_tick_action_and_memory_budgets_survive_poll_bursts(self):
        state = engine.new_room(player(1), 'starship-suspects', now=1000)
        for _ in range(11): state = self.act(state, pid(1), 'add-ai')
        state = self.act(state, pid(1), 'start')
        state = engine.tick(state, 1000)
        with patch.object(self.ai, 'decide', return_value=(None, {'seen': True})) as decide:
            state = engine.tick(state, 1002)
            self.assertEqual(decide.call_count, 8)
            state = engine.tick(state, 1002)
            self.assertEqual(decide.call_count, 11)
            self.assertLess(len(json.dumps(state['_ai']).encode()), 5000)
        state = self.act(state, pid(1), 'close', now=1003)
        self.assertNotIn('_ai', state)

    def test_slow_polls_do_not_starve_tail_seats_in_large_rooms(self):
        for kind, count in (('starship-suspects', 12), ('trivia', 24)):
            state = engine.new_room(player(1), kind, settings={'roundSeconds': 180}, now=1000)
            for _ in range(count - 1): state = self.act(state, pid(1), 'add-ai')
            state = self.act(state, pid(1), 'start')
            state = engine.tick(state, 1000)
            visits = set()
            def policy(view, memory, now):
                visits.add(view['self']['id'])
                return None, {'seen': True}
            with patch.object(self.ai, 'decide', side_effect=policy) as decide:
                for now in (1010, 1020, 1030):
                    previous = decide.call_count
                    state = engine.tick(state, now)
                    self.assertLessEqual(decide.call_count - previous, 8)
            self.assertEqual(len(visits), count - 1)
            self.assertTrue(all(agent['memory'].get('seen') for agent in state['_ai'].values()))

    def test_duel_policy_is_random_sealed_and_ignores_other_choices(self):
        state = self.begin('hand-duel')
        view = engine.project(state, state['players'][1]['id'])
        view['game']['choices'] = {pid(1): 'rock'}
        with patch.object(self.ai.secrets, 'choice', return_value='rock') as choose:
            action, _ = self.ai.decide(view, {}, 1002)
        self.assertEqual(action, {'type': 'choose', 'choice': 'rock'})
        self.assertEqual(tuple(choose.call_args.args[0]), ('rock', 'paper', 'scissors'))

    def test_drop_four_wins_and_blocks_using_only_public_board(self):
        state = self.begin('drop-four')
        ai_id = state['players'][1]['id']
        view = engine.project(state, ai_id)
        view['game']['turnId'] = ai_id
        for identity in (ai_id, pid(1)):
            view['game']['board'] = [[None] * 7 for _ in range(6)]
            view['game']['board'][5][:3] = [identity] * 3
            action, _ = self.ai.decide(view, {}, 1002)
            self.assertEqual(action, {'type': 'drop', 'column': 3})

    def test_trivia_uses_question_knowledge_and_never_hidden_answer_index(self):
        state = self.begin('trivia', rounds=1)
        view = engine.project(state, state['players'][1]['id'])
        view['game']['question'] = {'text': 'Which planet is famous for its large rings?',
                                    'options': ['Mars', 'Saturn', 'Mercury', 'Venus']}
        view['game']['correctIndex'] = 3  # Even a poisoned extra field is ignored.
        with patch.object(self.ai.secrets, 'randbelow', return_value=1):
            action, _ = self.ai.decide(view, {}, 1002)
        self.assertEqual(action, {'type': 'answer', 'answer': 1})
        view['self']['answer'] = 1
        self.assertIsNone(self.ai.decide(view, {}, 1003)[0])

    def test_complete_hand_duel_with_one_human_and_one_computer(self):
        state = self.begin('hand-duel')
        now = 1000
        with patch.object(self.ai.secrets, 'choice', return_value='rock'):
            for _ in range(3):
                now += 5
                state = engine.tick(state, now)
                state = self.act(state, pid(1), 'choose', now=now, choice='paper')
                if state['status'] == 'finished': break
                state = self.act(state, pid(1), 'advance', now=now)
                state = engine.tick(state, now)
        self.assertEqual(state['status'], 'finished')
        self.assertEqual(state['winner'], pid(1))
        self.assertEqual(state['players'][0]['score'], 3)
        state = self.act(state, pid(1), 'restart', now=now + 1)
        self.assertNotIn('_ai', state)
        self.assertTrue(state['players'][1]['isAI'])

    def test_starship_crew_complete_own_tasks_without_reading_other_roles(self):
        state = self.begin('starship-suspects')
        self.assertEqual(state['_game']['roles'][pid(1)], 'impostor')
        for now in range(1002, 1180, 2):
            state = engine.tick(state, now)
            for agent in state['_ai'].values():
                self.assertLessEqual(len(json.dumps(agent['memory'], separators=(',', ':')).encode()), 1024)
            if state['status'] == 'finished': break
        self.assertEqual(state['status'], 'finished')
        self.assertEqual(state['winner'], 'crew')

    def test_eliminated_ai_crew_keep_completing_their_ghost_tasks(self):
        state = self.begin('starship-suspects')
        ghost = state['players'][1]['id']
        state['players'][1]['alive'] = False
        for now in range(1002, 1180, 2):
            state = engine.tick(state, now)
            if state['status'] == 'finished': break
        self.assertEqual(state['winner'], 'crew')
        self.assertTrue(all(task['complete'] for task in state['_game']['tasks'][ghost]))

    def test_sketch_artist_streams_and_guesser_uses_only_public_geometry(self):
        state = self.begin('sketch-guess', rounds=2)
        ai_id = state['players'][1]['id']
        prompt = engine.project(state, pid(1))['self']['prompt']
        strokes = self.ai.sketch().drawing_for(prompt)
        for index, stroke in enumerate(strokes):
            state = self.act(state, pid(1), 'stroke', now=1001 + index, **stroke)
        state = engine.tick(state, 1001 + len(strokes) + 4)
        self.assertEqual(state['phase'], 'reveal')
        self.assertIn(ai_id, state['_game']['guessedIds'])
        state = self.act(state, pid(1), 'advance', now=1002 + len(strokes) + 4)
        state = engine.tick(state, 1002 + len(strokes) + 4)
        artist_view = engine.project(state, ai_id)
        self.assertIn(artist_view['self']['prompt'], self.ai.supported_prompts())
        start = 1002 + len(strokes) + 4
        for now in range(start + 2, start + 35, 2):
            state = engine.tick(state, now)
            if state['phase'] != 'draw': break
        ink = engine.project(state, pid(1))['game']['strokes']
        self.assertGreater(len(ink), 3)
        self.assertNotIn('prompt', engine.project(state, pid(1))['self'])

    def sketch_view(self):
        return {'status': 'playing', 'kind': 'sketch-guess', 'phase': 'draw', 'phaseId': 1, 'round': 1,
                'deadlineAt': 1075, 'settings': {'roundSeconds': 75},
                'self': {'id': pid(2)}, 'game': {'artistId': pid(1), 'strokes': [], 'guessedIds': [], 'drawingEpoch': 0}}

    def test_sketch_guesser_preserves_a_late_attempt_while_ink_is_still_changing(self):
        view, memory = self.sketch_view(), {}
        stroke = {'color': '#000000', 'width': 3, 'points': [[.1, .2], [.3, .4]]}
        view['game']['strokes'] = [deepcopy(stroke) for _ in range(3)]
        with patch.object(self.ai.sketch(), 'rank_guesses', return_value=['treehouse', 'snowman', 'rainbow']):
            first, memory = self.ai.decide(view, memory, 1000)
            self.assertEqual(first['text'], 'treehouse')
            for now in (1002, 1004):
                view['game']['strokes'].append(deepcopy(stroke))
                action, memory = self.ai.decide(view, memory, now)
                self.assertIsNone(action)
            view['game']['strokes'].append(deepcopy(stroke))
            second, memory = self.ai.decide(view, memory, 1006)
            self.assertEqual(second['text'], 'snowman')
            for now in (1008, 1010, 1012):
                view['game']['strokes'].append(deepcopy(stroke))
                action, memory = self.ai.decide(view, memory, now)
                self.assertIsNone(action)
            self.assertIsNone(self.ai.decide(view, memory, 1016)[0])
            third, memory = self.ai.decide(view, memory, 1018)
            self.assertEqual(third['text'], 'rainbow')
            self.assertEqual(len(memory['guesses']), 3)
            self.assertLess(len(json.dumps(memory).encode()), 1024)

    def test_sketch_guesser_clear_does_not_spend_or_reset_guesses_and_new_phase_resets_gates(self):
        view, memory = self.sketch_view(), {}
        stroke = {'color': '#000000', 'width': 3, 'points': [[.1, .2], [.3, .4]]}
        view['game']['strokes'] = [deepcopy(stroke) for _ in range(3)]
        with patch.object(self.ai.sketch(), 'rank_guesses', return_value=['treehouse', 'snowman', 'rainbow']):
            _, memory = self.ai.decide(view, memory, 1000)
            _, memory = self.ai.decide(view, memory, 1006)
            view['game'].update(strokes=[], drawingEpoch=1)
            action, memory = self.ai.decide(view, memory, 1008)
            self.assertIsNone(action)
            self.assertEqual(len(memory['guesses']), 2)
            view['game']['strokes'] = [deepcopy(stroke) for _ in range(3)]
            action, memory = self.ai.decide(view, memory, 1012)
            self.assertIsNone(action)  # Fresh ink resets the idle gate after clear.
            view.update(phaseId=2, round=2, deadlineAt=1150)
            action, memory = self.ai.decide(view, memory, 1013)
            self.assertEqual(action['text'], 'treehouse')
            self.assertEqual(memory['guesses'], ['treehouse'])

    def test_sketch_guesser_can_use_reserved_attempt_late_in_a_continuously_drawn_round(self):
        view = self.sketch_view()
        stroke = {'color': '#000000', 'width': 3, 'points': [[.1, .2], [.3, .4]]}
        view['game']['strokes'] = [deepcopy(stroke) for _ in range(3)]
        memory = {'phaseId': 1, 'phaseSince': 1000, 'firstInkAt': 1000,
                  'guesses': ['treehouse', 'snowman'], 'lastGuessAt': 1010}
        with patch.object(self.ai.sketch(), 'rank_guesses', return_value=['treehouse', 'snowman', 'rainbow']):
            action, memory = self.ai.decide(view, memory, 1056)
            self.assertIsNone(action)
            view['game']['strokes'].append(deepcopy(stroke))
            action, memory = self.ai.decide(view, memory, 1057)
            self.assertEqual(action['text'], 'rainbow')

    def test_streamed_bundled_drawings_keep_a_correct_guess_available_after_completion(self):
        recognized, exhausted = 0, []
        for prompt in self.ai.supported_prompts():
            template = self.ai.sketch().drawing_for(prompt)
            view, memory = self.sketch_view(), {}
            attempts = []
            for second in range(2, 76, 2):
                view['game']['strokes'] = template[:second]
                action, memory = self.ai.decide(view, memory, 1000 + second)
                if action:
                    attempts.append((second, action['text']))
                    if action['text'] == prompt:
                        recognized += 1
                        break
                self.assertLessEqual(len(json.dumps(memory).encode()), 1024)
            if len(attempts) == 3 and attempts[-1][0] < len(template) and attempts[-1][1] != prompt:
                exhausted.append(prompt)
        self.assertEqual(recognized, len(self.ai.supported_prompts()))
        self.assertEqual(exhausted, [])


if __name__ == '__main__':
    unittest.main()
