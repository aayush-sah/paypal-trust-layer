import asyncio
import json

import websockets


async def main():
    async with websockets.connect("ws://127.0.0.1:8000/ws") as ws:
        print("Connected. Press Ctrl+C to stop.\n")
        while True:
            msg = json.loads(await ws.recv())
            if msg["type"] != "tick":
                print("server says:", msg)
                continue

            c = msg["counts"]
            print(f"{msg['tx_per_sec']:>6} tx/s | batch {msg['batch_ms']:>5} ms | "
                  f"APPROVE {c['APPROVE']:>4}  STEP_UP {c['STEP_UP']:>3}  HOLD {c['HOLD']:>3}")

            for f in msg["flagged"]:
                if f["decision"] == "HOLD":
                    print(f"        HOLD  id={f['id']} amount={f['amount']} "
                          f"(truth: {f['label']}) -> {f['reasons'][0]}")


try:
    asyncio.run(main())
except KeyboardInterrupt:
    print("\nStopped.")