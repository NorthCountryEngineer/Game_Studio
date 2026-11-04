"""Synthetic private passphrase admission, lifecycle and transaction checks."""
from copy import deepcopy
import json
import unittest
import secrets
import uuid

import test_multiplayer as existing
from test_nce_api import DynamoResourceTable

relay, support = existing.relay, existing.support
PHRASE = 'Purple comet 27'


class MultiplayerPassphraseTests(unittest.TestCase):
    setUp = existing.MultiplayerTests.setUp
    event = existing.MultiplayerTests.event
    room = existing.MultiplayerTests.room
    error = existing.MultiplayerTests.error
    invitation = existing.MultiplayerTests.invitation
    join = existing.MultiplayerTests.join
    messages = existing.MultiplayerTests.messages
    send = existing.MultiplayerTests.send
    socket_join = existing.MultiplayerTests.socket_join
    mutate_publication = existing.MultiplayerTests.mutate_publication

    def create(self, phrase=PHRASE, **options):
        return relay.dispatch(self.api, self.event(), 'POST', '/multiplayer/rooms', {
            'gameId': support.GAME, 'publishedRevision': 7, 'passphrase': phrase, **options})

    def join_body(self, created, phrase=PHRASE, **options):
        return {'requestId': str(uuid.uuid4()), 'guestToken': secrets.token_urlsafe(32),
            'gameId': created['gameId'], 'publishedRevision': created['publishedRevision'],
            'specSha256': created['specSha256'], 'passphrase': phrase, **options}

    def phrase_join(self, created, phrase=PHRASE, **options):
        return relay.dispatch(self.api, self.event(), 'POST', '/multiplayer/join-by-passphrase', self.join_body(created, phrase, **options))

    def registry(self, game_id=support.GAME):
        return self.database.rows['rooms'][relay.key('passphrases', game_id)]

    def close(self, created):
        return relay.close_room(self.api, created['roomId'], {'hostToken': created['hostToken']})

    def renewable(self, connection, created, token):
        relay.connect(self.api, self.event(connection, '$connect'))
        relay.message(self.api, self.event(connection, body={
            'type': 'join', 'roomId': created['roomId'], 'token': token, 'leaseVersion': 1}))

    def test_phrase_join_preserves_guest_descriptor_and_never_retains_plaintext(self):
        created = self.create()
        guest = self.phrase_join(created, '  PURPLE   COMET 27  ')
        self.assertEqual(guest['roomId'], created['roomId'])
        self.assertEqual(set(guest), {'roomId', 'guestToken', 'expiresAt', 'socketUrl', 'gameId', 'publishedRevision', 'specSha256'})
        self.assertEqual(set(created), {'roomId', 'hostToken', 'inviteToken', 'expiresAt', 'socketUrl', 'gameId', 'publishedRevision', 'specSha256'})
        encoded = json.dumps(self.database.rows)
        for private in (PHRASE, PHRASE.lower(), guest['guestToken'], created['hostToken'], created['inviteToken']):
            self.assertNotIn(private, encoded)
        self.assertEqual(len(self.room(created)['passphraseHash']), 64)
        self.assertEqual(self.registry()['entries'], [{'digest': self.room(created)['passphraseHash'], 'roomId': created['roomId']}])
        self.assertEqual(relay.public_rooms(self.api, self.event(), {}), {'rooms': []})

    def test_phrase_and_invitation_compete_for_the_same_one_guest_seat(self):
        created = self.create(); self.phrase_join(created)
        self.error(403, lambda: self.join(created))
        self.error(403, lambda: self.phrase_join(created))
        other = self.create('Green comet 99'); self.join(other)
        self.error(403, lambda: self.phrase_join(other, 'Green comet 99'))

    def test_invalid_phrases_and_public_phrase_rooms_allocate_nothing(self):
        for phrase in ('short', '------', ' hi\nthere ', 'snow\u2603', 'a' * 49, 'a' * 97, True, 123, None, {}, []):
            with self.subTest(phrase=phrase): self.error(400, lambda: self.create(phrase))
        self.error(400, lambda: self.create(visibility='public'))
        self.assertFalse(self.database.rows['rooms'])

    def test_wrong_phrase_game_edition_and_hash_do_not_claim_or_reveal_a_seat(self):
        created = self.create()
        self.error(403, lambda: self.phrase_join(created, 'Wrong comet 27'))
        self.error(403, lambda: self.phrase_join(created, gameId=support.OTHER))
        self.error(409, lambda: self.phrase_join(created, publishedRevision=8))
        self.error(409, lambda: self.phrase_join(created, specSha256='a' * 64))
        self.assertFalse(self.room(created)['guestHash'])
        for extra in ({'inviteToken': created['inviteToken']}, {'match': {'mode': 'versus', 'lives': 5, 'timeLimit': 180}}, {'roomId': created['roomId']}):
            self.error(400, lambda: self.phrase_join(created, **extra))

    def test_same_phrase_is_game_scoped_and_collision_is_case_space_insensitive(self):
        first = self.create()
        self.error(409, lambda: self.create(' PURPLE   COMET 27 '))
        second_public = {**deepcopy(self.published), 'id': support.OTHER}
        second_key = support.games.key('game', support.OTHER)
        self.database.rows['published-games'][second_key] = {**deepcopy(self.database.rows['published-games'][self.public_key]),
            'id': second_key, 'payload': json.dumps(second_public)}
        second = self.create(gameId=support.OTHER)
        self.assertNotEqual(self.room(first)['passphraseHash'], self.room(second)['passphraseHash'])
        self.assertEqual(self.phrase_join(second)['roomId'], second['roomId'])
        self.assertEqual(self.phrase_join(first)['roomId'], first['roomId'])

    def test_closed_and_expired_rooms_release_phrase_without_retargeting_old_invites(self):
        first = self.create(); self.close(first)
        second = self.create()
        self.error(410, lambda: self.join(first))
        self.assertEqual(self.phrase_join(second)['roomId'], second['roomId'])
        self.now = second['expiresAt']
        third = self.create()
        self.assertEqual(self.registry()['entries'], [{'digest': self.room(third)['passphraseHash'], 'roomId': third['roomId']}])
        self.assertEqual(self.phrase_join(third)['roomId'], third['roomId'])

    def test_host_disconnection_grace_releases_phrase_but_live_host_keeps_it(self):
        first = self.create(); self.renewable('host', first, first['hostToken'])
        self.now += 30; self.send('host', {'type': 'ping'})
        self.error(409, lambda: self.create())
        self.now += relay.HEARTBEAT_SECONDS + relay.DISCONNECT_GRACE
        second = self.create()
        self.assertEqual(self.phrase_join(second)['roomId'], second['roomId'])
        self.error(410, lambda: self.send('host', {'type': 'ping'}))

    def test_two_concurrent_creators_can_never_own_the_same_phrase(self):
        original = self.database.transact; winner = []; raced = False
        def concurrent(TransactItems):
            nonlocal raced
            if not raced and any('Put' in op and ':passphrases:' in op['Put']['Item']['id'] for op in TransactItems):
                raced = True
                winner.append(self.create())
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = concurrent
        self.error(409, self.create)
        self.assertEqual(len(winner), 1)
        self.assertEqual(len([row for row in self.database.rows['rooms'].values() if ':room:' in row['id']]), 1)
        self.assertEqual(self.phrase_join(winner[0])['roomId'], winner[0]['roomId'])

    def test_discarded_room_version_is_fenced_against_concurrent_lease_renewal(self):
        first = self.create(); self.now = first['expiresAt']
        original = self.database.transact; raced = False
        def concurrent(TransactItems):
            nonlocal raced
            if not raced and any('ConditionCheck' in op and op['ConditionCheck'].get('Key', {}).get('id') == relay.key('room', first['roomId']) for op in TransactItems):
                raced = True
                previous = self.room(first)
                self.database.rows['rooms'][previous['id']] = relay.revision(previous, expiresAt=self.now + 1800)
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = concurrent
        self.error(409, self.create)
        self.assertEqual(self.registry()['entries'][0]['roomId'], first['roomId'])
        self.assertEqual(len([row for row in self.database.rows['rooms'].values() if ':room:' in row['id']]), 1)

    def test_native_resource_decimals_and_hours_of_renewals_preserve_phrase_and_match(self):
        original_table = self.database.Table
        self.database.Table = lambda name: DynamoResourceTable(self.database, name) if name == 'rooms' else original_table(name)
        match = {'mode': 'versus', 'lives': 2, 'timeLimit': 30}
        created = self.create(match=match); guest = self.phrase_join(created)
        self.assertEqual(guest['match'], match)
        self.renewable('host', created, created['hostToken'])
        self.renewable('guest', created, guest['guestToken'])
        for _ in range(361):
            self.now += 20
            for connection in ('host', 'guest'): self.send(connection, {'type': 'ping'})
            self.assertGreaterEqual(self.registry()['expiresAt'], self.room(created)['expiresAt'])
        self.assertGreater(self.room(created)['expiresAt'], created['expiresAt'] + 7200)
        self.assertEqual(self.registry()['entries'][0]['roomId'], created['roomId'])
        self.assertEqual(self.messages('guest')[0]['match'], match)

    def test_guess_rate_limits_count_misses_and_have_installation_and_source_bounds(self):
        created = self.create()
        for _ in range(20): self.error(403, lambda: self.phrase_join(created, 'Wrong comet 27'))
        self.error(429, lambda: self.phrase_join(created))
        self.assertFalse(self.room(created)['guestHash'])
        self.now += 60
        self.assertEqual(self.phrase_join(created)['roomId'], created['roomId'])

    def test_installation_guess_limit_also_bounds_distributed_sources(self):
        created = self.create()
        body = {field: created[field] for field in ('gameId', 'publishedRevision', 'specSha256')}
        body.update(passphrase='Wrong comet 27', requestId=str(uuid.uuid4()), guestToken=secrets.token_urlsafe(32))
        for source in range(6):
            for _ in range(20):
                self.error(403, lambda: relay.join_by_passphrase(self.api, self.event(source='203.0.113.' + str(source)), body))
        self.error(429, lambda: relay.join_by_passphrase(self.api, self.event(source='203.0.113.99'), body))
        self.assertFalse(self.room(created)['guestHash'])

    def test_bounded_registry_reclaims_closed_entries_before_capacity_check(self):
        rooms = []
        for index in range(relay.PASSPHRASE_LIMIT):
            if index and index % 6 == 0: self.now += 60
            rooms.append(self.create('Comet number ' + str(index)))
        self.assertEqual(len(self.registry()['entries']), relay.PASSPHRASE_LIMIT)
        self.error(409, lambda: self.create('One more comet'))
        self.close(rooms[0])
        final = self.create('One more comet')
        self.assertEqual(len(self.registry()['entries']), relay.PASSPHRASE_LIMIT)
        self.assertNotIn(rooms[0]['roomId'], [entry['roomId'] for entry in self.registry()['entries']])
        self.assertEqual(self.phrase_join(final, 'One more comet')['roomId'], final['roomId'])

    def test_concurrent_invitation_claim_wins_once_over_phrase_admission(self):
        created = self.create(); original = self.database.transact; winners = []; raced = False
        def concurrent(TransactItems):
            nonlocal raced
            if not raced and any('Put' in op and op['Put']['Item'].get('roomId') == created['roomId']
                    and op['Put']['Item'].get('guestHash') for op in TransactItems):
                raced = True
                winners.append(self.join(created))
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = concurrent
        self.error(403, lambda: self.phrase_join(created))
        self.assertEqual(len(winners), 1)
        self.assertEqual(self.room(created)['guestHash'], relay.digest(winners[0]['guestToken']))
        self.error(403, lambda: self.join(created))

    def test_lost_guest_reply_retries_the_exact_committed_capability(self):
        created = self.create(); body = self.join_body(created)
        original = relay.transaction
        def lost_reply(api, operations):
            committed = original(api, operations)
            if committed and any('Put' in op and op['Put']['Item'].get('guestRequestHash') for op in operations):
                raise RuntimeError('Synthetic response lost after commit')
            return committed
        from unittest.mock import patch
        with patch.object(relay, 'transaction', side_effect=lost_reply):
            with self.assertRaises(RuntimeError): relay.join_by_passphrase(self.api, self.event(), body)
        recovered = relay.join_by_passphrase(self.api, self.event(), {**body, 'passphrase': ' PURPLE   COMET 27 '})
        self.assertEqual(recovered['roomId'], created['roomId'])
        self.assertEqual(recovered['guestToken'], body['guestToken'])
        self.assertEqual(self.room(created)['guestHash'], relay.digest(body['guestToken']))
        self.socket_join('guest-recovered', created, recovered['guestToken'])
        self.assertEqual(self.messages('guest-recovered')[0]['seat'], 1)
        for change in ({'guestToken': secrets.token_urlsafe(32)}, {'passphrase': 'Changed comet'},
                {'publishedRevision': 8}, {'specSha256': 'a' * 64}):
            self.error(409, lambda: relay.join_by_passphrase(self.api, self.event(), {**body, **change}))

    def test_old_guest_retry_never_redirects_to_a_room_reusing_the_phrase(self):
        original = self.create(); body = self.join_body(original)
        relay.join_by_passphrase(self.api, self.event(), body)
        self.close(original)
        replacement = self.create()
        self.error(410, lambda: relay.join_by_passphrase(self.api, self.event(), body))
        self.assertFalse(self.room(replacement)['guestHash'])
        registry = self.registry()
        self.assertEqual(len(registry['receipts']), 1)
        self.assertGreaterEqual(registry['expiresAt'], self.now + relay.PASSPHRASE_RETRY_SECONDS)
        self.database.rows['rooms'].pop(relay.key('room', original['roomId']))
        self.error(410, lambda: relay.join_by_passphrase(self.api, self.event(), body))
        self.assertEqual(self.phrase_join(replacement)['roomId'], replacement['roomId'])

    def test_concurrent_exact_guest_retry_recovers_the_single_committed_seat(self):
        created = self.create(); body = self.join_body(created)
        original = self.database.transact; raced = False; replies = []
        def concurrent(TransactItems):
            nonlocal raced
            if not raced and any('Put' in op and op['Put']['Item'].get('guestRequestHash') for op in TransactItems):
                raced = True
                replies.append(relay.join_by_passphrase(self.api, self.event(), body))
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = concurrent
        recovered = relay.join_by_passphrase(self.api, self.event(), body)
        self.assertEqual(recovered, replies[0])
        self.assertEqual(recovered['guestToken'], body['guestToken'])
        self.assertEqual(len(self.registry()['receipts']), 1)

    def test_bounded_guest_receipts_refuse_new_claims_then_prune_expired_history(self):
        created = self.create()
        self.registry()['receipts'] = {format(index, '064x'): {'roomId': str(uuid.uuid4()),
            'fingerprint': 'a' * 64, 'expiresAt': self.now + 1} for index in range(relay.PASSPHRASE_RECEIPTS)}
        self.error(429, lambda: self.phrase_join(created))
        self.assertFalse(self.room(created)['guestHash'])
        self.now += 2
        self.assertEqual(self.phrase_join(created)['roomId'], created['roomId'])
        self.assertEqual(len(self.registry()['receipts']), 1)

    def test_guest_request_identity_and_capability_are_required_before_storage(self):
        created = self.create(); body = self.join_body(created)
        for field in ('requestId', 'guestToken'):
            invalid = dict(body); del invalid[field]
            self.error(400, lambda: relay.join_by_passphrase(self.api, self.event(), invalid))
        self.error(400, lambda: relay.join_by_passphrase(self.api, self.event(), {**body, 'requestId': 'invalid'}))
        self.error(403, lambda: relay.join_by_passphrase(self.api, self.event(), {**body, 'guestToken': 'invalid'}))
        self.assertFalse(self.room(created)['guestHash'])
        self.assertNotIn('receipts', self.registry())

    def test_supplied_guest_capability_cannot_reuse_the_host_or_invitation(self):
        created = self.create()
        for token in (created['hostToken'], created['inviteToken']):
            self.error(400, lambda: self.phrase_join(created, guestToken=token))
        self.assertFalse(self.room(created)['guestHash'])
        self.assertNotIn('receipts', self.registry())

    def test_lost_host_reply_recovers_same_room_host_and_invitation(self):
        options = {'requestId': str(uuid.uuid4()), 'hostToken': secrets.token_urlsafe(32),
            'match': {'mode': 'versus', 'lives': 2, 'timeLimit': 30}}
        original = relay.transaction; committed_rooms = []
        def lost_reply(api, operations):
            committed = original(api, operations)
            rooms = [op['Put']['Item'] for op in operations if 'Put' in op and op['Put']['Item'].get('createFingerprint')]
            if committed and rooms:
                committed_rooms.extend(rooms)
                raise RuntimeError('Synthetic response lost after commit')
            return committed
        from unittest.mock import patch
        with patch.object(relay, 'transaction', side_effect=lost_reply):
            with self.assertRaises(RuntimeError): self.create(**options)
        recovered = self.create('  PURPLE   COMET 27 ', **options)
        again = self.create(**options)
        self.assertEqual(recovered, again)
        self.assertEqual(recovered['roomId'], committed_rooms[0]['roomId'])
        self.assertEqual(recovered['hostToken'], options['hostToken'])
        self.assertEqual(relay.digest(recovered['inviteToken']), self.room(recovered)['inviteHash'])
        self.assertEqual(len([row for row in self.database.rows['rooms'].values() if ':room:' in row['id']]), 1)
        self.socket_join('recovered-host', recovered, recovered['hostToken'])
        self.assertEqual(self.messages('recovered-host')[0]['seat'], 0)
        self.assertEqual(self.join(recovered)['match'], options['match'])

    def test_host_recovery_rejects_changed_settings_and_closed_original(self):
        options = {'requestId': str(uuid.uuid4()), 'hostToken': secrets.token_urlsafe(32)}
        created = self.create(**options)
        for changes in ({'hostToken': secrets.token_urlsafe(32)}, {'match': {'mode': 'versus', 'lives': 3, 'timeLimit': 120}}):
            self.error(409, lambda: self.create(**{**options, **changes}))
        self.error(409, lambda: self.create('Changed comet', **options))
        self.close(created)
        self.error(410, lambda: self.create(**options))
        self.assertEqual(len([row for row in self.database.rows['rooms'].values() if ':room:' in row['id']]), 1)

    def test_host_recovery_fields_are_paired_and_cannot_change_legacy_create(self):
        for options in ({'requestId': str(uuid.uuid4())}, {'hostToken': secrets.token_urlsafe(32)}):
            self.error(400, lambda: self.create(**options))
        self.error(400, lambda: relay.create_room(self.api, self.event(), {'gameId': support.GAME,
            'publishedRevision': 7, 'requestId': str(uuid.uuid4()), 'hostToken': secrets.token_urlsafe(32)}))
        self.assertFalse(self.database.rows['rooms'])

    def test_publishing_another_edition_invalidates_phrase_admission(self):
        created = self.create()
        self.mutate_publication(lambda value: value.update(revision=8, publishedRevision=8))
        self.error(410, lambda: self.phrase_join(created))
        self.assertTrue(self.room(created)['closed'])
        self.assertFalse(self.room(created)['guestHash'])


if __name__ == '__main__':
    unittest.main()
