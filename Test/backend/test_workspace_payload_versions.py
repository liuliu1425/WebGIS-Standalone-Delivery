"""Regression tests for v1/v2 workspace payloads; temporary SQLite only."""
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from importlib import import_module
routes = import_module('app.api.routers.workspace_router')
from app.api.deps import require_session
from app.services.user_workspace_store import UserWorkspaceStore


class WorkspacePayloadVersions(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.store = UserWorkspaceStore(Path(self.tmp.name) / 'workspace.sqlite3')
        self.patch = patch.object(routes, 'get_user_workspace_store', return_value=self.store)
        self.patch.start()
        app = FastAPI()
        app.include_router(routes.router)
        app.dependency_overrides[require_session] = lambda: SimpleNamespace(user_id=72, role='admin')
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.patch.stop()
        self.store.close()
        self.tmp.cleanup()

    def push(self, payload, revision=0):
        return self.client.put('/workspace', json={'payload': payload, 'base_revision': revision})

    def test_legacy_v1_roundtrip(self):
        payload = {'version': 1, 'snapshot': {'version': 1, 'layers': []},
                   'dismissed': {'overlayLayerIds': ['imported-example']}}
        self.assertEqual(self.push(payload).status_code, 200)
        result = self.client.get('/workspace').json()['payload']
        self.assertEqual(result['snapshot'], payload['snapshot'])
        self.assertEqual(result['version'], 1)

    def test_scoped_v2_roundtrip_no_lost_buckets(self):
        payload = {'version': 2, 'scopes': {
            'http://127.0.0.1:15175': {'snapshot': {'layers': [{'id': 'test'}]}, 'dismissed': {}},
            'another-local-scope': {'snapshot': {'layers': []}, 'dismissed': {}},
        }}
        self.assertEqual(self.push(payload).status_code, 200)
        result = self.client.get('/workspace').json()['payload']
        self.assertEqual(result['version'], 2)
        self.assertEqual(result['scopes'], payload['scopes'])

    def test_empty_scopes_valid_but_missing_required_structure_rejected(self):
        self.assertEqual(self.push({'version': 2, 'scopes': {}}).status_code, 200)
        for payload in [
            {'version': 1}, {'version': 2}, {'version': 3, 'snapshot': {}},
            {'version': 2, 'scopes': {'scope': {'dismissed': {}}}},
            {'version': 2, 'scopes': {'scope': {'snapshot': []}}},
        ]:
            with self.subTest(payload=payload):
                self.assertEqual(self.push(payload).status_code, 422)

    def test_revision_conflict_does_not_overwrite(self):
        self.assertEqual(self.push({'version': 2, 'scopes': {}}).status_code, 200)
        r = self.push({'version': 2, 'scopes': {'x': {'snapshot': {}}}}, revision=0)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(self.client.get('/workspace').json()['payload']['scopes'], {})


if __name__ == '__main__':
    unittest.main()
