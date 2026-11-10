from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import httpx

from payments import create_order, capture_order
from risk import score_transaction, record, seed_demo_history

app = FastAPI(title="PayPal Trust Layer")
seed_demo_history()

ORDERS = {}


class OrderRequest(BaseModel):
    amount: str
    currency: str = "USD"
    payer_id: str = "alice"
    payee_id: str = "shop_a"
    hour: int | None = None


@app.get("/")
def root():
    return {"name": "PayPal Trust Layer", "docs": "/docs"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/orders")
def new_order(req: OrderRequest):
    risk = score_transaction(req.payer_id, req.payee_id, float(req.amount), req.hour)

    if risk["decision"] == "HOLD":
        raise HTTPException(status_code=403, detail={"message": "Held by Trust Layer", **risk})

    try:
        order = create_order(req.amount, req.currency)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=e.response.text)

    ORDERS[order["id"]] = {
        "payer": req.payer_id, "payee": req.payee_id,
        "amount": float(req.amount), "risk": risk,
    }
    approve_url = next(
        (l["href"] for l in order["links"] if l["rel"] in ("approve", "payer-action")),
        None,
    )
    return {"order_id": order["id"], "approve_url": approve_url, "risk": risk}


@app.post("/orders/{order_id}/capture")
def capture(order_id: str, confirmed: bool = False):
    info = ORDERS.get(order_id)
    if info is None:
        raise HTTPException(status_code=404, detail="Order never passed the Trust Layer")

    if info["risk"]["decision"] == "STEP_UP" and not confirmed:
        raise HTTPException(status_code=428, detail={"message": "Confirmation required", **info["risk"]})

    try:
        result = capture_order(order_id)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=e.response.text)

    record(info["payer"], info["payee"], info["amount"])
    return {"order_id": order_id, "status": result["status"], "risk": info["risk"]}