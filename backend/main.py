import json
import uuid
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
import httpx

from payments import create_order, capture_order
from risk import record, seed_demo_history
from decision import decide
from explain import explain
from webhooks import verify_signature, check_event
from stream import router as stream_router

app = FastAPI(title="PayPal Trust Layer")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(stream_router)
seed_demo_history()

ORDERS = {}
DECISIONS = {}
EVENTS = []
SEEN_EVENTS = set()


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
    return {"status": "ok"}


@app.post("/orders")
def new_order(req: OrderRequest):
    risk = decide(req.payer_id, req.payee_id, float(req.amount), req.hour)

    decision_id = uuid.uuid4().hex[:12]
    DECISIONS[decision_id] = {"risk": risk, "amount": float(req.amount), "explanation": None}

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
        order = create_order(req.amount, req.currency)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=e.response.text)

    ORDERS[order["id"]] = {
        "payer": req.payer_id,
        "payee": req.payee_id,
        "amount": float(req.amount),
        "risk": risk,
    }

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


@app.post("/orders/{order_id}/capture")
def capture(order_id: str, confirmed: bool = False):
    info = ORDERS.get(order_id)
    if info is None:
        raise HTTPException(status_code=404, detail="Order never passed the Trust Layer")

    if info["risk"]["decision"] == "STEP_UP" and not confirmed:
        raise HTTPException(
            status_code=428,
            detail={"message": "Confirmation required before capture", **info["risk"]},
        )

    try:
        result = capture_order(order_id)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=e.response.text)

    record(info["payer"], info["payee"], info["amount"])
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


@app.post("/webhooks/paypal")
async def paypal_webhook(request: Request):
    raw = await request.body()

    try:
        valid = await verify_signature(request.headers, raw)
    except (httpx.HTTPError, RuntimeError) as e:
        print("Webhook verification unavailable:", type(e).__name__, str(e)[:100])
        raise HTTPException(status_code=503, detail="Could not verify right now, please retry")

    if not valid:
        log_event({
            "event_type": None, "order_id": None, "status": "REJECTED",
            "findings": ["Invalid or missing PayPal signature"],
        })
        raise HTTPException(status_code=400, detail="Invalid signature")

    event = json.loads(raw)
    event_id = event.get("id")
    if event_id in SEEN_EVENTS:
        return {"status": "duplicate"}
    SEEN_EVENTS.add(event_id)

    result = check_event(event, ORDERS)
    if result["status"] == "OK" and result["order_id"] in ORDERS:
        ORDERS[result["order_id"]]["webhook_confirmed"] = True
    log_event(result)
    return {"status": result["status"]}


@app.get("/events")
def recent_events():
    return list(reversed(EVENTS[-50:]))