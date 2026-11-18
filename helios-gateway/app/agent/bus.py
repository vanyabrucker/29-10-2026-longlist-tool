"""In-process pub/sub for live session SSE (deltas + new stored events)."""

from __future__ import annotations

import threading
import uuid
from collections import defaultdict
from queue import Queue
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subs: dict[uuid.UUID, list[Queue]] = defaultdict(list)

    def subscribe(self, session_id: uuid.UUID) -> Queue:
        q: Queue = Queue()
        with self._lock:
            self._subs[session_id].append(q)
        return q

    def unsubscribe(self, session_id: uuid.UUID, q: Queue) -> None:
        with self._lock:
            subs = self._subs.get(session_id) or []
            if q in subs:
                subs.remove(q)
            if not subs:
                self._subs.pop(session_id, None)

    def publish(self, session_id: uuid.UUID, message: dict[str, Any]) -> None:
        with self._lock:
            subs = list(self._subs.get(session_id) or [])
        for q in subs:
            q.put(message)


bus = EventBus()
