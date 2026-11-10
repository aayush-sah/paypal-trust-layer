import asyncio
import json
import os

import httpx
from dotenv import load_dotenv

from get_token import get_access_token

load_dotenv()

BASE_URL = os.getenv("PAYPAL_BASE_URL")
WEBHOOK_ID = os.getenv("PAYPAL_WEBHOOK_ID")

REQUIRED_HEADERS = [
    "paypal-auth-algo",
    "paypal-cert-url",
    "paypal-transmission-id",
    "paypal-transmission-sig",
    "paypal-transmission-time",
]


async def verify_signature(headers, raw_body: bytes) -> bool:
    if not WEBHOOK_ID:
        raise RuntimeError("PAYPAL_WEBHOOK_ID is missing in .env")

    h = {k.lower(): v for k, v in headers.items()}
    if any(name not in h for name in REQUIRED_HEADERS):
        return False

    try:
        body_text = raw_body.decode("utf-8")
    except UnicodeDecodeError:
        return False

    payload = (
        "{"
        f'"auth_algo": {json.dumps(h["paypal-auth-algo"])}, '
        f'"cert_url": {json.dumps(h["paypal-cert-url"])}, '
        f'"transmission_id": {json.dumps(h["paypal-transmission-id"])}, '
        f'"transmission_sig": {json.dumps(h["paypal-transmission-sig"])}, '
        f'"transmission_time": {json.dumps(h["paypal-transmission-time"])}, '
        f'"webhook_id": {json.dumps(WEBHOOK_ID)}, '
        f'"webhook_event": {body_text}'
        "}"
    )

    token = await asyncio.to_thread(get_access_token)
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(
            f"{BASE_URL}/v1/notifications/verify-webhook-signature",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            content=payload,
        )

    return response.status_code == 200 and response.json().get("verification_status") == "SUCCESS"


def check_event(event, orders):
    event_type = event.get("event_type")
    findings = []
    order_id = None

    if event_type == "PAYMENT.CAPTURE.COMPLETED":
        try:
            resource = event["resource"]
            order_id = resource["supplementary_data"]["related_ids"]["order_id"]
            paid = float(resource["amount"]["value"])
        except (KeyError, TypeError, ValueError):
            findings.append("Capture event is missing the order id or amount")
        else:
            info = orders.get(order_id)
            if info is None:
                findings.append("Payment completed for an order that never passed the Trust Layer")
            elif abs(info["amount"] - paid) > 0.005:
                findings.append(
                    f"Amount mismatch: Trust Layer approved {info['amount']:.2f}, PayPal reports {paid:.2f}"
                )

    return {
        "event_type": event_type,
        "order_id": order_id,
        "status": "ANOMALY" if findings else "OK",
        "findings": findings,
    }