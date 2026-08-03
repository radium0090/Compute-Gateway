# Generated from openapi/genchi.openapi.yaml. Do not edit by hand.
from typing import Literal, TypeAlias, TypedDict


class ChatCompletionRequest(TypedDict, total=False):
    model: str
    messages: list[dict[str, object]]
    temperature: float
    top_p: float
    max_tokens: int
    stop: str | list[str]
    stream: bool
    n: Literal[1]
    user: str


class ChatCompletionResponse(TypedDict, total=False):
    id: str
    object: Literal["chat.completion"]
    created: int
    model: str
    choices: list[dict[str, object]]
    usage: dict[str, object]
    genchi: dict[str, object]


class ChatCompletionChunk(TypedDict, total=False):
    id: str
    object: Literal["chat.completion.chunk"]
    created: int
    model: str
    choices: list[dict[str, object]]
    usage: dict[str, object]
    genchi: dict[str, object]


class ErrorResponse(TypedDict, total=False):
    error: dict[str, object]
    genchi: dict[str, object]


class LivenessResponse(TypedDict, total=False):
    status: Literal["ok"]


class ModelList(TypedDict, total=False):
    object: Literal["list"]
    data: list[dict[str, object]]


class ReadinessResponse(TypedDict, total=False):
    status: Literal["ready"] | Literal["not_ready"]
    checks: dict[str, object]
