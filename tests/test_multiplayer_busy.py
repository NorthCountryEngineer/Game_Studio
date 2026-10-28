"""Offline shared-condition contention; a busy hint grants no gameplay or lease."""
from copy import deepcopy
import unittest
from unittest.mock import patch

import test_multiplayer as existing
import test_multiplayer_latency as latency

relay, support = existing.relay, existing.support


class BusyTests(unittest.TestCase):
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
    controls = latency.LatencyTests.controls
    admit = latency.LatencyTests.admit

    def setUp(self):
        latency.LatencyTests.setUp(self)
        sleep = patch.object(relay.time, 'sleep')
        self.sleep = sleep.start(); self.addCleanup(sleep.stop)

    def pair(self, flow=3, host_flow=None):
        self.database.meta.client.transact_write_items.side_effect = self.database.transact
        self.locked = False
        created = self.create(); guest = self.join(created)
        self.admit('host', created, created['hostToken'], flow if host_flow is None else host_flow)
        self.admit('guest', created, guest['guestToken'], flow)
        self.callback.reset_mock()
        self.database.meta.client.transact_write_items.reset_mock()
        return created, guest

    def lock_publication(self, code='TransactionConflict'):
        """Model a DynamoDB transaction holding the shared publication item.

        MemoryDatabase otherwise runs transactions instantaneously and cannot
        model conflict between two ConditionChecks on the same published game.
        """
        original = self.database.transact
        self.locked = True
        self.attempts = []
        def transact(TransactItems):
            checks = [operation['ConditionCheck'] for operation in TransactItems if 'ConditionCheck' in operation]
            if self.locked and any(check['TableName'] == 'published-games' for check in checks):
                self.attempts.append(deepcopy(TransactItems))
                publication = checks[0]
                room = checks[1] if len(checks) == 2 else TransactItems[1]['Put']
                self.assertEqual(publication['ExpressionAttributeValues'][':payload'], self.database.rows['published-games'][self.public_key]['payload'])
                self.assertEqual(publication['ExpressionAttributeValues'][':revision'], self.database.rows['published-games'][self.public_key]['revision'])
                for check in (publication, room):
                    self.assertEqual(check['ExpressionAttributeValues'][':org'], support.ORG)
                    self.assertEqual(check['ExpressionAttributeValues'][':service'], support.SERVICE)
                self.assertIn('#v = :version', room['ConditionExpression'])
                self.assertTrue(any('Put' in operation and 'generation' in operation['Put']['Item'] for operation in TransactItems))
                error = existing.ConditionalFailure()
                error.response = {'Error': {'Code': 'TransactionCanceledException'}, 'CancellationReasons': [
                    {'Code': code if index == 0 else 'None'} for index in range(len(TransactItems))]}
                raise error
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transact

    def test_known_flow_three_admission_preserves_ready_and_acks(self):
        self.pair()
        self.assertEqual(self.database.rows['rooms'][relay.key('connection', 'host')]['flowVersion'], 3)
        self.send('guest', self.controls())
        self.assertEqual(self.messages('host'), [self.controls()])
        self.assertEqual(self.messages('guest'), [{'type': 'ack', 'kind': 'input', 'seq': 1}])

    def test_shared_publication_lock_yields_only_busy_without_any_commit_or_disconnect(self):
        created, _ = self.pair()
        for connection, body in [('host', {'type': 'state', 'seq': 7, 'state': self.snapshot()}),
                ('guest', self.controls(8, 32)), ('host', {'type': 'ping'})]:
            with self.subTest(kind=body['type']):
                self.callback.reset_mock(); before = deepcopy(self.database.rows)
                self.lock_publication()
                response = relay.websocket_handler(self.api, self.event(connection, body=body))
                expected = {'type': 'busy', 'kind': body['type'], 'retryAfterMs': 200}
                if body['type'] != 'ping': expected['seq'] = body['seq']
                self.assertEqual(response['statusCode'], 200)
                self.assertEqual(self.messages(connection), [expected])
                self.assertEqual(self.messages('guest' if connection == 'host' else 'host'), [])
                self.assertEqual(len(self.attempts), 5)
                self.assertEqual(self.database.rows, before, 'busy cannot advance a sequence, rate counter, liveness, room lease or publication')
                self.callback.delete_connection.assert_not_called()
                self.assertEqual(self.room(created)['connection0'], 'host')
                self.assertEqual(self.room(created)['connection1'], 'guest')

    def test_retry_waits_are_bounded_and_only_between_failed_attempts(self):
        self.pair(); self.lock_publication()
        with patch.object(relay.secrets, 'randbelow', side_effect=[0, 15, 0, 15]):
            self.send('guest', self.controls())
        self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [0.005, 0.020, 0.005, 0.020])

    def test_finite_lock_conflicts_can_commit_once_without_busy_or_duplicate_forwarding(self):
        self.pair(); self.lock_publication()
        self.sleep.side_effect = lambda _: setattr(self, 'locked', len(self.attempts) < 2)
        self.send('guest', self.controls(2, 0, [{'seq': 1, 'mask': 32}, {'seq': 2, 'mask': 0}]))
        self.assertEqual(len(self.attempts), 2)
        self.assertEqual(len(self.messages('host')), 1)
        self.assertEqual(self.messages('guest'), [{'type': 'ack', 'kind': 'input', 'seq': 2}])

    def test_next_packet_after_busy_performs_fresh_validation_and_commits_normally(self):
        self.pair(); self.lock_publication(); self.send('guest', self.controls())
        self.locked = False; self.callback.reset_mock()
        with patch.object(relay, 'publication', wraps=relay.publication) as publication:
            self.send('guest', self.controls(2, 0, [{'seq': 1, 'mask': 4}, {'seq': 2, 'mask': 0}]))
            self.assertEqual(publication.call_count, 1)
        self.assertEqual(self.messages('guest'), [{'type': 'ack', 'kind': 'input', 'seq': 2}])
        self.assertEqual(self.messages('host')[0]['history'], [{'seq': 1, 'mask': 4}, {'seq': 2, 'mask': 0}])

    def test_legacy_flow_one_and_two_keep_their_terminal_contention_response(self):
        for flow in (1, 2):
            with self.subTest(flow=flow):
                self.database.rows['rooms'].clear(); self.callback.reset_mock(); self.pair(flow)
                self.lock_publication()
                body = self.controls() if flow == 2 else {'type': 'input', 'seq': 1, 'mask': 4}
                response = relay.websocket_handler(self.api, self.event('guest', body=body))
                self.assertEqual(response['statusCode'], 409)
                self.assertEqual(self.messages('guest'), [{'type': 'error', 'message': 'The relay is busy. Reconnect shortly.'}])
                self.assertFalse(any(message['type'] == 'busy' for message in self.messages('guest')))
                self.callback.delete_connection.assert_called_once_with(ConnectionId='guest')

    def test_same_revision_publication_change_during_retry_remains_terminal(self):
        created, _ = self.pair(); self.lock_publication()
        self.sleep.side_effect = lambda _: self.mutate_publication(lambda value: value['spec'].update(title='Changed while waiting for the shared lock'))
        self.error(410, lambda: self.send('guest', self.controls()))
        self.assertEqual(len(self.attempts), 1)
        self.assertTrue(self.room(created)['closed'])
        self.assertFalse(any(message['type'] in {'busy', 'ack', 'input'} for message in self.messages('guest') + self.messages('host')))

    def test_replaced_connection_generation_during_retry_remains_terminal(self):
        created, guest = self.pair(); self.lock_publication()
        def replacement(_):
            self.locked = False
            self.admit('replacement', created, guest['guestToken'], 3)
            self.locked = True
        self.sleep.side_effect = replacement
        self.error(403, lambda: self.send('guest', self.controls()))
        self.assertEqual(self.room(created)['connection1'], 'replacement')
        self.assertFalse(any(message['type'] in {'busy', 'ack', 'input'} for message in self.messages('guest') + self.messages('host')))

    def test_publication_revoked_after_busy_is_not_hidden_by_further_busy(self):
        self.pair(); self.lock_publication(); self.send('guest', self.controls())
        self.locked = False; self.callback.reset_mock()
        self.database.rows['published-games'].pop(self.public_key)
        self.error(410, lambda: self.send('guest', self.controls(2)))
        self.assertFalse(any(message['type'] in {'busy', 'ack', 'input'} for message in self.messages('guest') + self.messages('host')))

    def test_invalid_kind_seat_schema_and_out_of_range_sequence_never_get_busy(self):
        self.pair(); self.lock_publication()
        cases = [('guest', {'type': 'unknown'}, 403), ('guest', {'type': 'state', 'seq': 1, 'state': self.snapshot()}, 403),
            ('host', {'type': 'ping', 'seq': 1}, 400), ('guest', self.controls(0), 400),
            ('guest', self.controls(10000001), 400), ('host', {'type': 'state', 'seq': 0, 'state': self.snapshot()}, 400),
            ('host', {'type': 'state', 'seq': 10000001, 'state': self.snapshot()}, 400),
            ('guest', {'type': 'input', 'seq': 1, 'mask': 4}, 400)]
        for connection, body, status in cases:
            with self.subTest(body=body): self.error(status, lambda: self.send(connection, body))
        self.assertEqual(self.attempts, [])
        self.assertEqual(self.messages('host') + self.messages('guest'), [])

    def test_unknown_or_validation_cancellation_metadata_is_raised_not_busy(self):
        self.pair()
        for code in ('ValidationError', 'AccessDenied', 'UnknownFutureReason'):
            with self.subTest(code=code):
                self.lock_publication(code)
                with self.assertRaises(existing.ConditionalFailure): self.send('guest', self.controls())
                self.assertEqual(len(self.attempts), 1)
                self.assertEqual(self.messages('host') + self.messages('guest'), [])

    def test_conditional_check_cancellation_can_return_busy_but_never_ack(self):
        self.pair(); self.lock_publication('ConditionalCheckFailed')
        self.send('guest', self.controls())
        self.assertEqual(self.messages('guest'), [{'type': 'busy', 'kind': 'input', 'seq': 1, 'retryAfterMs': 200}])
        self.assertEqual(self.messages('host'), [])

    def test_three_to_two_peer_retains_history_and_three_to_one_strips_it(self):
        for host_flow in (1, 2, 3):
            with self.subTest(host_flow=host_flow):
                self.database.rows['rooms'].clear(); self.callback.reset_mock(); self.pair(host_flow=host_flow)
                self.send('guest', self.controls())
                expected = self.controls() if host_flow in {2, 3} else {'type': 'input', 'seq': 1, 'mask': 4}
                self.assertEqual(self.messages('host'), [expected])
                self.assertEqual(self.messages('guest'), [{'type': 'ack', 'kind': 'input', 'seq': 1}])


if __name__ == '__main__': unittest.main()
