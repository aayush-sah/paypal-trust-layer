import hashlib
import json
import os
import sqlite3
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

DB_PATH = Path(os.getenv("AUDIT_DB", Path(__file__).parent / "audit.db"))
GENESIS = "0" * 64

router = APIRouter()
_lock = threading.Lock()
_db = sqlite3.connect(DB_PATH, check_same_thread=False)
_db.row_factory = sqlite3.Row
_db.execute(
    """CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        payload TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
    )"""
)
_db.commit()

_original = None
_reject_times = deque()


def compute_hash(prev_hash, ts, kind, ref, payload):
    text = "|".join([prev_hash, ts, kind, ref, payload])
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def summarize(kind, data):
    if kind == "decision":
        return (f"{data['decision']} ${data['amount']:,.2f} {data['payer']} to {data['payee']} "
                f"(rules {data['rules_score']}, model {data['ml_score']})")
    if kind == "order_created":
        return f"PayPal order created for ${data['amount']:,.2f}"
    if kind == "capture":
        extra = " (confirmed by user)" if data.get("confirmed") else ""
        return f"Capture {data['status']} for ${data['amount']:,.2f}{extra}"
    if kind == "capture_blocked":
        return "Capture blocked: confirmation required"
    if kind == "capture_failed":
        return f"Capture failed: {data.get('reason', 'unknown')}"
    if kind == "webhook":
        findings = "; ".join(data.get("findings", []))
        return f"{data['event_type']} -> {data['status']}" + (f": {findings}" if findings else "")
    if kind == "webhook_rejected":
        return "Webhook rejected: invalid or missing PayPal signature"
    return kind


def append(kind, ref, data):
    ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    payload = json.dumps(data, sort_keys=True, separators=(",", ":"))
    with _lock:
        row = _db.execute("SELECT hash FROM audit ORDER BY id DESC LIMIT 1").fetchone()
        prev_hash = row["hash"] if row else GENESIS
        new_hash = compute_hash(prev_hash, ts, kind, ref, payload)
        cur = _db.execute(
            "INSERT INTO audit (ts, kind, ref, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)",
            (ts, kind, ref, payload, prev_hash, new_hash),
        )
        _db.commit()
        return cur.lastrowid


def allow_rejection_log():
    now = time.time()
    while _reject_times and now - _reject_times[0] > 60:
        _reject_times.popleft()
    if len(_reject_times) >= 20:
        return False
    _reject_times.append(now)
    return True


def verify():
    with _lock:
        rows = _db.execute("SELECT * FROM audit ORDER BY id").fetchall()

    prev = GENESIS
    for row in rows:
        if row["prev_hash"] != prev:
            return {"ok": False, "count": len(rows), "broken_at": row["id"],
                    "reason": "the link to the previous entry does not match (an entry was removed or replaced)",
                    "head": prev}
        expected = compute_hash(row["prev_hash"], row["ts"], row["kind"], row["ref"], row["payload"])
        if expected != row["hash"]:
            return {"ok": False, "count": len(rows), "broken_at": row["id"],
                    "reason": "the contents of this entry were changed after it was written",
                    "head": prev}
        prev = row["hash"]
    return {"ok": True, "count": len(rows), "broken_at": None, "reason": "", "head": prev}


@router.get("/audit")
def list_entries(limit: int = Query(200, ge=1, le=1000)):
    with _lock:
        rows = _db.execute("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    out = []
    for r in rows:
        data = json.loads(r["payload"])
        try:
            summary = summarize(r["kind"], data)
        except (KeyError, TypeError):
            summary = "(entry contents are not in the expected format)"
        out.append({"id": r["id"], "ts": r["ts"], "kind": r["kind"], "ref": r["ref"],
                    "summary": summary, "hash": r["hash"], "prev_hash": r["prev_hash"]})
    return out


@router.get("/audit/verify")
def audit_verify():
    return verify()


@router.post("/audit/tamper")
def audit_tamper():
    global _original
    if _original is not None:
        raise HTTPException(status_code=409, detail="An entry is already tampered. Undo it first.")
    with _lock:
        row = _db.execute(
            "SELECT * FROM audit WHERE kind = 'decision' AND payload LIKE '%\"decision\":\"HOLD\"%' "
            "ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row is None:
            row = _db.execute("SELECT * FROM audit WHERE kind = 'decision' ORDER BY id DESC LIMIT 1").fetchone()
        if row is None:
            raise HTTPException(status_code=409, detail="No decision entries yet. Make a payment first.")
        data = json.loads(row["payload"])
        _original = (row["id"], row["payload"])
        data["decision"] = "APPROVE"
        _db.execute("UPDATE audit SET payload = ? WHERE id = ?",
                    (json.dumps(data, sort_keys=True, separators=(",", ":")), row["id"]))
        _db.commit()
    return {"tampered_id": row["id"]}


@router.post("/audit/untamper")
def audit_untamper():
    global _original
    if _original is None:
        raise HTTPException(status_code=409, detail="Nothing is tampered.")
    entry_id, payload = _original
    with _lock:
        _db.execute("UPDATE audit SET payload = ? WHERE id = ?", (payload, entry_id))
        _db.commit()
    _original = None
    return {"restored_id": entry_id}