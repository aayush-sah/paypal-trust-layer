from risk import seed_demo_history
from decision import decide

seed_demo_history()

tests = [
    ("Test 1: normal",             100,   "shop_a",  12, "APPROVE"),
    ("Test 2: 3.5x known payee",   120,   "shop_a",  12, "APPROVE"),
    ("Test 3: 3.5x new payee",     120,   "new_guy", 12, "STEP_UP"),
    ("Test 4: drain at 3 AM",      10000, "new_guy", 3,  "HOLD"),
    ("Test 5: just under 3x, 1AM", 100,   "shop_a",  1,  "STEP_UP"),
    ("Test 6: scam-like",          45,    "new_guy", 14, "APPROVE"),
]

for name, amount, payee, hour, expected in tests:
    r = decide("alice", payee, amount, hour)
    ok = "PASS" if r["decision"] == expected else "FAIL"
    print(f"{name:<30} rules={r['rules_score']:>3} ml={r['ml_score']:>5} -> {r['decision']:<8} {ok}")
    for reason in r["reasons"]:
        print("     ", reason)