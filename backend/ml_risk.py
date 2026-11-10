from datetime import datetime
from pathlib import Path
import joblib
import numpy as np
from risk import HISTORY
from features import FEATURE_NAMES, live_features

bundle = joblib.load(Path(__file__).parent / "model.joblib")
assert bundle["features"] == FEATURE_NAMES, "Model was trained on different features. Retrain it."
model, MEDIAN, P1 = bundle["model"], bundle["median"], bundle["p1"]


def ml_risk(payer, payee, amount, hour=None):
    now = datetime.now()
    hour = now.hour if hour is None else hour
    x = np.array([live_features(HISTORY[payer], payee, amount, hour, now)])
    s = model.score_samples(x)[0]
    return round(float(np.clip(50 * (MEDIAN - s) / (MEDIAN - P1), 0, 100)), 1)