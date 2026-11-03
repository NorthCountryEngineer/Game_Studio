"""Actual Party adapter/rules with synthetic DynamoDB and no cloud calls."""
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

spec = importlib.util.spec_from_file_location('test_party_api_module', Path(__file__).parents[1] / 'backend/nce_api/party.py')
party = importlib.util.module_from_spec(spec)
spec.loader.exec_module(party)


def uuid(number):
    return f'{number:08x}-0000-4000-8000-{number:012x}'


def capability(number):
    return base64.urlsafe_b64encode(hashlib.sha256(str(number).encode()).digest()).rstrip(b'=').decode()


class PartyAPITests(unittest.TestCase):
    authorize = support.GameTests.authorize
    event = support.GameTests.event
    write_registry = support.GameTests.write_registry

    def setUp(self):
        support.GameTests.setUp(self)
        self.database.meta.client.exceptions = types.SimpleNamespace(TransactionCanceledException=ConditionalFailure)
        self.clock = 1000000
        clock = patch.object(party.time, 'time', side_effect=lambda: self.clock)
        clock.start(); self.addCleanup(clock.stop)
        pause = patch.object(party, 'pause'); pause.start(); self.addCleanup(pause.stop)
        self.sessions = {}; self.room_id = uuid(1); self.request_counter = 1000
        self.create_body = self.new_create_body(self.room_id)
        for name in ('socket', 'create_connection'):
            blocked = patch.object(socket, name, side_effect=AssertionError('Network is disabled in offline tests.'))
            blocked.start(); self.addCleanup(blocked.stop)

    def new_create_body(self, room_id, **values):
        return {'requestId': room_id, 'name': 'Host', 'avatar': 'fox', 'kind': 'trivia',
            'playerToken': capability(room_id), 'inviteToken': capability('invite-' + room_id), **values}

    def request_event(self, player_id=None, ip='192.0.2.5'):
        return {'requestContext': {'http': {'sourceIp': ip}}, 'headers':
            {'authorization': 'Bearer ' + self.sessions[player_id]['token']} if player_id else {}}

    def create(self, **values):
        self.create_body.update(values)
        result = party.dispatch(self.api, self.request_event(), 'POST', '/party/rooms', self.create_body)
        self.sessions[result['session']['playerId']] = result['session']
        return result

    def join_body(self, number):
        return {'requestId': uuid(number), 'name': 'Player ' + str(number), 'avatar': 'robot',
            'playerToken': capability(number), 'inviteToken': self.create_body['inviteToken']}

    def join(self, number):
        result = party.dispatch(self.api, self.request_event(), 'POST', '/party/rooms/' + self.room_id + '/join', self.join_body(number))
        self.sessions[result['session']['playerId']] = result['session']
        return result

    def get(self, player_id=None):
        return party.dispatch(self.api, self.request_event(player_id or self.room_id), 'GET', '/party/rooms/' + self.room_id, {})['room']

    def body(self, player_id, kind, **values):
        room = self.get(player_id); self.request_counter += 1
        return {'requestId': uuid(self.request_counter), 'phaseId': room['phaseId'],
            'sequence': room['self']['actionSequence'] + 1, 'type': kind, **values}

    def action(self, player_id, kind, **values):
        return self.send(player_id, self.body(player_id, kind, **values))

    def send(self, player_id, body):
        return party.dispatch(self.api, self.request_event(player_id), 'POST', '/party/rooms/' + self.room_id + '/actions', body)['room']

    def state(self):
        return json.loads(self.database.rows['published-games'][party.key('game-party-room', self.room_id)]['payload'])

    def index(self):
        return json.loads(self.database.rows['published-games'][party.key('game-party-index')]['payload'])

    def error(self, status, action):
        with self.assertRaises(party.PartyError) as caught:
            action()
        self.assertEqual(caught.exception.status, status)
        return caught.exception.message

    def test_get_requires_exact_room_capability_not_invite_or_core_identity(self):
        self.create(); self.join(2)
        path = '/party/rooms/' + self.room_id
        for headers in ({}, {'authorization': 'Bearer current'}, {'authorization': 'Bearer ' + self.create_body['inviteToken']},
                {'authorization': 'Bearer ' + capability('different')}, {'authorization': ['bad']}):
            self.error(401, lambda: party.dispatch(self.api, {'headers': headers}, 'GET', path, {}))
        event = {'headers': {'Authorization': 'Bearer ' + self.sessions[uuid(2)]['token']}}
        self.assertEqual(party.dispatch(self.api, event, 'GET', path, {})['room']['self']['id'], uuid(2))
        self.authorization.assert_not_called()

    def test_invitation_must_never_double_as_player_capability(self):
        self.create()
        body = {**self.join_body(2), 'playerToken': self.create_body['inviteToken']}
        self.error(400, lambda: party.join(self.api, self.room_id, body))
        self.assertEqual(len(self.state()['members']), 1)

    def test_creator_and_join_retries_are_idempotent_and_different_payloads_conflict(self):
        first = self.create(); joined = self.join(2)
        before = deepcopy(self.database.rows)
        self.assertEqual(self.create()['session'], first['session'])
        self.assertEqual(self.join(2)['session'], joined['session'])
        self.assertEqual(self.database.rows, before)
        self.error(409, lambda: party.create(self.api, self.request_event(), {**self.create_body, 'name': 'Other host'}))
        self.error(409, lambda: party.join(self.api, self.room_id, {**self.join_body(2), 'name': 'Other name'}))
        self.assertEqual(self.index()['count'], 1)

    def test_last_action_retry_is_read_only_and_sequence_or_phase_reuse_fails(self):
        self.create(); self.join(2)
        body = self.body(uuid(2), 'chat', text='Hello town.')
        first = self.send(uuid(2), body); saved = deepcopy(self.database.rows)
        second = self.send(uuid(2), body)
        self.assertEqual(first, second); self.assertEqual(saved, self.database.rows)
        self.error(409, lambda: self.send(uuid(2), {**body, 'text': 'Changed contents.'}))
        self.error(409, lambda: self.send(uuid(2), {**body, 'sequence': 3, 'requestId': uuid(900)}))
        self.error(409, lambda: self.send(uuid(2), {**body, 'sequence': 2, 'phaseId': 99, 'requestId': uuid(901)}))
        self.assertEqual(len(self.state()['game']['chat']), 1)

    def test_active_lease_renewal_updates_index_and_room_atomically(self):
        self.create(); self.clock += party.ROOM_SECONDS // 2 + 1
        expected = self.clock + party.ROOM_SECONDS
        self.assertEqual(self.get()['expiresAt'], expected)
        self.assertEqual(self.state()['expiresAt'], expected)
        self.assertEqual(self.index()['rooms'][self.room_id], expected)
        transactions = self.database.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        self.assertEqual(len(transactions), 2)

    def test_expired_rows_are_removed_only_with_fenced_index_on_new_creation(self):
        self.create(); old_id = self.room_id
        unrelated = {'id': 'unrelated', 'payload': 'preserve'}
        self.database.rows['published-games']['unrelated'] = unrelated
        self.clock += party.ROOM_SECONDS + 1
        self.error(410, self.get)
        self.room_id = uuid(8); self.create_body = self.new_create_body(self.room_id)
        self.create()
        self.assertNotIn(party.key('game-party-room', old_id), self.database.rows['published-games'])
        self.assertNotIn(old_id, self.index()['rooms'])
        self.assertEqual(self.database.rows['published-games']['unrelated'], unrelated)

    def test_missing_expired_room_can_be_recreated_without_duplicate_transaction_targets(self):
        self.create()
        del self.database.rows['published-games'][party.key('game-party-room', self.room_id)]
        self.clock += party.ROOM_SECONDS + 1
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
        self.assertEqual(self.index()['rooms'][self.room_id], self.clock + party.ROOM_SECONDS)

    def test_closed_room_has_short_bounded_retention_in_room_and_index(self):
        self.create(); self.action(self.room_id, 'close')
        self.assertLessEqual(self.state()['expiresAt'], self.clock + 600)
        self.assertEqual(self.state()['expiresAt'], self.index()['rooms'][self.room_id])

    def test_closed_room_is_reclaimed_after_short_retention_without_deleting_other_rows(self):
        self.create(); self.action(self.room_id, 'close')
        old_id = self.room_id
        self.clock += 61
        self.error(410, self.get)
        self.room_id = uuid(8); self.create_body = self.new_create_body(self.room_id)
        self.create()
        self.assertNotIn(party.key('game-party-room', old_id), self.database.rows['published-games'])
        self.assertEqual(set(self.index()['rooms']), {self.room_id})

    def test_leave_keeps_private_view_accessible_and_prevents_more_game_actions(self):
        self.create(); self.join(2)
        result = self.action(uuid(2), 'leave')
        self.assertTrue(result['self']['left']); self.assertTrue(self.get(uuid(2))['self']['left'])
        self.error(403, lambda: self.action(uuid(2), 'chat', text='I left already.'))

    def test_creation_rate_counts_distinct_creates_but_not_exact_retries(self):
        first = self.create()
        for _ in range(3): self.create()
        self.assertEqual(self.index()['count'], 1)
        for number in range(2, party.SOURCE_CREATE_LIMIT + 1):
            body = self.new_create_body(uuid(number))
            party.create(self.api, self.request_event(), body)
        before = deepcopy(self.database.rows)
        self.error(429, lambda: party.create(self.api, self.request_event(), self.new_create_body(uuid(99))))
        self.assertEqual(before, self.database.rows)
        self.assertEqual(first['session']['roomId'], uuid(1))

    @patch.object(party, 'MAX_ROOMS', 64)
    def test_installation_limit_does_not_depend_on_source_header_values(self):
        for number in range(1, party.CREATE_LIMIT + 1):
            body = self.new_create_body(uuid(number))
            party.create(self.api, self.request_event(ip='192.0.2.' + str(number)), body)
        self.error(429, lambda: party.create(self.api, self.request_event(ip='198.51.100.1'), self.new_create_body(uuid(999))))
        self.assertEqual(self.index()['count'], party.CREATE_LIMIT)

    def test_missing_gateway_source_cannot_allocate_room(self):
        self.error(503, lambda: party.create(self.api, {'headers': {'x-forwarded-for': '192.0.2.1'}}, self.create_body))
        self.assertFalse(self.database.rows['published-games'])

    def test_tenant_mismatch_fails_before_projection_or_overwrite(self):
        self.create()
        row = self.database.rows['published-games'][party.key('game-party-room', self.room_id)]
        row['organization_id'] = support.OTHER
        saved = deepcopy(self.database.rows)
        self.error(404, self.get); self.assertEqual(self.database.rows, saved)

    def test_room_storage_corruption_is_preserved(self):
        self.create()
        row = self.database.rows['published-games'][party.key('game-party-room', self.room_id)]
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

    def test_party_rows_never_leak_through_public_catalog_and_all_cursor_kinds_continue(self):
        self.create(); self.join(2)
        result = support.games.list_games(self.api, None, {'queryStringParameters': {'specVersion': 'all'}}, public=True)
        self.assertEqual(result, {'games': []})
        for name, suffix in (('game-party-room', self.room_id), ('game-party-index', '')):
            cursor_key = {'id': party.key(name, suffix)}
            first = {'Items': list(self.database.rows['published-games'].values()), 'LastEvaluatedKey': cursor_key}
            with patch.object(MemoryTable, 'scan', return_value=first):
                page = support.games.list_games(self.api, None, {}, public=True)
            self.assertEqual(page['games'], [])
            with patch.object(MemoryTable, 'scan', return_value={'Items': []}) as scanned:
                continued = support.games.list_games(self.api, None, {'queryStringParameters': {'cursor': page['cursor'], 'specVersion': 'all'}}, public=True)
            self.assertEqual(continued['games'], [])
            self.assertEqual(scanned.call_args.kwargs['ExclusiveStartKey'], cursor_key)
            for private in (False, True):
                malformed = party.key(name, '' if suffix else uuid(99))
                encoded = base64.urlsafe_b64encode(json.dumps({'id': malformed}).encode()).decode()
                with self.assertRaises(support.games.GameError) as caught:
                    support.games.list_games(self.api, self.claims, {'queryStringParameters': {'cursor': encoded}}, public=not private)
                self.assertEqual(caught.exception.status, 400)

    def test_oversized_unknown_and_server_state_requests_are_rejected(self):
        self.create()
        self.error(413, lambda: party.dispatch(self.api, self.request_event(), 'POST', '/party/rooms', {'x': 'x' * 16000}))
        self.error(404, lambda: party.dispatch(self.api, self.request_event(), 'POST', '/party/rooms/not-a-uuid', {}))
        for addition in ({'role': 'party'}, {'game': {}}, {'winner': 'town'}, {'tokenHash': 'changed'}):
            body = {**self.body(self.room_id, 'start'), **addition}
            self.error(400, lambda: self.send(self.room_id, body))

    def test_all_five_online_games_create_join_and_start_without_core_or_models(self):
        metadata = {game['id']: game for game in party.engine().catalog()}
        for offset, kind in enumerate(('starship-suspects', 'sketch-guess', 'trivia', 'hand-duel', 'drop-four')):
            with self.subTest(kind=kind):
                self.room_id = uuid(100 + offset)
                self.create_body = self.new_create_body(self.room_id, kind=kind)
                self.create()
                for number in range(2, metadata[kind]['minPlayers'] + 1): self.join(number)
                room = self.action(self.room_id, 'start')
                self.assertEqual(room['status'], 'playing')
                self.assertEqual(room['roomId'], self.room_id)
                self.assertEqual(room['self']['actionSequence'], 1)
                wire = json.dumps(room)
                for hidden in ('tokenHash', 'inviteHash', 'createFingerprint', '_game', 'members'):
                    self.assertNotIn(hidden, wire)
                self.assertNotIn(self.create_body['playerToken'], wire)
                self.assertNotIn(self.create_body['inviteToken'], wire)
        self.authorization.assert_not_called(); self.provider.converse.assert_not_called()

    def test_private_capabilities_are_hashed_and_source_addresses_are_not_saved(self):
        self.create(); self.join(2)
        saved = json.dumps(self.database.rows)
        for secret in (self.create_body['playerToken'], self.create_body['inviteToken'], capability(2), '192.0.2.5'):
            self.assertNotIn(secret, saved)
        self.assertEqual(len(self.state()['members']), 2)

    def test_concurrent_locked_hands_resolve_once_and_replay_stays_read_only(self):
        self.create(kind='hand-duel'); self.join(2); self.action(self.room_id, 'start')
        body = self.body(self.room_id, 'choose', choice='rock')
        real = self.database.transact; raced = False
        def race(TransactItems):
            nonlocal raced
            if not raced:
                raced = True
                self.database.meta.client.transact_write_items.side_effect = real
                self.action(uuid(2), 'choose', choice='scissors')
                self.database.meta.client.transact_write_items.side_effect = race
            return real(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = race
        room = self.send(self.room_id, body)
        self.assertEqual(room['phase'], 'reveal')
        self.assertEqual(next(p for p in room['players'] if p['id'] == self.room_id)['score'], 1)
        self.assertEqual(len(room['game']['choices']), 2)
        before = deepcopy(self.database.rows)
        self.assertEqual(self.send(self.room_id, body), room)
        self.assertEqual(before, self.database.rows)

    def test_hidden_hand_and_trivia_answer_are_per_seat_until_reveal(self):
        self.create(kind='hand-duel'); self.join(2); self.action(self.room_id, 'start')
        self.action(self.room_id, 'choose', choice='rock')
        self.assertEqual(self.get()['self']['choice'], 'rock')
        other = self.get(uuid(2))
        self.assertIsNone(other['self']['choice']); self.assertEqual(other['game']['choices'], {})
        self.assertNotIn('rock', json.dumps(other))
        self.action(uuid(2), 'choose', choice='scissors')
        self.assertEqual(self.get(uuid(2))['game']['choices'][self.room_id], 'rock')
        self.room_id=uuid(55); self.create_body=self.new_create_body(self.room_id)
        self.create(); self.join(2); self.action(self.room_id,'start')
        self.action(self.room_id,'answer',answer=0)
        other=self.get(uuid(2)); self.assertIsNone(other['self']['answer'])
        self.assertNotIn('correctIndex',other['game']); self.assertNotIn('answers',other['game'])

    def test_board_finish_shortens_lease_once_and_rematch_renews_and_clears_board(self):
        self.create(kind='drop-four'); self.join(2); self.action(self.room_id,'start')
        for who,col in ((self.room_id,0),(uuid(2),1),(self.room_id,0),(uuid(2),1),(self.room_id,0),(uuid(2),1),(self.room_id,0)):
            self.action(who,'drop',column=col)
        finished=self.get(); self.assertEqual(finished['status'],'finished')
        expiry=self.clock+600; self.assertEqual(finished['expiresAt'],expiry)
        self.clock+=120; self.assertEqual(self.get()['expiresAt'],expiry)
        restarted=self.action(self.room_id,'restart')
        self.assertEqual(restarted['status'],'lobby'); self.assertEqual(restarted['game'],{})
        self.assertTrue(all(p['score']==0 for p in restarted['players']))
        self.assertEqual(restarted['expiresAt'],self.clock+party.ROOM_SECONDS)
        self.assertEqual(self.index()['rooms'][self.room_id],restarted['expiresAt'])
        self.assertNotIn('retiring',self.state())

    def test_two_concurrent_final_seat_joins_cannot_overfill_duel(self):
        self.create(kind='hand-duel')
        real=self.database.transact; raced=False
        def race(TransactItems):
            nonlocal raced
            if not raced:
                raced=True; self.database.meta.client.transact_write_items.side_effect=real
                self.join(3); self.database.meta.client.transact_write_items.side_effect=race
            return real(TransactItems)
        self.database.meta.client.transact_write_items.side_effect=race
        self.error(409,lambda:self.join(2))
        self.assertEqual(len(self.state()['game']['players']),2)
        self.assertIn(uuid(3),self.state()['members']); self.assertNotIn(uuid(2),self.state()['members'])

    def test_party_handler_routes_are_anonymous_and_creator_routes_remain_protected(self):
        handler=support.handler
        with patch.object(handler,'clients',return_value=(self.database,None,None)), patch.object(handler,'_party',party), patch.object(handler,'authorize',side_effect=handler.APIError(401,'Sign in.')) as authorization:
            event={'requestContext':{'http':{'method':'GET','sourceIp':'192.0.2.5'}},'rawPath':'/party/config','headers':{}}
            result=handler.handler(event,None)
            self.assertEqual(result['statusCode'],200)
            self.assertEqual(len(json.loads(result['body'])['games']),6)
            authorization.assert_not_called()
            protected=handler.handler({**event,'rawPath':'/session'},None)
            self.assertEqual(protected['statusCode'],401)

    def test_payload_bound_rejects_without_writing_or_exposing_stored_private_state(self):
        self.create(); before=deepcopy(self.database.rows)
        self.error(413,lambda:party.put('game-party-room',self.room_id,{'drawing':'x'*320001},None))
        self.assertEqual(before,self.database.rows)

    def sketch(self, count=3):
        self.create(kind='sketch-guess', settings={'roundSeconds': 180})
        for number in range(2, count + 1): self.join(number)
        return self.action(self.room_id, 'start')

    def segment(self, number, points=None):
        return {'id': uuid(number), 'color': '#abcdef', 'width': 12,
                'points': points or [[.1234, .9876], [.9999, .0001]]}

    def test_sketch_streamed_batches_and_legacy_strokes_have_no_forced_pause(self):
        self.sketch()
        for number in range(3):
            room = self.action(self.room_id, 'drawing-batch', drawingEpoch=0, segments=[self.segment(2000 + number)])
        room = self.action(self.room_id, 'stroke', color='#000000', width=2, points=[[0, 0], [1, 1]])
        self.assertEqual(len(room['game']['strokes']), 4)
        before = deepcopy(self.database.rows)
        self.error(429, lambda: self.action(self.room_id, 'drawing-batch', drawingEpoch=0, segments=[self.segment(2003)]))
        self.assertEqual(before, self.database.rows)
        self.clock += 1
        room = self.action(self.room_id, 'drawing-batch', drawingEpoch=0, segments=[self.segment(2003)])
        self.assertEqual(len(room['game']['strokes']), 5)
        other = self.get(uuid(2))
        self.assertEqual(room['game']['strokes'], other['game']['strokes'])
        self.assertNotIn('prompt', other['game']); self.assertNotIn('prompt', other['self'])
        self.authorization.assert_not_called(); self.provider.converse.assert_not_called()

    def test_sketch_batch_retry_and_conflict_do_not_repeat_or_drop_ink(self):
        self.sketch()
        body = self.body(self.room_id, 'drawing-batch', drawingEpoch=0, segments=[self.segment(2000)])
        real = self.database.transact; raced = False
        def race(TransactItems):
            nonlocal raced
            if not raced:
                raced = True
                self.database.meta.client.transact_write_items.side_effect = real
                self.action(uuid(2), 'guess', text='A teapot')
                self.database.meta.client.transact_write_items.side_effect = race
            return real(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = race
        room = self.send(self.room_id, body)
        self.assertEqual(len(room['game']['strokes']), 1)
        self.assertEqual(room['chat'][-1]['text'], 'A teapot')
        before = deepcopy(self.database.rows)
        self.assertEqual(self.send(self.room_id, body), room)
        self.assertEqual(before, self.database.rows)
        self.error(409, lambda: self.send(self.room_id, {**body, 'segments': [self.segment(2001)]}))
        self.assertEqual(before, self.database.rows)

    def test_sketch_clear_fences_queued_batches_and_requires_current_artist(self):
        self.sketch()
        self.action(self.room_id, 'drawing-batch', drawingEpoch=0, segments=[self.segment(2000)])
        self.error(403, lambda: self.action(uuid(2), 'clear-drawing', drawingEpoch=0))
        self.error(403, lambda: self.action(uuid(2), 'drawing-batch', drawingEpoch=0, segments=[self.segment(2001)]))
        clear = self.body(self.room_id, 'clear-drawing', drawingEpoch=0)
        room = self.send(self.room_id, clear)
        self.assertEqual(room['game']['drawingEpoch'], 1)
        self.assertEqual(room['game']['strokes'], [])
        saved = deepcopy(self.database.rows)
        self.assertEqual(self.send(self.room_id, clear), room)
        self.error(409, lambda: self.action(self.room_id, 'drawing-batch', drawingEpoch=0, segments=[self.segment(2001)]))
        self.assertEqual(saved, self.database.rows)
        room = self.action(self.room_id, 'drawing-batch', drawingEpoch=1, segments=[self.segment(2001)])
        self.assertEqual([stroke['id'] for stroke in room['game']['strokes']], [uuid(2001)])

    def test_sketch_concurrent_clear_wins_without_replaying_stale_batch(self):
        self.sketch()
        body = self.body(self.room_id, 'drawing-batch', drawingEpoch=0, segments=[self.segment(2000)])
        real = self.database.transact; raced = False
        def race(TransactItems):
            nonlocal raced
            if not raced:
                raced = True
                self.database.meta.client.transact_write_items.side_effect = real
                self.action(self.room_id, 'clear-drawing', drawingEpoch=0)
                self.database.meta.client.transact_write_items.side_effect = race
            return real(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = race
        self.error(409, lambda: self.send(self.room_id, body))
        room = self.get()
        self.assertEqual(room['game']['drawingEpoch'], 1)
        self.assertEqual(room['game']['strokes'], [])
        self.assertEqual(room['self']['actionSequence'], 2)

    def test_sketch_streams_for_full_turn_without_minute_or_stroke_limit(self):
        self.sketch()
        started = self.clock
        for batch in range(358):
            self.clock = started + batch // 2
            room = self.action(self.room_id, 'drawing-batch', drawingEpoch=0,
                               segments=[self.segment(2000 + batch)])
        self.assertEqual(room['phase'], 'draw')
        self.assertEqual(room['self']['actionSequence'], 359)
        self.assertEqual(len(room['game']['strokes']), 358)
        self.assertEqual(room['game']['strokes'][-1]['id'], uuid(2357))
        self.assertLess(self.state()['members'][self.room_id]['rate']['count'], 180)

    def test_sketch_maximum_batch_and_full_unicode_room_fit_storage_and_wire_bounds(self):
        self.sketch(count=12)
        points = [[round(.1111 + index / 10000, 4), round(.9999 - index / 10000, 4)] for index in range(120)]
        body = self.body(self.room_id, 'drawing-batch', drawingEpoch=0,
                         segments=[self.segment(2000 + number, points) for number in range(6)])
        self.assertLessEqual(len(party.canonical(body).encode()), 16000)
        self.send(self.room_id, body)
        state = self.state()
        for number, player in enumerate(state['game']['players']): player['name'] = '\U0001f600' * 15 + chr(65 + number)
        state['game']['chat'] = [{'id': 'c' + str(number), 'playerId': uuid(2), 'name': '\U0001f600' * 16,
                                 'text': '\U0001f600' * 160, 'at': self.clock} for number in range(60)]
        state['game']['events'] = [{'id': 'e' + str(number), 'text': '\U0001f600' * 32 + ' joined the room.',
                                   'at': self.clock} for number in range(60)]
        state['game']['_game']['strokes'] = [{**self.segment(3000 + number, points), 'playerId': self.room_id} for number in range(384)]
        state['game'] = party.engine().apply_action(state['game'], self.room_id,
            {'type': 'drawing-batch', 'drawingEpoch': 0, 'segments': [self.segment(4000, points)]}, now=self.clock + 1)
        self.assertLess(len(party.canonical(state).encode()), 300000)
        previous = self.database.rows['published-games'][party.key('game-party-room', self.room_id)]
        operation = party.put('game-party-room', self.room_id, state, previous)
        self.assertTrue(party.transact(self.api, [operation]))
        self.clock += 1
        room = self.action(self.room_id, 'drawing-batch', drawingEpoch=0, segments=[self.segment(4001, points)])
        self.assertEqual(room['game']['strokes'][-1]['id'], uuid(4001))
        self.assertLess(len(self.database.rows['published-games'][party.key('game-party-room', self.room_id)]['payload'].encode()), 300000)
        self.assertLessEqual(len(room['game']['strokes']), 384)

    def test_nonfinite_or_non_json_fields_are_rejected_before_any_storage(self):
        for value in (float('nan'), float('inf'), -float('inf'), object()):
            self.error(400,lambda:party.dispatch(self.api,self.request_event(),'POST','/party/rooms',{'bad':value}))
        self.assertFalse(self.database.rows['published-games'])
