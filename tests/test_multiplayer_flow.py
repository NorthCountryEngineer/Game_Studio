"""Synthetic opt-in flow acknowledgments; no AWS, real accounts or network."""
from copy import deepcopy
import json
import unittest

import test_multiplayer as existing

relay = existing.relay
support = existing.support


class FlowTests(unittest.TestCase):
    setUp = existing.MultiplayerTests.setUp
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

    def admit(self, connection, created, token, flow=True, lease=True):
        self.assertEqual(relay.websocket_handler(self.api, self.event(connection, '$connect'))['statusCode'], 200)
        body = {'type': 'join', 'roomId': created['roomId'], 'token': token}
        if flow:body['flowVersion'] = 1
        if lease:body['leaseVersion'] = 1
        self.assertEqual(relay.websocket_handler(self.api, self.event(connection, body=body))['statusCode'], 200)

    def pair(self, host_flow=True, guest_flow=True, lease=True):
        room = self.create(); guest = self.join(room)
        self.admit('host', room, room['hostToken'], host_flow, lease)
        self.admit('guest', room, guest['guestToken'], guest_flow, lease)
        self.callback.reset_mock()
        return room, guest

    def acks(self, connection):
        return [message for message in self.messages(connection) if message['type'] == 'ack']

    def test_flow_opt_in_is_exact_and_does_not_change_ready_or_disclose_flags(self):
        created = self.create()
        for index, value in enumerate((True, False, 0, 3, '1', None, [], {})):
            connection = 'invalid-flow-' + str(index)
            relay.connect(self.api, self.event(connection, '$connect'))
            self.error(400, lambda: self.send(connection, {'type': 'join', 'roomId': created['roomId'],
                'token': created['hostToken'], 'leaseVersion': 1, 'flowVersion': value}))
            self.assertNotIn('roomId', self.database.rows['rooms'][relay.key('connection', connection)])
        self.admit('valid', created, created['hostToken'])
        self.assertEqual(self.database.rows['rooms'][relay.key('connection', 'valid')]['flowVersion'], 1)
        self.assertEqual(set(self.messages('valid')[0]), {'type','roomId','seat','expiresAt','gameId','publishedRevision','specSha256'})
        self.assertEqual(self.acks('valid'), [])
        self.send('valid', {'type': 'ping'}); self.assertEqual(self.acks('valid'), [], 'heartbeats retain their separate lease/pong protocol')

    def test_legacy_and_lease_only_clients_get_no_ack_even_when_peer_opts_in(self):
        for lease in (False, True):
            with self.subTest(lease=lease):
                self.database.rows['rooms'].clear(); self.callback.reset_mock()
                self.pair(host_flow=False, guest_flow=True, lease=lease)
                self.send('host', {'type':'state','seq':1,'state':self.snapshot()})
                self.assertEqual(self.acks('host'), [])
                self.send('guest', {'type':'input','seq':1,'mask':4})
                self.assertEqual(self.acks('guest'), [{'type':'ack','kind':'input','seq':1}])
                self.assertNotIn('flowVersion', self.database.rows['rooms'][relay.key('connection','host')])

    def test_ack_follows_fenced_commit_and_peer_delivery_for_each_kind(self):
        self.pair(); order = []; original = self.database.transact
        def transaction(TransactItems):
            result = original(TransactItems); order.append('committed'); return result
        def posted(*, ConnectionId, Data):
            message = json.loads(Data); order.append((ConnectionId,message['type']))
            if message['type'] == 'ack':
                stored = self.database.rows['rooms'][relay.key('connection', ConnectionId)]
                self.assertEqual(stored['seq'], message['seq'])
        self.database.meta.client.transact_write_items.side_effect = transaction
        self.callback.post_to_connection.side_effect = posted
        self.send('host', {'type':'state','seq':1,'state':self.snapshot()})
        self.assertEqual(order, ['committed',('guest','state'),('host','ack')])
        self.assertEqual(self.acks('host'), [{'type':'ack','kind':'state','seq':1}]); order.clear()
        self.send('guest', {'type':'input','seq':2,'mask':32})
        self.assertEqual(order, ['committed',('host','input'),('guest','ack')])
        self.assertEqual(self.acks('guest'), [{'type':'ack','kind':'input','seq':2}])

    def test_duplicate_and_old_sequences_ack_original_request_without_reforward_or_regression(self):
        self.pair()
        for seq in (7,7,6):self.send('guest', {'type':'input','seq':seq,'mask':1})
        self.assertEqual(self.messages('host'), [{'type':'input','seq':7,'mask':1}])
        self.assertEqual(self.acks('guest'), [{'type':'ack','kind':'input','seq':seq} for seq in (7,7,6)])
        connection = self.database.rows['rooms'][relay.key('connection','guest')]
        self.assertEqual(connection['seq'],7); self.assertEqual(connection['rateCount_input'],3)
        for seq in (8,8,5):self.send('host', {'type':'state','seq':seq,'state':self.snapshot()})
        self.assertEqual(len([value for value in self.messages('guest') if value['type']=='state']),1)
        self.assertEqual(self.acks('host'), [{'type':'ack','kind':'state','seq':seq} for seq in (8,8,5)])

    def test_cas_retry_emits_one_forward_and_one_ack(self):
        self.pair(); original = self.database.transact; failed = False
        def transaction(TransactItems):
            nonlocal failed
            if not failed:
                failed = True; raise existing.ConditionalFailure()
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transaction
        self.send('guest', {'type':'input','seq':1,'mask':1})
        self.assertEqual(self.messages('host'), [{'type':'input','seq':1,'mask':1}])
        self.assertEqual(self.acks('guest'), [{'type':'ack','kind':'input','seq':1}])

    def test_replaced_generation_cannot_forward_or_ack_inflight_request(self):
        created,_ = self.pair(); original = self.database.transact; raced = False
        def transaction(TransactItems):
            nonlocal raced
            if not raced and any('Put' in operation and operation['Put']['Item']['id']==relay.key('connection','host') for operation in TransactItems):
                raced = True; self.admit('replacement', created, created['hostToken'])
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transaction
        self.error(403, lambda:self.send('host',{'type':'state','seq':1,'state':self.snapshot()}))
        self.assertEqual(self.acks('host'),[])
        self.assertFalse(any(value['type']=='state' for value in self.messages('guest')))

    def test_publication_change_or_invalid_snapshot_cannot_receive_ack(self):
        self.pair(); invalid = deepcopy(self.snapshot()); invalid['unexpected']='not allowed'
        self.error(400,lambda:self.send('host',{'type':'state','seq':1,'state':invalid}))
        self.assertEqual(self.acks('host'),[]); self.assertEqual(self.messages('guest'),[])
        original = self.database.transact; raced = False
        def transaction(TransactItems):
            nonlocal raced
            if not raced:
                raced = True; self.mutate_publication(lambda value:value.update(revision=8,publishedRevision=8))
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transaction
        self.error(410,lambda:self.send('host',{'type':'state','seq':1,'state':self.snapshot()}))
        self.assertEqual(self.acks('host'),[])

    def test_peer_absent_and_definitively_gone_still_ack_processed_update(self):
        self.pair(); relay.disconnect(self.api,'guest'); self.callback.reset_mock()
        self.send('host',{'type':'state','seq':1,'state':self.snapshot()})
        self.assertEqual(self.messages('host'),[{'type':'peer','connected':False},{'type':'ack','kind':'state','seq':1}])
        self.database.rows['rooms'].clear(); self.callback.reset_mock(); created,_=self.pair()
        def posted(*,ConnectionId,Data):
            if ConnectionId=='guest' and json.loads(Data)['type']=='state':raise existing.Gone()
        self.callback.post_to_connection.side_effect=posted
        self.send('host',{'type':'state','seq':2,'state':self.snapshot()})
        self.assertEqual(self.acks('host'),[{'type':'ack','kind':'state','seq':2}])
        self.assertEqual(self.room(created)['connection1'],'')

    def test_uncertain_peer_delivery_does_not_ack_but_duplicate_retry_can_ack_commit(self):
        self.pair()
        def unavailable(*,ConnectionId,Data):
            if ConnectionId=='guest':raise RuntimeError('Synthetic callback unavailable')
        self.callback.post_to_connection.side_effect=unavailable
        with self.assertRaisesRegex(RuntimeError,'Synthetic callback'):self.send('host',{'type':'state','seq':3,'state':self.snapshot()})
        self.assertEqual(self.acks('host'),[])
        self.assertEqual(self.database.rows['rooms'][relay.key('connection','host')]['seq'],3)
        self.callback.post_to_connection.side_effect=None; self.callback.reset_mock()
        self.send('host',{'type':'state','seq':3,'state':self.snapshot()})
        self.assertEqual(self.messages('guest'),[])
        self.assertEqual(self.acks('host'),[{'type':'ack','kind':'state','seq':3}])

    def test_definitive_ack_delivery_failure_disconnects_only_own_current_generation(self):
        created,_=self.pair()
        def gone_ack(*,ConnectionId,Data):
            if ConnectionId=='host' and json.loads(Data)['type']=='ack':raise existing.Gone()
        self.callback.post_to_connection.side_effect=gone_ack
        self.send('host',{'type':'state','seq':1,'state':self.snapshot()})
        self.assertEqual(self.room(created)['connection0'],''); self.assertEqual(self.room(created)['connection1'],'guest')
        self.assertEqual(self.messages('guest')[-1],{'type':'peer','connected':False})

    def test_ack_gone_race_cannot_disconnect_a_replacement_generation(self):
        created,_=self.pair(); replaced=False
        def gone_ack(*,ConnectionId,Data):
            nonlocal replaced
            if ConnectionId=='host' and json.loads(Data)['type']=='ack':
                if not replaced:
                    replaced=True; self.admit('replacement',created,created['hostToken'])
                raise existing.Gone()
        self.callback.post_to_connection.side_effect=gone_ack
        self.send('host',{'type':'state','seq':1,'state':self.snapshot()})
        self.assertEqual(self.room(created)['connection0'],'replacement')
        self.assertEqual(self.room(created)['connection1'],'guest')
        self.assertFalse(self.room(created)['disconnectedAt0'])

    def test_duplicate_acks_remain_subject_to_existing_rate_limit(self):
        self.pair()
        for _ in range(30):self.send('guest',{'type':'input','seq':1,'mask':0})
        self.assertEqual(len(self.acks('guest')),30)
        self.error(429,lambda:self.send('guest',{'type':'input','seq':1,'mask':0}))
        self.assertEqual(len(self.acks('guest')),30)
        self.assertEqual(len(self.messages('host')),1)


if __name__=='__main__':
    unittest.main()
