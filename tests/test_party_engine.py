"""Synthetic rule journeys and private-view boundaries for the five party engines."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('game_studio_party_engine', Path(__file__).resolve().parents[1] / 'backend/nce_api/party_engine.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


def pid(number):
    return '00000000-0000-4000-8000-' + str(number).zfill(12)


def player(number):
    return {'id': pid(number), 'name': 'Player' + str(number), 'avatar': engine.AVATARS[(number - 1) % len(engine.AVATARS)]}


class PartyEngineTests(unittest.TestCase):
    def error(self, status, callback):
        with self.assertRaises(engine.PartyError) as raised:
            callback()
        self.assertEqual(raised.exception.status, status)
        return raised.exception.message

    def lobby(self, kind, count=None, settings=None):
        count = count or engine.GAMES[kind]['minPlayers']
        state = engine.new_room(player(1), kind, settings=settings, now=1000)
        state['roomId'] = pid(99)
        for number in range(2, count + 1):
            state = engine.add_player(state, player(number), now=1000)
        return state

    def begin(self, kind, count=None, settings=None):
        with patch.object(engine, '_shuffle', lambda values: values), patch.object(engine.secrets, 'choice', lambda values: values[0]):
            return self.act(self.lobby(kind, count, settings), pid(1), 'start', now=1000)

    def act(self, state, actor, action, now=1001, **fields):
        return engine.apply_action(state, actor, {'type': action, 'phaseId': state['phaseId'], **fields}, now=now)

    def role(self, state, role):
        return [p['id'] for p in state['players'] if state['_game']['roles'][p['id']] == role and not p['left']]

    def move_to(self, state, actor, room, now):
        """Walk connected rooms using a tiny breadth-first search; actions are real."""
        start = state['_game']['positions'][actor]
        queue = [(start, [])]
        seen = set()
        while queue:
            current, route = queue.pop(0)
            if current == room:
                for step in route:
                    now += 1
                    state = self.act(state, actor, 'move', now=now, room=step)
                return state, now
            if current not in seen:
                seen.add(current)
                queue.extend((neighbor, route + [neighbor]) for neighbor in next(r['neighbors'] for r in engine.ROOMS if r['id'] == current))
        self.fail('No ship route')

    def test_catalog_matches_canonical_and_is_copy(self):
        canonical = json.loads((Path(__file__).resolve().parents[1] / 'config/party-games.json').read_text())['games']
        self.assertEqual(engine.catalog(), canonical)
        altered = engine.catalog()
        altered[0]['title'] = 'Changed'
        self.assertEqual(engine.catalog()[0]['title'], 'Mafia')
        self.assertEqual(len(engine.GAMES), 5)
        self.error(400, lambda: engine.new_room(player(1), 'mafia', now=1000))

    def test_no_transition_mutates_inputs(self):
        for kind in engine.GAMES:
            with self.subTest(kind=kind):
                state = engine.new_room(player(1), kind, now=1000)
                before = deepcopy(state)
                joined = engine.add_player(state, player(2), now=1001)
                self.assertEqual(before, state)
                self.assertEqual(len(joined['players']), 2)
                before = deepcopy(joined)
                view = engine.project(joined, pid(1), now=1001)
                view['players'][0]['name'] = 'Changed'
                self.assertEqual(before, joined)
                self.assertEqual(engine.reconcile(joined, 1001), joined)
                result = self.act(joined, pid(1), 'chat', text='Hello')
                self.assertEqual(before, joined)
                self.assertEqual(result['chat'][-1]['text'], 'Hello')

    def test_invalid_kinds_players_and_times_fail_closed(self):
        for value in [None, [], {}, 42, '', 'unknown']:
            with self.subTest(kind=value):
                self.error(400, lambda: engine.new_room(player(1), value, now=1000))
        for field, value in [('id', 'bad'), ('name', ''), ('name', '\u202eevil'), ('name', 'x' * 17), ('avatar', 'unknown')]:
            self.error(400, lambda: engine.new_room({**player(1), field: value}, 'trivia', now=1000))
        self.error(400, lambda: engine.new_room({**player(1), 'role': 'impostor'}, 'trivia', now=1000))
        for now in [-1, float('nan'), True, '1000']:
            self.error(400, lambda: engine.new_room(player(1), 'trivia', now=now))

    def test_settings_strict_and_capacity_host_permissions(self):
        for kind in engine.GAMES:
            for bad in [{'model': 'provider'}, {'maxPlayers': 99}, {'roundSeconds': True}, {'rounds': 999}]:
                with self.subTest(kind=kind, bad=bad):
                    self.error(400, lambda: engine.new_room(player(1), kind, settings=bad, now=1000))
        state = self.lobby('trivia', count=3)
        self.error(403, lambda: self.act(state, pid(2), 'settings', settings={'rounds': 2}))
        self.error(409, lambda: self.act(state, pid(1), 'settings', settings={'maxPlayers': 2}))
        state = self.act(state, pid(1), 'settings', settings={'rounds': 2, 'maxPlayers': 3})
        self.assertEqual(state['settings']['rounds'], 2)
        self.error(409, lambda: engine.add_player(state, player(4), now=1001))

    def test_join_names_ids_and_seat_limits(self):
        state = self.lobby('hand-duel', count=1)
        self.error(409, lambda: engine.add_player(state, {**player(2), 'name': 'PLAYER1'}, now=1001))
        self.error(409, lambda: engine.add_player(state, player(1), now=1001))
        state = engine.add_player(state, player(2), now=1001)
        self.error(409, lambda: engine.add_player(state, player(3), now=1001))
        state = self.act(state, pid(1), 'start')
        self.error(409, lambda: engine.add_player(state, player(3), now=1001))

    def test_start_requires_players_and_host(self):
        for kind in engine.GAMES:
            state = self.lobby(kind, count=1)
            self.error(409, lambda: self.act(state, pid(1), 'start'))
        state = self.lobby('trivia')
        self.error(403, lambda: self.act(state, pid(2), 'start'))
        started = self.act(state, pid(1), 'start')
        self.error(409, lambda: self.act(started, pid(1), 'settings', settings={}))

    def test_lobby_kick_leave_and_bounded_retired_seats(self):
        state = self.lobby('trivia', count=3)
        self.error(403, lambda: self.act(state, pid(2), 'kick', targetId=pid(3)))
        self.error(400, lambda: self.act(state, pid(1), 'kick', targetId=pid(1)))
        state = self.act(state, pid(1), 'kick', targetId=pid(3))
        self.assertEqual(len(state['players']), 2)
        state = self.act(state, pid(2), 'leave')
        self.error(403, lambda: self.act(state, pid(2), 'chat', text='left'))
        for number in range(3, 40):
            state = engine.add_player(state, player(number), now=1002)
            state = self.act(state, pid(number), 'leave', now=1002)
        self.assertLessEqual(len(state['players']), 2)
        self.error(409, lambda: self.act(state, pid(1), 'leave'))

    def test_unknown_extra_fields_and_stale_phases(self):
        state = self.begin('trivia')
        for action in [{'type': 'answer', 'answer': 1, 'score': 999}, {'type': 'evil'}, [], {'type': 'answer', 'phaseId': True}]:
            self.error(400 if action != {'type': 'answer', 'phaseId': True} else 409,
                       lambda: engine.apply_action(state, pid(1), action, now=1001))
        self.error(409, lambda: engine.apply_action(state, pid(1), {'type': 'answer', 'answer': 1, 'phaseId': 0}, now=1001))
        self.error(403, lambda: engine.project(state, pid(999), now=1001))
        self.error(409, lambda: self.act(state, pid(1), 'advance'))

    def test_chat_normalized_bounded_and_rate_limited(self):
        state = self.lobby('trivia')
        self.error(400, lambda: self.act(state, pid(1), 'chat', text='A\nB'))
        for _ in range(12):
            state = self.act(state, pid(1), 'chat', text='Hello', now=1001)
        self.error(429, lambda: self.act(state, pid(1), 'chat', text='More', now=1001))
        for minute in range(1, 10):
            for _ in range(12):
                state = self.act(state, pid(1), 'chat', text='Hello', now=1001 + minute * 61)
        self.assertEqual(len(state['chat']), 60)
        self.assertEqual(len(state['_messageTimes'][pid(1)]), 12)

    def test_close_and_restart_clear_private_state(self):
        state = self.begin('hand-duel')
        state = self.act(state, pid(1), 'choose', choice='rock')
        self.error(403, lambda: self.act(state, pid(2), 'close'))
        closed = self.act(state, pid(1), 'close')
        self.assertEqual(closed['_game'], {})
        self.assertEqual(engine.project(closed, pid(2), now=1001)['game'], {})
        self.error(409, lambda: self.act(closed, pid(1), 'chat', text='closed'))
        self.error(409, lambda: self.act(state, pid(1), 'restart'))
        for number in range(3):
            if number:
                state = self.act(state, pid(1), 'advance', now=1002 + number)
                state = self.act(state, pid(1), 'choose', choice='rock', now=1002 + number)
            state = self.act(state, pid(2), 'choose', choice='scissors', now=1002 + number)
        self.assertEqual(state['status'], 'finished')
        restarted = self.act(state, pid(1), 'restart', now=1010)
        self.assertEqual(restarted['phase'], 'lobby')
        self.assertEqual(restarted['_game'], {})
        self.assertEqual(restarted['chat'], [])
        self.assertTrue(all(person['score'] == 0 for person in restarted['players']))

    def test_hand_duel_hidden_locked_choices_and_best_of_five(self):
        state = self.begin('hand-duel')
        for round_number in range(3):
            state = self.act(state, pid(1), 'choose', choice='rock', now=1001 + round_number)
            own, other = engine.project(state, pid(1)), engine.project(state, pid(2))
            self.assertEqual(own['self']['choice'], 'rock')
            self.assertIsNone(other['self']['choice'])
            self.assertEqual(other['game']['choices'], {})
            self.assertEqual(other['game']['selectedIds'], [pid(1)])
            self.error(409, lambda: self.act(state, pid(1), 'choose', choice='paper', now=1001 + round_number))
            state = self.act(state, pid(2), 'choose', choice='scissors', now=1001 + round_number)
            self.assertEqual(engine.project(state, pid(2))['game']['choices'][pid(1)], 'rock')
            if round_number < 2:
                state = self.act(state, pid(1), 'advance', now=1001 + round_number)
        self.assertEqual(state['winner'], pid(1))
        self.assertEqual(state['players'][0]['score'], 3)

    def test_hand_duel_all_combinations(self):
        beats = {('rock', 'scissors'), ('paper', 'rock'), ('scissors', 'paper')}
        for a in ['rock', 'paper', 'scissors']:
            for b in ['rock', 'paper', 'scissors']:
                with self.subTest(a=a, b=b):
                    state = self.begin('hand-duel')
                    state = self.act(state, pid(1), 'choose', choice=a)
                    state = self.act(state, pid(2), 'choose', choice=b)
                    winner = None if a == b else pid(1) if (a, b) in beats else pid(2)
                    self.assertEqual(state['_game']['result']['winnerId'], winner)

    def test_hand_duel_timeout_and_tie_bound(self):
        state = self.begin('hand-duel')
        state = self.act(state, pid(2), 'choose', choice='paper')
        state = engine.reconcile(state, 1045)
        self.assertEqual(state['_game']['result']['winnerId'], pid(2))
        state = engine.reconcile(state, 1050)
        self.assertEqual(state['phase'], 'choose')
        self.assertEqual(state['round'], 2)
        state['round'] = 30
        state = engine.reconcile(state, 2000)
        self.assertEqual(state['status'], 'finished')
        self.error(400, lambda: self.act(self.begin('hand-duel'), pid(1), 'choose', choice='laser'))

    def test_drop_four_turn_gravity_and_vertical_win(self):
        state = self.begin('drop-four')
        self.error(403, lambda: self.act(state, pid(2), 'drop', column=0))
        for index, column in enumerate([0, 1, 0, 1, 0, 1, 0]):
            state = self.act(state, pid(1 if index % 2 == 0 else 2), 'drop', now=1001 + index, column=column)
        self.assertEqual(state['winner'], pid(1))
        self.assertEqual(state['_game']['board'][5][0], pid(1))
        self.assertEqual(len(state['_game']['winningCells']), 4)
        self.assertEqual(state['players'][0]['score'], 1)

    def test_drop_four_horizontal_and_diagonal_rules(self):
        state = self.begin('drop-four')
        for index, column in enumerate([0, 0, 1, 1, 2, 2, 3]):
            state = self.act(state, pid(1 if index % 2 == 0 else 2), 'drop', now=1001 + index, column=column)
        self.assertEqual(state['winner'], pid(1))
        board = [[None] * 7 for _ in range(6)]
        for row, column in [(5, 0), (4, 1), (3, 2), (2, 3)]:
            board[row][column] = pid(1)
        self.assertEqual(len(engine._board_winner(board, 2, 3, pid(1))), 4)
        for row, column in [(5, 6), (4, 5), (3, 4), (2, 3)]:
            board[row][column] = pid(2)
        self.assertEqual(len(engine._board_winner(board, 2, 3, pid(2))), 4)

    def test_drop_four_full_column_bad_columns_timeout_and_draw(self):
        state = self.begin('drop-four')
        for column in [-1, 7, True, 2.1, None]:
            self.error(400, lambda: self.act(state, pid(1), 'drop', column=column))
        for number in range(6):
            state = self.act(state, pid(1 if number % 2 == 0 else 2), 'drop', now=1001 + number, column=0)
        self.error(409, lambda: self.act(state, pid(1), 'drop', now=1008, column=0))
        state = engine.reconcile(state, 2000)
        self.assertEqual(state['winner'], pid(2))
        # A nearly full alternating board without a four through the last cell.
        state = self.begin('drop-four')
        state['_game']['board'] = [[pid(1 if (row + col // 2) % 2 else 2) for col in range(7)] for row in range(6)]
        state['_game']['board'][0][0] = None
        state['_game']['turnId'] = pid(1)
        state = self.act(state, pid(1), 'drop', column=0)
        self.assertEqual(state['winner'], 'draw')

    def test_trivia_full_game_hidden_answers_and_server_scores(self):
        state = self.begin('trivia', settings={'rounds': 2})
        for round_number in range(2):
            correct = engine.TRIVIA[state['_game']['order'][round_number]][2]
            before = deepcopy(state)
            state = self.act(state, pid(1), 'answer', answer=correct, now=1001 + round_number)
            self.assertEqual(before['players'][0]['score'], 0 if round_number == 0 else 120)
            other = engine.project(state, pid(2))
            self.assertNotIn('correctIndex', other['game'])
            self.assertNotIn('answers', other['game'])
            self.assertIsNone(other['self']['answer'])
            self.assertEqual(engine.project(state, pid(1))['self']['answer'], correct)
            self.error(409, lambda: self.act(state, pid(1), 'answer', answer=0, now=1001 + round_number))
            state = self.act(state, pid(2), 'answer', answer=(correct + 1) % 4, now=1001 + round_number)
            self.assertEqual(engine.project(state, pid(2))['game']['correctIndex'], correct)
            self.assertEqual(state['players'][0]['score'], (round_number + 1) * 120)
            state = self.act(state, pid(1), 'advance', now=1001 + round_number)
        self.assertEqual(state['winner'], pid(1))
        self.assertEqual(state['status'], 'finished')

    def test_trivia_timeout_absence_bad_answer_and_no_bank_leak(self):
        state = self.begin('trivia', settings={'rounds': 1})
        for answer in [None, True, -1, 4, '1']:
            self.error(400, lambda: self.act(state, pid(1), 'answer', answer=answer))
        view = engine.project(state, pid(2))
        self.assertNotIn('order', view['game'])
        self.assertNotIn('TRIVIA', json.dumps(view))
        state = engine.reconcile(state, 1030)
        self.assertEqual(state['_game']['result']['correctIds'], [])
        state = engine.reconcile(state, 1036)
        self.assertEqual(state['winner'], 'draw')

    def test_trivia_leave_does_not_hold_remaining_answers(self):
        state = self.begin('trivia', count=3)
        state = self.act(state, pid(3), 'answer', answer=0)
        state = self.act(state, pid(3), 'leave')
        state = self.act(state, pid(1), 'answer', answer=1)
        state = self.act(state, pid(2), 'answer', answer=1)
        self.assertEqual(state['phase'], 'reveal')

    def test_trivia_bank_is_well_formed(self):
        self.assertGreaterEqual(len(engine.TRIVIA), 30)
        self.assertEqual(len({question[0] for question in engine.TRIVIA}), len(engine.TRIVIA))
        for text, options, answer in engine.TRIVIA:
            self.assertTrue(text)
            self.assertEqual(len(options), 4)
            self.assertEqual(len(set(options)), 4)
            self.assertIn(answer, range(4))

    def test_sketch_secret_prompt_strokes_guess_and_rotating_artist(self):
        state = self.begin('sketch-guess', count=3, settings={'rounds': 2})
        artist = engine.project(state, pid(1))
        self.assertEqual(artist['self']['prompt'], 'hot-air balloon')
        self.assertNotIn('prompt', engine.project(state, pid(2))['self'])
        self.assertNotIn('prompt', engine.project(state, pid(2))['game'])
        state = self.act(state, pid(1), 'stroke', color='#FF00AA', width=3, points=[[0, 0], [1, 1]])
        stroke = engine.project(state, pid(2))['game']['strokes'][0]
        self.assertEqual(stroke['color'], '#ff00aa')
        self.error(403, lambda: self.act(state, pid(2), 'stroke', color='#ff00aa', width=3, points=[[0, 0]]))
        self.error(403, lambda: self.act(state, pid(1), 'guess', text='balloon'))
        state = self.act(state, pid(2), 'guess', text='balloon')
        self.assertNotIn('balloon', json.dumps(engine.project(state, pid(3))))
        self.assertEqual(state['chat'][-1]['text'], 'Guessed the drawing!')
        self.assertEqual(state['players'][1]['score'], 100)
        self.assertEqual(state['players'][0]['score'], 30)
        self.error(409, lambda: self.act(state, pid(2), 'guess', text='balloon'))
        state = self.act(state, pid(3), 'guess', text='HOT AIR BALLOON')
        self.assertEqual(state['phase'], 'reveal')
        self.assertEqual(engine.project(state, pid(3))['game']['prompt'], 'hot-air balloon')
        state = self.act(state, pid(1), 'advance')
        self.assertEqual(state['_game']['artistId'], pid(2))
        self.assertEqual(state['_game']['strokes'], [])
        self.assertNotIn('prompt', engine.project(state, pid(1))['self'])
        state = engine.reconcile(state, 2000)
        state = engine.reconcile(state, 2006)
        self.assertEqual(state['status'], 'finished')

    def test_sketch_wrong_guesses_public_but_correct_answer_hidden(self):
        state = self.begin('sketch-guess', count=3)
        state = self.act(state, pid(2), 'guess', text='A teapot')
        self.assertEqual(engine.project(state, pid(3))['chat'][-1]['text'], 'A teapot')
        state = self.act(state, pid(2), 'guess', text='balloon')
        self.assertEqual(engine.project(state, pid(3))['chat'][-1]['text'], 'Guessed the drawing!')

    def test_sketch_stroke_limits_numbers_quantization_and_clear(self):
        state = self.begin('sketch-guess')
        invalid = [('#12345', 2, [[0, 0]]), ('#000000', 0, [[0, 0]]), ('#000000', True, [[0, 0]]),
                   ('#000000', 2, [[float('nan'), 0]]), ('#000000', 2, [[True, 0]]),
                   ('#000000', 2, [[1.1, 0]]), ('#000000', 2, []), ('#000000', 2, [[0, 0]] * 121)]
        for color, width, points in invalid:
            self.error(400, lambda: self.act(state, pid(1), 'stroke', color=color, width=width, points=points))
        state = self.act(state, pid(1), 'stroke', color='#000000', width=2, points=[[.123456789, .987654321]])
        self.assertEqual(state['_game']['strokes'][0]['points'], [[.1235, .9877]])
        self.error(429, lambda: self.act(state, pid(1), 'stroke', color='#000000', width=2, points=[[0, 0]]))
        for _ in range(5):
            state = self.act(state, pid(1), 'clear-drawing')
        self.error(429, lambda: self.act(state, pid(1), 'clear-drawing'))
        self.assertEqual(state['_game']['strokes'], [])

    def test_sketch_bounded_stroke_payload_under_storage_limit(self):
        state = self.begin('sketch-guess', settings={'roundSeconds': 180})
        for number in range(60):
            state = self.act(state, pid(1), 'stroke', now=1001 + number, color='#abcdef', width=12,
                             points=[[.123456789, .987654321]] * 120)
        self.error(409, lambda: self.act(state, pid(1), 'stroke', now=1062, color='#000000', width=2, points=[[0, 0]]))
        self.assertLess(len(json.dumps(state).encode()), 200000)
        self.assertEqual(len(state['_game']['strokes']), 60)

    def test_sketch_artist_leaving_reveals_without_changing_secret_prompt(self):
        state = self.begin('sketch-guess', count=4)
        state = engine.reconcile(state, 1075)
        state = self.act(state, pid(1), 'advance', now=1076)
        self.assertEqual(state['_game']['artistId'], pid(2))
        prompt = engine.project(state, pid(2))['self']['prompt']
        state = self.act(state, pid(2), 'leave', now=1077)
        self.assertEqual(state['phase'], 'reveal')
        self.assertEqual(engine.project(state, pid(3))['game']['prompt'], prompt)

    def test_starship_roles_private_and_only_impostors_know_teammates(self):
        state = self.begin('starship-suspects', count=8)
        impostors = self.role(state, 'impostor')
        crew = self.role(state, 'crew')
        self.assertEqual(len(impostors), 2)
        view = engine.project(state, crew[0])
        self.assertEqual(view['self']['role'], 'crew')
        self.assertEqual(view['self']['teammateIds'], [])
        self.assertTrue(all('role' not in item for item in view['players']))
        self.assertNotIn('roles', view['game'])
        self.assertNotIn('tasks', view['game'])
        for impostor in impostors:
            ally = engine.project(state, impostor)['self']['teammateIds']
            self.assertEqual(ally, [p for p in impostors if p != impostor])
        self.assertEqual(view['game']['tasksTotal'], 18)
        self.assertEqual(len(view['self']['tasks']), 3)

    def test_starship_movement_connected_with_cooldown(self):
        state = self.begin('starship-suspects')
        self.error(400, lambda: self.act(state, pid(2), 'move', room='reactor'))
        state = self.act(state, pid(2), 'move', room='medbay')
        self.error(429, lambda: self.act(state, pid(2), 'move', room='reactor'))
        state = self.act(state, pid(2), 'move', room='reactor', now=1002)
        self.assertEqual(engine.project(state, pid(2))['self']['room'], 'reactor')
        self.error(403, lambda: self.act(state, pid(2), 'chat', text='radio'))

    def test_starship_private_cooldowns_follow_movement_tasks_and_repairs(self):
        state = self.begin('starship-suspects')
        view = engine.project(state, pid(2))
        self.assertLessEqual(view['self']['moveReadyAt'], 1000)
        self.assertLessEqual(view['self']['taskReadyAt'], 1000)
        state = self.act(state, pid(2), 'move', room='storage', now=1001)
        self.assertEqual(engine.project(state, pid(2))['self']['moveReadyAt'], 1002)
        task = state['_game']['tasks'][pid(2)][0]
        self.assertEqual(task['room'], 'storage')
        state = self.act(state, pid(2), 'task', taskId=task['id'], step='●', now=1002)
        self.assertEqual(engine.project(state, pid(2))['self']['taskReadyAt'], 1003)
        self.assertLess(engine.project(state, pid(3))['self']['taskReadyAt'], 1000)
        state = self.act(state, pid(1), 'sabotage', now=1015)
        state, now = self.move_to(state, pid(2), 'reactor', 1015)
        state = self.act(state, pid(2), 'repair', step=0, now=now + 1)
        self.assertEqual(engine.project(state, pid(2))['self']['taskReadyAt'], now + 2)
        self.assertNotIn('moveReadyAt', engine.project(state, pid(2))['game'])
        self.assertNotIn('taskReadyAt', engine.project(state, pid(2))['game'])

    def test_starship_tasks_sequence_ownership_location_and_fake_progress(self):
        state = self.begin('starship-suspects')
        task = state['_game']['tasks'][pid(2)][0]
        self.error(409, lambda: self.act(state, pid(2), 'task', taskId=task['id'], step='●'))
        state, now = self.move_to(state, pid(2), task['room'], 1000)
        self.error(400, lambda: self.act(state, pid(2), 'task', taskId=task['id'], step='▲', now=now + 1))
        for offset in range(3):
            state = self.act(state, pid(2), 'task', taskId=task['id'], step='●', now=now + 1 + offset)
        self.assertEqual(engine.project(state, pid(2))['game']['tasksCompleted'], 1)
        self.assertEqual(engine.project(state, pid(3))['players'][1]['score'], 0)
        self.assertEqual(engine.project(state, pid(2))['self']['score'], 50)
        # The impostor can act busy, but fake tasks never move the crew task bar.
        fake = state['_game']['tasks'][pid(1)][0]
        state, now = self.move_to(state, pid(1), fake['room'], now + 5)
        for offset in range(3):
            state = self.act(state, pid(1), 'task', taskId=fake['id'], step='●', now=now + 1 + offset)
        self.assertEqual(engine.project(state, pid(3))['game']['tasksCompleted'], 1)

    def test_starship_full_crew_task_win_including_ghost_tasks(self):
        state = self.begin('starship-suspects', count=5)
        state = self.act(state, pid(1), 'tag', targetId=pid(2), now=1015)
        self.assertFalse(engine._player(state, pid(2))['alive'])
        now = 1016
        for crew_id in self.role(state, 'crew'):
            for task in deepcopy(state['_game']['tasks'][crew_id]):
                state, now = self.move_to(state, crew_id, task['room'], now)
                for symbol in task['sequence']:
                    now += 1
                    state = self.act(state, crew_id, 'task', taskId=task['id'], step=symbol, now=now)
        self.assertEqual(state['winner'], 'crew')
        self.assertEqual(state['status'], 'finished')
        self.assertTrue(all('role' in p for p in engine.project(state, pid(2))['players']))

    def test_starship_tag_privacy_range_cooldown_and_parity_win(self):
        state = self.begin('starship-suspects')
        self.error(403, lambda: self.act(state, pid(2), 'tag', targetId=pid(3), now=1015))
        self.error(409, lambda: self.act(state, pid(1), 'tag', targetId=pid(2), now=1001))
        self.error(400, lambda: self.act(state, pid(1), 'tag', targetId=pid(1), now=1015))
        state = self.act(state, pid(2), 'move', room='medbay', now=1014)
        self.error(400, lambda: self.act(state, pid(1), 'tag', targetId=pid(2), now=1015))
        state = self.act(state, pid(1), 'tag', targetId=pid(3), now=1015)
        view = engine.project(state, pid(4))
        self.assertTrue(all(p['score'] == 0 for p in view['players']))
        self.assertEqual(view['game']['bodies'], [{'playerId': pid(3), 'room': 'bridge'}])
        self.error(409, lambda: self.act(state, pid(1), 'tag', targetId=pid(4), now=1016))
        self.error(403, lambda: self.act(state, pid(3), 'chat', text='ghost', now=1016))
        state = self.act(state, pid(1), 'tag', targetId=pid(4), now=1030)
        self.assertEqual(state['winner'], 'impostor')

    def test_starship_report_discussion_hidden_voting_and_crew_win(self):
        state = self.begin('starship-suspects', count=5)
        state = self.act(state, pid(1), 'tag', targetId=pid(2), now=1015)
        self.error(403, lambda: self.act(state, pid(2), 'report', targetId=pid(2), now=1016))
        state = self.act(state, pid(3), 'move', room='storage', now=1016)
        self.error(400, lambda: self.act(state, pid(3), 'report', targetId=pid(2), now=1017))
        state = self.act(state, pid(4), 'report', targetId=pid(2), now=1017)
        self.assertEqual(state['phase'], 'discussion')
        self.assertEqual(state['_game']['bodies'], [])
        for actor in [pid(1), pid(3), pid(4), pid(5)]:
            state = self.act(state, actor, 'ready', now=1018)
        self.assertEqual(state['phase'], 'voting')
        self.error(403, lambda: self.act(state, pid(2), 'vote', targetId=pid(1), now=1019))
        state = self.act(state, pid(3), 'vote', targetId=pid(1), now=1019)
        other = engine.project(state, pid(4))
        self.assertIsNone(other['self']['vote'])
        self.assertEqual(other['game']['votedIds'], [pid(3)])
        self.assertNotIn('votes', other['game'])
        self.error(409, lambda: self.act(state, pid(3), 'vote', targetId='skip', now=1019))
        for actor in [pid(1), pid(4), pid(5)]:
            state = self.act(state, actor, 'vote', targetId=pid(1), now=1019)
        self.assertEqual(state['winner'], 'crew')
        self.assertEqual(engine.project(state, pid(4))['players'][0]['role'], 'impostor')

    def test_starship_tied_vote_no_reveal_and_timers(self):
        state = self.begin('starship-suspects')
        state = self.act(state, pid(2), 'emergency')
        self.assertFalse(state['_game']['emergencies'][pid(2)])
        state = engine.reconcile(state, 1046)
        self.assertEqual(state['phase'], 'voting')
        for actor, target in [(pid(1), pid(2)), (pid(2), pid(1)), (pid(3), pid(1)), (pid(4), pid(2))]:
            state = self.act(state, actor, 'vote', targetId=target, now=1047)
        self.assertEqual(state['phase'], 'roaming')
        self.assertTrue(all(p['alive'] for p in state['players']))
        self.assertTrue(all('role' not in p for p in engine.project(state, pid(3))['players']))
        self.error(409, lambda: self.act(state, pid(2), 'emergency', now=1048))
        state = self.act(state, pid(3), 'emergency', now=1048)
        state = engine.reconcile(state, 1093)
        state = engine.reconcile(state, 1138)
        self.assertEqual(state['phase'], 'roaming')

    def test_starship_sabotage_repair_and_timeout(self):
        state = self.begin('starship-suspects')
        self.error(403, lambda: self.act(state, pid(2), 'sabotage', now=1015))
        self.error(409, lambda: self.act(state, pid(1), 'sabotage'))
        state = self.act(state, pid(1), 'sabotage', now=1015)
        self.error(409, lambda: self.act(state, pid(2), 'emergency', now=1016))
        self.error(409, lambda: self.act(state, pid(2), 'repair', step=0, now=1016))
        state, now = self.move_to(state, pid(2), 'reactor', 1015)
        self.error(409, lambda: self.act(state, pid(2), 'repair', step=2, now=now + 1))
        for step in range(3):
            state = self.act(state, pid(2), 'repair', step=step, now=now + 1 + step)
        self.assertIsNone(state['_game']['sabotage'])
        self.assertEqual(state['players'][1]['score'], 25)
        state = self.act(state, pid(1), 'sabotage', now=1075)
        state = engine.reconcile(state, 1135)
        self.assertEqual(state['winner'], 'impostor')

    def test_starship_leaving_updates_tasks_and_win(self):
        state = self.begin('starship-suspects', count=5)
        state = self.act(state, pid(5), 'leave')
        self.assertEqual(state['_game']['taskTotal'], 9)
        self.assertEqual(len(engine.project(state, pid(2))['game']['positions']), 4)
        # Give creator a crew role purely to exercise an impostor leaving path.
        state = self.begin('starship-suspects')
        state['_game']['roles'][pid(1)], state['_game']['roles'][pid(2)] = 'crew', 'impostor'
        state = self.act(state, pid(2), 'leave')
        self.assertEqual(state['winner'], 'crew')

    def test_leaving_last_pending_player_resolves_without_waiting_for_timeout(self):
        state = self.begin('trivia', count=3)
        state = self.act(state, pid(1), 'answer', answer=1)
        state = self.act(state, pid(2), 'answer', answer=1)
        state = self.act(state, pid(3), 'leave')
        self.assertEqual(state['phase'], 'reveal')
        state = self.begin('sketch-guess', count=3)
        state = self.act(state, pid(2), 'guess', text='balloon')
        state = self.act(state, pid(3), 'leave')
        self.assertEqual(state['phase'], 'reveal')
        state = self.begin('starship-suspects', count=5)
        state = self.act(state, pid(2), 'emergency')
        for actor in [pid(1), pid(2), pid(3), pid(4)]:
            state = self.act(state, actor, 'ready')
        state = self.act(state, pid(5), 'leave')
        self.assertEqual(state['phase'], 'voting')
        for actor in [pid(1), pid(2), pid(3)]:
            state = self.act(state, actor, 'vote', targetId=pid(1))
        state = self.act(state, pid(4), 'leave')
        self.assertEqual(state['winner'], 'crew')

    def test_projection_stable_after_canonical_storage_roundtrip(self):
        for kind, action in [('hand-duel', {'type': 'choose', 'choice': 'rock'}), ('trivia', {'type': 'answer', 'answer': 1})]:
            state = self.begin(kind, count=3 if kind == 'trivia' else 2)
            state = engine.apply_action(state, pid(2), action, now=1001)
            if kind == 'trivia':
                state = engine.apply_action(state, pid(1), action, now=1001)
            stored = json.loads(json.dumps(state, sort_keys=True))
            self.assertEqual(engine.project(state, pid(1)), engine.project(stored, pid(1)))
        state = self.begin('starship-suspects', count=8)
        state = self.act(state, pid(3), 'emergency')
        state = engine.reconcile(state, 1046)
        state = self.act(state, pid(4), 'vote', targetId='skip', now=1047)
        state = self.act(state, pid(3), 'vote', targetId='skip', now=1047)
        stored = json.loads(json.dumps(state, sort_keys=True))
        self.assertEqual(engine.project(state, pid(1)), engine.project(stored, pid(1)))

    def test_expired_phase_actions_cannot_change_previous_answers(self):
        for kind, action in [('trivia', {'type': 'answer', 'answer': 1}), ('hand-duel', {'type': 'choose', 'choice': 'rock'})]:
            state = self.begin(kind)
            action['phaseId'] = state['phaseId']
            self.error(409, lambda: engine.apply_action(state, pid(1), action, now=2000))
            self.assertEqual(state['phase'], 'question' if kind == 'trivia' else 'choose')


if __name__ == '__main__':
    unittest.main()
