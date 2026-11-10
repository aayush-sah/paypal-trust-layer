import math
from datetime import timedelta

FEATURE_NAMES = ["log_ratio", "new_payee", "hour", "velocity"]


def live_features(past, payee, amount, hour, now):
    log_ratio = 0.0
    if len(past) >= 3:
        avg = sum(t["amount"] for t in past) / len(past)
        log_ratio = math.log(max(amount, 0.01) / avg)

    new_payee = 1.0 if past and payee not in {t["payee"] for t in past} else 0.0
    velocity = float(sum(1 for t in past if now - t["time"] < timedelta(seconds=60)))

    return [log_ratio, new_payee, float(hour), velocity]