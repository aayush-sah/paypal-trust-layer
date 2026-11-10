from risk import score_transaction, seed_demo_history

seed_demo_history()

tests = [
    ("Test 1", 100,   "shop_a",  None, "APPROVE"),
    ("Test 2", 120,   "shop_a",  None, "APPROVE"),
    ("Test 3", 120,   "new_guy", None, "STEP_UP"),
    ("Test 4", 10000, "new_guy", 3,    "HOLD"),
]

for name, amount, payee, hour, expected in tests:
    r = score_transaction("alice", payee, amount, hour)
    ok = "PASS" if r["decision"] == expected else "FAIL"
    print(f"{name}: score={r['score']} decision={r['decision']} (expected {expected}) {ok}")
    for reason in r["reasons"]:
        print("   -", reason)