"""Offline relay read reuse, immutable validation results and bounded input history."""
from collections import OrderedDict
from copy import deepcopy
import json
import os
import unittest
from unittest.mock import patch

import test_multiplayer as existing
from test_nce_api import MemoryTable

relay, support = existing.relay, existing.support


class LatencyTests(unittest.TestCase):
    event = existing.MultiplayerTests.event
    create = existing.MultiplayerTests.create
    join = existing.MultiplayerTests.join
    invitation = existing.MultiplayerTests.invitation
    room = existing.MultiplayerTests.room
    messages = existing.MultiplayerTests.messages
    error = existing.MultiplayerTests.error
    send = existing.MultiplayerTests.send
    snapshot = existing.MultiplayerTests.snapshot
    mutate_publication = existing.MultiplayerTests.mutate_publication

    def setUp(self):
        existing.MultiplayerTests.setUp(self)
        cache = patch.object(relay, '_publication_validations', OrderedDict())
        cache.start(); self.addCleanup(cache.stop)

    def admit(self, connection, created, token, flow=2):
        relay.connect(self.api, self.event(connection, '$connect'))
        body = {'type': 'join', 'roomId': created['roomId'], 'token': token, 'leaseVersion': 1}
        if flow is not None: body['flowVersion'] = flow
        relay.message(self.api, self.event(connection, body=body))

    def pair(self, host_flow=2, guest_flow=2):
        created = self.create(); guest = self.join(created)
        self.admit('host', created, created['hostToken'], host_flow)
        self.admit('guest', created, guest['guestToken'], guest_flow)
        self.callback.reset_mock()
        return created, guest

    def controls(self, seq=1, mask=4, history=None):
        return {'type': 'input', 'seq': seq, 'mask': mask,
            'history': history if history is not None else [{'seq': seq, 'mask': mask}]}

    def acks(self, connection):
        return [message for message in self.messages(connection) if message['type'] == 'ack']

    def test_each_direction_uses_four_consistent_reads_and_keeps_all_transaction_fences(self):
        self.pair(); relay._publication_validations.clear()
        original = MemoryTable.get_item; reads = []
        def read(table, Key, **options):
            reads.append((table.name, Key['id'], options.get('ConsistentRead')))
            return original(table, Key, **options)
        with patch.object(MemoryTable, 'get_item', read), patch.object(support.games, 'validate_spec', wraps=support.games.validate_spec) as validate:
            for connection, body in [('host', {'type': 'state', 'seq': 1, 'state': self.snapshot()}), ('guest', self.controls())]:
                reads.clear(); self.send(connection, body)
                self.assertEqual(len(reads), 4)
                self.assertTrue(all(consistent for _, _, consistent in reads))
                self.assertEqual(len({(table, key) for table, key, _ in reads}), 4)
                operations = self.database.meta.client.transact_write_items.call_args.kwargs['TransactItems']
                self.assertEqual([next(iter(operation)) for operation in operations], ['ConditionCheck', 'ConditionCheck', 'Put'])
                publication = operations[0]['ConditionCheck']
                self.assertEqual(publication['ExpressionAttributeValues'][':payload'], self.database.rows['published-games'][self.public_key]['payload'])
                self.assertEqual(publication['ExpressionAttributeValues'][':revision'], 7)
                self.assertEqual(publication['ExpressionAttributeValues'][':org'], support.ORG)
                self.assertEqual(publication['ExpressionAttributeValues'][':service'], support.SERVICE)
                self.assertIn('#v = :version', operations[1]['ConditionCheck']['ConditionExpression'])
            self.assertEqual(validate.call_count, 1)

    def test_validation_cache_has_no_mutable_spec_and_returns_fresh_nested_values(self):
        first, spec_hash, _ = relay.publication(self.api, support.GAME, 7)
        first['player']['name'] = 'Caller changed only its own copy'
        second, second_hash, _ = relay.publication(self.api, support.GAME, 7)
        self.assertEqual(second, self.spec); self.assertEqual(second_hash, spec_hash)
        self.assertIsNot(first['player'], second['player'])
        self.assertTrue(all(isinstance(value, str) and len(value) == 64 for value in relay._publication_validations.values()))

    def test_validation_cache_is_bounded_lru_and_scope_bound(self):
        payloads = []
        for index in range(relay.PUBLICATION_VALIDATION_LIMIT):
            self.mutate_publication(lambda value: value['spec'].update(title='Synthetic edition ' + str(index)))
            payloads.append(self.database.rows['published-games'][self.public_key]['payload'])
            relay.publication(self.api, support.GAME, 7)
        first, second = list(relay._publication_validations)[:2]
        self.database.rows['published-games'][self.public_key]['payload'] = payloads[0]
        relay.publication(self.api, support.GAME, 7)
        self.mutate_publication(lambda value: value['spec'].update(title='One additional synthetic edition'))
        relay.publication(self.api, support.GAME, 7)
        self.assertEqual(len(relay._publication_validations), relay.PUBLICATION_VALIDATION_LIMIT)
        self.assertIn(first, relay._publication_validations); self.assertNotIn(second, relay._publication_validations)
        original = deepcopy(self.database.rows['published-games'][self.public_key])
        with patch.dict(os.environ, {'CORE_ORGANIZATION_ID': support.OTHER}):
            changed_key = support.games.key('game', support.GAME)
            self.database.rows['published-games'][changed_key] = {**original, 'id': changed_key, 'organization_id': support.OTHER}
            relay.publication(self.api, support.GAME, 7)
            self.assertEqual(next(reversed(relay._publication_validations))[0], support.OTHER)

    def test_same_revision_payload_change_invalidates_cached_room(self):
        created, _ = self.pair()
        self.mutate_publication(lambda value: value['spec'].update(title='Changed public content at the same revision'))
        self.error(410, lambda: self.send('guest', self.controls()))
        self.assertTrue(self.room(created)['closed'])
        self.assertEqual(self.acks('guest'), [])
        self.assertFalse(any(message['type'] == 'input' for message in self.messages('host')))

    def test_cached_publication_is_still_fenced_against_same_revision_race(self):
        created, _ = self.pair(); original = self.database.transact; raced = False
        def transact(TransactItems):
            nonlocal raced
            if not raced:
                raced = True
                self.mutate_publication(lambda value: value['spec'].update(title='Concurrent publication payload change'))
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transact
        self.error(410, lambda: self.send('host', {'type': 'state', 'seq': 1, 'state': self.snapshot()}))
        self.assertTrue(self.room(created)['closed']); self.assertEqual(self.acks('host'), [])
        self.assertFalse(any(message['type'] == 'state' for message in self.messages('guest')))

    def test_invalid_changed_spec_is_never_admitted_by_validation_cache(self):
        self.pair()
        self.mutate_publication(lambda value: value['spec']['player'].update(speed=999))
        self.error(410, lambda: self.send('guest', self.controls()))
        self.assertEqual(self.acks('guest'), [])

    def test_request_local_peer_record_rechecks_liveness_at_delivery_time(self):
        created, _ = self.pair(); original = self.database.transact
        def transact(TransactItems):
            result = original(TransactItems)
            self.now += relay.HEARTBEAT_SECONDS + 1
            return result
        self.database.meta.client.transact_write_items.side_effect = transact
        self.send('guest', self.controls())
        self.assertFalse(any(message['type'] == 'input' for message in self.messages('host')))
        self.assertEqual(self.room(created)['connection0'], '')
        self.assertEqual(self.acks('guest'), [{'type': 'ack', 'kind': 'input', 'seq': 1}])

    def test_flow_two_history_is_forwarded_exactly_but_never_retained(self):
        self.pair()
        controls = self.controls(3, 0, [{'seq': 1, 'mask': 0}, {'seq': 2, 'mask': 32}, {'seq': 3, 'mask': 0}])
        self.send('guest', controls)
        self.assertEqual(self.messages('host'), [controls])
        self.assertEqual(self.acks('guest'), [{'type': 'ack', 'kind': 'input', 'seq': 3}])
        for row in self.database.rows['rooms'].values():
            self.assertFalse({'history', 'mask', 'state', 'players'} & set(row))

    def test_history_is_strict_bounded_and_bound_to_final_controls(self):
        self.pair()
        histories = [None, [], {}, [{'seq': 1, 'mask': 0}] * 9,
            [{'seq': 2, 'mask': 4}, {'seq': 1, 'mask': 4}],
            [{'seq': 1, 'mask': 4}, {'seq': 1, 'mask': 4}],
            [{'seq': 1, 'mask': 4}], [{'seq': 3, 'mask': 0}],
            [{'seq': 3, 'mask': 4, 'extra': True}], [{'seq': 0, 'mask': 4}],
            [{'seq': True, 'mask': 4}], [{'seq': 3, 'mask': True}],
            [{'seq': 3, 'mask': 64}], [{'seq': 2147483648, 'mask': 4}]]
        for history in histories:
            with self.subTest(history=history):
                body = {'type': 'input', 'seq': 3, 'mask': 4, 'history': history}
                self.error(400, lambda: self.send('guest', body))
        self.error(400, lambda: self.send('guest', {'type': 'input', 'seq': 1, 'mask': 4}))
        self.assertEqual(self.messages('host'), []); self.assertEqual(self.acks('guest'), [])
        self.assertEqual(self.database.rows['rooms'][relay.key('connection', 'guest')]['seq'], -1)

    def test_legacy_peer_receives_only_original_input_shape(self):
        for host_flow in (None, 1):
            with self.subTest(host_flow=host_flow):
                self.database.rows['rooms'].clear(); self.callback.reset_mock()
                self.pair(host_flow=host_flow)
                self.send('guest', self.controls(2, 0, [{'seq': 1, 'mask': 32}, {'seq': 2, 'mask': 0}]))
                self.assertEqual(self.messages('host'), [{'type': 'input', 'seq': 2, 'mask': 0}])
                self.assertEqual(self.acks('guest'), [{'type': 'ack', 'kind': 'input', 'seq': 2}])

    def test_legacy_sender_cannot_add_history_and_still_works_with_new_peer(self):
        self.pair(guest_flow=1)
        self.error(400, lambda: self.send('guest', self.controls()))
        body = {'type': 'input', 'seq': 1, 'mask': 4}
        self.send('guest', body)
        self.assertEqual(self.messages('host'), [body]); self.assertEqual(len(self.acks('guest')), 1)

    def test_newer_cumulative_history_survives_older_packet_acceptance_order(self):
        self.pair()
        newer = self.controls(3, 0, [{'seq': 2, 'mask': 32}, {'seq': 3, 'mask': 0}])
        self.send('guest', newer); self.send('guest', self.controls(2, 32))
        self.assertEqual(self.messages('host'), [newer])
        self.assertEqual(self.acks('guest'), [{'type': 'ack', 'kind': 'input', 'seq': seq} for seq in (3, 2)])
        self.assertEqual(self.database.rows['rooms'][relay.key('connection', 'guest')]['seq'], 3)

    def test_full_bounded_history_and_maximum_sequence_are_admitted(self):
        self.pair()
        history = [{'seq': 2147483640 + offset, 'mask': offset} for offset in range(8)]
        body = self.controls(2147483647, 7, history)
        self.send('guest', body)
        self.assertEqual(self.messages('host'), [body])
        self.assertEqual(self.acks('guest'), [{'type': 'ack', 'kind': 'input', 'seq': 2147483647}])

    def test_newer_pipelined_packet_can_win_an_inflight_older_packet_cas(self):
        self.pair(); original = self.database.transact; raced = False
        newer = self.controls(2, 0, [{'seq': 1, 'mask': 32}, {'seq': 2, 'mask': 0}])
        def transact(TransactItems):
            nonlocal raced
            if not raced:
                raced = True; self.send('guest', newer)
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transact
        self.send('guest', self.controls(1, 32))
        self.assertEqual(self.messages('host'), [newer])
        self.assertEqual(self.acks('guest'), [{'type': 'ack', 'kind': 'input', 'seq': seq} for seq in (2, 1)])
        self.assertEqual(self.database.rows['rooms'][relay.key('connection', 'guest')]['seq'], 2)

    def test_replaced_guest_generation_cannot_forward_cumulative_history(self):
        created, guest = self.pair(); original = self.database.transact; replaced = False
        def transact(TransactItems):
            nonlocal replaced
            if not replaced:
                replaced = True
                self.admit('replacement-guest', created, guest['guestToken'])
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transact
        self.error(403, lambda: self.send('guest', self.controls(2, 0, [{'seq': 1, 'mask': 32}, {'seq': 2, 'mask': 0}])))
        self.assertEqual(self.room(created)['connection1'], 'replacement-guest')
        self.assertFalse(any(message['type'] == 'input' for message in self.messages('host')))
        self.assertEqual(self.acks('guest'), [])

    def test_history_retry_and_duplicate_rate_bounds_remain_enforced(self):
        self.pair(); original = self.database.transact; retried = False
        def transact(TransactItems):
            nonlocal retried
            if not retried:
                retried = True; raise existing.ConditionalFailure()
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transact
        body = self.controls(2, 0, [{'seq': 1, 'mask': 16}, {'seq': 2, 'mask': 0}])
        self.send('guest', body)
        self.assertEqual(self.messages('host'), [body]); self.assertEqual(len(self.acks('guest')), 1)
        for _ in range(29): self.send('guest', body)
        self.error(429, lambda: self.send('guest', body))
        self.assertEqual(self.messages('host'), [body]); self.assertEqual(len(self.acks('guest')), 30)


if __name__ == '__main__': unittest.main()
