"""Synthetic versus-room authority and schema checks; no network or providers."""
from copy import deepcopy
import json
import unittest

import test_multiplayer as existing

relay, support = existing.relay, existing.support
MATCH = {'mode': 'versus', 'lives': 3, 'timeLimit': 120}


class VersusRoomTests(unittest.TestCase):
    setUp = existing.MultiplayerTests.setUp
    event = existing.MultiplayerTests.event
    join = existing.MultiplayerTests.join
    invitation = existing.MultiplayerTests.invitation
    room = existing.MultiplayerTests.room
    messages = existing.MultiplayerTests.messages
    error = existing.MultiplayerTests.error
    send = existing.MultiplayerTests.send
    snapshot = existing.MultiplayerTests.snapshot
    mutate_publication = existing.MultiplayerTests.mutate_publication
    socket_join = existing.MultiplayerTests.socket_join

    def create(self, match=MATCH, visibility='private'):
        return relay.dispatch(self.api, self.event(), 'POST', '/multiplayer/rooms',
            {'gameId': support.GAME, 'publishedRevision': 7, 'match': match, 'visibility': visibility})

    def publish(self, spec):
        self.spec = deepcopy(support.games.validate_spec(spec))
        self.published['spec'] = self.spec
        self.database.rows['published-games'][self.public_key]['payload'] = json.dumps(self.published)

    def version(self, version):
        spec = support.games.design_game('Asteroids with three levels.')['spec']
        spec['version'] = version
        spec.pop('multiplayer', None)
        spec.pop('powerUps', None)
        spec.pop('asteroids', None)
        if version == 1:
            spec.pop('levels', None); spec.pop('progression', None)
        if version == 4:
            spec['multiplayer'] = {'mode': 'cooperative', 'maxPlayers': 2}
        if version == 5:
            spec['powerUps'] = support.games.default_power_ups()
        if version == 6:
            spec['asteroids'] = support.games.default_asteroid_settings()
        return spec

    def versus_state(self, lives=(3, 3), elapsed=0, winner=None, reason=None):
        state = self.snapshot()
        state['elapsed'] = elapsed
        state['versus'] = {'winner': winner, 'reason': reason}
        for index, life in enumerate(lives): state['players'][index]['lives'] = life
        if reason is not None: state.update(outcome='finished', running=False, paused=False)
        return state

    def pair(self, visibility='private'):
        created = self.create(visibility=visibility)
        guest = self.join(created)
        self.socket_join('host', created, created['hostToken'])
        self.socket_join('guest', created, guest['guestToken'])
        return created, guest

    def test_config_has_exact_bounded_integer_fields_and_does_not_touch_publication(self):
        original = deepcopy(self.database.rows['published-games'])
        for invalid in [None, [], {}, {'mode': 'versus', 'lives': 3},
                {**MATCH, 'mode': 'cooperative'}, {**MATCH, 'lives': True}, {**MATCH, 'lives': 3.0},
                {**MATCH, 'lives': 0}, {**MATCH, 'lives': 6}, {**MATCH, 'timeLimit': 29},
                {**MATCH, 'timeLimit': 181}, {**MATCH, 'timeLimit': False}, {**MATCH, 'timeLimit': 120.5},
                {**MATCH, 'winner': 0}, {**MATCH, 'maxPlayers': 12}]:
            with self.subTest(invalid=invalid): self.error(400, lambda: self.create(invalid))
        created = self.create()
        self.assertEqual(created['match'], MATCH)
        self.assertEqual(self.room(created)['match'], MATCH)
        self.assertEqual(self.database.rows['published-games'], original)
        self.assertNotIn('match', self.published['spec'])
        self.assertEqual(set(created) - {'match'}, {'roomId', 'hostToken', 'inviteToken', 'expiresAt', 'socketUrl', 'gameId', 'publishedRevision', 'specSha256'})

    def test_solo_and_cooperative_shooting_formats_are_eligible_without_opt_in_changes(self):
        for version in (1, 2, 4, 5, 6):
            with self.subTest(version=version):
                self.publish(self.version(version))
                spec, _, _ = relay.publication(self.api, support.GAME, 7, match=MATCH)
                self.assertEqual(spec['version'], version)
                if version != 4:
                    # Warm versus-validation cache never grants ordinary co-op.
                    self.error(409, lambda: relay.publication(self.api, support.GAME, 7))
        self.publish(self.version(4))
        relay.publication(self.api, support.GAME, 7)
        relay.publication(self.api, support.GAME, 7, match=MATCH)

    def test_nonshooting_flows_and_other_formats_are_refused_even_with_cached_validation(self):
        spec = self.version(2)
        spec['arcade']['shooting'] = False; spec['arcade']['splitAsteroids'] = False
        self.publish(spec)
        self.error(409, lambda: self.create())
        spec = self.version(2); spec['flow'] = support.games.default_flow(spec)
        self.publish(spec)
        self.error(409, lambda: self.create())
        spec = support.games.default_spec()
        self.publish(spec)
        self.error(409, lambda: self.create())

    def test_guests_cannot_supply_change_or_learn_another_seat_capability(self):
        created = self.create()
        body = {**self.invitation(created), 'match': {**MATCH, 'lives': 5}}
        self.error(400, lambda: relay.dispatch(self.api, self.event(), 'POST', '/multiplayer/rooms/' + created['roomId'] + '/join', body))
        guest = self.join(created)
        self.assertEqual(guest['match'], MATCH)
        self.assertNotIn('hostToken', guest); self.assertNotIn('inviteToken', guest)
        self.socket_join('host', created, created['hostToken'])
        self.socket_join('guest', created, guest['guestToken'])
        for connection in ('host', 'guest'):
            ready = next(message for message in self.messages(connection) if message['type'] == 'ready')
            self.assertEqual(ready['match'], MATCH)
            self.assertNotIn('token', ready)
        self.error(403, lambda: self.send('guest', {'type': 'state', 'seq': 1, 'state': self.versus_state()}))

    def test_private_rooms_stay_private_and_public_listings_reveal_only_match_rules(self):
        private = self.create(); public = self.create(visibility='public')
        self.socket_join('public-host', public, public['hostToken'])
        listing = relay.dispatch(self.api, self.event(), 'GET', '/multiplayer/lobby', {})
        self.assertEqual(len(listing['rooms']), 1)
        room = listing['rooms'][0]
        self.assertEqual(room['roomId'], public['roomId']); self.assertEqual(room['match'], MATCH)
        self.assertNotEqual(room['roomId'], private['roomId'])
        self.assertEqual(set(room), {'roomId', 'gameId', 'publishedRevision', 'specSha256', 'title', 'expiresAt', 'match'})
        self.assertNotIn(public['inviteToken'], json.dumps(listing))
        binding = {key: public[key] for key in ('gameId', 'publishedRevision', 'specSha256')}
        guest = relay.dispatch(self.api, self.event(), 'POST', '/multiplayer/rooms/' + public['roomId'] + '/lobby-join', binding)
        self.assertEqual(guest['match'], MATCH)
        self.assertEqual(relay.dispatch(self.api, self.event(), 'GET', '/multiplayer/lobby', {})['rooms'], [])

    def test_match_rules_survive_reconnect_and_renewal_and_remain_in_cas_fence(self):
        created, guest = self.pair()
        self.send('host', {'type': 'state', 'seq': 1, 'state': self.versus_state()})
        self.now += 10
        self.socket_join('replacement-host', created, created['hostToken'])
        self.assertEqual(self.room(created)['match'], MATCH)
        ready = next(message for message in self.messages('replacement-host') if message['type'] == 'ready')
        self.assertEqual(ready['match'], MATCH)
        self.error(403, lambda: self.send('host', {'type': 'state', 'seq': 2, 'state': self.versus_state()}))
        self.assertTrue(any('ConditionCheck' in operation for call in self.database.meta.client.transact_write_items.call_args_list for operation in call.kwargs['TransactItems']))

    def test_live_publication_revocation_closes_versus_room_after_cache_warmup(self):
        created = self.create()
        self.mutate_publication(lambda value: value['spec']['arcade'].update(shooting=False, splitAsteroids=False))
        self.error(410, lambda: relay.active_room(self.api, created['roomId']))
        self.assertTrue(self.room(created)['closed'])

    def test_versus_snapshots_require_first_arena_and_configured_lives_clock_and_metadata(self):
        state = self.versus_state()
        self.assertEqual(relay.validate_state(state, self.spec, MATCH), state)
        bad = []
        for patch_value in ({'levelIndex': 1}, {'elapsed': 120}, {'elapsed': 121}, {'outcome': 'won'}, {'outcome': 'lost'},
                {'versus': {'winner': True, 'reason': None}}, {'versus': {'winner': None, 'reason': []}},
                {'versus': {'winner': None, 'reason': None, 'lives': 5}}, {'match': MATCH}):
            bad.append({**state, **patch_value})
        for field, value in [('lives', 4), ('lives', True)]:
            malformed = deepcopy(state); malformed['players'][0][field] = value; bad.append(malformed)
        malformed = deepcopy(state); malformed.pop('versus'); bad.append(malformed)
        malformed = deepcopy(state); malformed['players'][1]['lives'] = 0; bad.append(malformed)
        for malformed in bad:
            with self.subTest(malformed=malformed): self.error(400, lambda: relay.validate_state(malformed, self.spec, MATCH))
        self.error(400, lambda: relay.validate_state(state, self.spec))

    def test_elimination_and_clock_results_compare_lives_only_and_never_collection_goals(self):
        for lives, elapsed, winner, reason in [((3, 0), 1, 0, 'elimination'), ((0, 2), 40, 1, 'elimination'),
                ((0, 0), 120, 'draw', 'elimination'), ((3, 2), 120, 0, 'time'),
                ((1, 3), 120, 1, 'time'), ((2, 2), 120, 'draw', 'time')]:
            state = self.versus_state(lives, elapsed, winner, reason)
            self.assertEqual(relay.validate_state(state, self.spec, MATCH), state)
            for patch_value in ({'running': True}, {'paused': True}, {'versus': {'winner': None, 'reason': reason}},
                    {'versus': {'winner': 1 if winner == 0 else 0, 'reason': reason}},
                    {'versus': {'winner': winner, 'reason': 'time' if reason == 'elimination' else 'elimination'}}):
                malformed = {**state, **patch_value}
                with self.subTest(lives=lives, patch_value=patch_value): self.error(400, lambda: relay.validate_state(malformed, self.spec, MATCH))
        early = self.versus_state((3, 2), 119, 0, 'time')
        self.error(400, lambda: relay.validate_state(early, self.spec, MATCH))
        state = self.versus_state(elapsed=50)
        state['players'][0]['score'] = self.spec['levels'][0]['rules']['goal'] + 1
        relay.validate_state(state, self.spec, MATCH)
        self.error(400, lambda: relay.validate_state(state, self.spec))

    def test_host_messages_cannot_override_rules_or_emit_cooperative_outcomes(self):
        created, _ = self.pair()
        before = deepcopy(self.database.rows['rooms'])
        state = self.versus_state()
        self.error(400, lambda: self.send('host', {'type': 'state', 'seq': 1, 'state': state, 'match': {**MATCH, 'lives': 5}}))
        self.assertEqual(before, self.database.rows['rooms'])
        for changed in ({'outcome': 'won'}, {'versus': {'winner': 0, 'reason': 'elimination'}}):
            self.error(400, lambda: self.send('host', {'type': 'state', 'seq': 1, 'state': {**state, **changed}}))
        terminal = self.versus_state((1, 0), 10, 0, 'elimination')
        self.send('host', {'type': 'state', 'seq': 1, 'state': terminal})
        projected = next(message for message in self.messages('guest') if message['type'] == 'state')
        self.assertEqual(projected['state'], terminal)
        self.assertEqual(self.room(created)['match'], MATCH)


if __name__ == '__main__': unittest.main()
