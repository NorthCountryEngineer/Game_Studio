"""Actual Mafia adapter/rules with synthetic DynamoDB and no cloud calls."""
from copy import deepcopy
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import types
import unittest
from unittest.mock import Mock, patch

import test_games as support
from test_nce_api import ConditionalFailure, MemoryTable
from test_mafia_narration import PHRASES

spec = importlib.util.spec_from_file_location('test_mafia_api_module', Path(__file__).parents[1] / 'backend/nce_api/mafia.py')
mafia = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mafia)


def uuid(number):
    return f'{number:08x}-0000-4000-8000-{number:012x}'


def capability(number):
    return base64.urlsafe_b64encode(hashlib.sha256(str(number).encode()).digest()).rstrip(b'=').decode()


class MafiaAPITests(unittest.TestCase):
    authorize = support.GameTests.authorize
    event = support.GameTests.event
    write_registry = support.GameTests.write_registry

    def setUp(self):
        support.GameTests.setUp(self)
        self.database.meta.client.exceptions = types.SimpleNamespace(TransactionCanceledException=ConditionalFailure)
        self.clock = 1000000
        clock = patch.object(mafia.time, 'time', side_effect=lambda: self.clock)
        clock.start(); self.addCleanup(clock.stop)
        pause = patch.object(mafia, 'pause')
        pause.start(); self.addCleanup(pause.stop)
        shuffle = patch.object(mafia.engine().secrets, 'SystemRandom', return_value=types.SimpleNamespace(shuffle=lambda items: None))
        shuffle.start(); self.addCleanup(shuffle.stop)
        self.bank = {'version': 1, 'source': 'amazon.nova-micro-v1:0', 'phrases': PHRASES}
        bank = patch.object(mafia.narration(), 'load_bank', return_value=deepcopy(self.bank))
        self.load_bank = bank.start(); self.addCleanup(bank.stop)
        config = patch.object(mafia.narration(), 'public_config', return_value={'aiAvailable': True, 'aiLabel': 'AI narrator'})
        config.start(); self.addCleanup(config.stop)
        self.sessions = {}; self.room_id = uuid(1); self.request_counter = 1000
        self.create_body = self.new_create_body(self.room_id)
        for name in ('socket', 'create_connection'):
            blocked = patch.object(socket, name, side_effect=AssertionError('Network is disabled in offline tests.'))
            blocked.start(); self.addCleanup(blocked.stop)

    def new_create_body(self, room_id, **values):
        return {'requestId': room_id, 'name': 'Host', 'avatar': 'fox',
            'playerToken': capability(room_id), 'inviteToken': capability('invite-' + room_id), **values}

    def request_event(self, player_id=None, ip='192.0.2.5'):
        return {'requestContext': {'http': {'sourceIp': ip}}, 'headers':
            {'authorization': 'Bearer ' + self.sessions[player_id]['token']} if player_id else {}}

    def create(self, **values):
        self.create_body.update(values)
        result = mafia.dispatch(self.api, self.request_event(), 'POST', '/mafia/rooms', self.create_body)
        self.sessions[result['session']['playerId']] = result['session']
        return result

    def join_body(self, number):
        return {'requestId': uuid(number), 'name': 'Player ' + str(number), 'avatar': 'robot',
            'playerToken': capability(number), 'inviteToken': self.create_body['inviteToken']}

    def join(self, number):
        result = mafia.dispatch(self.api, self.request_event(), 'POST', '/mafia/rooms/' + self.room_id + '/join', self.join_body(number))
        self.sessions[result['session']['playerId']] = result['session']
        return result

    def get(self, player_id=None):
        return mafia.dispatch(self.api, self.request_event(player_id or self.room_id), 'GET', '/mafia/rooms/' + self.room_id, {})['room']

    def body(self, player_id, kind, **values):
        room = self.get(player_id); self.request_counter += 1
        return {'requestId': uuid(self.request_counter), 'phaseId': room['phaseId'],
            'sequence': room['self']['actionSequence'] + 1, 'type': kind, **values}

    def action(self, player_id, kind, **values):
        return self.send(player_id, self.body(player_id, kind, **values))

    def send(self, player_id, body):
        return mafia.dispatch(self.api, self.request_event(player_id), 'POST', '/mafia/rooms/' + self.room_id + '/actions', body)['room']

    def state(self):
        return json.loads(self.database.rows['published-games'][mafia.key('game-mafia-room', self.room_id)]['payload'])

    def index(self):
        return json.loads(self.database.rows['published-games'][mafia.key('game-mafia-index')]['payload'])

    def error(self, status, action):
        with self.assertRaises(mafia.MafiaError) as caught:
            action()
        self.assertEqual(caught.exception.status, status)
        return caught.exception.message

    def playing(self, ai=False):
        self.create(narratorMode='ai' if ai else 'human')
        for number in range(2, 6 if ai else 7):
            self.join(number)
        self.action(self.room_id, 'start')
        return self.state()['game']

    def ai_voting(self):
        game = self.playing(ai=True)
        roles = {player['role']: player['id'] for player in game['players'] if player['role'] != 'civilian'}
        self.action(roles['mafia'], 'night-action', targetId=uuid(4))
        self.action(roles['doctor'], 'night-action', targetId=uuid(4))
        self.action(roles['detective'], 'night-action', targetId=roles['mafia'])
        self.assertEqual(self.get()['phase'], 'discussion')
        for player in self.state()['game']['players']:
            self.action(player['id'], 'ready')
        self.assertEqual(self.get()['phase'], 'voting')
        return roles

    def test_room_creation_and_join_are_anonymous_and_caps_are_hashed_at_rest(self):
        created = self.create(); joined = self.join(2)
        self.assertEqual(created['room']['self']['role'], None)
        self.assertTrue(created['room']['self']['isNarrator'])
        self.assertFalse(joined['room']['self']['isNarrator'])
        self.assertEqual(joined['room']['self']['actionSequence'], 0)
        self.assertEqual(len(self.state()['members']), 2)
        serialized = json.dumps(self.database.rows)
        for value in (self.create_body['playerToken'], self.create_body['inviteToken'], capability(2), '192.0.2.5'):
            self.assertNotIn(value, serialized)
        self.authorization.assert_not_called(); self.provider.converse.assert_not_called()

    def test_get_requires_exact_room_capability_not_invite_or_core_identity(self):
        self.create(); self.join(2)
        path = '/mafia/rooms/' + self.room_id
        for headers in ({}, {'authorization': 'Bearer current'}, {'authorization': 'Bearer ' + self.create_body['inviteToken']},
                {'authorization': 'Bearer ' + capability('different')}, {'authorization': ['bad']}):
            self.error(401, lambda: mafia.dispatch(self.api, {'headers': headers}, 'GET', path, {}))
        event = {'headers': {'Authorization': 'Bearer ' + self.sessions[uuid(2)]['token']}}
        self.assertEqual(mafia.dispatch(self.api, event, 'GET', path, {})['room']['self']['id'], uuid(2))
        self.authorization.assert_not_called()

    def test_room_id_and_invite_are_bound_and_midround_join_is_rejected(self):
        self.create()
        invalid = {**self.join_body(2), 'inviteToken': capability('wrong')}
        self.error(403, lambda: mafia.join(self.api, self.room_id, invalid))
        self.error(404, lambda: mafia.join(self.api, uuid(999), self.join_body(2)))
        for number in range(2, 7): self.join(number)
        self.action(self.room_id, 'start')
        self.error(409, lambda: self.join(7))
        self.assertEqual(len(self.state()['members']), 6)

    def test_invitation_must_never_double_as_player_capability(self):
        self.create()
        body = {**self.join_body(2), 'playerToken': self.create_body['inviteToken']}
        self.error(400, lambda: mafia.join(self.api, self.room_id, body))
        self.assertEqual(len(self.state()['members']), 1)

    def test_creator_and_join_retries_are_idempotent_and_different_payloads_conflict(self):
        first = self.create(); joined = self.join(2)
        before = deepcopy(self.database.rows)
        self.assertEqual(self.create()['session'], first['session'])
        self.assertEqual(self.join(2)['session'], joined['session'])
        self.assertEqual(self.database.rows, before)
        self.error(409, lambda: mafia.create(self.api, self.request_event(), {**self.create_body, 'name': 'Other host'}))
        self.error(409, lambda: mafia.join(self.api, self.room_id, {**self.join_body(2), 'name': 'Other name'}))
        self.assertEqual(self.index()['count'], 1)

    def test_role_projection_and_private_choices_never_cross_seats(self):
        self.playing()
        self.action(uuid(2), 'chat', channel='mafia', text='Our private plan.')
        self.action(uuid(2), 'night-action', targetId=uuid(5))
        mafia_view, detective_view, civilian_view = self.get(uuid(2)), self.get(uuid(3)), self.get(uuid(5))
        narrator = self.get()
        for room in (mafia_view, detective_view, civilian_view):
            self.assertNotIn('members', room); self.assertNotIn('nightActions', room)
            self.assertNotIn('narratorInfo', room)
            self.assertTrue(all('role' not in player for player in room['players']))
            self.assertNotIn('tokenHash', json.dumps(room))
        self.assertEqual(mafia_view['self']['role'], 'mafia')
        self.assertEqual(detective_view['self']['role'], 'detective')
        self.assertEqual(civilian_view['self']['role'], 'civilian')
        self.assertEqual(civilian_view['mafiaChat'], []); self.assertEqual(detective_view['mafiaChat'], [])
        self.assertEqual(mafia_view['mafiaChat'][0]['text'], 'Our private plan.')
        self.assertEqual(narrator['narratorInfo']['nightActions'], {uuid(2): uuid(5)})
        self.assertEqual(len(narrator['narratorInfo']['roles']), 5)

    def test_nonowner_and_non_narrator_cannot_control_room(self):
        self.create(); self.join(2)
        for action in ('start', 'close', 'reassign-narrator'):
            values = {'targetId': uuid(2)} if action == 'reassign-narrator' else {}
            self.error(403, lambda: self.action(uuid(2), action, **values))
        self.error(403, lambda: self.action(uuid(2), 'announce', text='Pretend narrator.'))
        self.assertEqual(self.get(uuid(2))['self']['actionSequence'], 0)

    def test_last_action_retry_is_read_only_and_sequence_or_phase_reuse_fails(self):
        self.create(); self.join(2)
        body = self.body(uuid(2), 'chat', text='Hello town.', channel='public')
        first = self.send(uuid(2), body); saved = deepcopy(self.database.rows)
        second = self.send(uuid(2), body)
        self.assertEqual(first, second); self.assertEqual(saved, self.database.rows)
        self.error(409, lambda: self.send(uuid(2), {**body, 'text': 'Changed contents.'}))
        self.error(409, lambda: self.send(uuid(2), {**body, 'sequence': 3, 'requestId': uuid(900)}))
        self.error(409, lambda: self.send(uuid(2), {**body, 'sequence': 2, 'phaseId': 99, 'requestId': uuid(901)}))
        self.assertEqual(len(self.state()['game']['chat']), 1)

    def test_two_concurrent_final_seat_joins_cannot_overfill(self):
        self.create(maxPlayers=5)
        for number in range(2, 6): self.join(number)
        real = self.database.transact; raced = False
        def race(TransactItems):
            nonlocal raced
            if not raced:
                raced = True
                self.database.meta.client.transact_write_items.side_effect = real
                self.join(7)
                self.database.meta.client.transact_write_items.side_effect = race
            return real(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = race
        self.error(409, lambda: self.join(6))
        self.assertEqual(len(self.state()['game']['players']), 6)
        self.assertNotIn(uuid(6), self.state()['members']); self.assertIn(uuid(7), self.state()['members'])

    def test_concurrent_last_votes_preserve_both_and_resolve_exactly_once(self):
        self.ai_voting()
        for player_id in (uuid(1), uuid(2), uuid(3)):
            self.action(player_id, 'vote', targetId='skip')
        body = self.body(uuid(4), 'vote', targetId='skip')
        real = self.database.transact; raced = False
        def race(TransactItems):
            nonlocal raced
            if not raced:
                raced = True
                self.database.meta.client.transact_write_items.side_effect = real
                self.action(uuid(5), 'vote', targetId='skip')
                self.database.meta.client.transact_write_items.side_effect = race
            return real(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = race
        result = self.send(uuid(4), body)
        self.assertEqual(result['phase'], 'night'); self.assertEqual(result['day'], 2)
        state = self.state()
        self.assertEqual(sum(event['text'].endswith('The town did not eliminate anyone in this vote.') for event in state['game']['events']), 1)
        self.assertEqual(state['members'][uuid(4)]['sequence'], body['sequence'])
        self.assertEqual(self.send(uuid(4), body)['phase'], 'night')

    def test_timed_out_ai_poll_advances_one_phase_and_rejects_old_phase_action(self):
        self.playing(ai=True)
        body = self.body(uuid(4), 'chat', text='Too late for the previous phase.', channel='public')
        self.clock += 76
        self.error(409, lambda: self.send(uuid(4), body))
        self.assertEqual(self.get(uuid(4))['phase'], 'discussion')
        self.assertEqual(self.state()['members'][uuid(4)]['sequence'], 0)
        self.assertEqual(self.get()['day'], 1)

    def test_human_poll_does_not_advance_and_narrator_timeout_control_is_explicit(self):
        self.playing(); self.clock += 76
        self.assertEqual(self.get()['phase'], 'night')
        self.error(409, lambda: self.action(self.room_id, 'advance'))
        self.assertEqual(self.action(self.room_id, 'advance', force=True)['phase'], 'discussion')

    def test_active_lease_renewal_updates_index_and_room_atomically(self):
        self.create(); self.clock += mafia.ROOM_SECONDS // 2 + 1
        expected = self.clock + mafia.ROOM_SECONDS
        self.assertEqual(self.get()['expiresAt'], expected)
        self.assertEqual(self.state()['expiresAt'], expected)
        self.assertEqual(self.index()['rooms'][self.room_id], expected)
        transactions = self.database.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        self.assertEqual(len(transactions), 2)

    def test_expired_rows_are_removed_only_with_fenced_index_on_new_creation(self):
        self.create(); old_id = self.room_id
        unrelated = {'id': 'unrelated', 'payload': 'preserve'}
        self.database.rows['published-games']['unrelated'] = unrelated
        self.clock += mafia.ROOM_SECONDS + 1
        self.error(410, self.get)
        self.room_id = uuid(8); self.create_body = self.new_create_body(self.room_id)
        self.create()
        self.assertNotIn(mafia.key('game-mafia-room', old_id), self.database.rows['published-games'])
        self.assertNotIn(old_id, self.index()['rooms'])
        self.assertEqual(self.database.rows['published-games']['unrelated'], unrelated)

    def test_missing_expired_room_can_be_recreated_without_duplicate_transaction_targets(self):
        self.create()
        del self.database.rows['published-games'][mafia.key('game-mafia-room', self.room_id)]
        self.clock += mafia.ROOM_SECONDS + 1
        real = self.database.transact
        def unique_targets(TransactItems):
            targets = []
            for entry in TransactItems:
                operation = next(iter(entry.values()))
                item_key = operation.get('Key', operation.get('Item'))['id']
                targets.append((operation['TableName'], item_key))
            self.assertEqual(len(targets), len(set(targets)), 'DynamoDB forbids two transaction operations on the same item.')
            return real(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = unique_targets
        result = self.create()
        self.assertEqual(result['room']['phase'], 'lobby')
        self.assertEqual(self.index()['rooms'][self.room_id], self.clock + mafia.ROOM_SECONDS)

    def test_closed_room_has_short_bounded_retention_in_room_and_index(self):
        self.create(); self.action(self.room_id, 'close')
        self.assertLessEqual(self.state()['expiresAt'], self.clock + 600)
        self.assertEqual(self.state()['expiresAt'], self.index()['rooms'][self.room_id])

    def test_finished_retention_does_not_slide_and_rematch_renews_both_leases(self):
        self.ai_voting()
        for number in range(1, 6):
            self.action(uuid(number), 'vote', targetId=self.room_id)
        finished = self.get()
        self.assertEqual(finished['phase'], 'finished'); self.assertEqual(finished['winner'], 'town')
        expiry = self.clock + 600
        self.assertEqual(self.state()['expiresAt'], expiry)
        self.assertEqual(self.index()['rooms'][self.room_id], expiry)
        self.assertTrue(self.state()['retiring'])
        self.clock += 120
        self.assertEqual(self.get()['expiresAt'], expiry)
        self.assertEqual(self.index()['rooms'][self.room_id], expiry)
        restarted = self.action(self.room_id, 'restart')
        self.assertEqual(restarted['phase'], 'lobby'); self.assertGreater(restarted['phaseId'], finished['phaseId'])
        self.assertIsNone(restarted['winner']); self.assertIsNone(restarted['self']['role'])
        self.assertEqual(restarted['self']['checks'], [])
        self.assertEqual(restarted['chat'], []); self.assertEqual(restarted['mafiaChat'], [])
        self.assertEqual(self.state()['expiresAt'], self.clock + mafia.ROOM_SECONDS)
        self.assertEqual(self.index()['rooms'][self.room_id], self.state()['expiresAt'])
        self.assertNotIn('retiring', self.state())
        self.assertTrue(all(player['role'] is None for player in self.state()['game']['players']))

    def test_closed_room_is_reclaimed_after_short_retention_without_deleting_other_rows(self):
        self.create(); self.action(self.room_id, 'close')
        old_id = self.room_id
        self.clock += 61
        self.error(410, self.get)
        self.room_id = uuid(8); self.create_body = self.new_create_body(self.room_id)
        self.create()
        self.assertNotIn(mafia.key('game-mafia-room', old_id), self.database.rows['published-games'])
        self.assertEqual(set(self.index()['rooms']), {self.room_id})

    def test_leave_keeps_private_view_accessible_and_prevents_more_game_actions(self):
        self.create(); self.join(2)
        result = self.action(uuid(2), 'leave')
        self.assertTrue(result['self']['left']); self.assertTrue(self.get(uuid(2))['self']['left'])
        self.error(403, lambda: self.action(uuid(2), 'chat', text='I left already.', channel='public'))

    def test_creation_rate_counts_distinct_creates_but_not_exact_retries(self):
        first = self.create()
        for _ in range(3): self.create()
        self.assertEqual(self.index()['count'], 1)
        for number in range(2, mafia.SOURCE_CREATE_LIMIT + 1):
            body = self.new_create_body(uuid(number))
            mafia.create(self.api, self.request_event(), body)
        before = deepcopy(self.database.rows)
        self.error(429, lambda: mafia.create(self.api, self.request_event(), self.new_create_body(uuid(99))))
        self.assertEqual(before, self.database.rows)
        self.assertEqual(first['session']['roomId'], uuid(1))

    def test_installation_limit_does_not_depend_on_source_header_values(self):
        for number in range(1, mafia.CREATE_LIMIT + 1):
            body = self.new_create_body(uuid(number))
            mafia.create(self.api, self.request_event(ip='192.0.2.' + str(number)), body)
        self.error(429, lambda: mafia.create(self.api, self.request_event(ip='198.51.100.1'), self.new_create_body(uuid(999))))
        self.assertEqual(self.index()['count'], mafia.CREATE_LIMIT)

    def test_missing_gateway_source_cannot_allocate_room(self):
        self.error(503, lambda: mafia.create(self.api, {'headers': {'x-forwarded-for': '192.0.2.1'}}, self.create_body))
        self.assertFalse(self.database.rows['published-games'])

    def test_tenant_mismatch_fails_before_projection_or_overwrite(self):
        self.create()
        row = self.database.rows['published-games'][mafia.key('game-mafia-room', self.room_id)]
        row['organization_id'] = support.OTHER
        saved = deepcopy(self.database.rows)
        self.error(404, self.get); self.assertEqual(self.database.rows, saved)

    def test_room_storage_corruption_is_preserved(self):
        self.create()
        row = self.database.rows['published-games'][mafia.key('game-mafia-room', self.room_id)]
        row['payload'] = 'not JSON'
        saved = deepcopy(self.database.rows)
        self.error(503, self.get); self.assertEqual(saved, self.database.rows)

    def test_unknown_service_failures_propagate_and_exhausted_conflicts_do_not_commit(self):
        self.database.meta.client.transact_write_items.side_effect = RuntimeError('Unknown storage failure')
        with self.assertRaisesRegex(RuntimeError, 'Unknown storage failure'):
            self.create()
        self.assertFalse(self.database.rows['published-games'])
        self.database.meta.client.transact_write_items.side_effect = ConditionalFailure()
        self.error(503, self.create); self.assertFalse(self.database.rows['published-games'])

    def test_narration_cache_errors_are_mapped_to_service_error_not_uncaught_exception(self):
        self.load_bank.side_effect = mafia.narration().NarrationError(503, 'The cached narrator is unavailable.')
        self.error(503, lambda: self.create(narratorMode='ai'))
        self.assertFalse(self.database.rows['published-games'])

    def test_public_config_narration_errors_are_mapped_without_authentication_or_charge(self):
        with patch.object(mafia.narration(), 'public_config', side_effect=mafia.narration().NarrationError(503, 'The cached narrator is unavailable.')):
            self.error(503, lambda: mafia.dispatch(self.api, self.request_event(), 'GET', '/mafia/config', {}))
        self.authorization.assert_not_called(); self.provider.converse.assert_not_called()
        self.assertFalse(self.database.rows['published-games'])

    def test_mafia_rows_never_leak_through_public_catalog_and_all_cursor_kinds_continue(self):
        self.create(); self.join(2)
        bank_key = mafia.key('game-mafia-narration')
        self.database.rows['published-games'][bank_key] = {'id': bank_key,
            'organization_id': support.ORG, 'service_id': support.SERVICE, 'payload': '{"private":"draft roles"}'}
        result = support.games.list_games(self.api, None, {'queryStringParameters': {'specVersion': 'all'}}, public=True)
        self.assertEqual(result, {'games': []})
        for name, suffix in (('game-mafia-room', self.room_id), ('game-mafia-index', ''), ('game-mafia-narration', '')):
            cursor_key = {'id': mafia.key(name, suffix)}
            first = {'Items': list(self.database.rows['published-games'].values()), 'LastEvaluatedKey': cursor_key}
            with patch.object(MemoryTable, 'scan', return_value=first):
                page = support.games.list_games(self.api, None, {}, public=True)
            self.assertEqual(page['games'], [])
            with patch.object(MemoryTable, 'scan', return_value={'Items': []}) as scanned:
                continued = support.games.list_games(self.api, None, {'queryStringParameters': {'cursor': page['cursor'], 'specVersion': 'all'}}, public=True)
            self.assertEqual(continued['games'], [])
            self.assertEqual(scanned.call_args.kwargs['ExclusiveStartKey'], cursor_key)
            for private in (False, True):
                malformed = mafia.key(name, '' if suffix else uuid(99))
                encoded = base64.urlsafe_b64encode(json.dumps({'id': malformed}).encode()).decode()
                with self.assertRaises(support.games.GameError) as caught:
                    support.games.list_games(self.api, self.claims, {'queryStringParameters': {'cursor': encoded}}, public=not private)
                self.assertEqual(caught.exception.status, 400)

    def test_oversized_unknown_and_server_state_requests_are_rejected(self):
        self.create()
        self.error(413, lambda: mafia.dispatch(self.api, self.request_event(), 'POST', '/mafia/rooms', {'x': 'x' * 12000}))
        self.error(404, lambda: mafia.dispatch(self.api, self.request_event(), 'POST', '/mafia/rooms/not-a-uuid', {}))
        for addition in ({'role': 'mafia'}, {'game': {}}, {'winner': 'town'}, {'tokenHash': 'changed'}):
            body = {**self.body(self.room_id, 'start'), **addition}
            self.error(400, lambda: self.send(self.room_id, body))

