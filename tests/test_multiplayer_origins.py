"""Synthetic exact primary/compatibility-origin admission; no AWS/network access."""
import json
import os
import unittest
from unittest.mock import patch

import test_multiplayer as existing

relay = existing.relay
PRIMARY = 'https://games.example.test'
LEGACY = 'https://legacy.example.test'


class MultiplayerOriginTests(unittest.TestCase):
    setUp = existing.MultiplayerTests.setUp
    event = existing.MultiplayerTests.event
    error = existing.MultiplayerTests.error

    def test_optional_alias_admits_only_two_exact_origins_in_http_and_websocket(self):
        with patch.dict(os.environ, {'APPLICATION_ORIGIN': PRIMARY, 'LEGACY_FRONTEND_ORIGIN': LEGACY}), patch.object(relay, 'clients', side_effect=self.api.clients):
            for index, origin in enumerate((PRIMARY, LEGACY)):
                event = self.event(); event.update(rawPath='/multiplayer/lobby'); event['requestContext']['http']['method'] = 'GET'; event['headers']['origin'] = origin
                result = relay.handler(event, None)
                self.assertEqual(result['statusCode'], 200)
                self.assertEqual(json.loads(result['body']), {'rooms': []})
                connect = self.event('origin-' + str(index), '$connect'); connect['headers']['origin'] = origin
                self.assertEqual(relay.websocket_handler(self.api, connect)['statusCode'], 200)
            for origin in ('https://unknown.example.test', 'https://www.games.example.test', LEGACY + '/', LEGACY + ':443', PRIMARY + ',' + LEGACY):
                event = self.event('blocked', '$connect'); event['headers']['origin'] = origin
                self.assertEqual(relay.websocket_handler(self.api, event)['statusCode'], 403)
            self.error(403, lambda: relay.origin({'headers': {'origin': PRIMARY, 'Origin': LEGACY}}))

    def test_empty_alias_preserves_single_origin_and_loopback_preview_without_widening(self):
        with patch.dict(os.environ, {'LEGACY_FRONTEND_ORIGIN': ''}):
            os.environ.pop('APPLICATION_ORIGIN', None)
            relay.origin(self.event())
            self.error(403, lambda: relay.origin({'headers': {'origin': LEGACY}}))
            os.environ['FRONTEND_ORIGIN'] = 'http://127.0.0.1:8096'
            relay.origin({'headers': {'origin': 'http://127.0.0.1:8096'}})
            self.error(403, lambda: relay.origin({'headers': {'origin': 'http://external.example.test:8096'}}))

    def test_malformed_duplicate_or_mismatched_configuration_fails_closed(self):
        for legacy in (PRIMARY, LEGACY + '/', LEGACY + ':443', 'http://legacy.example.test', 'https://*.example.test', 'https://Legacy.example.test', 'https://user:pass@legacy.example.test', LEGACY + '?next=private', LEGACY + '#private', 'https://.example.test', LEGACY + ',' + PRIMARY):
            with self.subTest(legacy=legacy), patch.dict(os.environ, {'APPLICATION_ORIGIN': PRIMARY, 'LEGACY_FRONTEND_ORIGIN': legacy}):
                self.error(503, lambda: relay.origin(self.event()))
        with patch.dict(os.environ, {'APPLICATION_ORIGIN': 'https://other.example.test', 'LEGACY_FRONTEND_ORIGIN': ''}):
            self.error(503, lambda: relay.origin(self.event()))


if __name__ == '__main__':
    unittest.main()
