import argparse
import time

import numpy as np

from engine import Engine

KINDS = ["drain", "night_takeover", "moderate", "scam", "card_testing"]


def build_traffic(rate, seconds, attack_rate, seed):
    rng = np.random.default_rng(seed)
    n = int(rate * seconds)
    n_payers = max(2000, int(rate * min(seconds, 60) * 2))

    base = np.exp(rng.normal(np.log(40), 0.5, n_payers))
    engine = Engine()
    for i in range(n_payers):
        amounts = base[i] * np.exp(rng.normal(0, 0.4, 5))
        engine.seed(f"u{i}", amounts, [f"f{i}_{k % 3}" for k in range(5)])

    arrival = np.sort(rng.uniform(0, seconds, n))
    payer = rng.integers(0, n_payers, n)
    amount = base[payer] * np.exp(rng.normal(0, 0.4, n))
    hour = np.clip(rng.normal(14, 4, n), 6, 23).round().astype(int)
    night = rng.random(n) < 0.02
    hour[night] = rng.integers(0, 6, night.sum())
    is_new = rng.random(n) < 0.10
    fav = rng.integers(0, 3, n)

    label = [None] * n
    attack_idx = rng.choice(n, size=int(n * attack_rate * 0.9), replace=False)
    kinds = rng.choice(["drain", "night_takeover", "moderate", "scam"], size=len(attack_idx),
                       p=[0.35, 0.30, 0.20, 0.15])
    for i, k in zip(attack_idx, kinds):
        label[i] = k
        if k == "drain":
            amount[i] = base[payer[i]] * rng.uniform(8, 300)
            is_new[i] = rng.random() < 0.7
            hour[i] = rng.integers(0, 24)
        elif k == "night_takeover":
            amount[i] = base[payer[i]] * rng.uniform(3, 15)
            is_new[i] = rng.random() < 0.9
            hour[i] = rng.integers(0, 6)
        elif k == "moderate":
            amount[i] = base[payer[i]] * rng.uniform(3, 8)
            is_new[i] = rng.random() < 0.8
            hour[i] = rng.integers(8, 22)
        else:
            amount[i] = base[payer[i]] * rng.uniform(0.8, 2.5)
            is_new[i] = True
            hour[i] = rng.integers(8, 22)

    txs = []
    for i in range(n):
        p = int(payer[i])
        payee = f"new{i}" if is_new[i] else f"f{p}_{int(fav[i])}"
        txs.append({"t": float(arrival[i]), "payer": f"u{p}", "payee": payee,
                    "amount": float(amount[i]), "hour": int(hour[i]), "label": label[i]})

    bursts = max(1, int(n * attack_rate * 0.1 / 8))
    for b in range(bursts):
        p = int(rng.integers(0, n_payers))
        t0 = float(rng.uniform(0, max(0.1, seconds - 1)))
        for k in range(8):
            txs.append({"t": t0 + k * 0.05, "payer": f"u{p}", "payee": f"burst{b}_{k}",
                        "amount": float(base[p] * rng.uniform(0.1, 1.0)),
                        "hour": int(rng.integers(0, 24)), "label": "card_testing"})

    txs.sort(key=lambda x: x["t"])
    return engine, txs


def run(engine, txs, window, max_batch):
    n = len(txs)
    latency = np.empty(n)
    results = [None] * n
    batch_sizes = []
    start = time.perf_counter() + 0.1
    i = 0

    while i < n:
        now = time.perf_counter() - start
        j = i
        while j < n and j - i < max_batch and txs[j]["t"] <= now:
            j += 1

        if j == i:
            time.sleep(max(0.0005, min(0.005, txs[i]["t"] - now)))
            continue
        if now - txs[i]["t"] < window and (j - i) < max_batch:
            time.sleep(0.001)
            continue

        out = engine.score_batch(txs[i:j])
        done = time.perf_counter() - start
        for k in range(i, j):
            latency[k] = done - txs[k]["t"]
            results[k] = out[k - i]
        batch_sizes.append(j - i)
        i = j

    total = time.perf_counter() - start
    return latency, results, batch_sizes, total


def report(txs, latency, results, batch_sizes, total, rate):
    n = len(txs)
    ms = latency * 1000
    print(f"\nOffered load : {rate:,} tx/s | transactions: {n:,} | run took {total:.2f}s")
    print(f"Throughput   : {n / total:,.0f} tx/s achieved")
    print(f"Latency (ms) : p50 {np.percentile(ms, 50):.1f} | p95 {np.percentile(ms, 95):.1f} | "
          f"p99 {np.percentile(ms, 99):.1f} | max {ms.max():.1f}")
    print(f"Batches      : {len(batch_sizes):,} | average size {np.mean(batch_sizes):.0f} | "
          f"largest {max(batch_sizes)}")

    normal = [r["decision"] for t, r in zip(txs, results) if t["label"] is None]
    print(f"\nNormal traffic ({len(normal):,} tx): "
          f"APPROVE {normal.count('APPROVE') / len(normal):.2%} | "
          f"STEP_UP {normal.count('STEP_UP') / len(normal):.2%} | "
          f"HOLD {normal.count('HOLD') / len(normal):.2%}")

    print(f"\n{'Attack type':<16}{'count':>7}{'missed':>9}{'STEP_UP':>9}{'HOLD':>8}")
    for kind in KINDS:
        d = [r["decision"] for t, r in zip(txs, results) if t["label"] == kind]
        if d:
            print(f"{kind:<16}{len(d):>7}{d.count('APPROVE') / len(d):>9.1%}"
                  f"{d.count('STEP_UP') / len(d):>9.1%}{d.count('HOLD') / len(d):>8.1%}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rate", type=int, default=1000)
    ap.add_argument("--seconds", type=int, default=10)
    ap.add_argument("--attack", type=float, default=0.01)
    ap.add_argument("--window", type=float, default=0.02)
    ap.add_argument("--max-batch", type=int, default=1024)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()

    print("Building synthetic traffic...")
    engine, txs = build_traffic(a.rate, a.seconds, a.attack, a.seed)
    print("Running...")
    lat, res, sizes, total = run(engine, txs, a.window, a.max_batch)
    report(txs, lat, res, sizes, total, a.rate)