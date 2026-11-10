import os
os.environ["PAYPAL_WEBHOOK_ID"] = "WH-TEST"

from fastapi.testclient import TestClient
import main
import webhooks


def make_event(event_id, order_id, amount):
    return {
        "id": event_id,
        "event_type": "PAYMENT.CAPTURE.COMPLETED",
        "resource": {
            "id": "CAP1",
            "status": "COMPLETED",
            "amount": {"currency_code": "USD", "value": amount},
            "supplementary_data": {"related_ids": {"order_id": order_id}},
        },
    }


main.ORDERS["ORD1"] = {
    "payer": "alice",
    "payee": "shop_a",
    "amount": 25.0,
    "risk": {"decision": "APPROVE"},
}
client = TestClient(main.app)


async def always_valid(headers, body):
    return True


print("--- Part 1: checking event contents ---")
r = webhooks.check_event(make_event("E1", "ORD1", "25.00"), main.ORDERS)
print("matching amount :", r["status"])
r = webhooks.check_event(make_event("E2", "ORD1", "250.00"), main.ORDERS)
print("wrong amount    :", r["status"], "-", r["findings"][0])
r = webhooks.check_event(make_event("E3", "ORDX", "25.00"), main.ORDERS)
print("unknown order   :", r["status"], "-", r["findings"][0])

print()
print("--- Part 2: the webhook door ---")
r = client.post("/webhooks/paypal", json=make_event("E4", "ORD1", "25.00"))
print("forged, no PayPal headers :", r.status_code, r.json())

main.verify_signature = always_valid
r = client.post("/webhooks/paypal", json=make_event("E5", "ORD1", "25.00"))
print("valid signature           :", r.status_code, r.json())
r = client.post("/webhooks/paypal", json=make_event("E5", "ORD1", "25.00"))
print("same event sent again     :", r.status_code, r.json())
r = client.post("/webhooks/paypal", json=make_event("E6", "ORD1", "999.00"))
print("valid but wrong amount    :", r.status_code, r.json())

print()
print("--- Event log ---")
for e in client.get("/events").json():
    print(e["status"], "|", e["findings"])