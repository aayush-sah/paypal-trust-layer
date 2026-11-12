import os
import time

import httpx
from dotenv import load_dotenv

from get_token import get_access_token, clear_token

load_dotenv()
BASE_URL = os.getenv("PAYPAL_BASE_URL")

MAX_ATTEMPTS = 3
RETRY_STATUS = {429, 500, 502, 503, 504}


class PayPalUnavailable(Exception):
    pass


def _post(path, request_id, body=None):
    if not BASE_URL:
        raise PayPalUnavailable("PAYPAL_BASE_URL is missing. Check your .env file.")

    for attempt in range(MAX_ATTEMPTS):
        last_attempt = attempt == MAX_ATTEMPTS - 1
        try:
            token = get_access_token()
            response = httpx.post(
                f"{BASE_URL}{path}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "PayPal-Request-Id": request_id,
                },
                json=body,
                timeout=15,
            )
        except RuntimeError as e:
            raise PayPalUnavailable(str(e))
        except httpx.TransportError:
            if last_attempt:
                break
            time.sleep(0.5 * 2 ** attempt)
            continue

        if response.status_code == 401 and attempt == 0:
            clear_token()
            continue
        if response.status_code in RETRY_STATUS and not last_attempt:
            time.sleep(0.5 * 2 ** attempt)
            continue

        response.raise_for_status()
        return response.json()

    raise PayPalUnavailable("PayPal is not responding. Please try again in a moment.")


def create_order(amount: str, currency: str, request_id: str):
    return _post(
        "/v2/checkout/orders",
        request_id,
        {
            "intent": "CAPTURE",
            "purchase_units": [{"amount": {"currency_code": currency, "value": amount}}],
        },
    )


def capture_order(order_id: str):
    return _post(f"/v2/checkout/orders/{order_id}/capture", f"capture-{order_id}")


if __name__ == "__main__":
    order = create_order("10.00", "USD", "manual-test-order")
    print("Order ID:", order["id"], "| Status:", order["status"])

    for link in order["links"]:
        if link["rel"] in ("approve", "payer-action"):
            print("Open this link and log in as the sandbox buyer:")
            print(link["href"])

    input("After approving in the browser, press Enter to capture...")

    result = capture_order(order["id"])
    print("Capture status:", result["status"])