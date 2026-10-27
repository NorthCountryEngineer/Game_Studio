"""Synthetic renewable idle leases and opt-in anonymous lobby security checks."""
from copy import deepcopy
import json
import types
import unittest
from unittest.mock import patch
import uuid

import test_multiplayer as existing
from test_nce_api import DynamoResourceTable

relay = existing.relay
support = existing.support


class LobbyLeaseTests(unittest.TestCase):
    setUp = existing.MultiplayerTests.setUp
    event = existing.MultiplayerTests.event
    create = existing.MultiplayerTests.create
    join = existing.MultiplayerTests.join
    invitation = existing.MultiplayerTests.invitation
    room = existing.MultiplayerTests.room
    messages = existing.MultiplayerTests.messages
    error = existing.MultiplayerTests.error
    send = existing.MultiplayerTests.send
    mutate_publication = existing.MultiplayerTests.mutate_publication

    def admit(self, connection, created, token, renewable=True):
        self.assertEqual(relay.websocket_handler(self.api, self.event(connection, '$connect'))['statusCode'], 200)
        body = {'type': 'join', 'roomId': created['roomId'], 'token': token}
        if renewable:
            body['leaseVersion'] = 1
        self.assertEqual(relay.websocket_handler(self.api, self.event(connection, body=body))['statusCode'], 200)

    def public(self, source='203.0.113.8'):
        return relay.dispatch(self.api, self.event(source=source), 'POST', '/multiplayer/rooms',
            {'gameId': support.GAME, 'publishedRevision': 7, 'visibility': 'public'})

    def listing(self):
        return relay.dispatch(self.api, self.event(), 'GET', '/multiplayer/lobby', {})

    def binding(self, created):
        return {key: created[key] for key in ('gameId', 'publishedRevision', 'specSha256')}

    def public_join(self, created, body=None):
        return relay.dispatch(self.api, self.event(), 'POST', '/multiplayer/rooms/' + created['roomId'] + '/lobby-join',
            self.binding(created) if body is None else body)

    def test_active_renewed_room_survives_hours_and_transport_reconnect_without_new_room(self):
        created = self.create(); guest = self.join(created)
        self.admit('host', created, created['hostToken']); self.admit('guest', created, guest['guestToken'])
        original_created_at = self.room(created)['createdAt']
        active_host = 'host'
        for tick in range(1, 601):
            self.now += 20
            for connection in (active_host, 'guest'):
                self.send(connection, {'type': 'ping'})
                self.assertEqual(self.messages(connection)[-2], {'type': 'lease', 'expiresAt': self.now + relay.ROOM_SECONDS})
            if tick == 361:  # Managed transport can rotate after two hours.
                relay.disconnect(self.api, active_host); self.now += 1
                self.admit('host-returned', created, created['hostToken'])
                self.error(403, lambda: self.send('host', {'type': 'ping'}))
                active_host = 'host-returned'
            self.assertFalse(self.room(created)['closed'])
        self.assertGreater(self.now, original_created_at + 3 * 3600)
        self.assertEqual(self.room(created)['createdAt'], original_created_at)
        self.assertGreater(self.room(created)['expiresAt'], created['expiresAt'] + 3 * 3600)
        self.assertEqual(self.database.rows['rooms'][relay.key('connection', 'guest')]['expiresAt'], self.now + relay.ROOM_SECONDS)
        self.assertFalse(any('state' in row or 'players' in row for row in self.database.rows['rooms'].values()))

    def test_legacy_seat_keeps_exact_descriptor_and_never_receives_new_frames_or_renews(self):
        created = self.create(); guest = self.join(created)
        self.admit('host', created, created['hostToken'], renewable=False)
        self.admit('guest', created, guest['guestToken'])
        self.now += 20; self.send('guest', {'type': 'ping'})
        extended = self.room(created)['expiresAt']; self.assertGreater(extended, created['expiresAt'])
        self.callback.reset_mock(); self.send('host', {'type': 'ping'})
        self.assertEqual(self.messages('host'), [{'type': 'pong'}, {'type': 'peer', 'connected': True}])
        self.assertEqual(self.room(created)['expiresAt'], extended)
        relay.disconnect(self.api, 'host'); self.now += 1
        self.admit('host-returned', created, created['hostToken'], renewable=False)
        self.assertEqual(self.messages('host-returned')[0]['expiresAt'], created['expiresAt'])
        self.assertFalse(any(message['type'] == 'lease' for message in self.messages('host-returned')))
        self.assertEqual(self.database.rows['rooms'][relay.key('connection', 'host-returned')]['expiresAt'], created['expiresAt'])

    def test_legacy_existing_record_captures_original_expiry_before_new_seat_renews(self):
        created = self.create(); guest = self.join(created)
        self.room(created).pop('legacyExpiresAt0'); self.room(created).pop('legacyExpiresAt1')
        self.admit('host', created, created['hostToken'], renewable=False)
        self.now += 10; self.admit('guest', created, guest['guestToken'])
        self.assertGreater(self.room(created)['expiresAt'], created['expiresAt'])
        self.assertEqual(self.room(created)['legacyExpiresAt0'], created['expiresAt'])
        relay.disconnect(self.api, 'host'); self.admit('host-returned', created, created['hostToken'], renewable=False)
        self.assertEqual(self.messages('host-returned')[0]['expiresAt'], created['expiresAt'])

    def test_idle_expiry_is_logical_and_guest_activity_cannot_resurrect_absent_host(self):
        created = self.create(); guest = self.join(created)
        self.admit('host', created, created['hostToken']); self.admit('guest', created, guest['guestToken'])
        for _ in range(3):
            self.now += 30; self.send('guest', {'type': 'ping'})
        self.now += 16
        self.error(410, lambda: self.send('guest', {'type': 'ping'}))
        self.assertEqual(self.room(created)['closedReason'], 'host-disconnected')
        untouched = self.create(); self.now = untouched['expiresAt']
        self.error(410, lambda: relay.active_room(self.api, untouched['roomId']))
        self.assertIn(relay.key('room', untouched['roomId']), self.database.rows['rooms'])
        self.assertEqual(self.room(untouched)['closedReason'], 'expired')

    def test_renewal_is_atomic_with_publication_and_stale_generation_cannot_extend(self):
        created = self.create(); self.admit('host', created, created['hostToken'])
        self.now += 10; self.admit('replacement', created, created['hostToken'])
        before = self.room(created)['expiresAt']; self.now += 10
        self.error(403, lambda: self.send('host', {'type': 'ping'})); self.assertEqual(self.room(created)['expiresAt'], before)
        original = self.database.transact; raced = False
        def transaction(TransactItems):
            nonlocal raced
            if not raced and any('Put' in operation and ':room:' in operation['Put']['Item']['id'] for operation in TransactItems):
                raced = True; self.mutate_publication(lambda value: value.update(revision=8, publishedRevision=8))
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transaction
        self.error(410, lambda: self.send('replacement', {'type': 'ping'}))
        self.assertEqual(self.room(created)['expiresAt'], before)
        self.assertEqual(self.room(created)['closedReason'], 'publication-changed')

    def test_lease_opt_in_is_exact_and_ready_precedes_lease(self):
        created = self.create()
        for value in (True, False, 0, 2, '1', None, [], {}):
            connection = 'pending-' + str(uuid.uuid4())
            relay.connect(self.api, self.event(connection, '$connect'))
            self.error(400, lambda: self.send(connection, {'type': 'join', 'roomId': created['roomId'], 'token': created['hostToken'], 'leaseVersion': value}))
        self.admit('valid', created, created['hostToken'])
        self.assertEqual([value['type'] for value in self.messages('valid')[:2]], ['ready', 'lease'])
        self.now += 20; self.send('valid', {'type': 'ping'}); expiry = self.room(created)['expiresAt']
        self.send('valid', {'type': 'ping'}); self.assertEqual(self.messages('valid')[-2], {'type': 'lease', 'expiresAt': expiry})

    def test_lobby_is_explicit_opt_in_and_lists_only_safe_publication_bound_fields(self):
        private = self.create(); self.admit('private-host', private, private['hostToken'])
        created = self.public(); self.assertEqual(self.listing(), {'rooms': []})
        self.admit('public-host', created, created['hostToken'])
        before = self.room(created)['expiresAt']; self.now += 1
        value = self.listing(); self.assertEqual(set(value), {'rooms'}); self.assertEqual(len(value['rooms']), 1)
        self.assertEqual(value['rooms'][0], {'roomId': created['roomId'], **self.binding(created), 'title': self.spec['title'], 'expiresAt': before})
        self.assertEqual(self.room(created)['expiresAt'], before, 'public polling cannot renew a room')
        encoded = json.dumps(value)
        for secret in (created['hostToken'], created['inviteToken'], private['roomId'], support.USER, support.ORG):
            self.assertNotIn(secret, encoded)
        guest = self.public_join(created); self.assertRegex(guest['guestToken'], relay.TOKEN)
        self.assertEqual(self.listing(), {'rooms': []}); self.assertEqual(self.room(created)['inviteHash'], '')
        self.error(409, lambda: self.public_join(created)); self.error(403, lambda: self.join(created))

    def test_visibility_and_lobby_join_contract_reject_unknown_data_and_private_room_claims(self):
        for value in (True, 0, [], {}, None, 'PUBLIC', ''):
            self.error(400, lambda: relay.create_room(self.api, self.event(), {'gameId': support.GAME, 'publishedRevision': 7, 'visibility': value}))
        private = self.create(); self.admit('private-host', private, private['hostToken'])
        self.error(409, lambda: self.public_join(private)); self.assertFalse(self.room(private)['guestHash'])
        created = self.public(); self.admit('host', created, created['hostToken'])
        for patch in ({'gameId': support.OTHER}, {'publishedRevision': 8}, {'specSha256': 'a' * 64}):
            self.error(409, lambda: self.public_join(created, {**self.binding(created), **patch}))
            self.assertFalse(self.room(created)['guestHash'])
        self.error(400, lambda: self.public_join(created, {**self.binding(created), 'inviteToken': created['inviteToken']}))
        self.error(400, lambda: relay.public_rooms(self.api, self.event(), {'identity': support.USER}))

    def test_listing_filters_absent_stale_closed_claimed_foreign_and_changed_publications(self):
        created = self.public(); self.admit('host', created, created['hostToken'])
        room = deepcopy(self.room(created)); connection = deepcopy(self.database.rows['rooms'][relay.key('connection', 'host')])
        public = deepcopy(self.database.rows['published-games'][self.public_key])
        for mutation in (lambda row: row.update(closed=True), lambda row: row.update(visibility='private'),
                lambda row: row.update(guestHash='a' * 64), lambda row: row.update(connection0=''),
                lambda row: row.update(expiresAt=self.now), lambda row: row.update(generation0='different')):
            self.database.rows['rooms'][room['id']] = deepcopy(room); mutation(self.room(created))
            self.assertEqual(self.listing(), {'rooms': []})
        self.database.rows['rooms'][room['id']] = deepcopy(room)
        self.database.rows['rooms'][connection['id']]['lastSeen'] = self.now - relay.HEARTBEAT_SECONDS
        self.assertEqual(self.listing(), {'rooms': []})
        self.database.rows['rooms'][connection['id']] = connection
        self.mutate_publication(lambda value: value.update(revision=8, publishedRevision=8))
        self.assertEqual(self.listing(), {'rooms': []})
        self.database.rows['published-games'][self.public_key] = public
        self.room(created)['service_id'] = support.OTHER
        self.error(404, self.listing)

    def test_two_public_rooms_have_distinct_returned_ids_and_registry_cap_prunes_unadmitted_startup(self):
        rooms = [self.public(source='203.0.113.' + str(index + 1)) for index in range(relay.LOBBY_LIMIT)]
        self.assertEqual(len({value['roomId'] for value in rooms}), relay.LOBBY_LIMIT)
        self.assertTrue(all(self.room(value)['roomId'] == value['roomId'] for value in rooms))
        self.error(409, lambda: self.public(source='203.0.113.99'))
        self.now += relay.PENDING_SECONDS + 1
        fresh = self.public(source='203.0.113.99')
        self.assertEqual(relay.lobby_registry(self.api)['roomIds'], [fresh['roomId']])
        self.assertIn(relay.key('room', rooms[0]['roomId']), self.database.rows['rooms'], 'pruning listing never deletes a room capability')

    def test_public_waiting_lease_renews_registry_ttl_and_full_relist_never_revokes_host(self):
        waiting = self.public(); self.admit('waiting-host', waiting, waiting['hostToken'])
        for _ in range(100):
            self.now += 20; self.send('waiting-host', {'type': 'ping'})
        self.assertGreater(relay.lobby_registry(self.api)['expiresAt'], waiting['expiresAt'])
        self.assertEqual(self.listing()['rooms'][0]['expiresAt'], self.now + relay.ROOM_SECONDS)
        # A previously pruned room can return after the discovery registry fills.
        registry = self.database.rows['rooms'][relay.key('lobby', 'waiting')]
        registry.update(roomIds=[], version=registry['version'] + 1)
        for index in range(relay.LOBBY_LIMIT):
            self.public(source='198.51.100.' + str(index + 1))
        old_expiry = self.room(waiting)['expiresAt']; self.now += 1
        self.send('waiting-host', {'type': 'ping'})
        self.assertGreater(self.room(waiting)['expiresAt'], old_expiry); self.assertFalse(self.room(waiting)['closed'])
        self.assertEqual(len(relay.lobby_registry(self.api)['roomIds']), relay.LOBBY_LIMIT)

    def test_public_and_invitation_claim_race_cannot_overwrite_winner(self):
        created = self.public(); self.admit('host', created, created['hostToken'])
        original = self.database.transact; raced = False; winner = []
        def transaction(TransactItems):
            nonlocal raced
            claiming = any('Put' in operation and ':room:' in operation['Put']['Item']['id'] and operation['Put']['Item'].get('guestHash') for operation in TransactItems)
            if claiming and not raced:
                raced = True
                winner.append(self.join(created))
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transaction
        self.error(409, lambda: self.public_join(created))
        self.assertEqual(self.room(created)['guestHash'], relay.digest(winner[0]['guestToken']))
        self.assertEqual(relay.lobby_registry(self.api)['roomIds'], [])
        self.assertEqual(self.listing(), {'rooms': []})

    def test_public_creation_registry_race_preserves_both_rooms_and_publication_race_refuses_claim(self):
        original = self.database.transact; raced = False; concurrent = []
        def transaction(TransactItems):
            nonlocal raced
            if not raced and any('Put' in operation and ':lobby:' in operation['Put']['Item']['id'] for operation in TransactItems):
                raced = True; concurrent.append(self.public(source='192.0.2.9'))
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transaction
        created = self.public()
        self.assertEqual(set(relay.lobby_registry(self.api)['roomIds']), {created['roomId'], concurrent[0]['roomId']})
        self.database.meta.client.transact_write_items.side_effect = original
        self.admit('host', created, created['hostToken']); raced = False
        def publication_race(TransactItems):
            nonlocal raced
            if not raced and any('Put' in operation and ':room:' in operation['Put']['Item']['id'] and operation['Put']['Item'].get('guestHash') for operation in TransactItems):
                raced = True; self.mutate_publication(lambda value: value.update(revision=8, publishedRevision=8))
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = publication_race
        self.error(410, lambda: self.public_join(created)); self.assertFalse(self.room(created)['guestHash'])

    def test_public_http_entrypoint_is_anonymous_same_origin_no_store_and_has_bounded_rates(self):
        created = self.public(); self.admit('host', created, created['hostToken'])
        with patch.object(relay, '_database', self.database), patch.object(relay, '_callback', self.callback):
            event = self.event(); event.update(rawPath='/multiplayer/lobby'); event['requestContext']['http']['method'] = 'GET'
            response = relay.handler(event, None)
            self.assertEqual(response['statusCode'], 200); self.assertEqual(len(json.loads(response['body'])['rooms']), 1)
            self.assertEqual(response['headers']['Cache-Control'], 'no-store')
            event['headers']['origin'] = 'https://foreign.example'; self.assertEqual(relay.handler(event, None)['statusCode'], 403)
        for _ in range(29):self.listing()
        self.error(429, self.listing)
        self.now += 60
        self.assertEqual(len(self.listing()['rooms']), 0, 'expired host heartbeat never appears live')

    def test_lobby_uses_only_bounded_key_reads_and_transactions_with_decimal_resource_values(self):
        self.database.table_class = DynamoResourceTable
        with patch.object(DynamoResourceTable, 'scan', side_effect=AssertionError('No table scans')):
            created = self.public(); self.admit('host', created, created['hostToken'])
            self.now += 15; self.send('host', {'type': 'ping'})
            self.assertEqual(len(self.listing()['rooms']), 1)
            guest = self.public_join(created); self.assertRegex(guest['guestToken'], relay.TOKEN)
        for call in self.database.meta.client.transact_write_items.call_args_list:
            self.assertLessEqual(len(call.kwargs['TransactItems']), 4)
            for operation in call.kwargs['TransactItems']:
                if 'Put' in operation:self.assertEqual(operation['Put']['TableName'], 'rooms')

    def test_abandoned_public_reservation_expires_can_be_replaced_and_old_token_never_admits(self):
        created = self.public(); self.admit('host', created, created['hostToken'])
        first = self.public_join(created); claimed_at = self.now
        room = self.room(created)
        self.assertFalse(room['guestAdmitted']); self.assertEqual(room['guestClaimedAt'], claimed_at)
        self.assertEqual(room['guestReservationExpiresAt'], claimed_at + relay.PENDING_SECONDS)
        self.assertEqual(relay.lobby_registry(self.api)['roomIds'], [created['roomId']])
        self.now += relay.PENDING_SECONDS - 1; self.send('host', {'type': 'ping'})
        self.assertEqual(self.listing(), {'rooms': []}); self.error(409, lambda: self.public_join(created))
        self.now += 1
        self.assertEqual(self.listing()['rooms'][0]['roomId'], created['roomId'])
        relay.connect(self.api, self.event('expired-guest', '$connect'))
        self.error(410, lambda: self.send('expired-guest', {'type': 'join', 'roomId': created['roomId'], 'token': first['guestToken'], 'leaseVersion': 1}))
        second = self.public_join(created)
        self.assertNotEqual(first['guestToken'], second['guestToken'])
        self.assertEqual(self.room(created)['guestClaimedAt'], self.now)
        self.assertEqual(self.room(created)['legacyExpiresAt1'], second['expiresAt'])
        relay.connect(self.api, self.event('replaced-guest', '$connect'))
        self.error(403, lambda: self.send('replaced-guest', {'type': 'join', 'roomId': created['roomId'], 'token': first['guestToken'], 'leaseVersion': 1}))
        self.admit('current-guest', created, second['guestToken'])
        self.assertTrue(self.room(created)['guestAdmitted']); self.assertEqual(relay.lobby_registry(self.api)['roomIds'], [])

    def test_admitted_public_guest_is_never_reopened_after_disconnect_or_reservation_timer(self):
        created = self.public(); self.admit('host', created, created['hostToken'])
        guest = self.public_join(created); self.admit('guest', created, guest['guestToken'])
        relay.disconnect(self.api, 'guest')
        for _ in range(8):
            self.now += 20; self.send('host', {'type': 'ping'})
            self.assertEqual(self.listing(), {'rooms': []})
            self.error(409, lambda: self.public_join(created))
        self.admit('guest-returned', created, guest['guestToken'])
        self.assertTrue(self.room(created)['guestAdmitted']); self.assertEqual(self.room(created)['connection1'], 'guest-returned')
        self.error(403, lambda: self.send('guest', {'type': 'ping'}))

    def test_expired_pending_replacement_loses_to_concurrent_first_admission_and_registry_preserves_pending(self):
        created = self.public(); self.admit('host', created, created['hostToken'])
        guest = self.public_join(created)
        # A later public creation must retain the pending claim's registry entry.
        second_room = self.public(source='192.0.2.10')
        self.assertEqual(set(relay.lobby_registry(self.api)['roomIds']), {created['roomId'], second_room['roomId']})
        self.now += relay.PENDING_SECONDS; self.send('host', {'type': 'ping'})
        original = self.database.transact; raced = False
        def transaction(TransactItems):
            nonlocal raced
            if not raced and any('Put' in operation and ':room:' in operation['Put']['Item']['id'] and operation['Put']['Item'].get('guestHash') for operation in TransactItems):
                raced = True
                # Complete a real admission with the immediately preceding
                # request timestamp, before this replacement can commit its CAS.
                with patch.object(relay.time, 'time', return_value=self.now - 1):
                    self.admit('winning-guest', created, guest['guestToken'])
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = transaction
        self.error(409, lambda: self.public_join(created))
        self.assertEqual(self.room(created)['guestHash'], relay.digest(guest['guestToken']))
        self.assertTrue(self.room(created)['guestAdmitted'])

    def test_private_invitation_guest_claims_do_not_acquire_public_reservation_expiry(self):
        created = self.public(); self.admit('host', created, created['hostToken'])
        guest = self.join(created)
        self.assertEqual(self.room(created)['guestReservationExpiresAt'], 0)
        for _ in range(4):
            self.now += 20; self.send('host', {'type': 'ping'})
        self.assertEqual(self.listing(), {'rooms': []}); self.error(409, lambda: self.public_join(created))
        self.admit('invited-guest', created, guest['guestToken'])
        self.assertTrue(self.room(created)['guestAdmitted'])


if __name__ == '__main__':
    unittest.main()
