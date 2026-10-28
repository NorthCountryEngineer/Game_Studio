"""Offline level-flow publication, model-boundary and score-order regression tests."""
from copy import deepcopy
import json
import unittest

import test_games as support
import test_game_scores as score_support

games, scores = support.games, score_support.scores


def campaign():
    spec = games.create_platformer_spec()
    spec['flow'] = {'version': 1, 'nodes': [
        {'id': 'step-4', 'type': 'menu', 'title': 'Choose your adventure'},
        {'id': 'step-2', 'type': 'level', 'levelId': 'level-2'},
        {'id': 'step-5', 'type': 'material', 'title': 'Fractions practice', 'kind': 'lesson', 'reference': 'ncacademy:lessons/fractions-1', 'required': True},
        {'id': 'step-1', 'type': 'level', 'levelId': 'level-1'},
        {'id': 'step-3', 'type': 'level', 'levelId': 'level-3'}]}
    return spec


class FlowTests(unittest.TestCase):
    setUp = support.GameTests.setUp
    authorize = support.GameTests.authorize
    event = support.GameTests.event
    error = support.GameTests.error
    create = support.GameTests.create
    finish_test = support.GameTests.finish_test
    publish = support.GameTests.publish
    message = support.GameTests.message
    configure_model = support.GameTests.configure_model
    save_config = support.GameTests.save_config
    write_registry = support.GameTests.write_registry

    def save(self, state, spec):
        return games.update(self.api, self.claims, state['id'], {'revision': state['revision'], 'spec': spec})

    def test_safe_flow_fields_reject_ambiguous_material_and_unsupported_formats(self):
        value = campaign()
        self.assertEqual(games.validate_spec(value), value)
        for change in [
            lambda spec: spec.update(genre='collect'),
            lambda spec: spec.update(multiplayer={'mode': 'cooperative', 'maxPlayers': 2}),
            lambda spec: spec['flow'].update(version=True),
            lambda spec: spec['flow']['nodes'][2].update(required=1),
            lambda spec: spec['flow']['nodes'][2].update(reference='https://example.com'),
            lambda spec: spec['flow']['nodes'][2].update(reference='course/../lesson'),
            lambda spec: spec['flow']['nodes'][2].update(reference='//example.com'),
            lambda spec: spec['flow']['nodes'][2].update(title='<script>'),
            lambda spec: spec['flow']['nodes'][2].update(kind='html'),
            lambda spec: spec['flow']['nodes'][2].update(token='private'),
            lambda spec: spec['flow']['nodes'].pop(),
            lambda spec: spec['flow']['nodes'].append(deepcopy(spec['flow']['nodes'][0])),
        ]:
            altered = deepcopy(value); change(altered)
            self.error(400, lambda: games.validate_spec(altered))
        asteroid = games.design_game('Asteroids with 3 levels and endless survival.')['spec']
        asteroid['flow'] = value['flow']
        self.error(400, lambda: games.validate_spec(asteroid))

    def test_review_all_levels_and_keep_versioned_flow_out_of_legacy_catalog(self):
        state = self.save(self.create(), campaign())
        self.error(400, lambda: games.complete_test(self.api, self.claims, state['id'], {'revision': state['revision'], 'reviewedLevelIds': ['level-1']}))
        published = self.publish(self.finish_test(state))
        legacy = games.list_games(self.api, None, {}, True)
        self.assertEqual(legacy['games'], [])
        all_games = games.list_games(self.api, None, {'queryStringParameters': {'specVersion': 'all'}}, True)
        self.assertEqual(all_games['games'][0]['spec'], campaign())
        changed = campaign(); changed['flow']['nodes'][2]['reference'] = 'private-draft/lesson'
        self.save(published, changed)
        public = games.dispatch(self.api, {}, 'GET', '/games/published/' + state['id'], {})
        self.assertEqual(public['spec']['flow'], campaign()['flow'])
        self.assertNotIn('messages', public)
        # A version 2 flow is also incompatible with older importers.
        changed['version'] = 2
        state = self.save(games.load(self.api, self.claims, state['id'])[0], changed)
        self.publish(self.finish_test(state))
        self.assertEqual(games.list_games(self.api, None, {}, True)['games'], [])

    def test_model_never_receives_material_refs_and_preserves_creator_flow(self):
        self.configure_model()
        state = self.save(self.create(), campaign())
        proposed = deepcopy(state['spec']); proposed.pop('flow'); proposed['title'] = 'Updated journey'
        self.provider.converse.return_value = {'output': {'message': {'content': [{'text': json.dumps({'text': 'Updated title.', 'spec': proposed})}]}}}
        changed = self.message(state, 'Title: Updated journey')
        self.assertEqual(changed['spec']['version'], 7)
        self.assertEqual(changed['spec']['flow'], state['spec']['flow'])
        sent = json.loads(self.provider.converse.call_args.kwargs['messages'][0]['content'][0]['text'])
        self.assertNotIn('flow', sent['currentGame'])
        self.assertNotIn('ncacademy:lessons/fractions-1', json.dumps(sent))

    def test_model_cannot_change_creator_route_on_unrelated_edit(self):
        self.configure_model()
        state = self.save(self.create(), campaign())
        proposed = deepcopy(state['spec']); proposed.pop('flow'); proposed['levels'].pop()
        self.provider.converse.return_value = {'output': {'message': {'content': [{'text': json.dumps({'text': 'Updated title.', 'spec': proposed})}]}}}
        self.error(502, lambda: self.message(state, 'Title: A new title'))
        self.assertEqual(games.load(self.api, self.claims, state['id'])[0]['spec'], state['spec'])

    def test_model_cannot_invent_material_references_or_required_gates(self):
        self.configure_model()
        state = self.save(self.create(), campaign())
        self.provider.converse.return_value = {'output': {'message': {'content': [{'text': json.dumps({'text': 'Added lesson.', 'spec': campaign()})}]}}}
        self.error(502, lambda: self.message(state, 'Title: A new title'))
        self.assertEqual(games.load(self.api, self.claims, state['id'])[0]['spec'], state['spec'])

    def test_flow_does_not_bypass_request_or_record_size_limits(self):
        before = deepcopy(self.database.rows)
        oversized = {'id': support.GAME, 'revision': 0, 'spec': campaign(), 'messages': [{'role': 'user', 'text': 'x' * 300000}]}
        self.error(413, lambda: games.envelope('game', oversized, support.USER))
        event = {'requestContext': {'http': {'method': 'PUT'}}, 'rawPath': '/games/' + support.GAME,
            'body': json.dumps({'revision': 0, 'spec': campaign(), 'extra': 'x' * 280000})}
        with self.assertRaises(support.handler.APIError) as caught: support.handler.dispatch(event)
        self.assertEqual(caught.exception.status, 413)
        self.assertEqual(self.database.rows, before)
        self.provider.converse.assert_not_called()

    def test_creator_material_is_retained_as_level_count_changes(self):
        original = campaign()
        grown = games.design_game('4 levels', original)['spec']
        self.assertEqual(grown['version'], 7)
        self.assertEqual(grown['flow']['nodes'][:-1], original['flow']['nodes'])
        reduced = games.design_game('2 levels', original)['spec']
        self.assertEqual(reduced['flow']['nodes'], [node for node in original['flow']['nodes'] if node.get('levelId') != 'level-3'])
        self.error(400, lambda: games.design_game('Add multiplayer.', original))

    def test_arcade_score_validation_uses_flow_order_and_pixel_platformer_has_no_board(self):
        spec = games.design_game('Asteroids with 3 levels.')['spec']
        spec['flow'] = campaign()['flow']
        spec = games.validate_spec(spec)
        result = {'outcome': 'lost', 'elapsed': 5, 'score': 0, 'points': 10, 'reviewedLevelIds': ['level-2']}
        self.assertEqual(scores.validate_result(result, spec), result)
        with self.assertRaises(scores.ScoreError): scores.validate_result({**result, 'reviewedLevelIds': ['level-1']}, spec)
        state = self.publish(self.finish_test(self.save(self.create(), campaign())))
        with self.assertRaises(scores.ScoreError) as caught: scores.publication(self.api, state['id'], state['publishedRevision'])
        self.assertEqual(caught.exception.status, 404)


if __name__ == '__main__': unittest.main()
