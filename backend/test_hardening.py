import os
import tempfile
import threading
import time
import types

tmp = tempfile.mkdtemp()
os.environ["AUDIT_DB"] = os.path.join(tmp, "test_audit.db")
os.environ["PAYPAL_CLIENT_ID"] = "test-id"
os.environ["PAYPAL_CLIENT_SECRET"] = "test-secret"
os.environ["PAYPAL_BASE_URL"] = "https://paypal.test"
os.environ["PAYPAL_WEBHOOK_ID"] = "WH-TEST"
os.environ["ANTHROPIC_API_KEY"] = ""

import httpx
import get_token
import payments
import audit
import main
from fastapi.testclient import TestClient

passed = 0
failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name} {detail}")


class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.text = str(body)
        self.request = httpx.Request("POST", "https://paypal.test")

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "error", request=self.request,
                response=httpx.Response(self.status_code, json=self._body, request=self.request),
            )


token_calls = 0
calls = []
script = []


def fake_post(url, **kwargs):
    global token_calls
    if url.endswith("/v1/oauth2/token"):
        token_calls += 1
        return FakeResponse(200, {"access_token": f"T{token_calls}", "expires_in": 3600})
    calls.append((url, kwargs.get("headers", {})))
    item = script.pop(0)
    if isinstance(item, Exception):
        raise item
    return item


real_sleep = time.sleep
httpx.post = fake_post
payments.time = types.SimpleNamespace(sleep=lambda s: None)

print("--- PayPal token cache ---")
get_token._token = None
for _ in range(3):
    get_token.get_access_token()
check("token fetched once for three calls", token_calls == 1, f"(fetched {token_calls} times)")
get_token._expires_at = time.time() - 1
get_token.get_access_token()
check("expired token is refreshed", token_calls == 2)

print("\n--- PayPal retries and idempotency ---")
script[:] = [FakeResponse(503, {}), FakeResponse(503, {}), FakeResponse(201, {"id": "ORD-A", "links": []})]
calls.clear()
order = payments.create_order("10.00", "USD", "order-abc")
check("succeeds on the third attempt after two 503 errors", order["id"] == "ORD-A" and len(calls) == 3)
check("same idempotency key on every attempt", {h["PayPal-Request-Id"] for _, h in calls} == {"order-abc"})

script[:] = [httpx.ConnectTimeout("slow")] * 3
calls.clear()
try:
    payments.create_order("10.00", "USD", "order-x")
    check("gives up after three timeouts with a clear error", False)
except payments.PayPalUnavailable:
    check("gives up after three timeouts with a clear error", len(calls) == 3)

script[:] = [FakeResponse(422, {"name": "UNPROCESSABLE_ENTITY"})]
calls.clear()
try:
    payments.create_order("10.00", "USD", "order-y")
    check("a 422 is not retried", False)
except httpx.HTTPStatusError:
    check("a 422 is not retried", len(calls) == 1)

before = token_calls
get_token._token = None
script[:] = [FakeResponse(401, {}), FakeResponse(201, {"id": "ORD-B", "links": []})]
order = payments.create_order("10.00", "USD", "order-z")
check("a 401 gets a fresh token and one retry", order["id"] == "ORD-B" and token_calls == before + 2)

script[:] = [FakeResponse(201, {"status": "COMPLETED"})]
calls.clear()
payments.capture_order("ORD-C")
check("capture uses a stable idempotency key", calls[0][1]["PayPal-Request-Id"] == "capture-ORD-C")

saved = payments.BASE_URL
payments.BASE_URL = None
try:
    payments.create_order("10.00", "USD", "order-q")
    check("missing PayPal config gives a clear error", False)
except payments.PayPalUnavailable:
    check("missing PayPal config gives a clear error", True)
payments.BASE_URL = saved

print("\n--- Capture safety in the API ---")
counter = {"orders": 0, "captures": 0}


def fake_create(amount, currency, request_id):
    counter["orders"] += 1
    return {"id": f"ORD{counter['orders']}", "status": "CREATED",
            "links": [{"rel": "approve", "href": "https://paypal.test/approve"}]}


def fake_capture(order_id):
    counter["captures"] += 1
    return {"status": "COMPLETED"}


main.create_order = fake_create
main.capture_order = fake_capture
client = TestClient(main.app)

oid = client.post("/orders", json={"amount": "30", "hour": 12}).json()["order_id"]
history_before = len(main.HISTORY["alice"])
check("first capture succeeds", client.post(f"/orders/{oid}/capture").status_code == 200)
check("second capture is refused with 409", client.post(f"/orders/{oid}/capture").status_code == 409)
check("history recorded once, PayPal called once",
      len(main.HISTORY["alice"]) == history_before + 1 and counter["captures"] == 1)

oid = client.post("/orders", json={"amount": "30", "hour": 12}).json()["order_id"]


def unavailable(order_id):
    raise payments.PayPalUnavailable("PayPal is not responding. Please try again in a moment.")


main.capture_order = unavailable
r = client.post(f"/orders/{oid}/capture")
check("PayPal outage gives 503", r.status_code == 503)
main.capture_order = fake_capture
check("capture can be retried after an outage", client.post(f"/orders/{oid}/capture").status_code == 200)

oid = client.post("/orders", json={"amount": "30", "hour": 12}).json()["order_id"]
counter["captures"] = 0


def slow_capture(order_id):
    counter["captures"] += 1
    real_sleep(0.3)
    return {"status": "COMPLETED"}


main.capture_order = slow_capture
codes = []


def click():
    codes.append(TestClient(main.app).post(f"/orders/{oid}/capture").status_code)


threads = [threading.Thread(target=click) for _ in range(2)]
for t in threads:
    t.start()
for t in threads:
    t.join()
check("double click: one capture goes through, one gets 409", sorted(codes) == [200, 409], f"(got {codes})")
check("double click: PayPal was called exactly once", counter["captures"] == 1)
main.capture_order = fake_capture

step = client.post("/orders", json={"amount": "120", "payee_id": "new_guy", "hour": 12}).json()
check("step-up without confirmation is blocked (428)", client.post(f"/orders/{step['order_id']}/capture").status_code == 428)
check("step-up with confirmation works", client.post(f"/orders/{step['order_id']}/capture?confirmed=true").status_code == 200)

created = counter["orders"]
held = client.post("/orders", json={"amount": "10000", "payee_id": "new_guy", "hour": 3})
check("a hold returns 403 and never calls PayPal", held.status_code == 403 and counter["orders"] == created)

print("\n--- Configuration, limits and memory ---")
health = client.get("/health").json()
check("health reports configuration without secrets",
      health["paypal_configured"] is True and health["claude_configured"] is False and "secret" not in str(health).lower())
check("oversized webhook is refused (413)", client.post("/webhooks/paypal", content=b"x" * 1_000_001).status_code == 413)

store = {}
for i in range(10):
    main.remember(store, i, i, cap=3)
check("memory cap keeps only the newest entries", list(store) == [7, 8, 9])

check("audit chain is still valid after all of this", audit.verify()["ok"] is True)

statuses = []
last = None
for _ in range(45):
    last = client.post("/orders", json={"amount": "10000", "payee_id": "new_guy", "hour": 3})
    statuses.append(last.status_code)
check("rate limit returns 429 under a burst", 429 in statuses)
check("429 includes a Retry-After header", last.status_code == 429 and bool(last.headers.get("retry-after")))

print(f"\n{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)