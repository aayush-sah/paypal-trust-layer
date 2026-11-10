from pathlib import Path
import numpy as np
import joblib
from sklearn.ensemble import IsolationForest
from features import FEATURE_NAMES

rng = np.random.default_rng(42)


def make_normal(n):
    log_ratio = rng.normal(0.0, 0.4, n)
    new_payee = (rng.random(n) < 0.10).astype(float)
    hour = np.clip(rng.normal(14, 4, n), 6, 23).round()
    night = rng.random(n) < 0.02
    hour[night] = rng.integers(0, 6, night.sum())
    velocity = rng.poisson(0.5, n).astype(float)
    return np.column_stack([log_ratio, new_payee, hour, velocity])


def make_attack(kind, n):
    if kind == "drain":
        ratio = rng.uniform(8, 300, n)
        new = rng.random(n) < 0.7
        hour = rng.integers(0, 24, n)
        vel = rng.poisson(0.5, n)
    elif kind == "card_testing":
        ratio = rng.uniform(0.1, 1.0, n)
        new = rng.random(n) < 0.5
        hour = rng.integers(0, 24, n)
        vel = rng.integers(5, 16, n)
    elif kind == "night_takeover":
        ratio = rng.uniform(3, 15, n)
        new = rng.random(n) < 0.9
        hour = rng.integers(0, 6, n)
        vel = rng.poisson(1, n)
    elif kind == "moderate":
        ratio = rng.uniform(3, 8, n)
        new = rng.random(n) < 0.8
        hour = rng.integers(8, 22, n)
        vel = rng.poisson(1, n)
    elif kind == "scam":
        ratio = rng.uniform(0.8, 2.5, n)
        new = np.ones(n, dtype=bool)
        hour = rng.integers(8, 22, n)
        vel = rng.poisson(0.5, n)
    return np.column_stack(
        [np.log(ratio), new.astype(float), hour.astype(float), vel.astype(float)]
    )


def rules_flag(X):
    ratio = np.exp(X[:, 0])
    score = np.where(ratio >= 10, 40, np.where(ratio >= 3, 20, 0)).astype(float)
    score += 20 * X[:, 1]
    score += 15 * (X[:, 2] < 6)
    score += 30 * (X[:, 3] >= 5)
    return score >= 30


train = make_normal(20000)
val = make_normal(5000)
test = make_normal(5000)

model = IsolationForest(n_estimators=300, random_state=42)
model.fit(train)

val_scores = model.score_samples(val)
median = float(np.median(val_scores))
p1 = float(np.percentile(val_scores, 1))


def to_risk(X):
    s = model.score_samples(X)
    return np.clip(50 * (median - s) / (median - p1), 0, 100)


print(f"Features: {FEATURE_NAMES}")
print(f"Calibration: median score {median:.3f} -> risk 0, 1st percentile {p1:.3f} -> risk 50\n")

ml_fp = (to_risk(test) >= 50).mean()
rules_fp = rules_flag(test).mean()
either_fp = ((to_risk(test) >= 50) | rules_flag(test)).mean()
print(f"False positives on normal test data:  rules {rules_fp:.2%} | ML {ml_fp:.2%} | either {either_fp:.2%}\n")

print(f"{'Attack type':<16}{'rules':>8}{'ML':>8}{'either':>8}")
for kind in ["drain", "card_testing", "night_takeover", "moderate", "scam"]:
    A = make_attack(kind, 1000)
    r = rules_flag(A).mean()
    m = (to_risk(A) >= 50).mean()
    e = (rules_flag(A) | (to_risk(A) >= 50)).mean()
    print(f"{kind:<16}{r:>8.1%}{m:>8.1%}{e:>8.1%}")

joblib.dump(
    {"model": model, "median": median, "p1": p1, "features": FEATURE_NAMES},
    Path(__file__).parent / "model.joblib",
)
print("\nSaved model.joblib")