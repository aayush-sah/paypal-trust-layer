from risk import score_transaction, seed_demo_history
from ml_risk import ml_risk

seed_demo_history()

tests = [
    ("Test 1", 100, "shop_a", 12),
    ("Test 2", 120, "shop_a", 12),
    ("Test 3", 120, "new_guy", 12),
    ("Test 4", 10000, "new_guy", 3),
    ("Extra: normal", 38, "shop_a", 12),
    ("Extra: scam-like", 45, "new_guy", 14),
    ("Extra: 3AM small", 30, "shop_a", 3),
]

print(f"{'Case':<20}{'rules':>7}{'ml':>8}")
for name, amount, payee, hour in tests:
    rules = score_transaction("alice", payee, amount, hour)["score"]
    ml = ml_risk("alice", payee, amount, hour)
    print(f"{name:<20}{rules:>7}{ml:>8}")