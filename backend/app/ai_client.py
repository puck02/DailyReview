import json
from collections.abc import AsyncIterator

import httpx

from app.config import settings


async def stream_chat_completion(messages: list[dict], model: str) -> AsyncIterator[str]:
    if not settings.ai_base_url or not settings.ai_api_key or settings.ai_api_key == "change-me":
        yield "这是一个本地测试回答。生产环境会使用配置的 AI API。"
        return

    url = settings.ai_base_url.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.ai_api_key}",
        "Content-Type": "application/json",
    }
    payload = {"model": model, "messages": messages, "stream": True}
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line.removeprefix("data:").strip()
                if data == "[DONE]":
                    break
                chunk = json.loads(data)
                delta = chunk.get("choices", [{}])[0].get("delta", {})
                content = delta.get("content")
                if content:
                    yield content
