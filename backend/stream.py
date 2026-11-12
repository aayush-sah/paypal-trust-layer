import asyncio
import os
import time
from collections import deque

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect

from engine import Engine
from incident import summarise
from ratelimit import limit

router = APIRouter()

N_PAYERS = 50_000
TICK = 0.1
KINDS = ["drain", "night_takeover", "moderate", "scam", "card_testing"]
MAX_SIM_RATE = int(os.getenv("MAX_SIM_RATE", "10000"))


class Simulation:
    def __init__(self):
        self.rng = np.random.default_rng()
        self.engine = None
        self.base = None
        self.running = False
        self.task = None
        self.rate = 1000
        self.attack_rate = 0.01
        self.pending = []
        self.clients = set()
        self.seq = 0
        self.totals = {"APPROVE": 0, "STEP_UP": 0, "HOLD": 0}
        # The newest held payments, kept so the incident summary can describe them.
        self.recent_holds = deque(maxlen=300)

    def init_population(self):
        rng = self.rng
        self.base = np.exp(rng.normal(np.log(40), 0.5, N_PAYERS))
        engine = Engine()
        for i in range(N_PAYERS):
            amounts = self.base[i] * np.exp(rng.normal(0, 0.4, 5))
            engine.seed(f"u{i}", amounts, [f"f{i}_{k % 3}" for k in range(5)])
        self.engine = engine

    def next_id(self):
        self.seq += 1
        return self.seq

    def make_normal(self, k):
        rng = self.rng
        payer = rng.integers(0, N_PAYERS, k)
        amount = self.base[payer] * np.exp(rng.normal(0, 0.4, k))
        hour = np.clip(rng.normal(14, 4, k), 6, 23).round().astype(int)
        night = rng.random(k) < 0.02
        hour[night] = rng.integers(0, 6, night.sum())
        is_new = rng.random(k) < 0.10
        fav = rng.integers(0, 3, k)

        txs = []
        for i in range(k):
            p = int(payer[i])
            tid = self.next_id()
            payee = f"n{tid}" if is_new[i] else f"f{p}_{int(fav[i])}"
            txs.append({"id": tid, "payer": f"u{p}", "payee": payee,
                        "amount": float(amount[i]), "hour": int(hour[i]), "label": None})
        return txs

    def make_attack(self, kind):
        rng = self.rng
        p = int(rng.integers(0, N_PAYERS))
        base = float(self.base[p])

        if kind == "card_testing":
            txs = []
            for _ in range(10):
                tid = self.next_id()
                txs.append({"id": tid, "payer": f"u{p}", "payee": f"x{tid}",
                            "amount": base * float(rng.uniform(0.1, 1.0)),
                            "hour": int(rng.integers(0, 24)), "label": kind})
            return txs

        if kind == "drain":
            amount, new, hour = base * rng.uniform(8, 300), rng.random() < 0.7, int(rng.integers(0, 24))
        elif kind == "night_takeover":
            amount, new, hour = base * rng.uniform(3, 15), rng.random() < 0.9, int(rng.integers(0, 6))
        elif kind == "moderate":
            amount, new, hour = base * rng.uniform(3, 8), rng.random() < 0.8, int(rng.integers(8, 22))
        else:
            amount, new, hour = base * rng.uniform(0.8, 2.5), True, int(rng.integers(8, 22))

        tid = self.next_id()
        payee = f"x{tid}" if new else f"f{p}_0"
        return [{"id": tid, "payer": f"u{p}", "payee": payee,
                 "amount": float(amount), "hour": hour, "label": kind}]

    def auto_attacks(self, k):
        txs = []
        for _ in range(int(self.rng.poisson(k * self.attack_rate))):
            kind = self.rng.choice(KINDS[:4], p=[0.35, 0.30, 0.20, 0.15])
            txs += self.make_attack(str(kind))
        if self.rng.random() < 0.01:
            txs += self.make_attack("card_testing")
        return txs

    def build_message(self, txs, results, seconds, elapsed):
        counts = {"APPROVE": 0, "STEP_UP": 0, "HOLD": 0}
        flagged, sample = [], []
        stride = max(1, len(txs) // 40)

        for i, (tx, r) in enumerate(zip(txs, results)):
            counts[r["decision"]] += 1
            item = {"id": tx["id"], "payer": tx["payer"], "payee": tx["payee"],
                    "amount": round(tx["amount"], 2), "hour": tx["hour"],
                    "decision": r["decision"], "rules": r["rules_score"],
                    "ml": r["ml_score"], "label": tx["label"]}
            if r["decision"] != "APPROVE":
                item["reasons"] = r["reasons"]
                flagged.append(item)
                if r["decision"] == "HOLD":
                    self.recent_holds.append({**item, "ts": time.time()})
            elif i % stride == 0 and len(sample) < 40:
                sample.append(item)

        for key in counts:
            self.totals[key] += counts[key]

        flagged.sort(key=lambda x: x["decision"] != "HOLD")
        return {
            "type": "tick",
            "ts": time.time(),
            "n": len(txs),
            "tx_per_sec": round(len(txs) / elapsed),
            "batch_ms": round(seconds * 1000, 1),
            "counts": counts,
            "totals": dict(self.totals),
            "sample": sample,
            "flagged": flagged[:60],
            "flagged_total": len(flagged),
        }

    async def broadcast(self, message):
        dead = []
        for ws in list(self.clients):
            try:
                await asyncio.wait_for(ws.send_json(message), timeout=1.0)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def loop(self):
        next_tick = time.perf_counter()
        last = next_tick - TICK
        while self.running:
            next_tick += TICK
            now = time.perf_counter()
            elapsed = min(max(now - last, 0.01), 0.5)
            last = now
            k = int(self.rng.poisson(self.rate * elapsed))
            txs = self.make_normal(k) + self.auto_attacks(k)
            txs += self.pending
            self.pending = []

            seconds = 0.0
            results = []
            if txs:
                started = time.perf_counter()
                results = await asyncio.to_thread(self.engine.score_batch, txs)
                seconds = time.perf_counter() - started

            await self.broadcast(self.build_message(txs, results, seconds, elapsed))

            delay = next_tick - time.perf_counter()
            if delay > 0:
                await asyncio.sleep(delay)
            else:
                next_tick = time.perf_counter()
                await asyncio.sleep(0)


sim = Simulation()


@router.post("/sim/start")
async def sim_start(rate: int = Query(1000, ge=1, le=MAX_SIM_RATE),
                    attack: float = Query(0.01, ge=0.0, le=0.5)):
    sim.rate = rate
    sim.attack_rate = attack
    if sim.engine is None:
        await asyncio.to_thread(sim.init_population)
    if not sim.running:
        sim.running = True
        sim.task = asyncio.create_task(sim.loop())
    return {"running": True, "rate": sim.rate, "attack": sim.attack_rate}


@router.post("/sim/stop")
async def sim_stop():
    sim.running = False
    if sim.task:
        await sim.task
        sim.task = None
    sim.pending = []
    return {"running": False}


@router.post("/sim/attack")
async def sim_attack(kind: str = Query("drain"), count: int = Query(1, ge=1, le=50)):
    if kind not in KINDS:
        raise HTTPException(status_code=422, detail=f"kind must be one of {KINDS}")
    if not sim.running:
        raise HTTPException(status_code=409, detail="Start the simulation first")
    for _ in range(count):
        sim.pending += sim.make_attack(kind)
    return {"queued": count, "kind": kind}


@router.post("/incidents/summary", dependencies=[Depends(limit(6, 60))])
async def incident_summary():
    holds = list(sim.recent_holds)
    if not holds:
        raise HTTPException(status_code=409, detail="No held payments yet. Start the traffic and inject an attack first.")
    # The Claude call can take a few seconds, so it runs in a worker thread.
    return await asyncio.to_thread(summarise, holds)


@router.get("/sim/status")
def sim_status():
    return {"running": sim.running, "rate": sim.rate, "attack": sim.attack_rate,
            "clients": len(sim.clients), "totals": sim.totals}


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    sim.clients.add(ws)
    await ws.send_json({"type": "hello", "running": sim.running, "rate": sim.rate})
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        sim.clients.discard(ws)