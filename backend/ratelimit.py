import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request


class RateLimiter:
    def __init__(self, max_calls, per_seconds):
        self.max_calls = max_calls
        self.per_seconds = per_seconds
        self.calls = defaultdict(deque)
        self.lock = threading.Lock()

    def check(self, key):
        now = time.monotonic()
        with self.lock:
            if len(self.calls) > 5000:
                for k in [k for k, q in self.calls.items() if not q or now - q[-1] > self.per_seconds]:
                    del self.calls[k]

            q = self.calls[key]
            while q and now - q[0] > self.per_seconds:
                q.popleft()
            if len(q) >= self.max_calls:
                return int(self.per_seconds - (now - q[0])) + 1
            q.append(now)
            return 0


def limit(max_calls, per_seconds):
    limiter = RateLimiter(max_calls, per_seconds)

    def dependency(request: Request):
        ip = request.client.host if request.client else "unknown"
        wait = limiter.check(ip)
        if wait:
            raise HTTPException(
                status_code=429,
                detail=f"Too many requests. Try again in {wait} seconds.",
                headers={"Retry-After": str(wait)},
            )

    return dependency