"""Computer-seat privacy, autonomy and capability boundaries; no network/models."""
from copy import deepcopy
import json
import unittest
from unittest.mock import patch

import test_mafia_engine as rules
import test_mafia_api as adapter

engine, pid, player = rules.engine, rules.pid, rules.player


def lobby():
    state = engine.new_room(player(1), now=1000, settings={'maxPlayers': 24})
    state['roomId'] = pid(99)
    return state


def act(state, kind, now=1000, actor=None, **fields):
    return engine.apply_action(state, actor or pid(1), {'type': kind, 'phaseId': state['phaseId'], **fields}, now=now)


def started():
    with patch.object(engine.uuid, 'uuid4', side_effect=[engine.uuid.UUID(pid(number)) for number in range(100, 104)]):
        state = act(lobby(), 'fill-ai')
    for index, person in enumerate(state['players'][1:]):
        person['_ai']['seed'] = 'synthetic-seed-' + str(index)
    with patch.object(engine.secrets, 'SystemRandom') as random:
        random.return_value.shuffle.side_effect = lambda roles: None
        state = act(state, 'start')
    return state


class MafiaAIEngineTests(unittest.TestCase):
    def test_fill_is_explicit_atomic_and_keeps_the_human_owner_playing(self):
        before = lobby(); state = act(before, 'fill-ai')
        self.assertEqual(len(before['players']), 1)
        self.assertEqual(len(state['players']), 5)
        self.assertEqual((state['narratorMode'], state['narratorId']), ('automatic', None))
        self.assertEqual(state['ownerId'], pid(1))
        self.assertFalse(state['players'][0].get('isAI', False))
        self.assertEqual(len({person['id'] for person in state['players']}), 5)
        self.assertEqual(len({person['name'].casefold() for person in state['players']}), 5)
        for person in state['players'][1:]:
            self.assertTrue(person['isAI']); engine.validate_player({key: person[key] for key in ('id', 'name', 'avatar')})
        self.assertEqual(len(act(state, 'fill-ai')['players']), 5)

    def test_add_preserves_manual_narration_and_ai_can_be_kicked_but_not_narrator(self):
        state = act(lobby(), 'add-ai'); bot = state['players'][-1]['id']
        self.assertEqual(state['narratorMode'], 'human')
        with self.assertRaises(engine.MafiaError): act(state, 'reassign-narrator', targetId=bot)
        self.assertEqual(len(act(state, 'kick', targetId=bot)['players']), 1)
        with self.assertRaises(engine.MafiaError): act(state, 'close', actor=bot)

    def test_only_host_can_fill_and_no_client_supplied_ai_metadata_or_count(self):
        state = engine.add_player(lobby(), player(2), now=1000)
        for action in ({'type': 'fill-ai', 'count': 4}, {'type': 'add-ai', 'name': 'Injected'}, {'type': 'add-ai', 'isAI': True}):
            with self.assertRaises(engine.MafiaError): engine.apply_action(state, pid(1), action, now=1000)
        with self.assertRaises(engine.MafiaError) as caught: act(state, 'fill-ai', actor=pid(2))
        self.assertEqual(caught.exception.status, 403)
        with self.assertRaises(engine.MafiaError): engine.add_player(state, {**player(3), 'isAI': True}, now=1000)
        with self.assertRaises(engine.MafiaError): act(started(), 'add-ai')

    def test_full_lobby_rejects_extra_ai_without_switching_narration_or_losing_seats(self):
        state = engine.new_room(player(1), now=1000, settings={'maxPlayers': 5})
        for number in range(2, 7): state = engine.add_player(state, player(number), now=1000)
        before = deepcopy(state)
        with self.assertRaises(engine.MafiaError): act(state, 'add-ai')
        with self.assertRaises(engine.MafiaError): act(state, 'fill-ai')
        self.assertEqual(before, state)

    def test_bots_wait_then_choose_without_ending_the_humans_night(self):
        state = started(); before = deepcopy(state)
        self.assertEqual(engine.reconcile(state, now=1001), state)
        after = engine.reconcile(state, now=1004)
        self.assertEqual(after['phase'], 'night')
        self.assertEqual(len(after['nightActions']), 2)
        self.assertNotIn(pid(1), after['nightActions'])
        self.assertEqual(state, before)
        target = next(person['id'] for person in after['players'] if person['role'] == 'civilian')
        after = act(after, 'night-action', now=1004, targetId=target)
        self.assertIn(after['phase'], {'discussion', 'finished'})

    def test_policy_cannot_observe_unknown_roles_votes_or_other_night_choices(self):
        state = started(); bot = next(person for person in state['players'] if person.get('isAI') and person['role'] == 'civilian')
        engine._set_phase(state, 'voting', 1000)
        other = deepcopy(state)
        people = [person for person in other['players'] if person['id'] != bot['id']]
        people[0]['role'], people[1]['role'] = people[1]['role'], people[0]['role']
        other['votes'] = {people[0]['id']: people[1]['id']}
        other['nightActions'] = {people[1]['id']: people[2]['id']}
        view, changed = engine.project(state, bot['id']), engine.project(other, bot['id'])
        self.assertEqual(view, changed)
        policy = engine.ai_policy(); memory = bot['_ai']
        self.assertEqual(policy.decide(view, memory, 1004), policy.decide(changed, memory, 1004))
        changed['players'].reverse()
        for person in changed['players']: person['isAI'] = not person.get('isAI', False)
        self.assertEqual(policy.decide(view, memory, 1004), policy.decide(changed, memory, 1004))

    def test_detective_uses_only_its_own_recorded_check_and_mafia_avoid_known_allies(self):
        state = started(); detective = next(person for person in state['players'] if person['role'] == 'detective')
        detective['checks'] = [{'day': 1, 'targetId': pid(1), 'isMafia': True}]
        engine._set_phase(state, 'voting', 1000)
        command = engine.ai_policy().decide(engine.project(state, detective['id']), detective['_ai'], 1004)
        self.assertEqual(command, {'type': 'vote', 'targetId': pid(1)})
        bot = next(person for person in state['players'] if person.get('isAI') and person['role'] == 'civilian')
        bot['role'] = 'mafia'; engine._set_phase(state, 'night', 1000)
        command = engine.ai_policy().decide(engine.project(state, bot['id']), bot['_ai'], 1004)
        self.assertNotIn(command['targetId'], {pid(1), bot['id']})

    def test_poll_work_and_public_discussion_are_bounded_and_idle_polls_do_not_write(self):
        state = lobby()
        for _ in range(23): state = act(state, 'add-ai')
        state = act(state, 'configure', narratorMode='automatic')
        state = act(state, 'start'); engine._set_phase(state, 'discussion', 1000)
        once = engine.reconcile(state, now=1004)
        self.assertEqual(len(once['chat']), 8)
        same_second = engine.reconcile(once, now=1004)
        self.assertEqual(len(same_second['chat']), 16)
        self.assertEqual(same_second['ready'], [])
        twice = engine.reconcile(once, now=1006)
        self.assertEqual(len(twice['ready']), 8)
        for tick in range(1008, 1024, 2): twice = engine.reconcile(twice, now=tick)
        self.assertEqual(len(twice['chat']), 23)
        self.assertEqual(len(twice['ready']), 23)
        self.assertEqual(twice, engine.reconcile(twice, now=1024))
        projection = engine.project(twice, pid(1))
        self.assertNotIn('_ai', json.dumps(projection)); self.assertNotIn('seed', json.dumps(projection))
        self.assertTrue(all(set(person['_ai']) <= {'seed', 'chatPhase', 'nextAt'} for person in twice['players'] if person.get('isAI')))

    def test_eliminated_solo_owner_can_watch_autonomous_game_finish_and_restart(self):
        state = started(); people = state['players']
        for person, role in zip(people, ['civilian', 'mafia', 'doctor', 'detective', 'civilian']): person['role'] = role
        people[0]['alive'] = False
        for tick in range(1004, 1600, 4):
            state = engine.reconcile(state, now=tick)
            if state['phase'] == 'finished': break
        self.assertEqual(state['phase'], 'finished')
        self.assertGreater(state['phaseId'], 2)
        before_roles = {person['id']: person['role'] for person in state['players']}
        state = act(state, 'restart', now=1600)
        self.assertEqual(state['phase'], 'lobby')
        self.assertEqual(state['chat'], []); self.assertEqual(state['votes'], {})
        self.assertTrue(all(person['role'] is None and person['checks'] == [] for person in state['players']))
        self.assertTrue(all(set(person['_ai']) == {'seed'} for person in state['players'] if person.get('isAI')))
        self.assertEqual(set(before_roles), {person['id'] for person in state['players']})


