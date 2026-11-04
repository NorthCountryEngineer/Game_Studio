"""One-human complete matches through all six real anonymous API adapters.

Only synthetic storage/capabilities are used. Human controllers receive their
ordinary public/private seat projection, never the authoritative game state.
"""
from copy import deepcopy
import unittest
from unittest.mock import patch

import test_party_api as party_support
import test_mafia_api as mafia_support


class AIMatchJourneyTests(unittest.TestCase):
    def party_fixture(self, kind, settings=None):
        fixture = party_support.PartyAPITests('runTest'); fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        engine = party_support.party.engine()
        for target, name, replacement in [
            (engine, '_shuffle', lambda values: list(values)),
            (engine.uuid, 'uuid4', lambda: engine.uuid.UUID(party_support.uuid(200 + next(self.ids)))),
            (engine.ai_rules().secrets, 'choice', lambda choices: list(choices)[0]),
            (engine.ai_rules().secrets, 'randbelow', lambda maximum: 1 if maximum == 4 else 0),
        ]:
            guard = patch.object(target, name, side_effect=replacement)
            guard.start(); self.addCleanup(guard.stop)
        fixture.create(kind=kind, **({'settings': settings} if settings else {}))
        room = fixture.action(fixture.room_id, 'fill-ai')
        self.assert_no_bot_capabilities(fixture, room)
        room = fixture.action(fixture.room_id, 'start')
        return fixture, room

    def setUp(self):
        self.ids = iter(range(1000))
        self.request = 20000

    def assert_no_bot_capabilities(self, fixture, room):
        bots = {player['id'] for player in room['players'] if player.get('isAI')}
        self.assertTrue(bots)
        self.assertEqual(set(fixture.state()['members']), {fixture.room_id})
        self.assertEqual(set(fixture.sessions), {fixture.room_id})
        self.assertFalse(bots & set(fixture.state()['members']))
        return bots

    def assert_projection(self, fixture, room, mafia=False):
        self.assertEqual(room['self']['id'], fixture.room_id)
        self.assertEqual(len({player['id'] for player in room['players']}), len(room['players']))
        self.assertTrue(all('AI' in player['name'] for player in room['players'] if player.get('isAI')))
        self.assertNotIn('_ai', room)
        self.assertNotIn('_game', room)
        self.assertNotIn('tokenHash', room)
        self.assertNotIn('members', room)
        self.assertNotIn('seed', room)
        if mafia:
            self.assertNotIn('narratorInfo', room)
            if room['phase'] != 'finished':
                self.assertTrue(all('role' not in player for player in room['players']))
        else:
            self.assertNotIn('order', room['game'])
            self.assertNotIn('roles', room['game'])
            if room['kind'] == 'trivia' and room['phase'] == 'question':
                self.assertNotIn('correctIndex', room['game'])
            if room['kind'] == 'sketch-guess' and room['phase'] == 'draw' and room['game']['artistId'] != fixture.room_id:
                self.assertNotIn('prompt', room['self']); self.assertNotIn('prompt', room['game'])

    def human_action(self, fixture, room, command):
        self.request += 1
        return fixture.send(fixture.room_id, {'requestId': party_support.uuid(self.request),
            'phaseId': room['phaseId'], 'sequence': room['self']['actionSequence'] + 1, **command})

    def finish_party(self, fixture, room, controller, limit=500):
        views = []
        for _ in range(limit):
            self.assert_projection(fixture, room)
            views.append((room['round'], room['phase']))
            if room['status'] == 'finished':
                break
            command = controller(deepcopy(room), fixture.clock)
            if command:
                room = self.human_action(fixture, room, command)
            fixture.clock += 2
            room = fixture.get()
        self.assertEqual(room['status'], 'finished', (room['kind'], room['phase'], room['round']))
        self.assertIsNotNone(room['winner'])
        self.assertTrue(all(isinstance(player['score'], int) and player['score'] >= 0 for player in room['players']))
        self.assert_no_bot_capabilities(fixture, room)
        return room, views

    def rematch_close_party(self, fixture, room):
        bots = self.assert_no_bot_capabilities(fixture, room)
        fresh = self.human_action(fixture, room, {'type': 'restart'})
        self.assertEqual(fresh['status'], 'lobby')
        self.assertEqual({player['id'] for player in fresh['players'] if player.get('isAI')}, bots)
        self.assertNotIn('_ai', fixture.state()['game'])
        self.assertTrue(all(player['score'] == 0 for player in fresh['players']))
        closed = self.human_action(fixture, fresh, {'type': 'close'})
        self.assertEqual(closed['status'], 'closed')
        self.assertEqual(closed['game'], {})
        self.assertNotIn('_ai', fixture.state()['game'])
        fixture.provider.converse.assert_not_called(); fixture.authorization.assert_not_called()

    def test_hand_duel_one_human_completes_match_rematches_and_closes(self):
        fixture, room = self.party_fixture('hand-duel')
        def controller(view, now):
            if view['phase'] == 'choose' and view['self'].get('choice') is None:
                return {'type': 'choose', 'choice': 'paper'}
            if view['phase'] == 'reveal': return {'type': 'advance'}
        result, phases = self.finish_party(fixture, room, controller)
        self.assertEqual(result['winner'], fixture.room_id)
        self.assertEqual(next(player['score'] for player in result['players'] if player['id'] == fixture.room_id), 3)
        self.assertGreaterEqual(len({round for round, _ in phases}), 3)
        self.rematch_close_party(fixture, result)

    def test_drop_four_one_human_completes_match_rematches_and_closes(self):
        fixture, room = self.party_fixture('drop-four')
        def controller(view, now):
            if view['phase'] == 'turn' and view['game']['turnId'] == view['self']['id']:
                return {'type': 'drop', 'column': next(column for column, cell in enumerate(view['game']['board'][0]) if cell is None)}
        result, phases = self.finish_party(fixture, room, controller, limit=100)
        self.assertIn(result['winner'], {player['id'] for player in result['players']} | {'draw'})
        self.assertEqual(result['game']['result']['winnerId'], result['winner'])
        self.assertIn(sum(player['score'] for player in result['players']), (0, 1))
        if result['winner'] != 'draw': self.assertEqual(len(result['game']['winningCells']), 4)
        self.rematch_close_party(fixture, result)

    def test_trivia_one_human_completes_all_rounds_rematches_and_closes(self):
        fixture, room = self.party_fixture('trivia', {'rounds': 3, 'roundSeconds': 30})
        def controller(view, now):
            if view['phase'] == 'question' and view['self'].get('answer') is None:
                # A legal guess based only on the displayed options.
                return {'type': 'answer', 'answer': 0}
            if view['phase'] == 'reveal': return {'type': 'advance'}
        result, phases = self.finish_party(fixture, room, controller)
        self.assertEqual({round for round, _ in phases}, {1, 2, 3})
        self.assertGreater(next(player['score'] for player in result['players'] if player.get('isAI')), 0)
        self.rematch_close_party(fixture, result)

    def test_sketch_one_human_draws_and_guesses_from_visible_ink_then_rematches(self):
        fixture, room = self.party_fixture('sketch-guess', {'rounds': 2, 'roundSeconds': 180})
        skills = party_support.party.engine().ai_rules().sketch()
        progress = {}
        def controller(view, now):
            if view['phase'] == 'reveal': return {'type': 'advance'}
            if view['phase'] != 'draw': return None
            state = progress.setdefault(view['phaseId'], {'offset': 0, 'ink': None, 'changedAt': now, 'guesses': []})
            if view['game']['artistId'] == view['self']['id']:
                template = skills.drawing_for(view['self']['prompt'])
                offset = state['offset']; chunk = template[offset:offset + 6]
                state['offset'] += len(chunk)
                if chunk:
                    return {'type': 'drawing-batch', 'drawingEpoch': view['game']['drawingEpoch'],
                        'segments': [{'id': party_support.uuid(100000 + view['phaseId'] * 100 + offset + index), **stroke} for index, stroke in enumerate(chunk)]}
            elif not view['self']['id'] in view['game']['guessedIds']:
                strokes = view['game']['strokes']
                if strokes != state['ink']:
                    state['ink'] = deepcopy(strokes); state['changedAt'] = now
                if strokes and now - state['changedAt'] >= 6:
                    candidates = [guess for guess in skills.rank_guesses(strokes) if guess not in state['guesses']]
                    if candidates:
                        state['guesses'].append(candidates[0])
                        return {'type': 'guess', 'text': candidates[0]}
        result, phases = self.finish_party(fixture, room, controller)
        self.assertEqual({round for round, _ in phases}, {1, 2})
        self.assertTrue(all(player['score'] > 0 for player in result['players']))
        self.assertGreaterEqual(len(progress), 2)
        self.rematch_close_party(fixture, result)

    def test_starship_idle_human_impostor_watches_ai_crew_complete_objectives(self):
        fixture, room = self.party_fixture('starship-suspects')
        self.assertEqual(room['self']['role'], 'impostor')
        result, phases = self.finish_party(fixture, room, lambda view, now: None, limit=200)
        self.assertEqual(result['winner'], 'crew')
        self.assertEqual(result['game']['tasksCompleted'], result['game']['tasksTotal'])
        self.assertTrue(all(player['score'] > 0 for player in result['players'] if player.get('isAI')))
        self.rematch_close_party(fixture, result)

    def test_mafia_one_human_partial_view_controller_finishes_rematches_and_closes(self):
        fixture = mafia_support.MafiaAPITests('runTest'); fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        engine = mafia_support.mafia.engine()
        for target, name, replacement in [
            (engine.uuid, 'uuid4', lambda: engine.uuid.UUID(mafia_support.uuid(300 + next(self.ids)))),
            (engine.secrets, 'token_hex', lambda count: '0123456789abcdef' * 2),
        ]:
            guard = patch.object(target, name, side_effect=replacement)
            guard.start(); self.addCleanup(guard.stop)
        fixture.load_bank.return_value = None
        fixture.create(); room = fixture.action(fixture.room_id, 'fill-ai')
        self.assertEqual(room['narratorMode'], 'automatic')
        bots = self.assert_no_bot_capabilities(fixture, room)
        room = fixture.action(fixture.room_id, 'start')
        phases = set()
        for _ in range(400):
            self.assert_projection(fixture, room, mafia=True)
            phases.add(room['phase'])
            if room['phase'] == 'finished': break
            own = room['self']; command = None
            others = [player for player in room['players'] if player['alive'] and not player.get('left') and not player['isNarrator'] and player['id'] != own['id']]
            if own['alive']:
                if room['phase'] == 'night' and own['nightTargetId'] is None:
                    if own['role'] == 'doctor': command = {'type': 'night-action', 'targetId': own['id']}
                    elif own['role'] in {'mafia', 'detective'}:
                        candidates = [player for player in others if own['role'] != 'mafia' or player['id'] not in own['allies']]
                        if candidates: command = {'type': 'night-action', 'targetId': candidates[0]['id']}
                elif room['phase'] == 'discussion' and not own['ready']:
                    command = {'type': 'ready'}
                elif room['phase'] == 'voting' and not own['hasVoted']:
                    checks = {check['targetId']: check['isMafia'] for check in own['checks']}
                    candidates = [player for player in others if player['id'] not in own['allies'] and checks.get(player['id']) is not False]
                    known = [player for player in candidates if checks.get(player['id']) is True]
                    command = {'type': 'vote', 'targetId': (known or candidates)[0]['id'] if candidates else 'skip'}
            if command: room = self.human_action(fixture, room, command)
            fixture.clock += 2; room = fixture.get()
        self.assertEqual(room['phase'], 'finished')
        self.assertIn(room['winner'], {'town', 'mafia'})
        self.assertTrue({'night', 'discussion', 'voting', 'finished'} <= phases)
        self.assertTrue(all(player.get('role') in engine.ROLES for player in room['players']))
        self.assertTrue(any('win' in event['kind'] for event in room['events']))
        fresh = self.human_action(fixture, room, {'type': 'restart'})
        self.assertEqual(fresh['phase'], 'lobby')
        self.assertEqual({player['id'] for player in fresh['players'] if player.get('isAI')}, bots)
        self.assertTrue(all(player['role'] is None and player['checks'] == [] for player in fixture.state()['game']['players']))
        self.assertTrue(all(set(player['_ai']) == {'seed'} for player in fixture.state()['game']['players'] if player.get('isAI')))
        closed = self.human_action(fixture, fresh, {'type': 'close'})
        self.assertEqual(closed['phase'], 'closed')
        self.assert_no_bot_capabilities(fixture, closed)
        fixture.load_bank.assert_not_called(); fixture.provider.converse.assert_not_called(); fixture.authorization.assert_not_called()


if __name__ == '__main__':
    unittest.main()
