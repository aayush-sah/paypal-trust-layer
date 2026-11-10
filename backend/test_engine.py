import random
from datetime import datetime, timedelta

from risk import HISTORY, record
from decision import decide
from engine import Engine

random.seed(7)
engine = Engine()

payers = [f"user{i}" for i in range(20)]
past = datetime.now() - timedelta(days=1)
base = {}
for p in payers:
    base[p] = random.uniform(15, 80)
    amounts = [base[p] * random.uniform(0.7, 1.3) for _ in range(5)]
    payees = [f"fav{p}_{k % 3}" for k in range(5)]
    engine.seed(p, amounts, payees)
    for a, pe in zip(amounts, payees):
        HISTORY[p].append({"amount": a, "payee": pe, "time": past})

mismatches = 0
counts = {"APPROVE": 0, "STEP_UP": 0, "HOLD": 0}

for i in range(600):
    p = random.choice(payers)
    kind = random.random()
    if kind < 0.80:
        amount = base[p] * random.uniform(0.6, 1.6)
        payee = f"fav{p}_{random.randint(0, 2)}"
        hour = random.randint(8, 21)
    elif kind < 0.90:
        amount = base[p] * random.uniform(3, 12)
        payee = f"new{i}"
        hour = random.randint(0, 23)
    else:
        amount = random.choice([200, 900, 6000, 9000])
        payee = f"new{i}"
        hour = random.randint(0, 5)
    amount = round(amount, 2)

    live = decide(p, payee, amount, hour)
    fast = engine.score_batch([{"payer": p, "payee": payee, "amount": amount, "hour": hour}])[0]
    counts[live["decision"]] += 1

    if live["decision"] != "HOLD":
        record(p, payee, amount)

    same = (live["decision"] == fast["decision"]
            and live["rules_score"] == fast["rules_score"]
            and live["ml_score"] == fast["ml_score"]
            and live["reasons"] == fast["reasons"])
    if not same:
        mismatches += 1
        if mismatches <= 3:
            print("MISMATCH", p, amount, hour, "\n  live:", live, "\n  fast:", fast)

print("decisions seen:", counts)
print("mismatches:", mismatches, "out of 600")