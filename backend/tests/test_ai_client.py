import asyncio

from app import ai_client
from app.config import settings


def test_stream_chat_completion_ignores_proxy_environment(monkeypatch):
    monkeypatch.setattr(settings, "ai_base_url", "https://example.test/v1")
    monkeypatch.setattr(settings, "ai_api_key", "test-key")
    monkeypatch.setattr(settings, "ai_default_model", "gpt-5.4-mini")

    captured: dict[str, object] = {}

    class FakeStream:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def aiter_lines(self):
            yield "data: [DONE]"

        def raise_for_status(self):
            return None

    class FakeClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, *args, **kwargs):
            return FakeStream()

    monkeypatch.setattr(ai_client.httpx, "AsyncClient", FakeClient)

    async def collect_tokens():
        return [
            token
            async for token in ai_client.stream_chat_completion([{"role": "user", "content": "hi"}], "gpt-5.4-mini")
        ]

    tokens = asyncio.run(collect_tokens())

    assert tokens == []
    assert captured["trust_env"] is False
