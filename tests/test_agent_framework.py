"""Offline assistant contract and billing-boundary tests. No AWS/network calls."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

sys.modules.setdefault('boto3', types.SimpleNamespace())
sys.modules.setdefault('botocore', types.SimpleNamespace())
sys.modules.setdefault('botocore.config', types.SimpleNamespace(Config=lambda **options: options))
ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('assistant_test_module', ROOT / 'backend/nce_api/agent_framework.py')
assistant = importlib.util.module_from_spec(spec); spec.loader.exec_module(assistant)
handler_spec = importlib.util.spec_from_file_location('assistant_handler_test', ROOT / 'backend/nce_api/handler.py')
api = importlib.util.module_from_spec(handler_spec); handler_spec.loader.exec_module(api)
PID = '11111111-1111-4111-8111-111111111111'
SID = '22222222-2222-4222-8222-222222222222'
USER = '33333333-3333-4333-8333-333333333333'
ORG = '44444444-4444-4444-8444-444444444444'
SERVICE = '55555555-5555-4555-8555-555555555555'
ASSET = '66666666-6666-4666-8666-666666666666'
RID = '77777777-7777-4777-8777-777777777777'


class ConditionalFailure(Exception):
    response = {'Error': {'Code': 'ConditionalCheckFailedException'}}


class Condition:
    def __init__(self, fn): self.fn = fn
    def __and__(self, other): return Condition(lambda item: self.fn(item) and other.fn(item))


class Attribute:
    def __init__(self, key): self.key = key
    def eq(self, value): return Condition(lambda item: self.key in item and item[self.key] == value)
    def not_exists(self): return Condition(lambda item: self.key not in item)


class MemoryTable:
    def __init__(self): self.rows = {}; self.puts = []
    def get_item(self, Key, **options):
        item = self.rows.get(Key['id'])
        return {'Item': deepcopy(item)} if item else {}
    def put_item(self, Item, ConditionExpression):
        if not ConditionExpression.fn(self.rows.get(Item['id'], {})): raise ConditionalFailure()
        self.rows[Item['id']] = deepcopy(Item); self.puts.append(deepcopy(Item))


class FrameworkTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'CORE_ORGANIZATION_ID': ORG, 'CORE_SERVICE_ID': SERVICE, 'ASSISTANT_TABLE': 'assistant',
            'MEDIA_BUCKET': 'media', 'ALLOW_PAID_MODELS': 'false', 'BEDROCK_MODEL_ALLOWLIST': '', 'REKOGNITION_ENABLED': 'false'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.table = MemoryTable(); self.database = Mock(); self.database.Table.return_value = self.table
        self.post = None
        self.api = types.SimpleNamespace(clients=lambda: (self.database, Mock(), Mock()), get_post=lambda pid: self.post,
            changing=api.changing, post_id=api.post_id, media_key=api.media_key, CATEGORIES=api.CATEGORIES, MIMES=api.MIMES)
        self.claims = {'sub': USER, 'permissions': ['games-create', 'games-publish', 'agents-manage']}
        self.attr = patch.object(assistant, 'attr', Attribute); self.attr.start(); self.addCleanup(self.attr.stop)
        self.provider = Mock(); self.provider_patch = patch.object(assistant, 'provider', return_value=self.provider)
        self.provider_patch.start(); self.addCleanup(self.provider_patch.stop)
        self.provider.converse.return_value = {'output': {'message': {'content': [{'text': 'A reviewed suggestion.'}]}}, 'usage': {'inputTokens': 10, 'outputTokens': 5}}
        self.provider.detect_labels.return_value = {'Labels': [{'Name': 'Animal', 'Confidence': 92.83}]}
        self.context = {'title': 'Axolotl afternoon', 'excerpt': '', 'category': 'Stories',
            'document': json.dumps({'version': 1, 'theme': 'cream', 'layout': 'story', 'blocks': [{'id': 'words', 'type': 'text', 'nodes': []}]}), 'mediaIds': []}
    def create(self, mode='media-coach', context=None, sid=SID):
        return assistant.create_session(self.api, self.claims, {'id': sid, 'postId': PID, 'modeId': mode, 'context': context or self.context})
    def turn(self, state, action='message', message='Help me describe this.', request=RID, **values):
        body = {'requestId': request, 'revision': state['revision'], 'action': action, **values}
        if action == 'message': body['message'] = message
        return assistant.turn(self.api, self.claims, state['id'], body)
    def inventory_start(self, mode):
        state = self.turn(self.create(mode), 'workflow')
        return self.turn(state, 'advance', request=SERVICE)
    def configure(self, change):
        config = assistant.configuration(self.api); change(config)
        return assistant.put_configuration(self.api, {'config': config, 'expectedRevision': config['revision']})['config']
    def image(self, mime='image/png'):
        ext = api.MIMES[mime]
        block = {'id': 'picture', 'type': 'image', 'key': f'drafts/{PID}/{ASSET}.{ext}', 'mime': mime, 'name': 'My picture', 'caption': '', 'alt': ''}
        self.context['document'] = json.dumps({'version': 1, 'blocks': [block]}); self.context['mediaIds'] = ['picture']
        self.post = {'id': PID, 'document': self.context['document'], 'organization_id': ORG}
    def video(self):
        block = {'id': 'movie', 'type': 'video', 'key': f'drafts/{PID}/{ASSET}.mp4', 'mime': 'video/mp4', 'name': 'My movie', 'caption': '', 'alt': ''}
        self.context['document'] = json.dumps({'version': 1, 'blocks': [block]}); self.context['mediaIds'] = ['movie']
        self.post = {'id': PID, 'document': self.context['document'], 'organization_id': ORG}
    def enable_paid(self):
        self.configure(lambda config: config.update(allowPaidExecution=True))
    def error(self, status, callback):
        with self.assertRaises(assistant.FrameworkError) as caught: callback()
        self.assertEqual(caught.exception.status, status, caught.exception.message)
    def test_defaults_are_shared_valid_and_free(self):
        config = assistant.defaults()
        self.assertFalse(config['allowPaidExecution'])
        self.assertEqual({mode['id'] for mode in config['modes']}, {'media-coach', 'image-analysis', 'video-analysis'})
        self.assertFalse(assistant.settings(self.api)['paidModelsAllowed'])
        self.provider_patch.target.provider.assert_not_called()
    def test_new_unsaved_text_draft_can_chat(self):
        state = self.create(); result = self.turn(state)
        self.assertEqual(result['status'], 'ready'); self.assertEqual(result['usage']['modelCalls'], 0)
        self.assertEqual(len(result['messages']), 3)
        self.assertNotIn('_snapshot', result); self.assertNotIn('_context', result)
        self.provider_patch.target.provider.assert_not_called()
    def test_context_fingerprint_is_canonical_unicode_sha256(self):
        import hashlib
        self.context['title'] = 'Axolotl café'
        state = self.create()
        self.assertEqual(state['contextFingerprint'], hashlib.sha256(assistant.canonical(self.context).encode()).hexdigest())
    def test_create_receipt_reuses_same_session_only_same_context(self):
        state = self.create(); self.assertEqual(self.create(), state)
        changed = deepcopy(self.context); changed['title'] = 'Different'
        self.error(409, lambda: self.create(context=changed))
    def test_selected_media_must_be_saved_owned_draft_blocks(self):
        self.image(); self.post = None
        self.error(409, self.create)
        self.post = {'document': self.context['document']}
        forged = deepcopy(self.context)
        document = json.loads(forged['document']); document['blocks'][0]['key'] = f'drafts/{SID}/{ASSET}.png'; forged['document'] = json.dumps(document)
        self.error(400, lambda: self.create(context=forged))
        self.context['mediaIds'] = ['not-present']; self.error(400, self.create)
    def test_non_media_selection_rejected(self):
        self.post = {'document': self.context['document']}; self.context['mediaIds'] = ['words']
        self.error(400, self.create)
    def test_session_owner_and_organization_isolation(self):
        self.create(); self.claims['sub'] = ASSET
        self.error(404, lambda: assistant.load_session(self.api, self.claims, SID))
        self.claims['sub'] = USER; os.environ['CORE_SERVICE_ID'] = ASSET
        self.error(404, lambda: assistant.load_session(self.api, self.claims, SID))
    def test_config_cas_rejects_stale_updates(self):
        old = assistant.defaults(); new = assistant.put_configuration(self.api, {'config': old, 'expectedRevision': 0})
        self.assertEqual(new['config']['revision'], 1)
        self.error(409, lambda: assistant.put_configuration(self.api, {'config': old, 'expectedRevision': 0}))
    def test_unknown_skills_cycles_and_non_dependency_bindings_rejected(self):
        for mutation in ('unknown', 'cycle', 'binding'):
            config = assistant.defaults(); nodes = config['workflows'][0]['graph']['nodes']
            if mutation == 'unknown': nodes[0]['skill'] = 'shell.execute'
            if mutation == 'cycle': nodes[0]['depends_on'] = ['review']
            if mutation == 'binding': nodes[0]['inputs'] = {'x': {'$node': 'review'}}
            self.error(400, lambda: assistant.validate_config(config))
    def test_exact_binding_objects_strings_literal(self):
        self.create(); state = assistant.load_session(self.api, self.claims, SID)
        self.assertEqual(assistant.resolve('$context.media', state, {}), '$context.media')
        self.assertEqual(assistant.resolve({'$context': 'media'}, state, {}), [])
        self.assertEqual(assistant.resolve({'nested': [{'a': 'b'}]}, state, {}), {'nested': [{'a': 'b'}]})
    def test_workflow_executes_one_node_per_action(self):
        state = self.create()
        self.assertEqual(state['steps'], [])
        state = self.turn(state, 'workflow')
        self.assertEqual([step['status'] for step in state['steps']], ['pending', 'pending', 'pending'])
        state = self.turn(state, 'advance', request=SERVICE)
        self.assertEqual([step['status'] for step in state['steps']], ['complete', 'pending', 'pending'])
        state = self.turn(state, 'advance', request=ASSET)
        self.assertEqual([step['status'] for step in state['steps']], ['complete', 'complete', 'pending'])
        state = self.turn(state, 'advance', request=USER)
        self.assertEqual(state['status'], 'review'); self.assertIn('summary', state['suggestion'])
        self.provider_patch.target.provider.assert_not_called()
    def test_chat_caption_is_reviewed_explicit_user_wording_only(self):
        self.image(); state = self.turn(self.create(), message='caption: My axolotl hiding behind a plant\nalt: Pink salamander by green leaves')
        self.assertEqual(state['suggestion']['captions'][0], {'blockId': 'picture', 'caption': 'My axolotl hiding behind a plant', 'alt': 'Pink salamander by green leaves'})
        self.assertNotIn('status', state['suggestion'])
    def test_chat_title_is_reviewed_and_stale_proposal_clears(self):
        state = self.turn(self.create(), message='Title: The afternoon explorer')
        self.assertEqual(state['suggestion']['title'], 'The afternoon explorer')
        self.assertEqual(state['status'], 'review')
        state = self.turn(state, message='What else should I consider?', request=ASSET)
        self.assertEqual(state['status'], 'ready'); self.assertNotIn('suggestion', state)
    def test_alt_only_preserves_caption_and_video_does_not_get_alt(self):
        self.image(); document = json.loads(self.context['document']); document['blocks'][0]['caption'] = 'Keep this caption'
        self.context['document'] = json.dumps(document); self.post['document'] = self.context['document']
        state = self.turn(self.create(), message='Alt: A pink salamander')
        self.assertEqual(state['suggestion']['captions'], [{'blockId': 'picture', 'caption': 'Keep this caption', 'alt': 'A pink salamander'}])
        self.video(); state = self.create(sid=ASSET)
        state = self.turn(state, message='Alt: This is a movie')
        self.assertNotIn('suggestion', state)
    def test_explicit_suggestion_does_not_cross_newlines(self):
        self.image(); state = self.turn(self.create(), message='Title:\nCaption: Our little friend')
        self.assertNotIn('title', state['suggestion'])
        self.assertEqual(state['suggestion']['captions'][0]['caption'], 'Our little friend')
    def test_duplicate_request_is_idempotent_and_content_bound(self):
        first = self.create(); second = self.turn(first)
        self.assertEqual(self.turn(first), second)
        self.error(409, lambda: self.turn(second, message='Different request', request=RID))
        self.assertEqual(len(self.table.puts), 3)
    def test_stale_session_revision_rejected(self):
        state = self.create(); self.turn(state)
        self.error(409, lambda: self.turn(state, request=ASSET))
    def test_snapshot_is_immutable_but_current_revocations_apply(self):
        state = self.create()
        self.configure(lambda config: config['agents'][0].update(instructions='Updated future agent instructions'))
        stored = assistant.load_session(self.api, self.claims, SID)
        self.assertNotEqual(stored['_snapshot']['agents'][0]['instructions'], 'Updated future agent instructions')
        self.configure(lambda config: config['agents'][0].update(enabled=False))
        self.error(403, lambda: self.turn(state))
    def test_paid_image_requires_saved_admin_authorization_even_if_legacy_env_is_enabled(self):
        self.image(); state = self.inventory_start('image-analysis')
        self.error(403, lambda: self.turn(state, 'advance', request=ASSET))
        os.environ['ALLOW_PAID_MODELS'] = 'true'
        self.error(403, lambda: self.turn(state, 'advance', request=ASSET))
        self.provider_patch.target.provider.assert_not_called()
    def test_admin_save_enables_existing_session_without_env_gates_or_provider_calls(self):
        self.image(); state = self.inventory_start('image-analysis')
        self.error(403, lambda: self.turn(state, 'advance', request=ASSET))
        self.enable_paid()
        self.assertTrue(assistant.settings(self.api)['paidModelsAllowed'])
        self.provider_patch.target.provider.assert_not_called()
        result = self.turn(state, 'advance', request=ASSET)
        self.assertEqual(result['usage']['modelCalls'], 1)
        self.provider.detect_labels.assert_called_once()
    def test_legacy_mode_without_audience_remains_available(self):
        self.configure(lambda config: [mode.pop('audience', None) for mode in config['modes']])
        self.assertEqual(self.create()['modeId'], 'media-coach')
    def test_mode_audience_grant_and_live_revocation_apply_to_every_turn(self):
        self.image(); self.enable_paid()
        self.configure(lambda config: config['modes'][1].update(audience={'allEditors': False, 'userIds': [ASSET]}))
        self.error(403, lambda: self.create('image-analysis'))
        self.configure(lambda config: config['modes'][1].update(audience={'allEditors': False, 'userIds': [USER]}))
        state = self.inventory_start('image-analysis')
        self.configure(lambda config: config['modes'][1].update(audience={'allEditors': False, 'userIds': []}))
        self.error(403, lambda: self.turn(state, 'advance', request=ASSET))
        self.provider_patch.target.provider.assert_not_called()
    def test_writer_settings_only_offer_assigned_modes_and_hide_recipient_ids(self):
        self.configure(lambda config: config['modes'][1].update(audience={'allEditors': False, 'userIds': [ASSET]}))
        writer = {'sub': USER, 'permissions': ['games-create', 'games-publish']}
        settings = assistant.settings(self.api, writer)
        self.assertNotIn('image-analysis', settings['availableModeIds'])
        self.assertNotIn('image-analysis', {mode['id'] for mode in settings['config']['modes']})
        self.assertTrue(all('audience' not in mode for mode in settings['config']['modes']))
        self.assertEqual(len(assistant.settings(self.api, self.claims)['config']['modes']), 3)
    def test_invalid_mode_recipient_ids_and_duplicate_grants_are_rejected(self):
        for ids in [[USER, USER], ['not-a-core-subject'], [None]]:
            config = assistant.defaults(); config['modes'][0]['audience'] = {'allEditors': False, 'userIds': ids}
            self.error(400, lambda: assistant.validate_config(config))
    def test_changed_agent_model_and_mode_workflow_revoke_snapshot_capabilities(self):
        state = self.create()
        self.configure(lambda config: config['agents'][0].update(modelId='image-labels'))
        self.error(403, lambda: self.turn(state))
        self.configure(lambda config: config['agents'][0].update(modelId='local-coach'))
        self.configure(lambda config: config['modes'][0].update(workflowId='image-analysis'))
        self.error(403, lambda: self.turn(state))
        self.provider_patch.target.provider.assert_not_called()
    def test_changed_workflow_step_agent_revokes_snapshot_capabilities(self):
        state = self.create()
        self.configure(lambda config: config['workflows'][0]['graph']['nodes'][1].update(agent_id='image-analyst'))
        self.error(403, lambda: self.turn(state))
        self.provider_patch.target.provider.assert_not_called()
    def test_paid_image_call_is_reserved_before_io_and_not_replayed(self):
        self.image(); self.enable_paid(); state = self.inventory_start('image-analysis')
        def detect(**options):
            stored = assistant.load_session(self.api, self.claims, SID)
            self.assertEqual(stored['_inflight']['requestId'], ASSET); self.assertEqual(stored['usage']['modelCalls'], 1)
            return {'Labels': [{'Name': 'Animal', 'Confidence': 95.0}]}
        self.provider.detect_labels.side_effect = detect
        result = self.turn(state, 'advance', request=ASSET)
        self.assertEqual(result['steps'][1]['output']['items'][0]['name'], 'Animal')
        self.assertEqual(self.turn(state, 'advance', request=ASSET), result)
        self.provider.detect_labels.assert_called_once_with(Image={'S3Object': {'Bucket': 'media', 'Name': f'drafts/{PID}/{ASSET}.png'}}, MaxLabels=25, MinConfidence=75)
    def test_provider_timeout_is_uncertain_no_automatic_replay(self):
        self.image(); self.enable_paid(); state = self.inventory_start('image-analysis')
        self.provider.detect_labels.side_effect = TimeoutError('private provider detail')
        result = self.turn(state, 'advance', request=ASSET)
        self.assertEqual(result['status'], 'uncertain'); self.assertNotIn('private provider', result['error'])
        self.assertEqual(self.turn(state, 'advance', request=ASSET), result)
        self.error(409, lambda: self.turn(result, 'advance', request=USER))
        self.provider.detect_labels.assert_called_once()
    def test_known_provider_error_explains_remedy_without_leaking_raw_details_or_retrying(self):
        self.image(); self.enable_paid(); state = self.inventory_start('image-analysis')
        error = RuntimeError('private credentials and provider message')
        error.response = {'Error': {'Code': 'AccessDeniedException', 'Message': 'secret token value'}}
        self.provider.detect_labels.side_effect = error
        result = self.turn(state, 'advance', request=ASSET)
        self.assertEqual(result['status'], 'uncertain')
        self.assertIn('check this account’s model availability', result['error'])
        self.assertNotIn('private credentials', result['error']); self.assertNotIn('secret token', result['error'])
        self.assertEqual(self.turn(state, 'advance', request=ASSET), result)
        self.error(409, lambda: self.turn(result, 'advance', request=USER))
        self.provider.detect_labels.assert_called_once()
    def test_known_provider_hints_use_only_allowlisted_error_codes(self):
        for code, expected in [('AccessDeniedException', 'denied'), ('ResourceNotFoundException', 'could not find'),
                               ('ValidationException', 'rejected'), ('ThrottlingException', 'limiting')]:
            with self.subTest(code=code):
                error = RuntimeError('private response'); error.response = {'Error': {'Code': code, 'Message': 'private response'}}
                hint = assistant.provider_failure_hint(error)
                self.assertIn(expected, hint); self.assertNotIn('private response', hint)
        error = RuntimeError('private response'); error.response = {'Error': {'Code': 'UnexpectedSecretCode'}}
        self.assertEqual(assistant.provider_failure_hint(error), '')
    def test_uncertain_crash_marker_cannot_be_replayed(self):
        self.image(); self.enable_paid(); state = self.inventory_start('image-analysis')
        original = assistant.save
        def save_without_completion(api_arg, key, state_arg, *args, **kw):
            if state_arg['revision'] == 5: raise RuntimeError('simulated persistence outage')
            return original(api_arg, key, state_arg, *args, **kw)
        with patch.object(assistant, 'save', side_effect=save_without_completion):
            with self.assertRaises(RuntimeError): self.turn(state, 'advance', request=ASSET)
        stored = assistant.load_session(self.api, self.claims, SID)
        with patch.object(assistant.time, 'time', return_value=stored['_inflight']['at'] + 60):
            result = assistant.public(stored); self.assertEqual(result['status'], 'uncertain')
        self.turn(state, 'advance', request=ASSET)
        self.provider.detect_labels.assert_called_once()
    def test_unsupported_image_type_never_calls_provider(self):
        self.image('image/webp'); self.enable_paid(); state = self.inventory_start('image-analysis')
        self.error(400, lambda: self.turn(state, 'advance', request=ASSET))
        self.provider_patch.target.provider.assert_not_called()
    def test_video_checkpoints_one_operation_per_action(self):
        self.video(); self.enable_paid(); state = self.inventory_start('video-analysis')
        self.provider.start_label_detection.return_value = {'JobId': 'job'}
        state = self.turn(state, 'advance', request=ASSET)
        self.assertEqual(state['status'], 'waiting'); self.provider.get_label_detection.assert_not_called()
        options = self.provider.start_label_detection.call_args.kwargs
        self.assertEqual(len(options['ClientRequestToken']), 64)
        self.provider.get_label_detection.return_value = {'JobStatus': 'IN_PROGRESS'}
        state = self.turn(state, 'advance', request=USER)
        self.assertEqual(state['status'], 'waiting'); self.assertEqual(self.provider.get_label_detection.call_count, 1)
        self.provider.get_label_detection.return_value = {'JobStatus': 'SUCCEEDED', 'Labels': [{'Label': {'Name': 'Water', 'Confidence': 90}}]}
        state = self.turn(state, 'advance', request=PID)
        self.assertEqual(state['status'], 'ready'); self.assertEqual(state['steps'][1]['status'], 'complete')
        self.provider.start_label_detection.assert_called_once()
    def test_video_results_pagination_checkpoint_is_bounded(self):
        self.video(); self.enable_paid(); state = self.inventory_start('video-analysis')
        self.provider.start_label_detection.return_value = {'JobId': 'job'}
        state = self.turn(state, 'advance', request=ASSET)
        self.provider.get_label_detection.return_value = {'JobStatus': 'SUCCEEDED', 'Labels': [{'Label': {'Name': 'Water', 'Confidence': 90}}], 'NextToken': 'page2'}
        state = self.turn(state, 'advance', request=USER)
        self.assertEqual(state['status'], 'waiting')
        self.provider.get_label_detection.return_value = {'JobStatus': 'SUCCEEDED', 'Labels': []}
        state = self.turn(state, 'advance', request=PID)
        self.assertEqual(self.provider.get_label_detection.call_args.kwargs['NextToken'], 'page2')
        self.assertEqual(state['steps'][1]['status'], 'complete')
    def test_paid_gate_revocation_blocks_pending_video_poll(self):
        self.video(); self.enable_paid(); state = self.inventory_start('video-analysis')
        self.provider.start_label_detection.return_value = {'JobId': 'job'}
        state = self.turn(state, 'advance', request=ASSET)
        self.configure(lambda config: config.update(allowPaidExecution=False))
        self.error(403, lambda: self.turn(state, 'advance', request=USER))
        self.provider.get_label_detection.assert_not_called()
    def test_model_call_limit_prevents_extra_provider_call(self):
        self.image(); self.enable_paid(); self.configure(lambda config: config['limits'].update(maxModelCalls=0))
        state = self.inventory_start('image-analysis')
        self.error(409, lambda: self.turn(state, 'advance', request=ASSET))
        self.provider_patch.target.provider.assert_not_called()
    def test_enabled_admin_bedrock_target_uses_saved_registry_and_max_tokens(self):
        self.enable_paid()
        def change(config):
            config['models'][1].update(target='example.model-v1', enabled=True)
            config['agents'][0]['modelId'] = 'bedrock-writer'
        self.configure(change); state = self.create()
        result = self.turn(state)
        options = self.provider.converse.call_args.kwargs
        self.assertEqual(options['inferenceConfig']['maxTokens'], 1024)
        self.assertNotIn('toolConfig', options); self.assertEqual(result['usage'], {'modelCalls': 1, 'inputTokens': 10, 'outputTokens': 5})
    def test_current_lower_model_output_limit_applies_to_existing_snapshot(self):
        self.enable_paid()
        def change(config):
            config['models'][1].update(target='example.model-v1', enabled=True)
            config['agents'][0]['modelId'] = 'bedrock-writer'
        self.configure(change); state = self.create()
        self.configure(lambda config: config['models'][1].update(maxOutputTokens=64))
        result = self.turn(state)
        self.assertEqual(result['usage']['modelCalls'], 1)
        self.assertEqual(self.provider.converse.call_args.kwargs['inferenceConfig']['maxTokens'], 64)
    def test_bedrock_missing_usage_stays_uncertain(self):
        self.enable_paid()
        def change(config):
            config['models'][1].update(target='example.model-v1', enabled=True)
            config['agents'][0]['modelId'] = 'bedrock-writer'
        self.configure(change)
        self.provider.converse.return_value = {'output': {'message': {'content': [{'text': 'Unconfirmed reply'}]}}}
        result = self.turn(self.create())
        self.assertEqual(result['status'], 'uncertain')
        self.assertEqual(len(result['messages']), 2)
        self.assertNotIn('Unconfirmed reply', json.dumps(result))
    def test_valid_usage_retained_when_model_has_no_text(self):
        self.enable_paid()
        def change(config):
            config['models'][1].update(target='example.model-v1', enabled=True)
            config['agents'][0]['modelId'] = 'bedrock-writer'
        self.configure(change)
        self.provider.converse.return_value = {'output': {'message': {'content': []}}, 'usage': {'inputTokens': 10, 'outputTokens': 5}}
        state = self.turn(self.create())
        self.assertEqual(state['status'], 'uncertain')
        self.assertEqual(state['usage'], {'modelCalls': 1, 'inputTokens': 10, 'outputTokens': 5})
        self.assertNotIn('suggestion', state)
    def test_known_partial_usage_retained_but_response_stays_uncertain(self):
        self.enable_paid()
        def change(config):
            config['models'][1].update(target='example.model-v1', enabled=True)
            config['agents'][0]['modelId'] = 'bedrock-writer'
        self.configure(change)
        self.provider.converse.return_value['usage'] = {'inputTokens': 10}
        state = self.turn(self.create())
        self.assertEqual(state['status'], 'uncertain')
        self.assertEqual(state['usage'], {'modelCalls': 1, 'inputTokens': 10, 'outputTokens': 0})
    def test_output_cap_violation_retains_actual_usage_but_withholds_text(self):
        self.enable_paid()
        def change(config):
            config['models'][1].update(target='example.model-v1', enabled=True)
            config['agents'][0]['modelId'] = 'bedrock-writer'
        self.configure(change)
        self.provider.converse.return_value = {'output': {'message': {'content': [{'text': 'Over cap content'}]}}, 'usage': {'inputTokens': 10, 'outputTokens': 2000}}
        state = self.turn(self.create())
        self.assertEqual(state['status'], 'uncertain'); self.assertEqual(state['usage']['outputTokens'], 2000)
        self.assertNotIn('Over cap content', json.dumps(state))
    def test_current_media_removal_revokes_later_analysis(self):
        self.image(); self.enable_paid(); state = self.inventory_start('image-analysis')
        self.post['document'] = json.dumps({'version': 1, 'blocks': [{'id': 'words', 'type': 'text'}]})
        self.error(400, lambda: self.turn(state, 'advance', request=ASSET))
        self.provider_patch.target.provider.assert_not_called()
    def test_provider_inputs_hide_unselected_media_and_object_locations(self):
        self.image(); context_doc = json.loads(self.context['document'])
        context_doc['blocks'].append({'id': 'not-selected', 'type': 'image', 'key': f'drafts/{PID}/{USER}.png', 'mime': 'image/png', 'name': 'Unselected private file'})
        self.context['document'] = json.dumps(context_doc); self.post['document'] = self.context['document']
        self.create(); state = assistant.load_session(self.api, self.claims, SID)
        raw = assistant.resolve({'post': {'$context': 'post'}, 'selected': {'$context': 'media'}, 'url': 'https://s3.example/?X-Amz-Signature=private'}, state, {})
        clean = assistant.canonical(assistant.provider_input(raw, state))
        self.assertNotIn('Unselected private file', clean); self.assertNotIn('drafts/', clean); self.assertNotIn('Signature', clean)
        self.assertIn('My picture', clean)
    def test_bedrock_receives_bounded_conversation(self):
        self.enable_paid()
        def change(config):
            config['models'][1].update(target='example.model-v1', enabled=True)
            config['agents'][0]['modelId'] = 'bedrock-writer'
        self.configure(change)
        state = self.turn(self.create(), message='First detail about my pet')
        self.turn(state, message='Please use that detail', request=ASSET)
        prompt = json.loads(self.provider.converse.call_args.kwargs['messages'][0]['content'][0]['text'])
        self.assertIn('First detail about my pet', [entry['text'] for entry in prompt['conversation']])
    def test_bedrock_structured_suggestion_is_review_only_and_plain_text(self):
        self.image(); self.enable_paid()
        def change(config):
            config['models'][1].update(target='example.model-v1', enabled=True)
            config['agents'][0]['modelId'] = 'bedrock-writer'
        self.configure(change)
        proposed = {'text': 'Here is a draft to review.', 'suggestion': {'summary': 'Please check the wording.', 'title': 'A quiet afternoon',
            'excerpt': 'An afternoon by the plants.', 'blocks': [{'type': 'text', 'text': '<b>A plain text story</b>'}],
            'captions': [{'blockId': 'picture', 'caption': 'By the plants', 'alt': 'An axolotl near a plant'}]}}
        self.provider.converse.return_value['output']['message']['content'][0]['text'] = json.dumps(proposed)
        state = self.turn(self.create())
        self.assertEqual(state['suggestion']['title'], 'A quiet afternoon')
        block = state['suggestion']['blocks'][0]
        self.assertEqual(block['nodes'][0]['children'][0], {'tag': '#text', 'text': '<b>A plain text story</b>'})
        self.assertNotIn('status', state['suggestion']); self.assertNotIn('key', json.dumps(block))
        self.assertEqual(self.post['document'], self.context['document'])
        self.provider.converse.assert_called_once()
    def test_unsafe_or_malformed_model_suggestions_become_guidance(self):
        self.image(); self.create(); state = assistant.load_session(self.api, self.claims, SID)
        state['_inflight'] = {'requestId': RID}
        for suggestion in [
            {'summary': 'bad', 'captions': [{'blockId': 'unselected', 'caption': 'Hidden file'}]},
            {'summary': 'bad', 'blocks': [{'type': 'image', 'text': 'Attach a file'}]},
            {'summary': 'bad', 'blocks': [{'type': 'text', 'text': 'Words', 'html': '<script>x</script>'}]},
            {'summary': 'bad', 'blocks': [{'type': 'fact', 'text': 'A new unverified fact'}]},
            {'summary': 'bad', 'status': 'Published'},
        ]:
            result = assistant.structured_response(json.dumps({'text': 'Guidance is safe to read.', 'suggestion': suggestion}), state)
            self.assertEqual(result, {'text': 'Guidance is safe to read.'})
        content = '{"text":"truncated JSON"'
        self.assertEqual(assistant.structured_response(content, state), {'text': content})
    def test_model_cannot_add_alt_to_video_or_duplicate_caption_targets(self):
        self.video(); self.create(); state = assistant.load_session(self.api, self.claims, SID)
        for captions in [[{'blockId': 'movie', 'caption': 'Video', 'alt': 'Not an image'}],
                         [{'blockId': 'movie', 'caption': 'First'}, {'blockId': 'movie', 'caption': 'Second'}]]:
            result = assistant.structured_response(json.dumps({'text': 'Review this.', 'suggestion': {'summary': 'Check this.', 'captions': captions}}), state)
            self.assertNotIn('suggestion', result)
    def test_public_workflow_input_snapshot_survives_admin_edits(self):
        state = self.create()
        self.configure(lambda config: config['workflows'][0].update(name='New future name'))
        result = assistant.public(assistant.load_session(self.api, self.claims, SID))
        self.assertEqual(result['workflow'], state['workflow'])
        self.assertEqual(set(result['workflow']), {'id', 'name', 'description', 'inputs'})
    def test_exported_agent_node_surfaces_validated_workflow_suggestion(self):
        self.enable_paid()
        def change(config):
            config['models'][1].update(target='example.model-v1', enabled=True)
            config['agents'][0]['modelId'] = 'bedrock-writer'
            config['workflows'][0]['graph'].update(nodes=[{'id': 'writer', 'name': 'Write a draft', 'skill': 'agent.respond',
                'agent_id': 'media-coach', 'depends_on': [], 'inputs': {'message': 'Help draft an introduction.'}}], outputs=[{'name': 'suggestion', 'node_id': 'writer'}])
        self.configure(change)
        self.provider.converse.return_value['output']['message']['content'][0]['text'] = json.dumps({'text': 'Review this draft.', 'suggestion': {'summary': 'Check this title.', 'title': 'Our new story'}})
        state = self.turn(self.create(), 'workflow')
        result = self.turn(state, 'advance', request=ASSET)
        self.assertEqual(result['status'], 'review'); self.assertEqual(result['suggestion']['title'], 'Our new story')
    def test_unsafe_binding_paths_and_mixed_objects_rejected(self):
        for binding in ({'$node': 'inventory', 'path': '__proto__'}, {'$node': 'inventory', 'path': 'items.constructor'}, {'$context': 'media', 'extra': True}, {'$context': []}):
            config = assistant.defaults(); config['workflows'][0]['graph']['nodes'][1]['inputs'] = {'value': binding}
            self.error(400, lambda: assistant.validate_config(config))
    def test_workflow_chat_blocked_until_steps_complete(self):
        state = self.turn(self.create(), 'workflow')
        self.error(409, lambda: self.turn(state, request=ASSET))
        self.provider_patch.target.provider.assert_not_called()
    def test_cas_collision_blocks_provider_io(self):
        self.image(); self.enable_paid(); state = self.inventory_start('image-analysis')
        with patch.object(self.table, 'put_item', side_effect=ConditionalFailure()):
            self.error(409, lambda: self.turn(state, 'advance', request=ASSET))
        self.provider_patch.target.provider.assert_not_called()
    def test_limits_and_message_size_rejected_before_io(self):
        self.configure(lambda config: config['limits'].update(maxTurns=1))
        state = self.turn(self.create())
        self.error(409, lambda: self.turn(state, request=ASSET))
        other = self.create(sid=ASSET)
        self.error(400, lambda: self.turn(other, message='x' * 6001))
    def test_delete_removes_content_and_reserves_identifier(self):
        self.create(); result = assistant.delete_session(self.api, self.claims, SID)
        self.assertEqual(result, {'removed': True})
        encoded = self.table.rows[assistant.scoped_key('session', SID)]['payload']
        self.assertNotIn('Axolotl afternoon', encoded); self.assertNotIn('document', encoded)
        self.error(404, lambda: assistant.load_session(self.api, self.claims, SID))
        self.error(409, self.create)
    def test_session_delete_retry_is_owner_only_idempotent(self):
        self.create()
        self.assertEqual(assistant.delete_session(self.api, self.claims, SID), {'removed': True})
        self.assertEqual(assistant.delete_session(self.api, self.claims, SID), {'removed': True})
        self.claims['sub'] = ASSET
        self.error(404, lambda: assistant.delete_session(self.api, self.claims, SID))
        self.claims['sub'] = USER
        self.error(404, lambda: assistant.delete_session(self.api, self.claims, ASSET))
    def test_handler_routes_enforce_writer_and_admin_permissions(self):
        api._assistant = assistant
        def auth(event, *permissions):
            if any(permission not in self.claims['permissions'] for permission in permissions): raise api.APIError(403, 'Denied')
            return self.claims
        event = {'requestContext': {'http': {'method': 'GET'}}, 'rawPath': '/assistant/config', 'headers': {}}
        with patch.object(api, 'authorize', side_effect=auth), patch.object(api, 'clients', return_value=(self.database, Mock(), Mock())):
            self.assertEqual(api.handler(event, None)['statusCode'], 200)
            self.claims['permissions'] = ['games-create']
            event.update(body=json.dumps({'config': assistant.defaults(), 'expectedRevision': 0})); event['requestContext']['http']['method'] = 'PUT'
            self.assertEqual(api.handler(event, None)['statusCode'], 403)
            self.claims['permissions'] = []
            event['requestContext']['http']['method'] = 'GET'
            self.assertEqual(api.handler(event, None)['statusCode'], 403)
    def test_publishers_and_account_managers_cannot_authorize_models_but_agent_admins_can(self):
        api._assistant = assistant
        def auth(event, *permissions):
            if any(permission not in self.claims['permissions'] for permission in permissions): raise api.APIError(403, 'Denied')
            return self.claims
        event = {'requestContext': {'http': {'method': 'PUT'}}, 'rawPath': '/assistant/config', 'headers': {}}
        with patch.object(api, 'authorize', side_effect=auth), patch.object(api, 'clients', return_value=(self.database, Mock(), Mock())):
            for permissions, expected in [(['games-create', 'games-publish'], 403),
                    (['games-create', 'accounts-manage'], 403), (['games-create', 'agents-manage'], 200),
                    (['games-create', 'admin'], 403)]:
                with self.subTest(permissions=permissions):
                    self.claims['permissions'] = permissions
                    config = assistant.configuration(self.api); config['allowPaidExecution'] = True
                    event['body'] = json.dumps({'config': config, 'expectedRevision': config['revision']})
                    self.assertEqual(api.handler(event, None)['statusCode'], expected)
            self.provider_patch.target.provider.assert_not_called()
    def test_payload_bound_is_checked_before_storage(self):
        self.error(413, lambda: assistant.save(self.api, 'too-large', {'revision': 0, 'huge': 'x' * 330001}))
        self.assertEqual(self.table.rows, {})


if __name__ == '__main__':
    unittest.main()
