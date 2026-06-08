import json
from collections.abc import AsyncIterator
from json import JSONDecodeError

import httpx

from app.admin.ai_config import AiConfig, get_ai_config
from app.config import settings


def _is_configured(config: AiConfig) -> bool:
    return bool(config.base_url and config.api_key and config.api_key != "change-me")


def _chat_completions_url(config: AiConfig) -> str:
    return config.base_url.rstrip("/") + "/chat/completions"


def _auth_headers(config: AiConfig) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }


def safe_ai_error_message(error: Exception) -> str:
    if isinstance(error, httpx.HTTPStatusError):
        return f"上游返回 HTTP {error.response.status_code}"
    if isinstance(error, httpx.TimeoutException):
        return "连接上游服务超时"
    if isinstance(error, httpx.ConnectError):
        return "无法连接上游服务"
    if isinstance(error, httpx.HTTPError):
        return "上游请求失败"
    if isinstance(error, (JSONDecodeError, ValueError)):
        return "上游返回格式异常"
    return "AI 服务测试失败"


async def complete_chat(messages: list[dict], model: str, fallback: str, ai_config: AiConfig | None = None) -> str:
    config = ai_config or get_ai_config()
    if not _is_configured(config):
        return fallback

    url = _chat_completions_url(config)
    headers = _auth_headers(config)
    payload = {"model": model, "messages": messages, "stream": False}
    async with httpx.AsyncClient(timeout=180, trust_env=True) as client:
        response = await client.post(url, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        return data.get("choices", [{}])[0].get("message", {}).get("content") or fallback


async def stream_chat_completion(messages: list[dict], model: str, ai_config: AiConfig | None = None) -> AsyncIterator[str]:
    config = ai_config or get_ai_config()
    if not _is_configured(config):
        yield "这是一个本地测试回答。生产环境会使用配置的 AI API。"
        return

    url = _chat_completions_url(config)
    headers = _auth_headers(config)
    payload = {"model": model, "messages": messages, "stream": True}
    async with httpx.AsyncClient(timeout=120, trust_env=True) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line.removeprefix("data:").strip()
                if data == "[DONE]":
                    break
                chunk = json.loads(data)
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta", {})
                content = delta.get("content")
                if content:
                    yield content


async def test_ai_connection(ai_config: AiConfig, model: str | None = None) -> str:
    if not _is_configured(ai_config):
        raise ValueError("AI config is incomplete")

    payload = {
        "model": model or settings.ai_default_model,
        "messages": [{"role": "user", "content": "请只回复 OK"}],
        "stream": False,
    }
    async with httpx.AsyncClient(timeout=30, trust_env=True) as client:
        response = await client.post(_chat_completions_url(ai_config), headers=_auth_headers(ai_config), json=payload)
        response.raise_for_status()
        data = response.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content")
        if not content:
            raise ValueError("Missing assistant content")
        return "AI 连接正常"
