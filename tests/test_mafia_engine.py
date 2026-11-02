"""Pure Mafia rule, privacy and boundary checks using synthetic players only."""
from copy import deepcopy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('game_studio_mafia_engine', Path(__file__).resolve().parents[1] / 'backend/nce_api/mafia_engine.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


def pid(number):
    return '00000000-0000-4000-8000-' + str(number).zfill(12)


def player(number):
    return {'id': pid(number), 'name': 'Player' + str(number), 'avatar': engine.AVATARS[(number - 1) % len(engine.AVATARS)]}


class MafiaEngineTests(unittest.TestCase):
    def error(self, status, callback):
        with self.assertRaises(engine.MafiaError) as raised:
            callback()
        self.assertEqual(raised.exception.status, status)
        return raised.exception.message

    def lobby(self, mode='ai', count=8):
        state = engine.new_room(player(1), mode, now=1000, settings={'maxPlayers': 24})
        state['roomId'] = pid(99)
        for number in range(2, count + 1):
            state = engine.add_player(state, player(number), now=1000)
        return state

    def started(self, mode='ai', count=8):
        state = self.lobby(mode, count)
        with patch.object(engine.secrets, 'SystemRandom') as random:
            random.return_value.shuffle.side_effect = lambda roles: None
            state = engine.apply_action(state, pid(1), {'type': 'start', 'phaseId': 0}, now=1000)
            random.return_value.shuffle.assert_called_once()
        return state

    def role(self, state, role):
        return [person for person in state['players'] if person['role'] == role and person['alive']]

    def act(self, state, actor, kind, now=1001, **fields):
        return engine.apply_action(state, actor, {'type': kind, 'phaseId': state['phaseId'], **fields}, now=now)

    def night(self, state, kill=None, protect=None, inspect=None, now=1001):
        mafia = self.role(state, 'mafia')
        doctor = self.role(state, 'doctor')
        detective = self.role(state, 'detective')
        civilians = self.role(state, 'civilian')
        kill = kill or civilians[0]['id']
        for member in mafia:
            state = self.act(state, member['id'], 'night-action', now=now, targetId=kill)
        if doctor:
            state = self.act(state, doctor[0]['id'], 'night-action', now=now, targetId=protect or doctor[0]['id'])
        if detective:
            state = self.act(state, detective[0]['id'], 'night-action', now=now, targetId=inspect or mafia[0]['id'])
        return state

    def voting(self, state, now=1002):
        for person in list(engine._living(state)):
            state = self.act(state, person['id'], 'ready', now=now)
        self.assertEqual(state['phase'], 'voting')
        return state

    def vote_all(self, state, target, now=1003):
        for person in list(engine._living(state)):
            state = self.act(state, person['id'], 'vote', now=now, targetId=target)
        return state

    def test_defaults_and_no_mutation(self):
        owner = player(1)
        state = engine.new_room(owner, now=1000)
        self.assertEqual(state['narratorId'], owner['id'])
        self.assertEqual(state['phase'], 'lobby')
        self.assertEqual(state['settings'], engine.DEFAULT_SETTINGS)
        before = deepcopy(state)
        joined = engine.add_player(state, player(2), now=1001)
        self.assertEqual(state, before)
        self.assertEqual(len(joined['players']), 2)
        self.assertEqual(owner, player(1))

    def test_human_creator_is_narrator_and_can_reassign_only_before_start(self):
        state = self.lobby('human', 6)
        self.error(403, lambda: self.act(state, pid(2), 'reassign-narrator', targetId=pid(3)))
        state = self.act(state, pid(1), 'reassign-narrator', targetId=pid(2))
        self.assertEqual(state['narratorId'], pid(2))
        with patch.object(engine.secrets, 'SystemRandom') as random:
            random.return_value.shuffle.side_effect = lambda roles: None
            state = self.act(state, pid(1), 'start')
        self.assertIsNotNone(state['players'][0]['role'])
        self.assertIsNone(state['players'][1]['role'])
        self.assertEqual(len(engine._active(state)), 5)
        self.error(409, lambda: self.act(state, pid(1), 'reassign-narrator', targetId=pid(3)))
        self.error(403, lambda: self.act(state, pid(1), 'advance'))
        self.error(403, lambda: self.act(state, pid(2), 'close'))

    def test_minimum_maximum_and_role_distribution(self):
        for mode, count in [('ai', 4), ('human', 5)]:
            self.error(409, lambda: self.act(self.lobby(mode, count), pid(1), 'start'))
        state = self.started('ai', 24)
        counts = {role: len(self.role(state, role)) for role in engine.ROLES}
        self.assertEqual(counts, {'mafia': 6, 'detective': 1, 'doctor': 1, 'civilian': 16})
        self.error(409, lambda: engine.add_player(state, player(25), now=1001))
        state = self.lobby('human', 25)
        self.error(409, lambda: engine.add_player(state, player(26), now=1001))
        self.error(409, lambda: self.act(state, pid(1), 'configure', narratorMode='ai'))

    def test_lobby_authority_capacity_and_removed_seats(self):
        state = self.lobby('human', 7)
        self.error(403, lambda: self.act(state, pid(2), 'kick', targetId=pid(3)))
        self.error(409, lambda: self.act(state, pid(1), 'kick', targetId=pid(1)))
        self.error(409, lambda: self.act(state, pid(1), 'configure', settings={'maxPlayers': 5}))
        state = self.act(state, pid(1), 'kick', targetId=pid(7))
        self.assertNotIn(pid(7), [person['id'] for person in state['players']])
        self.error(403, lambda: engine.project(state, pid(7), now=1001))
        state = self.act(state, pid(2), 'leave')
        self.assertTrue(engine.project(state, pid(2), now=1001)['self']['left'])
        self.assertEqual(len(engine._active(state)), 4)
        self.error(403, lambda: self.act(state, pid(2), 'chat', text='Still here?'))
        self.error(400, lambda: self.act(state, pid(1), 'reassign-narrator', targetId=pid(2)))
        self.error(409, lambda: self.act(state, pid(1), 'leave'))

    def test_input_validation_and_literal_names(self):
        for value in [None, [], {'id': pid(1), 'name': 'X', 'avatar': 'fox', 'role': 'mafia'}, {'id': 'x', 'name': 'X', 'avatar': 'fox'}, {'id': pid(1), 'name': 'X', 'avatar': 'unknown'}]:
            self.error(400, lambda: engine.validate_player(value))
        for name in ['', 'A' * 17, 'A\nB', '\u202eMystery', '\u200b', '\ud800', 1]:
            self.error(400, lambda: engine.validate_player({**player(1), 'name': name}))
        self.assertEqual(engine.validate_player({**player(1), 'name': ' <Pilot>🙂 '})['name'], '<Pilot>🙂')
        for settings in [{'maxPlayers': True}, {'maxPlayers': 25}, {'nightSeconds': 29}, {'discussionSeconds': 301}, {'votingSeconds': 0}, {'roles': []}, []]:
            self.error(400, lambda: engine.validate_settings(settings))
        for mode in ['robot', {}, False]:
            self.error(400, lambda: engine.new_room(player(1), mode, now=1000))
        state = self.lobby()
        self.error(409, lambda: engine.add_player(state, {**player(10), 'name': 'player1'}, now=1000))
        for action in [{'type': 'start', 'role': 'mafia'}, {'type': 'teleport'}, {'type': 'chat', 'channel': {}, 'text': 'Hi'}]:
            self.error(400, lambda: engine.apply_action(state, pid(1), action, now=1001))
        self.error(409, lambda: engine.apply_action(state, pid(1), {'type': 'start', 'phaseId': True}, now=1001))

    def test_private_projection_only_reveals_authorized_information(self):
        state = self.started()
        mafia, detective, doctor, civilian = (self.role(state, role)[0] for role in ('mafia', 'detective', 'doctor', 'civilian'))
        state = self.act(state, mafia['id'], 'night-action', targetId=civilian['id'])
        state = self.act(state, mafia['id'], 'chat', channel='mafia', text='Quietly pick a target.')
        ordinary = engine.project(state, civilian['id'], now=1001)
        self.assertEqual(ordinary['self']['role'], 'civilian')
        self.assertEqual(ordinary['self']['allies'], [])
        self.assertEqual(ordinary['mafiaChat'], [])
        self.assertNotIn('narratorInfo', ordinary)
        for field in ['nightActions', 'votes', '_messageTimes', 'narration', '_sequence']:
            self.assertNotIn(field, ordinary)
        self.assertFalse(any('role' in person for person in ordinary['players']))
        mafia_view = engine.project(state, mafia['id'], now=1001)
        self.assertEqual(mafia_view['self']['allies'], [self.role(state, 'mafia')[1]['id']])
        self.assertEqual(len(mafia_view['mafiaChat']), 1)
        self.assertEqual(mafia_view['self']['nightTargetId'], civilian['id'])
        self.assertEqual(engine.project(state, doctor['id'], now=1001)['self']['checks'], [])
        state['players'][0]['alive'] = False
        self.assertEqual(engine.project(state, mafia['id'], now=1001)['mafiaChat'], [])

    def test_human_narrator_sees_roles_and_private_choices_but_cannot_make_them(self):
        state = self.started('human', 6)
        mafia, civilian = self.role(state, 'mafia')[0], self.role(state, 'civilian')[0]
        state = self.act(state, mafia['id'], 'night-action', targetId=civilian['id'])
        view = engine.project(state, pid(1), now=1001)
        self.assertTrue(view['self']['isNarrator'])
        self.assertIsNone(view['self']['role'])
        self.assertEqual(len(view['narratorInfo']['roles']), 5)
        self.assertEqual(view['narratorInfo']['nightActions'], {mafia['id']: civilian['id']})
        self.assertFalse(view['narratorInfo']['readyToAdvance'])
        self.error(403, lambda: self.act(state, pid(1), 'night-action', targetId=civilian['id']))

    def test_doctor_protects_without_publicly_revealing_target_and_detective_gets_private_result(self):
        state = self.started()
        target = self.role(state, 'civilian')[0]['id']
        detective = self.role(state, 'detective')[0]['id']
        mafia = self.role(state, 'mafia')[0]['id']
        state = self.night(state, kill=target, protect=target, inspect=mafia)
        self.assertEqual(state['phase'], 'discussion')
        self.assertTrue(engine._player(state, target)['alive'])
        checks = engine.project(state, detective, now=1001)['self']['checks']
        self.assertEqual(checks, [{'day': 1, 'targetId': mafia, 'isMafia': True}])
        self.assertEqual(engine.project(state, target, now=1001)['self']['checks'], [])
        event = [event for event in state['events'] if event['kind'] == 'no-elimination'][-1]
        self.assertEqual(event['text'], 'Nobody was eliminated during the night.')
        self.assertNotIn(target, str(event))
        self.assertNotIn('doctor', event['text'].lower())

    def test_night_restrictions_and_simultaneous_detective_action(self):
        state = self.started()
        mafia = self.role(state, 'mafia')
        detective = self.role(state, 'detective')[0]['id']
        civilian = self.role(state, 'civilian')[0]['id']
        self.error(409, lambda: self.act(state, civilian, 'night-action', targetId=mafia[0]['id']))
        self.error(400, lambda: self.act(state, mafia[0]['id'], 'night-action', targetId=mafia[1]['id']))
        self.error(400, lambda: self.act(state, detective, 'night-action', targetId=detective))
        state = self.night(state, kill=detective, inspect=mafia[0]['id'])
        self.assertFalse(engine._player(state, detective)['alive'])
        self.assertTrue(engine.project(state, detective, now=1001)['self']['checks'][0]['isMafia'])
        self.error(403, lambda: self.act(state, detective, 'ready'))
        self.error(403, lambda: self.act(state, detective, 'chat', text='A clue!'))

    def test_split_mafia_target_does_not_choose_random_victim(self):
        state = self.started()
        mafia, civilians = self.role(state, 'mafia'), self.role(state, 'civilian')
        state = self.act(state, mafia[0]['id'], 'night-action', targetId=civilians[0]['id'])
        state = self.act(state, mafia[1]['id'], 'night-action', targetId=civilians[1]['id'])
        doctor, detective = self.role(state, 'doctor')[0], self.role(state, 'detective')[0]
        state = self.act(state, doctor['id'], 'night-action', targetId=doctor['id'])
        state = self.act(state, detective['id'], 'night-action', targetId=mafia[0]['id'])
        self.assertEqual(state['phase'], 'discussion')
        self.assertEqual(len(engine._living(state)), 8)

    def test_detective_retains_last_hundred_checks_without_an_artificial_round_limit(self):
        state = self.started()
        detective = self.role(state, 'detective')[0]
        mafia_id = self.role(state, 'mafia')[0]['id']
        detective['checks'] = [{'day': day, 'targetId': mafia_id, 'isMafia': True} for day in range(1, 101)]
        state['day'] = 101
        target = self.role(state, 'civilian')[0]['id']
        state = self.night(state, kill=target, protect=target, inspect=mafia_id)
        checks = engine.project(state, detective['id'], now=1001)['self']['checks']
        self.assertEqual(len(checks), 100)
        self.assertEqual(checks[0]['day'], 2)
        self.assertEqual(checks[-1], {'day': 101, 'targetId': mafia_id, 'isMafia': True})
        self.assertEqual(state['phase'], 'discussion')

    def test_day_vote_plurality_tie_skip_and_secret_ballots(self):
        state = self.voting(self.night(self.started(), protect=self.role(self.started(), 'civilian')[0]['id']))
        living = engine._living(state)
        first, second = living[0]['id'], living[1]['id']
        state = self.act(state, first, 'vote', targetId=second)
        view = engine.project(state, second, now=1003)
        self.assertFalse(view['self']['hasVoted'])
        self.assertNotIn('votes', view)
        self.assertNotIn(first, str(view['events'][-1]))
        for index, person in enumerate(living[1:]):
            state = self.act(state, person['id'], 'vote', targetId=first if index < 5 else second)
        self.assertEqual(state['phase'], 'night')
        self.assertFalse(engine._player(state, first)['alive'])
        state = self.voting(self.night(self.started(), protect=self.role(self.started(), 'civilian')[0]['id']))
        for index, person in enumerate(engine._living(state)):
            state = self.act(state, person['id'], 'vote', targetId=pid(1) if index < 4 else pid(2))
        self.assertEqual(len(engine._living(state)), 8)
        self.assertEqual(state['day'], 2)
        state = self.voting(self.night(self.started(), protect=self.role(self.started(), 'civilian')[0]['id']))
        state = self.vote_all(state, 'skip')
        self.assertEqual(len(engine._living(state)), 8)

    def test_win_conditions_are_server_owned_and_finished_reveals_roles(self):
        state = self.started('ai', 5)
        mafia = self.role(state, 'mafia')[0]['id']
        state = self.voting(self.night(state))
        state = self.vote_all(state, mafia)
        self.assertEqual(state['winner'], 'town')
        self.assertEqual(state['phase'], 'finished')
        view = engine.project(state, pid(1), now=1003)
        self.assertTrue(all('role' in person for person in view['players']))
        self.assertIsNone(view['deadlineAt'])
        self.error(409, lambda: self.act(state, pid(1), 'start'))
        state = self.started('ai', 5)
        state = self.voting(self.night(state))
        civilian = self.role(state, 'civilian')[0]['id']
        state = self.vote_all(state, civilian)
        self.assertEqual(state['phase'], 'night')
        detective = self.role(state, 'detective')[0]['id']
        state = self.night(state, kill=detective)
        self.assertEqual(state['winner'], 'mafia')
        self.assertEqual(state['phase'], 'finished')

    def test_ai_timers_advance_one_phase_and_human_never_advances_on_poll(self):
        state = self.started()
        before = deepcopy(state)
        self.assertEqual(engine.reconcile(state, now=1074), state)
        expired = engine.reconcile(state, now=1075)
        self.assertEqual(state, before)
        self.assertEqual(expired['phase'], 'discussion')
        self.assertEqual(expired['deadlineAt'], 1165)
        self.assertEqual(len(engine._living(expired)), 8)
        expired = engine.reconcile(expired, now=2000)
        self.assertEqual(expired['phase'], 'voting')
        self.assertEqual(expired['deadlineAt'], 2045)
        human = self.started('human', 6)
        self.assertEqual(engine.reconcile(human, now=10000), human)
        self.error(409, lambda: self.act(human, pid(1), 'advance', force=True, now=1074))
        self.error(409, lambda: self.act(human, pid(1), 'advance', now=1075))
        human = self.act(human, pid(1), 'advance', force=True, now=1075)
        self.assertEqual(human['phase'], 'discussion')
        human = self.act(human, pid(1), 'advance', now=1076)
        self.assertEqual(human['phase'], 'voting')

    def test_owner_rematch_clears_roles_checks_choices_and_private_history(self):
        state = self.started('ai', 5)
        mafia = self.role(state, 'mafia')[0]['id']
        state = self.act(state, mafia, 'chat', channel='mafia', text='Old private team plan.')
        state = self.vote_all(self.voting(self.night(state)), mafia)
        self.assertEqual(state['phase'], 'finished')
        old_phase = state['phaseId']
        self.error(403, lambda: self.act(state, pid(2), 'restart'))
        restarted = self.act(state, pid(1), 'restart', now=1100)
        self.assertEqual(restarted['phase'], 'lobby')
        self.assertEqual(restarted['phaseId'], old_phase + 1)
        self.assertEqual(restarted['day'], 0)
        self.assertIsNone(restarted['winner'])
        self.assertIsNone(restarted['deadlineAt'])
        self.assertEqual(restarted['chat'], [])
        self.assertEqual(restarted['mafiaChat'], [])
        self.assertEqual(restarted['nightActions'], {})
        self.assertEqual(restarted['votes'], {})
        self.assertEqual(restarted['_messageTimes'], {})
        self.assertTrue(all(person['alive'] and person['role'] is None and person['checks'] == [] for person in restarted['players']))
        self.assertEqual(len(restarted['events']), 1)
        self.assertNotIn('Old private', str(engine.project(restarted, pid(1), now=1100)))
        self.assertEqual(engine.project(restarted, pid(2), now=1100)['self']['allies'], [])
        self.error(409, lambda: self.act(restarted, pid(1), 'restart'))

    def test_chat_authorization_bounds_and_shared_rate(self):
        state = self.started()
        mafia, town = self.role(state, 'mafia')[0]['id'], self.role(state, 'civilian')[0]['id']
        self.error(409, lambda: self.act(state, town, 'chat', text='Wake up!'))
        self.error(403, lambda: self.act(state, town, 'chat', channel='mafia', text='Secret'))
        for index in range(12):
            state = self.act(state, mafia, 'chat', channel='mafia', text='Secret ' + str(index), now=1001)
        self.error(429, lambda: self.act(state, mafia, 'chat', channel='mafia', text='One more', now=1060))
        state = self.act(state, mafia, 'chat', channel='mafia', text='<script>literal</script>', now=1061)
        self.assertEqual(state['mafiaChat'][-1]['text'], '<script>literal</script>')
        self.error(400, lambda: self.act(state, mafia, 'chat', channel='mafia', text='x' * 241, now=1062))
        self.error(400, lambda: self.act(state, mafia, 'chat', channel='mafia', text='Hi\nthere', now=1062))
        self.error(403, lambda: self.act(state, mafia, 'announce', text='A narrator?'))
        human = self.started('human', 6)
        for index in range(12):
            human = self.act(human, pid(1), 'announce', text='Announcement ' + str(index))
        self.error(429, lambda: self.act(human, pid(1), 'chat', text='One more'))
        self.assertEqual(len([event for event in human['events'] if event['kind'] == 'announcement']), 12)

    def test_bounded_history_literal_ai_prose_and_canonical_events(self):
        state = self.lobby('ai', 5)
        state['narration'] = {'night': 'The moon rises.', 'townWin': 'A brighter morning.', 'protected': 'The streets are quiet.'}
        with patch.object(engine.secrets, 'SystemRandom') as random:
            random.return_value.shuffle.side_effect = lambda roles: None
            state = self.act(state, pid(1), 'start')
        self.assertTrue(state['events'][-1]['text'].startswith('The moon rises. Night 1:'))
        self.assertNotIn('narration', engine.project(state, pid(1), now=1001))
        mafia = self.role(state, 'mafia')[0]['id']
        for index in range(100):
            state = self.act(state, mafia, 'chat', channel='mafia', text='Message ' + str(index), now=1001 + index * 61)
        self.assertEqual(len(state['mafiaChat']), 40)
        human = self.started('human', 6)
        for index in range(110):
            human = self.act(human, pid(1), 'announce', text='Message ' + str(index), now=1001 + index * 61)
        self.assertEqual(len(human['chat']), 80)
        self.assertEqual(len(human['events']), 100)
        ids = [message['id'] for message in human['chat']]
        self.assertEqual(len(set(ids)), len(ids))

    def test_departure_and_close_do_not_allow_hidden_role_or_phase_manipulation(self):
        state = self.started('ai', 5)
        mafia = self.role(state, 'mafia')[0]['id']
        # In this deterministic fixture owner is mafia, so owner must close.
        self.error(409, lambda: self.act(state, mafia, 'leave'))
        town = self.role(state, 'civilian')[0]['id']
        state = self.act(state, town, 'leave')
        self.assertTrue(engine._player(state, town)['left'])
        self.assertFalse(engine._player(state, town)['alive'])
        self.error(403, lambda: self.act(state, town, 'vote', targetId='skip'))
        self.error(403, lambda: self.act(state, pid(2), 'close'))
        closed = self.act(state, pid(1), 'close')
        self.assertEqual(closed['phase'], 'closed')
        self.assertIsNone(closed['deadlineAt'])
        self.error(409, lambda: self.act(closed, pid(1), 'chat', text='Again'))
        self.assertEqual(state['phase'], 'night')


if __name__ == '__main__':
    unittest.main()
