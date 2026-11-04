"""Passphrase admission through real adapters and synthetic transactional storage."""
from copy import deepcopy
from decimal import Decimal
import json
import socket
import types
import unittest
from unittest.mock import patch

import test_games as support
import test_mafia_api as mafia_support
import test_party_api as party_support
from test_nce_api import ConditionalFailure


class RoomPassphraseTests(unittest.TestCase):
    authorize = support.GameTests.authorize
    event = support.GameTests.event
    write_registry = support.GameTests.write_registry

    def setUp(self):
        support.GameTests.setUp(self)
        self.database.meta.client.exceptions = types.SimpleNamespace(TransactionCanceledException=ConditionalFailure)
        self.clock = 1000000
        self.adapters = (mafia_support.mafia, party_support.party)
        for adapter in self.adapters:
            timer = patch.object(adapter.time, 'time', side_effect=lambda: self.clock)
            timer.start(); self.addCleanup(timer.stop)
            pause = patch.object(adapter, 'pause'); pause.start(); self.addCleanup(pause.stop)
        for name in ('socket', 'create_connection'):
            blocked = patch.object(socket, name, side_effect=AssertionError('Network is disabled in offline tests.'))
            blocked.start(); self.addCleanup(blocked.stop)
        self.counter = 0

    def prefix(self, adapter):
        return 'mafia' if adapter is mafia_support.mafia else 'party'

    def event_for(self, session=None, ip='192.0.2.5'):
        return {'requestContext': {'http': {'sourceIp': ip}},
            'headers': {'authorization': 'Bearer ' + session['token']} if session else {}}

    def create_body(self, adapter, phrase='Purple Comet', kind='trivia', **values):
        self.counter += 1
        body = {'requestId': party_support.uuid(self.counter), 'name': 'Host', 'avatar': 'fox',
            'playerToken': party_support.capability('host-' + str(self.counter)),
            'inviteToken': party_support.capability('invite-' + str(self.counter)), **values}
        if phrase is not None: body['passphrase'] = phrase
        if self.prefix(adapter) == 'party': body['kind'] = kind
        return body

    def create(self, adapter, body=None, **values):
        return adapter.dispatch(self.api, self.event_for(), 'POST', '/' + self.prefix(adapter) + '/rooms', body or self.create_body(adapter, **values))

    def join_body(self, adapter, phrase='purple comet', kind='trivia', **values):
        self.counter += 1
        body = {'requestId': party_support.uuid(100 + self.counter), 'name': 'Player ' + str(self.counter),
            'avatar': 'robot', 'playerToken': party_support.capability('guest-' + str(self.counter)),
            'passphrase': phrase, **values}
        if self.prefix(adapter) == 'party': body['kind'] = kind
        return body

    def join(self, adapter, body=None, **values):
        return adapter.dispatch(self.api, self.event_for(), 'POST', '/' + self.prefix(adapter) + '/join-by-passphrase', body or self.join_body(adapter, **values))

    def state(self, adapter, room_id):
        return json.loads(self.database.rows['published-games'][adapter.key('game-' + self.prefix(adapter) + '-room', room_id)]['payload'])

    def index(self, adapter):
        return json.loads(self.database.rows['published-games'][adapter.key('game-' + self.prefix(adapter) + '-index')]['payload'])

    def error(self, adapter, status, action):
        with self.assertRaises(adapter.MafiaError if self.prefix(adapter) == 'mafia' else adapter.PartyError) as caught:
            action()
        self.assertEqual(caught.exception.status, status)
        return caught.exception.message

    def action(self, adapter, session, action, **values):
        path = '/' + self.prefix(adapter) + '/rooms/' + session['roomId']
        current = adapter.dispatch(self.api, self.event_for(session), 'GET', path, {})['room']
        self.counter += 1
        body = {'requestId': party_support.uuid(1000 + self.counter), 'phaseId': current['phaseId'],
            'sequence': current['self']['actionSequence'] + 1, 'type': action, **values}
        return adapter.dispatch(self.api, self.event_for(session), 'POST', path + '/actions', body)

    def test_normalization_and_scope_are_predictable_and_strict(self):
        helper = self.adapters[0].passphrases()
        self.assertEqual(helper.normalize('  Purple   Comet-7 '), 'purple comet-7')
        self.assertEqual(helper.digest('mafia', 'Purple  Comet'), helper.digest('mafia', ' purple comet '))
        self.assertNotEqual(helper.digest('mafia', 'purple comet'), helper.digest('trivia', 'purple comet'))
        for phrase in ('', 'short', '------', 'x' * 49, ' ' * 97, 'abc\n123', 'abc\t123', 'éclairs', 'a/bcd5', None, True, ['purple comet']):
            with self.subTest(phrase=phrase), self.assertRaises(helper.PassphraseError): helper.normalize(phrase)
        self.assertEqual(helper.normalize('x' * 48), 'x' * 48)

    def test_all_six_game_kinds_admit_by_phrase_without_exposing_it(self):
        cases = [(self.adapters[0], 'mafia')] + [(self.adapters[1], game['id']) for game in self.adapters[1].engine().catalog() if game['id'] != 'mafia']
        for adapter, kind in cases:
            with self.subTest(kind=kind):
                created = self.create(adapter, kind=kind)
                joined = self.join(adapter, kind=kind)
                self.assertEqual(joined['room']['roomId'], created['room']['roomId'])
                self.assertNotEqual(joined['session']['token'], created['session']['token'])
                self.assertTrue(joined['room']['passphraseEnabled'])
                self.assertEqual(len(self.state(adapter, created['room']['roomId'])['members']), 2)
                wire = json.dumps(joined)
                for secret in ('purple comet', 'Purple Comet', 'passphraseHash', 'inviteHash', 'tokenHash', 'members'):
                    self.assertNotIn(secret, wire)
        saved = json.dumps(self.database.rows)
        for secret in ('purple comet', 'Purple Comet', '192.0.2.5'):
            self.assertNotIn(secret, saved)
        self.authorization.assert_not_called(); self.provider.converse.assert_not_called()

    def test_collision_is_scoped_to_same_game_and_existing_room_is_preserved(self):
        for adapter in self.adapters:
            first = self.create(adapter)
            saved = deepcopy(self.database.rows)
            self.error(adapter, 409, lambda: self.create(adapter))
            self.assertEqual(saved, self.database.rows)
            self.assertEqual(self.join(adapter)['room']['roomId'], first['room']['roomId'])
        other = self.create(self.adapters[1], kind='drop-four')
        self.assertEqual(self.join(self.adapters[1], kind='drop-four')['room']['roomId'], other['room']['roomId'])

    def test_create_idempotency_binds_normalized_phrase_and_different_phrase_conflicts(self):
        for adapter in self.adapters:
            body = self.create_body(adapter)
            first = self.create(adapter, body)
            saved = deepcopy(self.database.rows)
            self.assertEqual(self.create(adapter, {**body, 'passphrase': ' purple  COMET '})['session'], first['session'])
            self.assertEqual(saved, self.database.rows)
            self.error(adapter, 409, lambda: self.create(adapter, {**body, 'passphrase': 'orange comet'}))

    def test_wrong_game_wrong_phrase_full_and_started_have_same_unavailable_result(self):
        adapter = self.adapters[1]
        created = self.create(adapter, kind='hand-duel')
        wrong = self.error(adapter, 404, lambda: self.join(adapter, kind='hand-duel', phrase='wrong comet'))
        self.assertEqual(self.error(adapter, 404, lambda: self.join(adapter, kind='drop-four')), wrong)
        self.join(adapter, kind='hand-duel')
        self.assertEqual(self.error(adapter, 404, lambda: self.join(adapter, kind='hand-duel')), wrong)
        self.action(adapter, created['session'], 'start')
        self.assertEqual(self.error(adapter, 404, lambda: self.join(adapter, kind='hand-duel')), wrong)

    def test_exact_join_retry_keeps_own_seat_after_start_and_changed_request_conflicts(self):
        for adapter in self.adapters:
            host = self.create(adapter)
            body = self.join_body(adapter)
            first = self.join(adapter, body)
            if self.prefix(adapter) == 'mafia': self.action(adapter, host['session'], 'fill-ai')
            self.action(adapter, host['session'], 'start')
            self.assertEqual(self.join(adapter, {**body, 'passphrase': ' Purple   COMET '})['session'], first['session'])
            self.assertEqual(len(self.state(adapter, host['room']['roomId'])['members']), 2)
            self.error(adapter, 409, lambda: self.join(adapter, {**body, 'name': 'Changed name'}))
            self.error(adapter, 404, lambda: self.join(adapter))

    def test_closed_and_expired_phrases_can_be_reused_without_redirecting_old_guests(self):
        for adapter in self.adapters:
            host = self.create(adapter)
            self.action(adapter, host['session'], 'close')
            self.assertEqual(self.index(adapter)['passphrases'], {})
            self.error(adapter, 404, lambda: self.join(adapter))
            replacement = self.create(adapter)
            self.assertNotEqual(replacement['room']['roomId'], host['room']['roomId'])
            self.assertEqual(self.join(adapter)['room']['roomId'], replacement['room']['roomId'])
            self.clock += adapter.ROOM_SECONDS + 1
            self.error(adapter, 404, lambda: self.join(adapter))
            newest = self.create(adapter)
            self.assertNotEqual(newest['room']['roomId'], replacement['room']['roomId'])
            self.assertEqual(len(self.index(adapter)['passphrases']), 1)

    def test_original_join_retry_never_enters_replacement_room(self):
        for adapter in self.adapters:
            host = self.create(adapter)
            body = self.join_body(adapter)
            original = self.join(adapter, body)
            self.action(adapter, host['session'], 'close')
            replacement = self.create(adapter)
            resumed = self.join(adapter, body)
            self.assertEqual(resumed['room']['roomId'], original['room']['roomId'])
            self.assertEqual(resumed['room']['phase'], 'closed')
            self.clock += 61
            self.error(adapter, 404, lambda: self.join(adapter, body))
            self.assertEqual(len(self.state(adapter, replacement['room']['roomId'])['members']), 1)
            self.assertNotEqual(original['room']['roomId'], replacement['room']['roomId'])

    def test_finished_then_closed_room_releases_its_passphrase_immediately(self):
        adapter = self.adapters[1]
        host = self.create(adapter, kind='hand-duel')
        guest = self.join(adapter, kind='hand-duel')
        self.action(adapter, host['session'], 'start')
        for number in range(3):
            self.action(adapter, host['session'], 'choose', choice='rock')
            result = self.action(adapter, guest['session'], 'choose', choice='scissors')
            if number < 2: self.action(adapter, host['session'], 'advance')
        self.assertEqual(result['room']['status'], 'finished')
        self.assertTrue(self.state(adapter, host['room']['roomId'])['retiring'])
        self.action(adapter, host['session'], 'close')
        self.assertEqual(self.index(adapter)['passphrases'], {})
        saved = deepcopy(self.database.rows)
        adapter.room_request(self.api, self.event_for(host['session']), host['room']['roomId'])
        self.assertEqual(self.database.rows, saved)
        replacement = self.create(adapter, kind='hand-duel')
        self.assertNotEqual(replacement['room']['roomId'], host['room']['roomId'])

    def test_successful_receipts_mirror_active_leases_and_do_not_shrink_on_close(self):
        for adapter in self.adapters:
            host = self.create(adapter)
            self.join(adapter)
            receipt = next(iter(self.index(adapter)['passphraseAdmissions'].values()))
            initial = receipt['expiresAt']
            self.clock += adapter.ROOM_SECONDS // 2 + 1
            adapter.room_request(self.api, self.event_for(host['session']), host['room']['roomId'])
            renewed = next(iter(self.index(adapter)['passphraseAdmissions'].values()))['expiresAt']
            self.assertGreater(renewed, initial)
            self.action(adapter, host['session'], 'close')
            self.assertEqual(next(iter(self.index(adapter)['passphraseAdmissions'].values()))['expiresAt'], renewed)

    def test_full_room_does_not_reserve_new_receipt_and_changed_token_cannot_retarget(self):
        adapter = self.adapters[1]
        host = self.create(adapter, kind='hand-duel')
        body = self.join_body(adapter, kind='hand-duel')
        self.join(adapter, body)
        self.error(adapter, 404, lambda: self.join(adapter, kind='hand-duel'))
        self.assertEqual(len(self.index(adapter)['passphraseAdmissions']), 1)
        self.action(adapter, host['session'], 'close')
        replacement = self.create(adapter, kind='hand-duel')
        changed = {**body, 'playerToken': party_support.capability('replacement-token')}
        self.error(adapter, 409, lambda: self.join(adapter, changed))
        self.assertEqual(len(self.state(adapter, replacement['room']['roomId'])['members']), 1)

    def test_receipt_capacity_is_byte_bounded_and_expired_receipts_are_reclaimed(self):
        for adapter in self.adapters:
            host = self.create(adapter)
            index = self.index(adapter)
            index['passphraseAdmissions'] = {adapter.digest('request-' + str(number)): {
                'roomId': host['room']['roomId'], 'fingerprint': adapter.digest('body-' + str(number)),
                'expiresAt': self.clock + adapter.ROOM_SECONDS} for number in range(adapter.passphrases().MAX_ADMISSIONS)}
            self.assertLess(len(adapter.canonical(index).encode()), 250000)
            row = self.database.rows['published-games'][adapter.key('game-' + self.prefix(adapter) + '-index')]
            row['payload'] = adapter.canonical(index)
            self.error(adapter, 429, lambda: self.join(adapter))
            self.assertEqual(len(self.state(adapter, host['room']['roomId'])['members']), 1)
            self.clock += adapter.ROOM_SECONDS + 1
            replacement = self.create(adapter)
            self.assertEqual(self.join(adapter)['room']['roomId'], replacement['room']['roomId'])
            self.assertEqual(len(self.index(adapter)['passphraseAdmissions']), 1)

    def test_legacy_invitation_rooms_and_invitation_join_remain_compatible(self):
        for adapter in self.adapters:
            legacy = self.create(adapter, phrase=None)
            self.assertNotIn('passphraseEnabled', legacy['room'])
            self.error(adapter, 404, lambda: self.join(adapter))
            body = self.create_body(adapter)
            created = self.create(adapter, body)
            guest = self.join_body(adapter)
            del guest['passphrase']; guest.pop('kind', None)
            guest['inviteToken'] = body['inviteToken']
            joined = adapter.join(self.api, created['room']['roomId'], guest)
            self.assertEqual(joined['room']['roomId'], created['room']['roomId'])

    def test_invalid_phrases_are_rejected_without_any_storage_write(self):
        for adapter in self.adapters:
            saved = deepcopy(self.database.rows)
            for phrase in ('short', 'x' * 49, 'bad\nphrase', None, 123):
                body = self.create_body(adapter); body['passphrase'] = phrase
                self.error(adapter, 400, lambda: self.create(adapter, body))
                self.error(adapter, 400, lambda: self.join(adapter, self.join_body(adapter, phrase=phrase)))
            self.assertEqual(saved, self.database.rows)

    def test_guesses_consume_bounded_source_rate_even_when_no_room_exists(self):
        for adapter in self.adapters:
            with patch.object(adapter.passphrases(), 'SOURCE_ATTEMPTS', 3):
                for _ in range(3): self.error(adapter, 404, lambda: self.join(adapter))
                self.error(adapter, 429, lambda: self.join(adapter))
                rate = self.index(adapter)['passphraseRate']
                self.assertEqual(rate['count'], 3); self.assertEqual(len(rate['sources']), 1)
                self.clock += 60
                self.error(adapter, 404, lambda: self.join(adapter))
                self.assertEqual(self.index(adapter)['passphraseRate']['count'], 1)

    def test_installation_attempt_limit_and_source_inventory_are_bounded(self):
        for adapter in self.adapters:
            with patch.object(adapter.passphrases(), 'INSTALLATION_ATTEMPTS', 2):
                for source in range(2):
                    body = self.join_body(adapter)
                    self.error(adapter, 404, lambda: adapter.join_by_passphrase(self.api, self.event_for(ip='192.0.2.' + str(source)), body))
                self.error(adapter, 429, lambda: adapter.join_by_passphrase(self.api, self.event_for(ip='192.0.2.100'), self.join_body(adapter)))
                self.assertEqual(self.index(adapter)['passphraseRate']['count'], 2)
            self.clock += 60
            with patch.object(adapter.passphrases(), 'MAX_SOURCES', 2):
                for source in range(2):
                    body = self.join_body(adapter)
                    self.error(adapter, 404, lambda: adapter.join_by_passphrase(self.api, self.event_for(ip='192.0.2.' + str(source)), body))
                self.error(adapter, 429, lambda: adapter.join_by_passphrase(self.api, self.event_for(ip='192.0.2.100'), self.join_body(adapter)))
                self.assertEqual(len(self.index(adapter)['passphraseRate']['sources']), 2)

    def test_wrong_kind_and_missing_fields_fail_before_admission(self):
        adapter = self.adapters[1]
        for kind in ('mafia', 'unknown', None, [], {}):
            body = self.join_body(adapter, kind=kind)
            self.error(adapter, 400, lambda: self.join(adapter, body))
        for adapter in self.adapters:
            body = self.join_body(adapter)
            del body['playerToken']
            self.error(adapter, 400, lambda: self.join(adapter, body))
        self.assertFalse(self.database.rows['published-games'])

    def test_http_entry_routes_remain_anonymous_and_no_store(self):
        with patch.object(support.handler, 'clients', return_value=(self.database, None, None)), \
                patch.object(support.handler, '_mafia', self.adapters[0]), \
                patch.object(support.handler, '_party', self.adapters[1]), \
                patch.object(support.handler, 'authorize', side_effect=AssertionError('No login is needed.')):
            for adapter in self.adapters:
                created = self.create(adapter)
                event = self.event_for()
                event['requestContext']['http']['method'] = 'POST'
                event.update(rawPath='/' + self.prefix(adapter) + '/join-by-passphrase', body=json.dumps(self.join_body(adapter)))
                response = support.handler.handler(event, None)
                self.assertEqual(response['statusCode'], 200)
                self.assertEqual(response['headers']['Cache-Control'], 'no-store')
                self.assertEqual(json.loads(response['body'])['room']['roomId'], created['room']['roomId'])

    def test_index_claim_race_admits_exactly_one_host(self):
        for adapter in self.adapters:
            first = self.create_body(adapter)
            rival = self.create_body(adapter)
            real = self.database.transact; raced = False
            def race(TransactItems):
                nonlocal raced
                if not raced:
                    raced = True
                    self.database.meta.client.transact_write_items.side_effect = real
                    self.create(adapter, rival)
                    self.database.meta.client.transact_write_items.side_effect = race
                return real(TransactItems)
            self.database.meta.client.transact_write_items.side_effect = race
            self.error(adapter, 409, lambda: self.create(adapter, first))
            self.database.meta.client.transact_write_items.side_effect = real
            self.assertNotIn(adapter.key('game-' + self.prefix(adapter) + '-room', first['requestId']), self.database.rows['published-games'])
            self.assertEqual(self.join(adapter)['room']['roomId'], rival['requestId'])

    def test_last_seat_claim_race_never_admits_two_guests(self):
        adapter = self.adapters[1]
        host = self.create(adapter, kind='hand-duel')
        first = self.join_body(adapter, kind='hand-duel')
        rival = self.join_body(adapter, kind='hand-duel')
        real = self.database.transact; raced = False
        def race(TransactItems):
            nonlocal raced
            target = TransactItems[0].get('Put', {}).get('Item', {}).get('id', '')
            if not raced and target.startswith('game-party-room:'):
                raced = True
                self.database.meta.client.transact_write_items.side_effect = real
                self.join(adapter, rival)
                self.database.meta.client.transact_write_items.side_effect = race
            return real(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = race
        self.error(adapter, 404, lambda: self.join(adapter, first))
        state = self.state(adapter, host['room']['roomId'])
        self.assertEqual(len(state['members']), 2)
        self.assertIn(rival['requestId'], state['members']); self.assertNotIn(first['requestId'], state['members'])

    def test_conflicted_rate_reservation_does_not_admit_or_repeat_unboundedly(self):
        for adapter in self.adapters:
            host = self.create(adapter)
            saved = deepcopy(self.database.rows)
            self.database.meta.client.transact_write_items.side_effect = ConditionalFailure()
            before = self.database.meta.client.transact_write_items.call_count
            self.error(adapter, 503, lambda: self.join(adapter))
            self.assertEqual(self.database.meta.client.transact_write_items.call_count - before, 5)
            self.assertEqual(saved, self.database.rows)
            self.database.meta.client.transact_write_items.side_effect = self.database.transact

    def test_native_resource_decimal_revisions_preserve_phrase_cas(self):
        for adapter in self.adapters:
            host = self.create(adapter)
            for row in self.database.rows['published-games'].values(): row['revision'] = Decimal(row['revision'])
            joined = self.join(adapter)
            self.assertEqual(joined['room']['roomId'], host['room']['roomId'])
            self.action(adapter, host['session'], 'close')
            self.assertEqual(self.index(adapter)['passphrases'], {})


if __name__ == '__main__':
    unittest.main()
