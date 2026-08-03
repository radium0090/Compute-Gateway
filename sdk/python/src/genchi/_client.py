from __future__ import annotations

import json
import os
import socket
from collections.abc import Callable, Generator
from typing import Any, BinaryIO, Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ._generated.models import (
    ChatCompletionChunk,
    ChatCompletionRequest,
    ChatCompletionResponse,
    LivenessResponse,
    ModelList,
    ReadinessResponse,
)


class GenchiAPIError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status: int,
        code: str,
        request_id: str | None,
        retryable: bool,
        param: str | None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id
        self.retryable = retryable
        self.param = param


class GenchiConnectionError(Exception):
    pass


class Response(Protocol):
    status: int
    headers: Any

    def read(self, amount: int = -1) -> bytes: ...

    def readline(self, limit: int = -1) -> bytes: ...

    def close(self) -> None: ...


Transport = Callable[[Request, float], Response]


def _default_transport(request: Request, timeout: float) -> Response:
    try:
        return cast(Response, urlopen(request, timeout=timeout))
    except HTTPError as error:
        return cast(Response, error)


def _should_retry(status: int) -> bool:
    return status == 429 or status >= 500


def _bounded_int(value: int, name: str, *, positive: bool) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an integer")
    if (positive and value <= 0) or (not positive and value < 0):
        qualifier = "positive" if positive else "non-negative"
        raise ValueError(f"{name} must be {qualifier}")
    return value


class _Completions:
    def __init__(self, client: Genchi) -> None:
        self._client = client

    def create(self, **request: Any) -> ChatCompletionResponse:
        request["stream"] = False
        return cast(
            ChatCompletionResponse,
            self._client._json("POST", "/chat/completions", request, True),
        )

    def stream(self, **request: Any) -> Generator[ChatCompletionChunk, None, None]:
        request["stream"] = True
        return self._client._stream("/chat/completions", request)


class _Chat:
    def __init__(self, client: Genchi) -> None:
        self.completions = _Completions(client)


class _Models:
    def __init__(self, client: Genchi) -> None:
        self._client = client

    def list(self) -> ModelList:
        return cast(ModelList, self._client._json("GET", "/models", None, True))


class _Health:
    def __init__(self, client: Genchi) -> None:
        self._client = client

    def live(self) -> LivenessResponse:
        return cast(LivenessResponse, self._client._health("/health/live"))

    def ready(self) -> ReadinessResponse:
        return cast(ReadinessResponse, self._client._health("/health/ready"))


class Genchi:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout_seconds: int | None = None,
        max_retries: int | None = None,
        transport: Transport | None = None,
    ) -> None:
        resolved_key = api_key if api_key is not None else os.getenv("GENCHI_API_KEY")
        if not resolved_key:
            raise ValueError("A Genchi API key is required")
        self._api_key = resolved_key
        self._base_url = (
            base_url
            or os.getenv("GENCHI_BASE_URL")
            or "http://localhost:8080/v1"
        ).rstrip("/")
        self._timeout = _bounded_int(
            timeout_seconds
            if timeout_seconds is not None
            else int(os.getenv("GENCHI_TIMEOUT_SECONDS", "60")),
            "timeout_seconds",
            positive=True,
        )
        self._max_retries = _bounded_int(
            max_retries
            if max_retries is not None
            else int(os.getenv("GENCHI_MAX_RETRIES", "1")),
            "max_retries",
            positive=False,
        )
        self._transport = transport or _default_transport
        self.chat = _Chat(self)
        self.models = _Models(self)
        self.health = _Health(self)

    def _request(
        self,
        method: str,
        target: str,
        body: dict[str, Any] | None,
        authenticated: bool,
    ) -> Response:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Accept": "application/json, text/event-stream"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if authenticated:
            headers["Authorization"] = f"Bearer {self._api_key}"
        request = Request(
            target if target.startswith(("http://", "https://")) else self._base_url + target,
            data=payload,
            headers=headers,
            method=method,
        )
        last_error: Exception | None = None
        for attempt in range(self._max_retries + 1):
            try:
                response = self._transport(request, float(self._timeout))
            except (OSError, TimeoutError, URLError, socket.timeout) as error:
                last_error = error
                if attempt < self._max_retries:
                    continue
                raise GenchiConnectionError("Unable to reach the Genchi gateway.") from error
            if _should_retry(response.status) and attempt < self._max_retries:
                response.close()
                continue
            return response
        raise GenchiConnectionError("Unable to reach the Genchi gateway.") from last_error

    def _api_error(self, response: Response) -> GenchiAPIError:
        try:
            value = json.loads(response.read())
        except (json.JSONDecodeError, UnicodeDecodeError):
            value = {}
        error = value.get("error") if isinstance(value, dict) else None
        genchi = value.get("genchi") if isinstance(value, dict) else None
        error = error if isinstance(error, dict) else {}
        genchi = genchi if isinstance(genchi, dict) else {}
        request_id = genchi.get("request_id")
        if not isinstance(request_id, str):
            request_id = response.headers.get("x-request-id")
        return GenchiAPIError(
            error.get("message")
            if isinstance(error.get("message"), str)
            else "The Genchi gateway rejected the request.",
            status=response.status,
            code=error.get("code")
            if isinstance(error.get("code"), str)
            else "gateway_request_failed",
            request_id=request_id if isinstance(request_id, str) else None,
            retryable=genchi.get("retryable")
            if isinstance(genchi.get("retryable"), bool)
            else _should_retry(response.status),
            param=error.get("param") if isinstance(error.get("param"), str) else None,
        )

    def _json(
        self,
        method: str,
        target: str,
        body: dict[str, Any] | None,
        authenticated: bool,
    ) -> object:
        response = self._request(method, target, body, authenticated)
        try:
            if not 200 <= response.status < 300:
                raise self._api_error(response)
            return json.loads(response.read())
        finally:
            response.close()

    def _health(self, path: str) -> object:
        root = self._base_url[:-3] if self._base_url.endswith("/v1") else self._base_url
        return self._json("GET", root + path, None, False)

    def _stream(
        self, target: str, body: dict[str, Any]
    ) -> Generator[ChatCompletionChunk, None, None]:
        response = self._request("POST", target, body, True)
        if not 200 <= response.status < 300:
            try:
                raise self._api_error(response)
            finally:
                response.close()

        def events() -> Generator[ChatCompletionChunk, None, None]:
            data_lines: list[str] = []
            saw_done = False
            try:
                while line := response.readline():
                    decoded = line.decode("utf-8").rstrip("\r\n")
                    if decoded == "":
                        if not data_lines:
                            continue
                        data = "\n".join(data_lines)
                        data_lines.clear()
                        if data == "[DONE]":
                            saw_done = True
                            return
                        yield cast(ChatCompletionChunk, json.loads(data))
                    elif decoded.startswith("data:"):
                        data_lines.append(decoded[5:].lstrip())
                if data_lines:
                    data = "\n".join(data_lines)
                    if data == "[DONE]":
                        saw_done = True
                        return
                    yield cast(ChatCompletionChunk, json.loads(data))
                if not saw_done:
                    raise GenchiConnectionError(
                        "The Genchi stream ended before the [DONE] marker."
                    )
            finally:
                response.close()

        return events()
