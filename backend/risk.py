from collections import defaultdict
from datetime import datetime, timedelta

HISTORY = defaultdict(list)


def seed_demo_history():
    past = datetime.now() - timedelta(days=1)
    for amount, payee in [(20, "shop_a"), (35, "shop_a"), (50, "cafe_b"),
                          (25, "shop_a"), (40, "cafe_b")]:
        HISTORY["alice"].append({"amount": amount, "payee": payee, "time": past})


def record(payer, payee, amount):
    HISTORY[payer].append({"amount": amount, "payee": payee, "time": datetime.now()})


def rules_from_state(count, avg, payee_known, hour, velocity, amount):
    score, reasons = 0, []

    if count >= 3:
        ratio = amount / avg
        if ratio >= 10:
            score += 40
            reasons.append(f"Amount is {ratio:.1f}x this payer's average of {avg:.2f}")
        elif ratio >= 3:
            score += 20
            reasons.append(f"Amount is {ratio:.1f}x this payer's average of {avg:.2f}")

        if not payee_known:
            score += 20
            reasons.append("Payee has never been paid by this payer before")

    if 0 <= hour < 6:
        score += 15
        reasons.append(f"Unusual hour ({hour}:00)")

    if velocity >= 5:
        score += 30
        reasons.append(f"{velocity} payments in the last minute")

    if amount > 5000:
        score += 20
        reasons.append("Amount above the 5000 hard limit")

    if score >= 60:
        decision = "HOLD"
    elif score >= 30:
        decision = "STEP_UP"
    else:
        decision = "APPROVE"

    return {"score": min(score, 100), "decision": decision, "reasons": reasons}


def score_transaction(payer, payee, amount, hour=None):
    now = datetime.now()
    hour = now.hour if hour is None else hour
    past = HISTORY[payer]

    count = len(past)
    avg = sum(t["amount"] for t in past) / count if count else 0.0
    payee_known = payee in {t["payee"] for t in past}
    velocity = sum(1 for t in past if now - t["time"] < timedelta(seconds=60))

    return rules_from_state(count, avg, payee_known, hour, velocity, amount)