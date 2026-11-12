import json
import os
import threading
import uuid
from datetime import datetime, timezone

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
import httpx

load_dotenv()

from payments import create_order, capture_order, PayPalUnavailable
from risk import record, seed_demo_history, HISTORY
from decision import decide
from explain import explain
from webhooks import verify_signature, check_event
from stream import router as stream_router
from ratelimit import limit
import audit

ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if o.strip()
]
MAX_WEBHOOK_BYTES = 1_000_000

app = FastAPI(title="PayPal Trust Layer")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(stream_router)
app.include_router(audit.router, dependencies=[Depends(limit(120, 60))])
seed_demo_history()

ORDERS = {}
DECISIONS = {}
EVENTS = []
SEEN_EVENTS = {}
ORDER_LOCK = threading.Lock()

orders_limit = Depends(limit(30, 60))
capture_limit = Depends(limit(30, 60))
webhook_limit = Depends(limit(120, 60))
demo_limit = Depends(limit(20, 60))

PAYPAL_HINTS = {
    "ORDER_NOT_APPROVED": "The buyer has not approved this order yet. Finish Step 1 in PayPal first, then capture.",
    "ORDER_ALREADY_CAPTURED": "This order was already captured.",
    "INSTRUMENT_DECLINED": "The sandbox buyer's payment method was declined.",
    "PAYER_ACTION_REQUIRED": "The buyer still has to complete an action in PayPal. Finish Step 1 first.",
    "invalid_client": "PayPal rejected the Client ID or Secret. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.",
}


def config_status():
    return {
        "paypal_configured": bool(
            os.getenv("PAYPAL_CLIENT_ID") and os.getenv("PAYPAL_CLIENT_SECRET") and os.getenv("PAYPAL_BASE_URL")
        ),
        "webhook_configured": bool(os.getenv("PAYPAL_WEBHOOK_ID")),
        "claude_configured": bool(os.getenv("ANTHROPIC_API_KEY")),
    }


_WARNINGS = {
    "paypal_configured": "PayPal credentials are missing: real payments will fail (the simulator still works).",
    "webhook_configured": "PAYPAL_WEBHOOK_ID is missing: webhooks will be refused.",
    "claude_configured": "ANTHROPIC_API_KEY is missing: explanations use the built-in message.",
}
for _name, _ok in config_status().items():
    if not _ok:
        print("WARNING:", _WARNINGS[_name])


def remember(store, key, value, cap=2000):
    store[key] = value
    while len(store) > cap:
        store.pop(next(iter(store)))


def paypal_error(e: httpx.HTTPStatusError) -> str:
    try:
        body = e.response.json()
        first = (body.get("details") or [{}])[0]
        issue = first.get("issue") or body.get("name") or body.get("error") or "ERROR"
        description = first.get("description") or body.get("message") or body.get("error_description") or ""
    except ValueError:
        return f"PayPal error: {e.response.text[:200]}"
    return PAYPAL_HINTS.get(issue, f"PayPal error {issue}: {description}")


class OrderRequest(BaseModel):
    amount: str
    currency: str = "USD"
    payer_id: str = "alice"
    payee_id: str = "shop_a"
    hour: int | None = None

    @field_validator("amount")
    @classmethod
    def amount_must_be_positive_number(cls, v):
        try:
            value = float(v)
        except ValueError:
            raise ValueError("amount must be a number like '25.00'")
        if value <= 0:
            raise ValueError("amount must be greater than 0")
        return v

    @field_validator("hour")
    @classmethod
    def hour_in_range(cls, v):
        if v is not None and not 0 <= v <= 23:
            raise ValueError("hour must be between 0 and 23")
        return v


@app.get("/")
def root():
    return {"name": "PayPal Trust Layer", "docs": "/docs"}


@app.get("/health")
def health():
    return {"status": "ok", **config_status()}


@app.post("/orders", dependencies=[orders_limit])
def new_order(req: OrderRequest):
    risk = decide(req.payer_id, req.payee_id, float(req.amount), req.hour)

    decision_id = uuid.uuid4().hex[:12]
    remember(DECISIONS, decision_id, {"risk": risk, "amount": float(req.amount), "explanation": None})
    audit.append("decision", decision_id, {
        "decision": risk["decision"], "amount": float(req.amount),
        "payer": req.payer_id, "payee": req.payee_id,
        "rules_score": risk["rules_score"], "ml_score": risk["ml_score"], "reasons": risk["reasons"],
    })

    if risk["decision"] == "HOLD":
        raise HTTPException(
            status_code=403,
            detail={
                "message": "Held by Trust Layer. No PayPal order was created.",
                "decision_id": decision_id,
                **risk,
            },
        )

    try:
        order = create_order(req.amount, req.currency, f"order-{decision_id}")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=paypal_error(e))
    except PayPalUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))

    remember(ORDERS, order["id"], {
        "payer": req.payer_id,
        "payee": req.payee_id,
        "amount": float(req.amount),
        "risk": risk,
        "status": "created",
    })
    audit.append("order_created", order["id"], {"amount": float(req.amount), "decision_id": decision_id})

    approve_url = next(
        (l["href"] for l in order["links"] if l["rel"] in ("approve", "payer-action")),
        None,
    )
    return {
        "order_id": order["id"],
        "approve_url": approve_url,
        "decision_id": decision_id,
        "risk": risk,
    }


