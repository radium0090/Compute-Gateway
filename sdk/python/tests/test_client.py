import io
import json
import os
import unittest
from unittest.mock import patch

from genchi import Genchi, GenchiAPIError, GenchiConnectionError


class FakeResponse:
    def __init__(self, status=200, body=b"{}", headers=None):
        self.status = status
        self.headers = headers or {}
        self._body = io.BytesIO(body)
        self.closed = False

    def read(self, amount=-1):
        return self._body.read(amount)

    def readline(self, limit=-1):
        return self._body.readline(limit)

    def close(self):
        self.closed = True


class GenchiTests(unittest.TestCase):
    def test_completion_and_models_send_auth_without_leaking_key(self):
        requests = []

        def transport(request, _timeout):
            requests.append(request)
            if request.full_url.endswith("/models"):
                return FakeResponse(body=b'{"object":"list","data":[]}')
            return FakeResponse(
                body=json.dumps(
                    {
                        "id": "c-1",
                        "object": "chat.completion",
                        "created": 1,
                        "model": "genchi/fast",
                        "choices": [],
                        "usage": {},
                        "genchi": {},
                    }
                ).encode()
            )

        client = Genchi(api_key="test-only-key", transport=transport)
        result = client.chat.completions.create(
            model="genchi/fast", messages=[{"role": "user", "content": "Hi"}]
        )
        models = client.models.list()

        self.assertEqual(result["id"], "c-1")
        self.assertEqual(models["object"], "list")
        self.assertEqual(requests[0].get_header("Authorization"), "Bearer test-only-key")
        self.assertNotIn("test-only-key", repr(result))
        self.assertEqual(json.loads(requests[0].data)["stream"], False)

    def test_canonical_error_and_status_retry(self):
        attempts = []
        error = {
            "error": {"message": "busy", "code": "provider_unavailable", "param": None},
            "genchi": {"request_id": "req-1", "retryable": True},
        }

        def transport(_request, _timeout):
            attempts.append(1)
            return FakeResponse(status=503, body=json.dumps(error).encode())

        client = Genchi(api_key="test", max_retries=1, transport=transport)
        with self.assertRaises(GenchiAPIError) as raised:
            client.models.list()
        self.assertEqual(len(attempts), 2)
        self.assertEqual(raised.exception.status, 503)
        self.assertEqual(raised.exception.code, "provider_unavailable")
        self.assertEqual(raised.exception.request_id, "req-1")

    def test_stream_parses_events_and_closes_when_consumer_stops(self):
        response = FakeResponse(
            body=(
                b'data: {"id":"chunk-1","choices":[]}\n\n'
                b'data: {"id":"chunk-2","choices":[]}\n\n'
                b"data: [DONE]\n\n"
            )
        )
        client = Genchi(api_key="test", transport=lambda _request, _timeout: response)
        stream = client.chat.completions.stream(
            model="genchi/fast", messages=[{"role": "user", "content": "Hi"}]
        )
        self.assertEqual(next(stream)["id"], "chunk-1")
        stream.close()
        self.assertTrue(response.closed)

    def test_missing_credentials_and_network_failures_are_safe(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "API key"):
                Genchi()

        def unavailable(_request, _timeout):
            raise OSError("contains internal endpoint details")

        client = Genchi(api_key="test", max_retries=0, transport=unavailable)
        with self.assertRaises(GenchiConnectionError) as raised:
            client.models.list()
        self.assertNotIn("internal endpoint", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