class MafiaAIAPITests(unittest.TestCase):
    def setUp(self):
        self.fixture = adapter.MafiaAPITests('runTest'); self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_fill_needs_no_cached_ai_bank_and_bots_never_get_capabilities(self):
        f = self.fixture; f.load_bank.return_value = None; f.create()
        result = f.action(f.room_id, 'fill-ai')
        self.assertEqual(result['narratorMode'], 'automatic')
        self.assertEqual(sum(person.get('isAI', False) for person in result['players']), 4)
        self.assertEqual(set(f.state()['members']), {f.room_id})
        f.load_bank.assert_not_called(); f.provider.converse.assert_not_called(); f.authorization.assert_not_called()
        self.assertNotIn('_ai', json.dumps(result)); self.assertNotIn('tokenHash', json.dumps(result))
        f.action(f.room_id, 'start')
        for number in range(5): f.clock += 4; f.get()
        f.provider.converse.assert_not_called(); f.load_bank.assert_not_called()

    def test_existing_cached_ai_narration_gate_is_unchanged(self):
        f = self.fixture; f.load_bank.return_value = None
        f.error(409, lambda: f.create(narratorMode='ai'))
        f.create_body['narratorMode'] = 'automatic'; f.create()
        self.assertEqual(f.get()['narratorMode'], 'automatic')
        f.error(409, lambda: f.action(f.room_id, 'configure', narratorMode='ai'))
        f.provider.converse.assert_not_called()

    def test_add_ai_exact_retry_is_read_only_and_host_only(self):
        f = self.fixture; f.create(); f.join(2)
        f.error(403, lambda: f.action(adapter.uuid(2), 'add-ai'))
        body = f.body(f.room_id, 'add-ai'); room = f.send(f.room_id, body)
        before = deepcopy(f.database.rows)
        self.assertEqual(f.send(f.room_id, body), room)
        self.assertEqual(f.database.rows, before)
        f.error(409, lambda: f.send(f.room_id, {**body, 'type': 'fill-ai'}))
        self.assertEqual(f.database.rows, before)
        self.assertEqual(len(f.state()['members']), 2)

    def test_an_invited_human_cannot_claim_a_published_ai_seat_identifier(self):
        f = self.fixture; f.create(); room = f.action(f.room_id, 'add-ai')
        bot = next(person['id'] for person in room['players'] if person.get('isAI'))
        body = {**f.join_body(2), 'requestId': bot}
        before = deepcopy(f.database.rows)
        f.error(409, lambda: adapter.mafia.join(f.api, f.room_id, body))
        self.assertEqual(before, f.database.rows)
        self.assertNotIn(bot, f.state()['members'])

    def test_single_request_never_runs_two_ai_action_budgets(self):
        f = self.fixture; f.create(narratorMode='automatic', maxPlayers=24)
        for _ in range(23): f.action(f.room_id, 'add-ai')
        f.action(f.room_id, 'start')
        key = adapter.mafia.key('game-mafia-room', f.room_id)
        stored = f.state(); adapter.mafia.engine()._set_phase(stored['game'], 'discussion', f.clock)
        f.database.rows['published-games'][key]['payload'] = adapter.mafia.canonical(stored)
        f.clock += 4
        body = {'requestId': adapter.uuid(9000), 'phaseId': stored['game']['phaseId'], 'sequence': stored['members'][f.room_id]['sequence'] + 1, 'type': 'chat', 'text': 'Hello town.'}
        result = f.send(f.room_id, body)
        self.assertEqual(sum(message['playerId'] != f.room_id for message in result['chat']), 8)
        self.assertEqual(f.state()['game']['ready'], [])
        before = deepcopy(f.database.rows)
        f.clock += 5; f.send(f.room_id, body)
        self.assertEqual(f.database.rows, before)

    def test_concurrent_human_chat_and_ai_admission_preserve_both_once(self):
        f = self.fixture; f.create(); f.join(2)
        body = f.body(f.room_id, 'add-ai')
        real = f.database.transact
        raced = False
        def race(TransactItems):
            nonlocal raced
            if not raced:
                raced = True
                f.database.meta.client.transact_write_items.side_effect = real
                f.action(adapter.uuid(2), 'chat', text='I am still here.')
                f.database.meta.client.transact_write_items.side_effect = race
            return real(TransactItems)
        f.database.meta.client.transact_write_items.side_effect = race
        room = f.send(f.room_id, body)
        self.assertEqual(len(room['players']), 3)
        self.assertEqual(sum(person.get('isAI', False) for person in room['players']), 1)
        self.assertEqual(room['chat'][-1]['text'], 'I am still here.')
        before = deepcopy(f.database.rows)
        f.send(f.room_id, body)
        self.assertEqual(f.database.rows, before)


if __name__ == '__main__':
    unittest.main()
