from risk import seed_demo_history
from decision import decide
from explain import explain

seed_demo_history()

cases = [
    ("normal", 100, "shop_a", 12),
    ("step-up", 120, "new_guy", 12),
    ("hold", 10000, "new_guy", 3),
]

for name, amount, payee, hour in cases:
    result = decide("alice", payee, amount, hour)
    e = explain(result, amount)
    print(f"{name}: {result['decision']} (explained by {e['source']})")
    print("  ", e["text"], "\n")