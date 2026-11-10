"""OpenAI models through LangChain. Tests swap in fakes with `use_models()`."""
from typing import Any, Optional

from app.config import get_settings


class MissingKey(RuntimeError):
    pass


_chat: Optional[Any] = None
_embed: Optional[Any] = None


def use_models(chat: Any = None, embeddings: Any = None) -> None:
    global _chat, _embed
    _chat, _embed = chat, embeddings


def configured() -> bool:
    return _chat is not None or bool(get_settings().openai_api_key)


def chat_model(temperature: float = 0.2):
    if _chat is not None:
        return _chat
    s = get_settings()
    if not s.openai_api_key:
        raise MissingKey("Set OPENAI_API_KEY in api/.env to use the AI features.")
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(model=s.chat_model, api_key=s.openai_api_key, temperature=temperature, timeout=60,
                      max_retries=2)


def embeddings():
    if _embed is not None:
        return _embed
    s = get_settings()
    if not s.openai_api_key:
        raise MissingKey("Set OPENAI_API_KEY in api/.env to index documents by meaning.")
    from langchain_openai import OpenAIEmbeddings
    return OpenAIEmbeddings(model=s.embed_model, api_key=s.openai_api_key)


def embeddings_ready() -> bool:
    return _embed is not None or bool(get_settings().openai_api_key)
