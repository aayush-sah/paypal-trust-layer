from risk import score_transaction
from ml_risk import ml_risk

SEVERITY = {"APPROVE": 0, "STEP_UP": 1, "HOLD": 2}
ML_STEP_UP = 50


def decide(payer, payee, amount, hour=None):
    rules = score_transaction(payer, payee, amount, hour)
    ml = ml_risk(payer, payee, amount, hour)

    ml_decision = "STEP_UP" if ml >= ML_STEP_UP else "APPROVE"
    decision = max(rules["decision"], ml_decision, key=SEVERITY.get)

    reasons = [f"[rule] {r}" for r in rules["reasons"]]
    if ml_decision == "STEP_UP":
        reasons.append(f"[model] Pattern is unusual compared with normal traffic (ML risk {ml}/100)")

    return {
        "decision": decision,
        "rules_score": rules["score"],
        "ml_score": ml,
        "reasons": reasons,
    }