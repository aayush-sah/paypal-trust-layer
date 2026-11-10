import os
import uuid
import httpx
from dotenv import load_dotenv
from get_token import get_access_token

load_dotenv()
BASE_URL = os.getenv("PAYPAL_BASE_URL")


def create_order(amount: str, currency: str = "USD"):
    token = get_access_token()
    response = httpx.post(
        f"{BASE_URL}/v2/checkout/orders",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "PayPal-Request-Id": str(uuid.uuid4()),
        },
        json={
            "intent": "CAPTURE",
            "purchase_units": [
                {"amount": {"currency_code": currency, "value": amount}}
            ],
        },
    )
    response.raise_for_status()
    return response.json()


def capture_order(order_id: str):
    token = get_access_token()
    response = httpx.post(
        f"{BASE_URL}/v2/checkout/orders/{order_id}/capture",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "PayPal-Request-Id": str(uuid.uuid4()),
        },
    )
    response.raise_for_status()
    return response.json()


if __name__ == "__main__":
    order = create_order("10.00")
    print("Order ID:", order["id"], "| Status:", order["status"])

    for link in order["links"]:
        if link["rel"] in ("approve", "payer-action"):
            print("Open this link and log in as the sandbox buyer:")
            print(link["href"])

    input("After approving in the browser, press Enter to capture...")

    result = capture_order(order["id"])
    print("Capture status:", result["status"])