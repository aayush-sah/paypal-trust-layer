import os
import threading
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

CLIENT_ID = os.getenv("PAYPAL_CLIENT_ID")
CLIENT_SECRET = os.getenv("PAYPAL_CLIENT_SECRET")
BASE_URL = os.getenv("PAYPAL_BASE_URL")

_lock = threading.Lock()
_token = None
_expires_at = 0.0


def get_access_token():
    global _token, _expires_at
    with _lock:
        if _token and time.time() < _expires_at - 60:
            return _token

        if not (CLIENT_ID and CLIENT_SECRET and BASE_URL):
            raise RuntimeError("PayPal credentials are missing. Check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_BASE_URL in .env")

        response = httpx.post(
            f"{BASE_URL}/v1/oauth2/token",
            auth=(CLIENT_ID, CLIENT_SECRET),
            data={"grant_type": "client_credentials"},
            timeout=15,
        )
        response.raise_for_status()
        body = response.json()
        _token = body["access_token"]
        _expires_at = time.time() + float(body.get("expires_in", 300))
        return _token


def clear_token():
    global _token
    with _lock:
        _token = None


if __name__ == "__main__":
    token = get_access_token()
    print("Token received:", token[:12] + "...")