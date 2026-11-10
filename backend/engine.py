import math
import time
from collections import deque

import numpy as np

from risk import rules_from_state
from ml_risk import model, MEDIAN, P1
from decision import SEVERITY, ML_STEP_UP

WINDOW_SECONDS = 60.0


class PayerState:
    __slots__ = ("count", "total", "payees", "recent")

    def __init__(self):
        self.count = 0
        self.total = 0.0
        self.payees = set()
        self.recent = deque()


class Engine:
    def __init__(self):
        self.payers = {}

    def state(self, payer):
        s = self.payers.get(payer)
        if s is None:
            s = self.payers[payer] = PayerState()
        return s

    def seed(self, payer, amounts, payees):
        s = self.state(payer)
        for amount, payee in zip(amounts, payees):
            s.count += 1
            s.total += amount
            s.payees.add(payee)

    def score_batch(self, txs, now=None):
        now = time.time() if now is None else now
        rules_out = []
        rows = []

        for tx in txs:
            s = self.state(tx["payer"])
            recent = s.recent
            while recent and now - recent[0] >= WINDOW_SECONDS:
                recent.popleft()

            amount = tx["amount"]
            hour = tx["hour"]
            velocity = len(recent)
            payee_known = tx["payee"] in s.payees
            avg = s.total / s.count if s.count else 0.0

            result = rules_from_state(s.count, avg, payee_known, hour, velocity, amount)
            rules_out.append(result)

            log_ratio = math.log(max(amount, 0.01) / avg) if s.count >= 3 else 0.0
            new_payee = 1.0 if s.count > 0 and not payee_known else 0.0
            rows.append((log_ratio, new_payee, float(hour), float(velocity)))

            if result["decision"] != "HOLD":
                s.count += 1
                s.total += amount
                s.payees.add(tx["payee"])
                recent.append(now)

        raw = model.score_samples(np.array(rows))
        ml_scores = np.clip(50 * (MEDIAN - raw) / (MEDIAN - P1), 0, 100)

        out = []
        for rules, ml in zip(rules_out, ml_scores):
            ml = round(float(ml), 1)
            ml_decision = "STEP_UP" if ml >= ML_STEP_UP else "APPROVE"
            decision = max(rules["decision"], ml_decision, key=SEVERITY.get)

            reasons = [f"[rule] {r}" for r in rules["reasons"]]
            if ml_decision == "STEP_UP":
                reasons.append(f"[model] Pattern is unusual compared with normal traffic (ML risk {ml}/100)")

            out.append({
                "decision": decision,
                "rules_score": rules["score"],
                "ml_score": ml,
                "reasons": reasons,
            })
        return out