@app.post("/orders/{order_id}/capture", dependencies=[capture_limit])
def capture(order_id: str, confirmed: bool = False):
    info = ORDERS.get(order_id)
    if info is None:
        raise HTTPException(status_code=404, detail="Order never passed the Trust Layer")

    if info["risk"]["decision"] == "STEP_UP" and not confirmed:
        audit.append("capture_blocked", order_id, {"amount": info["amount"]})
        raise HTTPException(
            status_code=428,
            detail={"message": "Confirmation required before capture", **info["risk"]},
        )

    with ORDER_LOCK:
        state = info.get("status", "created")
        if state == "captured":
            raise HTTPException(status_code=409, detail="This order was already captured.")
        if state == "capturing":
            raise HTTPException(status_code=409, detail="A capture for this order is already in progress.")
        info["status"] = "capturing"

    try:
        result = capture_order(order_id)
    except httpx.HTTPStatusError as e:
        info["status"] = "created"
        reason = paypal_error(e)
        audit.append("capture_failed", order_id, {"amount": info["amount"], "reason": reason})
        raise HTTPException(status_code=502, detail=reason)
    except PayPalUnavailable as e:
        info["status"] = "created"
        audit.append("capture_failed", order_id, {"amount": info["amount"], "reason": str(e)})
        raise HTTPException(status_code=503, detail=str(e))

    info["status"] = "captured"
    record(info["payer"], info["payee"], info["amount"])
    audit.append("capture", order_id, {"amount": info["amount"], "status": result["status"], "confirmed": confirmed})
    return {"order_id": order_id, "status": result["status"], "risk": info["risk"]}


@app.get("/decisions/{decision_id}/explanation")
def decision_explanation(decision_id: str):
    d = DECISIONS.get(decision_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Unknown decision")

    if d["explanation"] is None:
        d["explanation"] = explain(d["risk"], d["amount"])

    return {"decision_id": decision_id, "decision": d["risk"]["decision"], **d["explanation"]}


def log_event(entry):
    entry["time"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    EVENTS.append(entry)
    del EVENTS[:-200]


@app.post("/webhooks/paypal", dependencies=[webhook_limit])
async def paypal_webhook(request: Request):
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_WEBHOOK_BYTES:
        raise HTTPException(status_code=413, detail="Payload too large")

    raw = await request.body()
    if len(raw) > MAX_WEBHOOK_BYTES:
        raise HTTPException(status_code=413, detail="Payload too large")

    try:
        valid = await verify_signature(request.headers, raw)
    except (httpx.HTTPError, RuntimeError) as e:
        print("Webhook verification unavailable:", type(e).__name__, str(e)[:100])
        raise HTTPException(status_code=503, detail="Could not verify right now, please retry")

    if not valid:
        if audit.allow_rejection_log():
            audit.append("webhook_rejected", "unknown", {"reason": "invalid or missing signature"})
        log_event({
            "event_type": None, "order_id": None, "status": "REJECTED",
            "findings": ["Invalid or missing PayPal signature"],
        })
        raise HTTPException(status_code=400, detail="Invalid signature")

    event = json.loads(raw)
    event_id = event.get("id")
    if event_id in SEEN_EVENTS:
        return {"status": "duplicate"}
    remember(SEEN_EVENTS, event_id, True, cap=5000)

    result = check_event(event, ORDERS)
    if result["status"] == "OK" and result["order_id"] in ORDERS:
        ORDERS[result["order_id"]]["webhook_confirmed"] = True
    log_event(result)
    audit.append("webhook", str(event_id), {
        "event_type": result["event_type"], "order_id": result["order_id"],
        "status": result["status"], "findings": result["findings"],
    })
    return {"status": result["status"]}


@app.get("/events")
def recent_events():
    return list(reversed(EVENTS[-50:]))


@app.post("/demo/reset", dependencies=[demo_limit])
def demo_reset():
    HISTORY.clear()
    seed_demo_history()
    ORDERS.clear()
    DECISIONS.clear()
    EVENTS.clear()
    SEEN_EVENTS.clear()
    return {"reset": True}