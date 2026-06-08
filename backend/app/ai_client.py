import json
from collections.abc import AsyncIterator

import httpx

from app.admin.ai_config import AiConfig, get_ai_config
from app.config import settings


async def complete_chat(messages: list[dict], model: str, fallback: str, ai_config: AiConfig | None = None) -> str:
    config = ai_config or get_ai_config()
    if not config.base_url or not config.api_key or config.api_key == "change-me":
        return fallback

    url = config.base_url.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }
    payload = {"model": model, "messages": messages, "stream": False}
    async with httpx.AsyncClient(timeout=180, trust_env=False) as client:
        response = await client.post(url, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        return data.get("choices", [{}])[0].get("message", {}).get("content") or fallback


async def stream_chat_completion(messages: list[dict], model: str, ai_config: AiConfig | None = None) -> AsyncIterator[str]:
    config = ai_config or get_ai_config()
    if not config.base_url or not config.api_key or config.api_key == "change-me":
        yield "这是一个本地测试回答。生产环境会使用配置的 AI API。"
        return

    url = config.base_url.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }
    payload = {"model": model, "messages": messages, "stream": True}
    async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
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
