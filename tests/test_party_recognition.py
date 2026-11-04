"""Separate, capability-bound recognition requests with synthetic model/storage."""
from copy import deepcopy
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import test_party_api as existing
from test_nce_api import ConditionalFailure, DynamoResourceTable

party, uuid = existing.party, existing.uuid


class PartyRecognitionTests(unittest.TestCase):
    setUp = existing.PartyAPITests.setUp
    authorize = existing.PartyAPITests.authorize
    event = existing.PartyAPITests.event
    write_registry = existing.PartyAPITests.write_registry
    new_create_body = existing.PartyAPITests.new_create_body
    request_event = existing.PartyAPITests.request_event
    create = existing.PartyAPITests.create
    join_body = existing.PartyAPITests.join_body
    join = existing.PartyAPITests.join
    get = existing.PartyAPITests.get
    body = existing.PartyAPITests.body
    action = existing.PartyAPITests.action
    send = existing.PartyAPITests.send
    state = existing.PartyAPITests.state
    index = existing.PartyAPITests.index
    error = existing.PartyAPITests.error

    def start(self, other_human=False, seconds=75):
        self.create(kind='sketch-guess', settings={'roundSeconds': seconds})
        if other_human: self.join(2)
        self.action(self.room_id, 'add-ai')
        self.action(self.room_id, 'start')
        self.ink(1)
        self.model = SimpleNamespace(MODEL_VERSION='synthetic-public-ink-v1',
            predict=Mock(return_value=[{'label': 'airplane', 'score': .91}]))
        model = patch.object(party, '_vision', self.model); model.start(); self.addCleanup(model.stop)
        return self.binding()

    def ink(self, number):
        return self.action(self.room_id, 'stroke', color='#244b50', width=5,
            points=[[.1, .2], [.2 + number / 100, .3], [.3, .5]])

    def binding(self):
        return party.engine().recognition_binding(self.state()['game'])

    def recognize(self, body=None, actor=None, event=None):
        return party.dispatch(self.api, event or self.request_event(actor or self.room_id), 'POST',
            '/party/rooms/' + self.room_id + '/recognition', self.binding() if body is None else body)

    def test_model_sees_only_authoritative_public_ink_and_ack_has_no_candidates(self):
        body = self.start()
        before = self.state(); index = deepcopy(self.index())
        result = self.recognize(body)
        self.assertEqual(result, {'version': 1, 'roomId': self.room_id, **body, 'status': 'ready', 'retryAfterMs': 3000})
        strokes = self.model.predict.call_args.args[0]
        self.assertTrue(strokes)
        self.assertTrue(all(set(stroke) == {'color', 'width', 'points'} for stroke in strokes))
        self.assertEqual(strokes, party.engine().recognition_strokes(before['game']))
        after = self.state()
        self.assertEqual(before['members'], after['members'])
        self.assertEqual(before['expiresAt'], after['expiresAt'])
        self.assertEqual(index, self.index())
        for key in ('phase', 'phaseId', 'deadlineAt', 'players', 'events', 'chat', '_ai'):
            self.assertEqual(before['game'][key], after['game'][key])
        private = after['game']['_game']
        self.assertEqual(private['_recognition']['candidates'], [{'label': 'airplane', 'score': .91}])
        self.assertNotIn('_recognitionJob', private)
        self.assertLess(len(json.dumps({key: value for key, value in private.items() if key.startswith('_recognition')}).encode()), 3072)
        wire = json.dumps(self.get())
        for secret in ('_recognition', 'synthetic-public-ink-v1', 'candidates', 'airplane'):
            self.assertNotIn(secret, wire)
        self.authorization.assert_not_called(); self.provider.converse.assert_not_called()

    def test_cached_same_ink_never_reruns_inference_or_changes_sequence(self):
        body = self.start(); self.assertEqual(self.recognize(body)['status'], 'ready')
        before = deepcopy(self.database.rows)
        self.assertEqual(self.recognize(body)['status'], 'cached')
        self.assertEqual(self.database.rows, before)
        self.model.predict.assert_called_once()

    def test_any_active_human_guest_can_trigger_but_credentials_and_left_seats_are_denied(self):
        body = self.start(other_human=True)
        self.error(401, lambda: self.recognize(body, event={'headers': {}}))
        self.error(401, lambda: self.recognize(body, event={'headers': {'authorization': 'Bearer ' + self.create_body['inviteToken']}}))
        self.assertEqual(self.recognize(body, actor=uuid(2))['status'], 'ready')
        self.action(uuid(2), 'leave')
        self.error(403, lambda: self.recognize(body, actor=uuid(2)))

    def test_strict_request_contract_refuses_predictions_images_and_invalid_bindings(self):
        body = self.start(); before = deepcopy(self.database.rows)
        for invalid in ({}, {**body, 'phaseId': True}, {**body, 'drawingEpoch': -1},
                {**body, 'inkSha256': 'bad'}, {**body, 'candidates': []}, {**body, 'prompt': 'cat'},
                {**body, 'strokes': []}, {**body, 'requestId': uuid(99)}):
            self.error(400, lambda: self.recognize(invalid))
        self.assertEqual(before, self.database.rows)
        self.model.predict.assert_not_called()

    def test_wrong_phase_epoch_and_hash_return_stale_without_a_claim(self):
        body = self.start(); before = deepcopy(self.database.rows)
        for change in ({'phaseId': body['phaseId'] + 1}, {'drawingEpoch': 10}, {'inkSha256': 'a' * 64}):
            self.assertEqual(self.recognize({**body, **change})['status'], 'stale')
        self.assertEqual(before, self.database.rows)
        self.model.predict.assert_not_called()

    def test_regular_get_and_drawing_post_never_import_or_run_the_model(self):
        self.start()
        with patch.object(party, 'vision', side_effect=AssertionError('No inference on ordinary room paths.')):
            for number in range(3):
                self.clock += 2
                self.get(); self.ink(number)
        self.model.predict.assert_not_called()

    def test_non_sketch_no_ai_and_empty_or_ended_rounds_do_no_work(self):
        self.create(kind='drop-four'); body = {'phaseId': 0, 'drawingEpoch': 0, 'inkSha256': 'a' * 64}
        with patch.object(party, 'vision', side_effect=AssertionError('Idle must not import a model.')):
            self.assertEqual(self.recognize(body)['status'], 'idle')
        self.action(self.room_id, 'close')
        self.assertEqual(self.recognize(body)['status'], 'idle')

    def test_drawing_changes_during_inference_discard_observation_and_preserve_new_ink(self):
        body = self.start()
        def draw(strokes):
            self.ink(8)
            return [{'label': 'cat', 'score': .95}]
        self.model.predict.side_effect = draw
        self.assertEqual(self.recognize(body)['status'], 'stale')
        game = self.state()['game']['_game']
        self.assertEqual(len(game['strokes']), 2)
        self.assertNotIn('_recognition', game)
        self.assertNotIn('_recognitionJob', game)

    def test_clear_invalidates_inflight_job_and_cache_without_resetting_budget(self):
        body = self.start()
        def clear(strokes):
            self.action(self.room_id, 'clear-drawing', drawingEpoch=0)
            return [{'label': 'cat', 'score': .9}]
        self.model.predict.side_effect = clear
        self.assertEqual(self.recognize(body)['status'], 'stale')
        game = self.state()['game']['_game']
        self.assertEqual(game['drawingEpoch'], 1)
        self.assertEqual(game['_recognitionBudget']['count'], 1)
        self.assertNotIn('_recognition', game)
        self.assertNotIn('_recognitionJob', game)

    def test_phase_change_and_close_discard_inflight_results(self):
        body = self.start()
        def close(strokes):
            self.action(self.room_id, 'close')
            return [{'label': 'cat', 'score': .9}]
        self.model.predict.side_effect = close
        self.assertEqual(self.recognize(body)['status'], 'stale')
        self.assertEqual(self.state()['game']['_game'], {})

    def test_round_deadline_is_not_advanced_or_extended_by_recognition(self):
        body = self.start(); before = self.state()
        self.clock = before['game']['deadlineAt']
        self.assertEqual(self.recognize(body)['status'], 'idle')
        self.assertEqual(self.state(), before)
        self.model.predict.assert_not_called()

    def test_concurrent_trigger_observes_one_claim_and_does_not_run_another_model(self):
        body = self.start(); replies = []
        def duplicate(strokes):
            replies.append(self.recognize(body))
            return [{'label': 'cat', 'score': .9}]
        self.model.predict.side_effect = duplicate
        self.assertEqual(self.recognize(body)['status'], 'ready')
        self.assertEqual(replies[0]['status'], 'busy')
        self.model.predict.assert_called_once()

    def test_expired_job_cannot_overwrite_a_newer_claim_result(self):
        body = self.start(); first = True; replies = []
        def takeover(strokes):
            nonlocal first
            if first:
                first = False; self.clock += 11
                replies.append(self.recognize(body))
                return [{'label': 'cat', 'score': .99}]
            return [{'label': 'airplane', 'score': .8}]
        self.model.predict.side_effect = takeover
        self.assertEqual(self.recognize(body)['status'], 'stale')
        self.assertEqual(replies[0]['status'], 'ready')
        self.assertEqual(self.state()['game']['_game']['_recognition']['candidates'], [{'label': 'airplane', 'score': .8}])

    def test_claim_contention_returns_busy_with_bounded_reads_and_no_inference(self):
        body = self.start(); before = deepcopy(self.database.rows)
        self.database.meta.client.transact_write_items.side_effect = ConditionalFailure()
        calls = self.database.meta.client.transact_write_items.call_count
        self.assertEqual(self.recognize(body)['status'], 'busy')
        self.assertEqual(self.database.meta.client.transact_write_items.call_count - calls, 2)
        self.assertEqual(before, self.database.rows)
        self.model.predict.assert_not_called()

    def test_observation_commit_retries_cas_without_repeating_the_classifier(self):
        body = self.start(); original = self.database.transact; conflicted = False
        def conflict(TransactItems):
            nonlocal conflicted
            item = TransactItems[0].get('Put', {}).get('Item')
            if not conflicted and item and '"_recognition":' in item.get('payload', ''):
                conflicted = True; raise ConditionalFailure()
            return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = conflict
        self.assertEqual(self.recognize(body)['status'], 'ready')
        self.model.predict.assert_called_once()

    def test_room_interval_and_phase_budget_bound_new_ink_inferences(self):
        body = self.start(seconds=180); started_at = self.clock; self.recognize(body)
        self.ink(2)
        self.assertEqual(self.recognize()['status'], 'busy')
        self.assertEqual(self.model.predict.call_count, 1)
        for count in range(1, 20):
            self.clock += 9; self.ink(count + 2)
            self.assertEqual(self.recognize()['status'], 'ready')
        self.assertEqual(self.clock - started_at, 171)
        self.clock += 1; self.ink(30)
        self.assertEqual(self.recognize()['status'], 'idle')
        self.assertEqual(self.model.predict.call_count, 20)
        self.assertEqual(self.state()['game']['_game']['_recognitionBudget']['count'], 20)

    def test_default_round_uses_four_second_compute_interval_with_three_second_busy_ack(self):
        self.start(); self.recognize(); self.ink(2)
        self.clock += 3
        busy = self.recognize()
        self.assertEqual(busy['status'], 'busy'); self.assertEqual(busy['retryAfterMs'], 3000)
        self.model.predict.assert_called_once()
        self.clock += 1
        self.assertEqual(self.recognize()['status'], 'ready')
        self.assertEqual(self.model.predict.call_count, 2)

    def test_invalid_or_failed_model_is_optional_and_releases_its_claim(self):
        body = self.start(); self.model.predict.return_value = [{'label': 'cat', 'score': float('nan')}]
        result = self.recognize(body)
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(result['retryAfterMs'], 10000)
        game = self.state()['game']['_game']
        self.assertNotIn('_recognition', game); self.assertNotIn('_recognitionJob', game)
        self.ink(9)
        self.assertEqual(self.recognize()['status'], 'busy')
        self.assertEqual(self.model.predict.call_count, 1)

    def test_model_input_is_detached_and_private_state_stays_within_the_bound(self):
        body = self.start()
        before = deepcopy(self.state()['game']['_game']['strokes'])
        def mutate(strokes):
            strokes[0]['points'][0][0] = .99
            strokes[0]['prompt'] = 'synthetic model-local value'
            return [{'label': 'x' * 80, 'score': 1 / (i + 1)} for i in range(1)]
        self.model.predict.side_effect = mutate
        self.assertEqual(self.recognize(body)['status'], 'ready')
        self.assertEqual(self.state()['game']['_game']['strokes'], before)

    def test_native_resource_decimal_revision_keeps_claim_and_result_fences(self):
        body = self.start(); original = self.database.Table
        self.database.Table = lambda name: DynamoResourceTable(self.database, name) if name == 'published-games' else original(name)
        self.assertEqual(self.recognize(body)['status'], 'ready')
        self.assertEqual(self.recognize(body)['status'], 'cached')

    def test_public_http_route_uses_room_capability_and_no_store_without_core_authority(self):
        body = self.start()
        handler = existing.support.handler
        with patch.object(handler, 'clients', return_value=(self.database, None, None)), \
                patch.object(handler, '_party', party), \
                patch.object(handler, 'authorize', side_effect=AssertionError('No Core authority on room recognition.')):
            event = self.request_event(self.room_id)
            event['requestContext']['http']['method'] = 'POST'
            event.update(rawPath='/party/rooms/' + self.room_id + '/recognition', body=json.dumps(body))
            result = handler.handler(event, None)
            self.assertEqual(result['statusCode'], 200)
            self.assertEqual(result['headers']['Cache-Control'], 'no-store')
            self.assertEqual(json.loads(result['body'])['status'], 'ready')
            event['headers'] = {}
            result = handler.handler(event, None)
            self.assertEqual(result['statusCode'], 401)
            self.assertEqual(result['headers']['Cache-Control'], 'no-store')

    def test_preflight_does_not_initialize_storage_auth_or_model(self):
        handler = existing.support.handler
        with patch.object(handler, 'clients', side_effect=AssertionError('No preflight storage.')), \
                patch.object(handler, 'authorize', side_effect=AssertionError('No preflight introspection.')), \
                patch.object(party, 'vision', side_effect=AssertionError('No preflight model.')):
            result = handler.handler({'rawPath': '/party/rooms/' + self.room_id + '/recognition',
                'requestContext': {'http': {'method': 'OPTIONS'}}}, None)
            self.assertEqual(result['statusCode'], 204)

    def test_human_only_drawing_avoids_model_and_hotpath_ink_hash_work(self):
        self.create(kind='sketch-guess'); self.join(2); self.action(self.room_id, 'start')
        with patch.object(party.engine(), 'recognition_strokes', side_effect=AssertionError('No hashing for human-only drawing.')), \
                patch.object(party, 'vision', side_effect=AssertionError('No human-only model.')):
            room = self.ink(3)
            self.assertNotIn('inkSha256', room['game'])
            self.assertEqual(self.recognize({'phaseId': room['phaseId'], 'drawingEpoch': 0, 'inkSha256': 'a' * 64})['status'], 'idle')

    def test_active_legacy_prompt_order_is_not_reselected_or_used_by_classifier(self):
        body = self.start()
        state = self.state(); previous = self.database.rows['published-games'][party.key('game-party-room', self.room_id)]
        legacy_index = next(index for index, (label, aliases) in enumerate(party.engine().PROMPTS) if label == 'pirate ship')
        state['game']['_game']['order'][0] = legacy_index
        self.assertTrue(party.transact(self.api, [party.put('game-party-room', self.room_id, state, previous)]))
        self.assertEqual(self.get()['self']['prompt'], 'pirate ship')
        self.assertEqual(self.recognize(body)['status'], 'ready')
        self.assertEqual(self.state()['game']['_game']['order'][0], legacy_index)
        self.assertNotIn('pirate ship', json.dumps(self.model.predict.call_args.args[0]))

    def test_eraser_and_pen_width_change_hash_and_invalidate_old_observation(self):
        body = self.start(); self.recognize(body)
        changed = self.action(self.room_id, 'stroke', color='#ffffff', width=10,
            points=[[.1, .2], [.21, .3], [.3, .5]])
        self.assertNotEqual(changed['game']['inkSha256'], body['inkSha256'])
        self.assertNotIn('_recognition', self.state()['game']['_game'])
        self.assertEqual(self.recognize(body)['status'], 'stale')

    def test_cached_tool_is_consumed_only_by_later_normal_ai_turns(self):
        self.start(); self.ink(2); self.ink(3)
        state = self.state()['game']
        prompt = party.engine().PROMPTS[state['_game']['order'][0]][0]
        label = next(label for label, target in party.engine().ai_rules().RECOGNITION_LABELS.items() if target == prompt)
        self.model.predict.return_value = [{'label': label, 'score': .9}]
        self.assertEqual(self.recognize()['status'], 'ready')
        self.assertEqual(self.state()['game']['phase'], 'draw')
        self.assertEqual(self.state()['game']['_game']['guessedIds'], [])
        self.clock += 3; self.get()
        self.clock += 8
        completed = self.get()
        self.assertEqual(completed['phase'], 'reveal')
        self.assertEqual(len(completed['game']['guessedIds']), 1)
        self.assertTrue(all(player['score'] > 0 for player in completed['players']))
        self.assertNotIn('_recognition', self.state()['game']['_game'])


if __name__ == '__main__':
    unittest.main()
