"""Synthetic HTTP/WSS relay tests. No cloud, real accounts or network calls."""
from copy import deepcopy
import importlib.util
import json
import math
import os
from pathlib import Path
import types
import unittest
from unittest.mock import Mock, patch
import uuid

import test_games as support
from test_nce_api import ConditionalFailure, MemoryDatabase, DynamoResourceTable

module = importlib.util.spec_from_file_location('multiplayer_test_module', Path(__file__).parents[1] / 'backend/nce_api/multiplayer.py')
relay = importlib.util.module_from_spec(module); module.loader.exec_module(relay)


class Gone(Exception):
    pass


class MultiplayerTests(unittest.TestCase):
    def setUp(self):
        self.now = 2000000000
        self.clock = patch.object(relay.time, 'time', side_effect=lambda: self.now)
        self.clock.start(); self.addCleanup(self.clock.stop)
        self.env = patch.dict(os.environ, {'CORE_ORGANIZATION_ID': support.ORG, 'CORE_SERVICE_ID': support.SERVICE,
            'GAME_PUBLIC_TABLE': 'published-games', 'MULTIPLAYER_TABLE': 'rooms',
            'FRONTEND_ORIGIN': 'https://games.example.test',
            'MULTIPLAYER_SOCKET_URL': 'wss://relay.example.test/live',
            'MULTIPLAYER_CALLBACK_URL': 'https://relay.example.test/live'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.database = MemoryDatabase()
        self.database.rows.update({'published-games': {}, 'rooms': {}})
        self.database.meta.client.exceptions = types.SimpleNamespace(TransactionCanceledException=ConditionalFailure)
        self.callback = Mock()
        self.callback.exceptions = types.SimpleNamespace(GoneException=Gone)
        self.api = types.SimpleNamespace(clients=lambda: (self.database, None, None), multiplayer_callback=self.callback)
        self.spec = support.games.design_game('Asteroids with three levels.')['spec']
        self.spec.update(version=4, multiplayer={'mode': 'cooperative', 'maxPlayers': 2})
        if 'levels' not in self.spec:
            self.spec['levels'] = support.games.get_levels({**self.spec, 'version': 1})
            self.spec['progression'] = 'Practice together.'
        self.published = {'id': support.GAME, 'status': 'Published', 'revision': 7, 'publishedRevision': 7, 'spec': self.spec}
        self.public_key = support.games.key('game', support.GAME)
        self.database.rows['published-games'][self.public_key] = {'id': self.public_key, 'revision': 7,
            'organization_id': support.ORG, 'service_id': support.SERVICE, 'payload': json.dumps(self.published)}
        self.games_patch = patch.object(relay, '_games', support.games)
        self.games_patch.start(); self.addCleanup(self.games_patch.stop)

    def event(self, connection=None, route=None, body=None, source='203.0.113.8'):
        context = {'http': {'sourceIp': source}, 'identity': {'sourceIp': source}}
        if connection:
            context.update(connectionId=connection, routeKey=route or '$default')
        return {'headers': {'origin': 'https://games.example.test'}, 'requestContext': context,
            **({'body': json.dumps(body)} if body is not None else {})}

    def create(self):
        return relay.dispatch(self.api, self.event(), 'POST', '/multiplayer/rooms', {'gameId': support.GAME, 'publishedRevision': 7})

    def join(self, room):
        return relay.dispatch(self.api, self.event(), 'POST', '/multiplayer/rooms/' + room['roomId'] + '/join', self.invitation(room))

    def invitation(self, room):
        return {'inviteToken': room['inviteToken'], 'gameId': room['gameId'],
            'publishedRevision': room['publishedRevision'], 'specSha256': room['specSha256']}

    def room(self, created):
        return self.database.rows['rooms'][relay.key('room', created['roomId'])]

    def messages(self, connection):
        return [json.loads(call.kwargs['Data']) for call in self.callback.post_to_connection.call_args_list
            if call.kwargs['ConnectionId'] == connection]

    def error(self, status, function):
        with self.assertRaises(relay.MultiplayerError) as caught:
            function()
        self.assertEqual(caught.exception.status, status)

    def socket_join(self, connection, room, token):
        self.assertEqual(relay.websocket_handler(self.api, self.event(connection, '$connect'))['statusCode'], 200)
        event = self.event(connection, body={'type': 'join', 'roomId': room['roomId'], 'token': token})
        self.assertEqual(relay.websocket_handler(self.api, event)['statusCode'], 200)

    def pair(self):
        room = self.create(); guest = self.join(room)
        self.socket_join('host-connection', room, room['hostToken'])
        self.socket_join('guest-connection', room, guest['guestToken'])
        self.callback.reset_mock()
        return room, guest

    def snapshot(self):
        return {'levelIndex': 0, 'elapsed': 0, 'outcome': 'playing', 'running': True, 'paused': False,
            'seed': 17031, 'nextId': 1, 'nextSnack': 0.4, 'nextHazard': 0.7,
            'players': [dict(x=x, y=448, vy=0, grounded=False, score=0, lives=self.spec['levels'][0]['rules']['lives'],
                invulnerable=1, angle=-1.5708, previousJump=False, fireCooldown=0, points=0) for x in (360, 560)],
            'entities': [], 'bullets': [], 'platforms': []}

    def send(self, connection, body):
        return relay.message(self.api, self.event(connection, body=body))

    def mutate_publication(self, change):
        value = deepcopy(self.published); change(value)
        self.database.rows['published-games'][self.public_key]['payload'] = json.dumps(value)

    def test_room_is_edition_bound_and_only_hashes_capabilities_in_dedicated_ttl_table(self):
        before = deepcopy(self.database.rows['published-games'])
        created = self.create(); room = self.room(created)
        self.assertEqual(set(created), {'roomId', 'hostToken', 'inviteToken', 'expiresAt', 'socketUrl', 'gameId', 'publishedRevision', 'specSha256'})
        self.assertRegex(created['roomId'], relay.UUID)
        self.assertEqual(created['expiresAt'], self.now + 1800)
        self.assertNotEqual(created['hostToken'], created['inviteToken'])
        encoded = json.dumps(self.database.rows['rooms'])
        for value in (created['hostToken'], created['inviteToken'], '203.0.113.8', 'Bearer', support.USER):
            self.assertNotIn(value, encoded)
        self.assertEqual(room['publishedRevision'], 7)
        self.assertEqual(len(room['specSha256']), 64)
        self.assertEqual(room['expiresAt'], created['expiresAt'])
        self.assertNotIn('spec', room)
        self.assertEqual(before, self.database.rows['published-games'])
        for call in self.database.meta.client.transact_write_items.call_args_list:
            for operation in call.kwargs['TransactItems']:
                if next(iter(operation)) != 'ConditionCheck':
                    self.assertEqual(next(iter(operation.values()))['TableName'], 'rooms')

    def test_strict_http_contract_and_only_current_opted_in_public_games(self):
        for body in ({}, {'gameId': support.GAME, 'publishedRevision': 7, 'schoolId': support.OTHER},
                {'gameId': support.GAME, 'publishedRevision': True}, {'gameId': 'bad', 'publishedRevision': 7}):
            self.error(400, lambda: relay.create_room(self.api, self.event(), body))
        self.error(409, lambda: relay.create_room(self.api, self.event(), {'gameId': support.GAME, 'publishedRevision': 6}))
        self.mutate_publication(lambda value: value['spec'].update(version=2))
        self.error(409, self.create)
        self.database.rows['published-games'].clear()
        self.error(404, self.create)
        self.assertFalse(any(':room:' in key for key in self.database.rows['rooms']))

    def test_atomic_one_guest_admission_consumes_invite_and_separates_capabilities(self):
        created = self.create(); guest = self.join(created)
        self.assertEqual(set(guest), {'roomId', 'guestToken', 'expiresAt', 'socketUrl', 'gameId', 'publishedRevision', 'specSha256'})
        self.assertNotIn(guest['guestToken'], json.dumps(self.database.rows['rooms']))
        self.assertNotEqual(guest['guestToken'], created['hostToken'])
        self.assertEqual(self.room(created)['inviteHash'], '')
        self.error(403, lambda: self.join(created))
        self.error(403, lambda: relay.join_room(self.api, self.event(), created['roomId'], {**self.invitation(created), 'inviteToken': created['hostToken']}))
        self.error(400, lambda: relay.join_room(self.api, self.event(), created['roomId'], {**self.invitation(created), 'seat': 0}))

    def test_wrong_game_edition_or_hash_is_rejected_without_consuming_invite(self):
        created = self.create()
        for changes in ({'gameId': support.OTHER}, {'publishedRevision': 8}, {'specSha256': 'a' * 64}):
            self.error(409, lambda: relay.join_room(self.api, self.event(), created['roomId'], {**self.invitation(created), **changes}))
            self.assertFalse(self.room(created)['guestHash'])
            self.assertTrue(self.room(created)['inviteHash'])
        self.join(created)

    def test_connection_requires_exact_origin_and_short_lived_pending_admission(self):
        for supplied in ('https://evil.example', 'null', 'https://games.example.test.evil', '', None):
            event = self.event('unauthorized', '$connect'); event['headers']['origin'] = supplied
            self.assertEqual(relay.websocket_handler(self.api, event)['statusCode'], 403)
        self.assertFalse(self.database.rows['rooms'])
        relay.connect(self.api, self.event('pending', '$connect'))
        self.now += 45
        self.error(410, lambda: self.send('pending', {'type': 'ping'}))
        self.callback.post_to_connection.assert_not_called()

    def test_capabilities_in_connection_query_are_rejected_before_allocation(self):
        event = self.event('pending', '$connect')
        event['queryStringParameters'] = {'token': 'must-not-use-urls'}
        self.assertEqual(relay.websocket_handler(self.api, event)['statusCode'], 400)
        self.assertFalse(self.database.rows['rooms'])

    def test_admitted_seats_receive_ready_and_peer_status_without_capability_disclosure(self):
        created = self.create(); guest = self.join(created)
        self.socket_join('host', created, created['hostToken'])
        self.assertEqual(self.messages('host'), [{'type': 'ready', 'roomId': created['roomId'], 'seat': 0, 'expiresAt': created['expiresAt'],
                'gameId': created['gameId'], 'publishedRevision': created['publishedRevision'], 'specSha256': created['specSha256']},
            {'type': 'peer', 'connected': False}])
        self.socket_join('guest', created, guest['guestToken'])
        self.assertEqual(self.messages('guest')[0]['seat'], 1)
        self.assertEqual(self.messages('guest')[-1], {'type': 'peer', 'connected': True})
        self.assertEqual(self.messages('host')[-1], {'type': 'peer', 'connected': True})
        outbound = json.dumps([call.kwargs['Data'].decode() for call in self.callback.post_to_connection.call_args_list])
        for token in (created['hostToken'], created['inviteToken'], guest['guestToken']):
            self.assertNotIn(token, outbound)

    def test_unadmitted_or_wrong_seat_cannot_relay_and_guest_input_only_reaches_host(self):
        created, _ = self.pair()
        self.send('guest-connection', {'type': 'input', 'seq': 0, 'mask': 33})
        self.assertEqual(self.messages('host-connection'), [{'type': 'input', 'seq': 0, 'mask': 33}])
        self.assertFalse(self.messages('guest-connection'))
        self.error(403, lambda: self.send('host-connection', {'type': 'input', 'seq': 0, 'mask': 1}))
        self.error(403, lambda: self.send('guest-connection', {'type': 'state', 'seq': 1, 'state': self.snapshot()}))
        relay.connect(self.api, self.event('pending', '$connect'))
        self.error(403, lambda: self.send('pending', {'type': 'input', 'seq': 0, 'mask': 1}))

    def test_host_snapshot_reaches_guest_and_never_persists_gameplay(self):
        self.pair()
        value = self.snapshot()
        value['players'][0].update(x=350.25, points=50)
        self.send('host-connection', {'type': 'state', 'seq': 0, 'state': value})
        self.assertEqual(self.messages('guest-connection'), [{'type': 'state', 'seq': 0, 'state': value}])
        for stored in self.database.rows['rooms'].values():
            self.assertNotIn('state', stored)
            self.assertNotIn('players', stored)
            self.assertNotIn('mask', stored)

    def test_snapshot_validation_rejects_extra_fields_nested_secrets_nonfinite_and_bounds(self):
        original = self.snapshot()
        candidates = []
        for field, value in [('running', 1), ('paused', 'false'), ('seed', True), ('seed', 4294967296), ('elapsed', math.nan),
                ('elapsed', math.inf), ('nextId', 0), ('levelIndex', 8), ('players', []), ('entities', [{}] * 97), ('outcome', 'hacked')]:
            changed = deepcopy(original); changed[field] = value; candidates.append(changed)
        changed = deepcopy(original); changed['players'][0]['token'] = 'secret'; candidates.append(changed)
        changed = deepcopy(original); changed['players'][0]['points'] = 1000001; candidates.append(changed)
        changed = deepcopy(original); changed['players'][0]['x'] = -1; candidates.append(changed)
        changed = deepcopy(original); changed['players'][0]['lives'] = True; candidates.append(changed)
        changed = deepcopy(original); changed['outcome'] = 'won'; candidates.append(changed)
        changed = deepcopy(original); changed['extra'] = 'bad'; candidates.append(changed)
        for value in candidates:
            with self.subTest(value=value):
                self.error(400, lambda: relay.validate_state(value, self.spec))
        value = deepcopy(original)
        entity = dict(id=1, kind='hazard', x=300, y=0, w=42, h=42, vx=0, vy=100, asteroid='large')
        value.update(nextId=2, entities=[entity])
        self.assertEqual(relay.validate_state(value, self.spec), value)
        value['bullets'] = [dict(id=1, owner=0, x=300, y=200, vx=0, vy=-620, ttl=1)]
        self.error(400, lambda: relay.validate_state(value, self.spec))

    def test_replayed_and_out_of_order_sequences_are_not_forwarded_twice(self):
        self.pair()
        self.send('guest-connection', {'type': 'input', 'seq': 3, 'mask': 16})
        self.send('guest-connection', {'type': 'input', 'seq': 3, 'mask': 0})
        self.send('guest-connection', {'type': 'input', 'seq': 2, 'mask': 0})
        self.assertEqual(len(self.messages('host-connection')), 1)
        self.send('guest-connection', {'type': 'input', 'seq': 4, 'mask': 0})
        self.assertEqual(len(self.messages('host-connection')), 2)

    def test_inflight_old_connection_cannot_forward_after_seat_replacement(self):
        created, _ = self.pair()
        original = self.database.transact
        raced = False
        def transaction(TransactItems):
            nonlocal raced
            connection_writes = [operation['Put']['Item'] for operation in TransactItems if 'Put' in operation
                and operation['Put']['Item'].get('connectionId') == 'guest-connection']
            if connection_writes and not raced:
                raced = True
                room = self.room(created)
                room.update(connection1='replacement', generation1=str(uuid.uuid4()), version=room['version'] + 1)
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transaction
        self.error(403, lambda: self.send('guest-connection', {'type': 'input', 'seq': 0, 'mask': 1}))
        self.assertFalse(self.messages('host-connection'))

    def test_room_creation_rejects_publication_race_atomically(self):
        original = self.database.transact
        def transaction(TransactItems):
            if any('Put' in operation and ':room:' in operation['Put']['Item']['id'] for operation in TransactItems):
                self.mutate_publication(lambda value: value.update(revision=8, publishedRevision=8))
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transaction
        self.error(409, self.create)
        self.assertFalse(any(':room:' in key for key in self.database.rows['rooms']))

    def test_guest_admission_losing_a_concurrent_race_cannot_replace_the_winner(self):
        created = self.create()
        original = self.database.transact
        raced = False
        def transaction(TransactItems):
            nonlocal raced
            if any('Put' in operation and ':room:' in operation['Put']['Item']['id'] for operation in TransactItems) and not raced:
                raced = True
                room = self.room(created)
                room.update(guestHash=relay.digest('a' * 43), inviteHash='', version=room['version'] + 1)
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transaction
        self.error(403, lambda: self.join(created))
        self.assertEqual(self.room(created)['guestHash'], relay.digest('a' * 43))

    def test_disconnect_pause_and_rejoin_generation_resists_stale_disconnect(self):
        created, guest = self.pair()
        relay.disconnect(self.api, 'guest-connection')
        self.assertEqual(self.messages('host-connection')[-1], {'type': 'peer', 'connected': False})
        self.now += 2
        self.socket_join('guest-rejoined', created, guest['guestToken'])
        self.assertEqual(self.room(created)['connection1'], 'guest-rejoined')
        relay.disconnect(self.api, 'guest-connection')
        self.assertEqual(self.room(created)['connection1'], 'guest-rejoined')
        self.error(403, lambda: self.send('guest-connection', {'type': 'input', 'seq': 100, 'mask': 0}))
        self.send('guest-rejoined', {'type': 'input', 'seq': 0, 'mask': 1})
        self.assertEqual(self.messages('host-connection')[-1], {'type': 'input', 'seq': 0, 'mask': 1})

    def test_same_capability_connection_replacement_closes_old_socket(self):
        created, guest = self.pair()
        self.socket_join('replacement', created, guest['guestToken'])
        self.callback.delete_connection.assert_called_with(ConnectionId='guest-connection')
        relay.disconnect(self.api, 'guest-connection')
        self.assertEqual(self.room(created)['connection1'], 'replacement')

    def test_host_absence_terminates_room_after_grace_and_caps_do_not_extend_expiry(self):
        created, _ = self.pair()
        relay.disconnect(self.api, 'host-connection')
        self.now += 59
        relay.active_room(self.api, created['roomId'])
        self.now += 1
        self.error(410, lambda: relay.active_room(self.api, created['roomId']))
        self.assertTrue(self.room(created)['closed'])
        self.assertEqual(self.messages('guest-connection')[-1], {'type': 'closed', 'reason': 'host-disconnected'})
        self.assertEqual(self.room(created)['expiresAt'], created['expiresAt'])

    def test_silent_host_heartbeat_expiry_is_enforced_without_disconnect_delivery(self):
        created, _ = self.pair()
        self.now += relay.HEARTBEAT_SECONDS + relay.DISCONNECT_GRACE
        self.error(410, lambda: relay.active_room(self.api, created['roomId']))
        self.assertEqual(self.room(created)['closedReason'], 'host-disconnected')

    def test_hard_expiry_does_not_wait_for_dynamodb_ttl_deletion(self):
        created, _ = self.pair()
        self.now = created['expiresAt']
        self.error(410, lambda: relay.active_room(self.api, created['roomId']))
        self.assertIn(relay.key('room', created['roomId']), self.database.rows['rooms'])
        self.assertEqual(self.room(created)['closedReason'], 'expired')

    def test_republish_hash_change_unpublish_and_foreign_tenant_invalidate_room(self):
        mutations = [lambda value: value.update(revision=8, publishedRevision=8),
            lambda value: value['spec'].update(title='A different edition'), lambda value: value.update(status='Draft')]
        for change in mutations:
            with self.subTest(change=change):
                self.database.rows['rooms'].clear()
                self.database.rows['published-games'][self.public_key]['payload'] = json.dumps(self.published)
                created, _ = self.pair()
                self.mutate_publication(change)
                self.error(410, lambda: self.send('guest-connection', {'type': 'ping'}))
                self.assertEqual(self.room(created)['closedReason'], 'publication-changed')

    def test_ping_checks_current_publication_and_reports_peer_status(self):
        self.pair()
        self.send('host-connection', {'type': 'ping'})
        self.assertEqual(self.messages('host-connection'), [{'type': 'pong'}, {'type': 'peer', 'connected': True}])
        relay.disconnect(self.api, 'guest-connection')
        self.callback.reset_mock()
        self.send('host-connection', {'type': 'ping'})
        self.assertEqual(self.messages('host-connection')[-1], {'type': 'peer', 'connected': False})

    def test_rate_limits_are_per_message_kind_and_inputs_resume_next_second(self):
        self.pair()
        for seq in range(30):
            self.send('guest-connection', {'type': 'input', 'seq': seq, 'mask': 1})
        self.send('guest-connection', {'type': 'ping'})
        self.error(429, lambda: self.send('guest-connection', {'type': 'input', 'seq': 30, 'mask': 1}))
        self.now += 1
        self.send('guest-connection', {'type': 'input', 'seq': 30, 'mask': 0})
        for seq in range(20):
            self.send('host-connection', {'type': 'state', 'seq': seq, 'state': self.snapshot()})
        self.send('host-connection', {'type': 'ping'})
        self.error(429, lambda: self.send('host-connection', {'type': 'state', 'seq': 20, 'state': self.snapshot()}))

    def test_replaying_one_sequence_does_not_bypass_connection_rate_limits(self):
        self.pair()
        for _ in range(30):
            self.send('guest-connection', {'type': 'input', 'seq': 0, 'mask': 1})
        self.assertEqual(len(self.messages('host-connection')), 1)
        self.error(429, lambda: self.send('guest-connection', {'type': 'input', 'seq': 0, 'mask': 1}))

    def test_room_creation_is_rate_limited_with_rotating_hashes_and_ttl(self):
        for _ in range(6):
            self.create()
        self.error(429, self.create)
        rate_rows = [value for key, value in self.database.rows['rooms'].items() if ':rate:' in key]
        self.assertEqual(len(rate_rows), 2)
        self.assertTrue(all(int(value['expiresAt']) <= self.now + 120 for value in rate_rows))
        self.now += 60
        self.create()

    def test_only_host_can_close_room_and_closure_is_idempotent(self):
        created, guest = self.pair()
        self.error(403, lambda: relay.close_room(self.api, created['roomId'], {'hostToken': guest['guestToken']}))
        self.assertEqual(relay.close_room(self.api, created['roomId'], {'hostToken': created['hostToken']}), {'closed': True})
        self.assertTrue(self.room(created)['closed'])
        self.assertEqual(relay.close_room(self.api, created['roomId'], {'hostToken': created['hostToken']}), {'closed': True})
        self.error(410, lambda: relay.active_room(self.api, created['roomId']))

    def test_exhausted_close_membership_races_fail_without_claiming_closure(self):
        created, _ = self.pair()
        attempts = 0
        def lose_transaction(api, operations):
            nonlocal attempts
            attempts += 1
            room = self.room(created)
            room.update(version=room['version'] + 1, generation1=str(uuid.uuid4()))
            return False
        with patch.object(relay, 'transaction', side_effect=lose_transaction):
            self.error(409, lambda: relay.close_room(self.api, created['roomId'], {'hostToken': created['hostToken']}))
        self.assertEqual(attempts, 5)
        self.assertFalse(self.room(created)['closed'])
        self.callback.post_to_connection.assert_not_called()
        self.callback.delete_connection.assert_not_called()

    def test_last_close_conflict_succeeds_only_if_final_read_is_already_closed(self):
        created, _ = self.pair()
        attempts = 0
        def another_closer(api, operations):
            nonlocal attempts
            attempts += 1
            room = self.room(created)
            room['version'] += 1
            if attempts == 5:
                room.update(closed=True, closedReason='closed')
            return False
        with patch.object(relay, 'transaction', side_effect=another_closer):
            self.assertEqual(relay.close_room(self.api, created['roomId'], {'hostToken': created['hostToken']}), {'closed': True})
        self.assertEqual(attempts, 5)
        self.assertTrue(self.room(created)['closed'])
        self.assertEqual(self.messages('host-connection')[-1], {'type': 'closed', 'reason': 'closed'})

    def test_malformed_ws_errors_are_safe_and_disconnect_without_logging_payload(self):
        self.pair()
        for body in ({'type': 'input', 'seq': 0, 'mask': 64}, {'type': 'input', 'seq': True, 'mask': 0},
                {'type': 'input', 'seq': 0, 'mask': 0, 'token': 'not-allowed'}, {'type': 'chat', 'text': 'private'}):
            self.error(400 if body.get('type') == 'input' else 403, lambda: self.send('guest-connection', body))
        event = self.event('guest-connection'); event['body'] = '{bad'
        response = relay.websocket_handler(self.api, event)
        self.assertEqual(response['statusCode'], 400)
        self.assertEqual(self.messages('guest-connection')[-1], {'type': 'error', 'message': 'Invalid multiplayer JSON.'})
        self.callback.delete_connection.assert_called_with(ConnectionId='guest-connection')
        event['body'] = 'x' * (relay.MAX_MESSAGE_BYTES + 1)
        self.error(413, lambda: relay.message(self.api, event))

    def test_gone_peer_callback_reports_disconnection(self):
        created, guest = self.pair()
        def deliver(**kwargs):
            if kwargs['ConnectionId'] == 'guest-connection':
                raise Gone()
        self.callback.post_to_connection.side_effect = deliver
        self.send('host-connection', {'type': 'state', 'seq': 0, 'state': self.snapshot()})
        self.assertEqual(self.messages('host-connection')[-1], {'type': 'peer', 'connected': False})
        self.assertEqual(self.room(created)['connection1'], '')
        self.callback.post_to_connection.side_effect = None
        self.callback.reset_mock()
        self.send('host-connection', {'type': 'ping'})
        self.assertEqual(self.messages('host-connection')[-1], {'type': 'peer', 'connected': False})
        self.socket_join('guest-returned', created, guest['guestToken'])
        self.send('host-connection', {'type': 'ping'})
        self.assertEqual(self.messages('host-connection')[-1], {'type': 'peer', 'connected': True})

    def test_decimal_resource_reads_do_not_break_epoch_generation_or_sequences(self):
        created, guest = self.pair()
        self.database.table_class = DynamoResourceTable
        self.send('guest-connection', {'type': 'input', 'seq': 0, 'mask': 1})
        self.send('host-connection', {'type': 'ping'})
        self.assertEqual(self.messages('host-connection')[0], {'type': 'input', 'seq': 0, 'mask': 1})
        self.assertEqual(relay.socket_url(), 'wss://relay.example.test/live')

    def test_standalone_http_entrypoint_has_no_core_credentials_and_rejects_foreign_origin(self):
        with patch.object(relay, '_database', self.database), patch.object(relay, '_callback', self.callback):
            event = self.event(); event.update(rawPath='/health'); event['requestContext']['http']['method'] = 'GET'
            self.assertEqual(json.loads(relay.handler(event, None)['body']), {'status': 'ok'})
            event.update(rawPath='/multiplayer/rooms', body=json.dumps({'gameId': support.GAME, 'publishedRevision': 7}))
            event['requestContext']['http']['method'] = 'POST'
            result = relay.handler(event, None)
            self.assertEqual(result['statusCode'], 200)
            event['headers']['origin'] = 'https://foreign.example'
            self.assertEqual(relay.handler(event, None)['statusCode'], 403)
            event['requestContext']['http']['method'] = 'OPTIONS'
            self.assertEqual(relay.handler(event, None)['statusCode'], 204)

    def test_health_and_preflight_do_not_initialize_aws_clients(self):
        with patch.object(relay, 'clients', side_effect=AssertionError('Must not initialize AWS')):
            event = self.event(); event['requestContext']['http']['method'] = 'OPTIONS'
            self.assertEqual(relay.handler(event, None)['statusCode'], 204)
            event['requestContext']['http']['method'] = 'GET'; event['rawPath'] = '/health'
            self.assertEqual(relay.handler(event, None)['statusCode'], 200)

    def test_publication_and_room_tenant_fields_are_checked_on_reads(self):
        self.database.rows['published-games'][self.public_key]['organization_id'] = support.OTHER
        self.error(404, self.create)
        self.database.rows['published-games'][self.public_key]['organization_id'] = support.ORG
        created = self.create()
        self.room(created)['service_id'] = support.OTHER
        self.error(404, lambda: relay.active_room(self.api, created['roomId']))


if __name__ == '__main__':
    unittest.main()
