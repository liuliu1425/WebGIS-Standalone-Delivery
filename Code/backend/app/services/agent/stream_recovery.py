"""Short-lived, owner-bound results for recovering an interrupted Agent stream."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from threading import Lock
from typing import Any, Literal


REQUEST_ID_HEADER = "X-Agent-Request-ID"
RECOVERY_KEY_HEADER = "X-Agent-Recovery-Key"
_REQUEST_ID = re.compile(r"[a-zA-Z0-9_-]{22,64}")
_RECOVERY_KEY = re.compile(r"[a-zA-Z0-9_-]{32,128}")

RecoveryOwner = tuple[str, ...]
RecoveryState = Literal["pending", "completed", "failed"]


def valid_request_id(value: str) -> bool:
    return bool(_REQUEST_ID.fullmatch(value))


def valid_recovery_key(value: str) -> bool:
    return bool(_RECOVERY_KEY.fullmatch(value))


@dataclass(frozen=True)
class Registration:
    request_id: str
    owner: RecoveryOwner
    key_digest: bytes


@dataclass
class _Record:
    registration: Registration
    expires_at: float
    state: RecoveryState = "pending"
    result: bytes | None = None


class StreamRecoveryStore:
    """Bounded local store for a single API process.

    The store tracks a result, not admission to execute an instruction. A
    missing, expired, or rejected record never authorizes another POST.
    """

    def __init__(
        self,
        *,
        max_records: int = 128,
        max_result_bytes: int = 128 * 1024,
        pending_ttl: float = 600,
        result_ttl: float = 300,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._records: dict[str, _Record] = {}
        self._lock = Lock()
        self._max_records = max_records
        self._max_result_bytes = max_result_bytes
        self._pending_ttl = pending_ttl
        self._result_ttl = result_ttl
        self._clock = clock

    def register(
        self, request_id: str, key: str, owner: RecoveryOwner
    ) -> Registration | None:
        now = self._clock()
        with self._lock:
            for expired in [
                name for name, record in self._records.items()
                if record.expires_at <= now
            ]:
                del self._records[expired]
            if request_id in self._records or len(self._records) >= self._max_records:
                return None
            registration = Registration(request_id, owner, hashlib.sha256(key.encode()).digest())
            self._records[request_id] = _Record(registration, now + self._pending_ttl)
            return registration

    def _pending_record(self, registration: Registration, now: float) -> _Record | None:
        record = self._records.get(registration.request_id)
        if (
            record is None
            or record.registration is not registration
            or record.state != "pending"
            or record.expires_at <= now
        ):
            return None
        return record

    def complete(self, registration: Registration, result: dict[str, Any]) -> None:
        # Keep an independent copy of the exact JSON result and cap retained data.
        try:
            encoded = json.dumps(
                result, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
        except (TypeError, ValueError, UnicodeError, RecursionError):
            encoded = b""
        now = self._clock()
        with self._lock:
            record = self._pending_record(registration, now)
            if record is None:
                return
            if not encoded or len(encoded) > self._max_result_bytes:
                del self._records[registration.request_id]
                return
            record.result = encoded
            record.state = "completed"
            record.expires_at = now + self._result_ttl

    def fail(self, registration: Registration) -> None:
        now = self._clock()
        with self._lock:
            record = self._pending_record(registration, now)
            if record is not None:
                record.state = "failed"
                record.expires_at = now + self._result_ttl

    def lookup(
        self, request_id: str, key: str, owner: RecoveryOwner
    ) -> dict[str, Any] | None:
        proof = hashlib.sha256(key.encode()).digest()
        now = self._clock()
        with self._lock:
            record = self._records.get(request_id)
            if (
                record is None
                or record.expires_at <= now
                or record.registration.owner != owner
                or not hmac.compare_digest(record.registration.key_digest, proof)
            ):
                return None
            state, result = record.state, record.result
        response: dict[str, Any] = {"state": state}
        if result is not None:
            response["result"] = json.loads(result)
        return response


stream_recovery = StreamRecoveryStore()
