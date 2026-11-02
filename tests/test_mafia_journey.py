"""Full synthetic Mafia journeys through the production API and memory DynamoDB.

No AWS, Core, model or real-player requests occur. Every actor uses its actual
anonymous capability and every mutation uses its current server action sequence.
"""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import types
import unittest
from unittest.mock import Mock, patch

from test_nce_api import ConditionalFailure, MemoryDatabase, ORG, SERVICE

spec = importlib.util.spec_from_file_location('game_studio_mafia_journey', Path(__file__).resolve().parents[1] / 'backend/nce_api/mafia.py')
mafia = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mafia)


def pid(number):
    return '00000000-0000-4000-8000-' + str(number).zfill(12)


def capability(number):
    return 'P' + str(number).zfill(42)


class MafiaJourneyTests(unittest.TestCase):
    def setUp(self):
        self.now = 2000000000
        self.clock = patch.object(mafia.time, 'time', side_effect=lambda: self.now)
        self.clock.start(); self.addCleanup(self.clock.stop)
        self.env = patch.dict(os.environ, {'CORE_ORGANIZATION_ID': ORG, 'CORE_SERVICE_ID': SERVICE,
            'GAME_PUBLIC_TABLE': 'published-games', 'GAME_DRAFT_TABLE': 'private-games'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.database = MemoryDatabase()
        self.database.rows.update({'published-games': {}, 'private-games': {}})
        self.database.meta.client.exceptions = types.SimpleNamespace(TransactionCanceledException=ConditionalFailure)
        self.authorize = Mock(side_effect=AssertionError('Anonymous gameplay must not introspect a Core identity.'))
        self.api = types.SimpleNamespace(clients=lambda: (self.database, None, None), authorize=self.authorize)
        self.engine = mafia.engine()
        self.shuffle = patch.object(self.engine.secrets, 'SystemRandom')
        random = self.shuffle.start(); self.addCleanup(self.shuffle.stop)
        random.return_value.shuffle.side_effect = lambda values: None
        self.phrases = {key: 'The town awaits its next chapter.' for key in ('night', 'discussion', 'voting', 'eliminated', 'protected', 'tie', 'townWin', 'mafiaWin')}
        narration = types.SimpleNamespace(load_bank=lambda api: {'version': 1, 'source': 'amazon.nova-micro-v1:0', 'phrases': deepcopy(self.phrases)})
        bank = patch.object(mafia, '_narration', narration)
        bank.start(); self.addCleanup(bank.stop)
        self.sessions = {}
        self.counter = 200

    def event(self, number=None):
        return {'headers': {'authorization': 'Bearer ' + capability(number)} if number else {},
            'requestContext': {'http': {'sourceIp': '203.0.113.50'}}}

    def dispatch(self, method, suffix='', body=None, number=None):
        path = '/mafia/rooms' + suffix
        return mafia.dispatch(self.api, self.event(number), method, path, body or {})

    def error(self, status, callback):
        with self.assertRaises(mafia.MafiaError) as raised:
            callback()
        self.assertEqual(raised.exception.status, status)

    def create(self, mode='ai', count=5):
        self.room_id = pid(1)
        invite = 'I' * 43
        result = self.dispatch('POST', body={'requestId': self.room_id, 'name': 'Captain', 'avatar': 'fox',
            'playerToken': capability(1), 'inviteToken': invite, 'narratorMode': mode,
            'maxPlayers': 8, 'nightSeconds': 30, 'discussionSeconds': 30, 'votingSeconds': 30})
        self.sessions[1] = result['session']
        for number in range(2, count + 1):
            joined = self.dispatch('POST', '/' + self.room_id + '/join', {'requestId': pid(number),
                'name': 'Player' + str(number), 'avatar': self.engine.AVATARS[number - 1],
                'playerToken': capability(number), 'inviteToken': invite})
            self.sessions[number] = joined['session']
        return self.get(1)

    def get(self, number):
        return self.dispatch('GET', '/' + self.room_id, number=number)['room']

    def action_body(self, number, kind, **fields):
        room = self.get(number)
        self.counter += 1
        return {'requestId': pid(self.counter), 'phaseId': room['phaseId'], 'sequence': room['self']['actionSequence'] + 1, 'type': kind, **fields}

    def act(self, number, kind, **fields):
        body = self.action_body(number, kind, **fields)
        return self.dispatch('POST', '/' + self.room_id + '/actions', body, number=number)['room']

    def roles(self):
        return {self.get(number)['self']['role']: number for number in self.sessions if self.get(number)['self']['role'] not in {None, 'civilian'}}

    def alive_numbers(self):
        view = self.get(1)
        return [number for number in self.sessions if any(player['id'] == pid(number) and player['alive'] and not player['isNarrator'] and not player.get('left') for player in view['players'])]

    def assert_private(self, number):
        room = self.get(number)
        wire = json.dumps(room)
        for field in ['tokenHash', 'inviteHash', 'createFingerprint', 'lastFingerprint', 'members', 'game', 'narration', '_messageTimes']:
            self.assertNotIn('"' + field + '"', wire)
        for seat in self.sessions:
            self.assertNotIn(capability(seat), wire)
        if not room['self']['isNarrator'] and room['phase'] != 'finished':
            self.assertNotIn('narratorInfo', room)
            self.assertFalse(any('role' in player for player in room['players']))
        return room

    def test_human_narrator_reassignment_full_game_private_choices_and_reconnect(self):
        lobby = self.create('human', 6)  # Five playing seats plus the human narrator.
        self.assertTrue(lobby['self']['isNarrator'])
        self.act(1, 'reassign-narrator', targetId=pid(2))
        started = self.act(1, 'start')
        self.assertEqual(started['phase'], 'night')
        self.assertFalse(started['self']['isNarrator'])
        self.assertTrue(started['self']['isOwner'])
        self.assertEqual(started['self']['role'], 'mafia')
        narrator = self.get(2)
        self.assertTrue(narrator['self']['isNarrator'])
        self.assertIsNone(narrator['self']['role'])
        self.assertEqual(len(narrator['narratorInfo']['roles']), 5)
        roles = self.roles()
        self.assertEqual(set(roles), {'mafia', 'detective', 'doctor'})
        civilians = [seat for seat in self.sessions if self.get(seat)['self']['role'] == 'civilian']
        victim = civilians[0]
        self.act(roles['mafia'], 'chat', channel='mafia', text='Only our team should see this.')
        for seat in civilians:
            self.assertEqual(self.assert_private(seat)['mafiaChat'], [])
        self.act(roles['mafia'], 'night-action', targetId=pid(victim))
        self.act(roles['doctor'], 'night-action', targetId=pid(victim))
        self.act(roles['detective'], 'night-action', targetId=pid(roles['mafia']))
        self.assertEqual(self.get(victim)['phase'], 'night')  # A human advances it.
        self.assertTrue(self.get(2)['narratorInfo']['readyToAdvance'])
        day = self.act(2, 'advance')
        self.assertEqual(day['phase'], 'discussion')
        self.assertTrue(self.get(victim)['self']['alive'])
        detective = self.assert_private(roles['detective'])
        self.assertEqual(detective['self']['checks'], [{'day': 1, 'targetId': pid(roles['mafia']), 'isMafia': True}])
        for seat in civilians:
            self.assertEqual(self.get(seat)['self']['checks'], [])
        self.act(victim, 'chat', channel='public', text='Let us compare our suspicions.')
        self.assertEqual(self.get(roles['doctor'])['chat'][-1]['text'], 'Let us compare our suspicions.')
        self.assertEqual(self.get(victim)['self']['id'], pid(victim))  # Same token reconnects.
        self.act(2, 'announce', text='Time to choose who should leave town.')
        self.act(2, 'advance')
        self.assertEqual(self.get(victim)['phase'], 'voting')
        for number in self.alive_numbers():
            self.act(number, 'vote', targetId=pid(roles['mafia']))
        self.assertEqual(self.get(victim)['phase'], 'voting')
        won = self.act(2, 'advance')
        self.assertEqual(won['phase'], 'finished')
        self.assertEqual(won['winner'], 'town')
        self.assertEqual(sum(player.get('role') == 'mafia' for player in won['players']), 1)
        self.authorize.assert_not_called()

    def test_ai_narration_full_game_automatic_phases_private_investigation_and_rematch(self):
        self.create('ai', 5)
        start = self.act(1, 'start')
        self.assertEqual(start['narratorMode'], 'ai')
        self.assertIsNone(start['narratorId'])
        self.assertTrue(start['events'][-1]['text'].startswith(self.phrases['night']))
        roles = self.roles()
        victim = next(number for number in self.sessions if self.get(number)['self']['role'] == 'civilian')
        self.act(roles['mafia'], 'night-action', targetId=pid(victim))
        self.act(roles['doctor'], 'night-action', targetId=pid(victim))
        day = self.act(roles['detective'], 'night-action', targetId=pid(roles['mafia']))
        self.assertEqual(day['phase'], 'discussion')
        self.assertTrue(self.get(roles['detective'])['self']['checks'][0]['isMafia'])
        for number in self.alive_numbers():
            voting = self.act(number, 'ready')
        self.assertEqual(voting['phase'], 'voting')
        for number in self.alive_numbers():
            won = self.act(number, 'vote', targetId=pid(roles['mafia']))
        self.assertEqual(won['phase'], 'finished')
        self.assertEqual(won['winner'], 'town')
        self.assertTrue(won['events'][-1]['text'].startswith(self.phrases['townWin']))
        self.error(403, lambda: self.act(2, 'restart'))
        rematch = self.act(1, 'restart')
        self.assertEqual(rematch['phase'], 'lobby')
        self.assertTrue(all('role' not in player for player in rematch['players']))
        self.assertEqual(rematch['self']['checks'], [])
        self.assertEqual(rematch['mafiaChat'], [])
        self.assertEqual(rematch['chat'], [])
        self.assertIsNone(rematch['winner'])
        self.assertEqual(len(rematch['events']), 1)
        self.assertEqual(self.get(2)['self']['role'], None)
        self.authorize.assert_not_called()

    def test_timeout_stale_actions_are_not_admitted_and_unknown_capability_cannot_read(self):
        self.create('ai', 5)
        started = self.act(1, 'start')
        stale = self.action_body(1, 'night-action', targetId=pid(4))
        self.now = started['deadlineAt']
        self.error(409, lambda: self.dispatch('POST', '/' + self.room_id + '/actions', stale, number=1))
        day = self.get(1)
        self.assertEqual(day['phase'], 'discussion')
        self.assertFalse(any(event['kind'] == 'elimination' for event in day['events']))
        self.assertEqual(day['self']['actionSequence'], stale['sequence'] - 1)
        self.assertIsNone(day['self']['nightTargetId'])
        self.now = day['deadlineAt']
        voting = self.get(2)
        self.assertEqual(voting['phase'], 'voting')
        self.now = voting['deadlineAt']
        night = self.get(3)
        self.assertEqual(night['phase'], 'night')
        self.assertEqual(night['day'], 2)
        self.assertEqual(len([player for player in night['players'] if player['alive']]), 5)
        self.error(401, lambda: self.dispatch('GET', '/' + self.room_id, number=99))
        self.error(401, lambda: self.dispatch('GET', '/' + self.room_id))
        self.authorize.assert_not_called()

    def test_action_retry_and_lobby_departure_preserve_other_seats(self):
        self.create('human', 6)
        before = self.get(1)
        body = self.action_body(3, 'chat', text='A single hello.')
        first = self.dispatch('POST', '/' + self.room_id + '/actions', body, number=3)['room']
        replay = self.dispatch('POST', '/' + self.room_id + '/actions', deepcopy(body), number=3)['room']
        self.assertEqual(replay['revision'], first['revision'])
        self.assertEqual(sum(message['text'] == 'A single hello.' for message in replay['chat']), 1)
        left = self.act(3, 'leave')
        self.assertTrue(left['self']['left'])
        self.assertFalse(left['self']['alive'])
        self.assertEqual(self.get(2)['self']['id'], pid(2))
        self.assertEqual(self.get(1)['ownerId'], before['ownerId'])
        self.error(403, lambda: self.act(3, 'chat', text='Not allowed'))
        self.act(1, 'kick', targetId=pid(4))
        self.error(403, lambda: self.get(4))
        self.assertEqual(self.get(5)['self']['id'], pid(5))
        self.authorize.assert_not_called()


if __name__ == '__main__':
    unittest.main()
