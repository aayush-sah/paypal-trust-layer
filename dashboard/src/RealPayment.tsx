import { useState } from 'react'
import { API } from './useStream'
import type { Decision } from './useStream'

interface Risk {
  decision: Decision
  rules_score: number
  ml_score: number
  reasons: string[]
}

interface Result {
  risk: Risk
  decisionId: string
  orderId: string | null
  approveUrl: string | null
}

interface Explanation {
  text: string
  source: string
}

const SCENARIOS = [
  { name: 'Normal payment', amount: '30', payee: 'shop_a', hour: '12' },
  { name: 'Unusual payee', amount: '120', payee: 'new_guy', hour: '12' },
  { name: 'Drain at 3 AM', amount: '10000', payee: 'new_guy', hour: '3' },
]

const CHIP: Record<Decision, string> = {
  APPROVE: 'border-emerald-500 text-emerald-300',
  STEP_UP: 'border-amber-500 text-amber-300',
  HOLD: 'border-red-500 text-red-300',
}

function readError(body: unknown, status: number) {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return 'Invalid input. Check the amount and the time.'
  return `Request failed (${status})`
}

export default function RealPayment() {
  const [amount, setAmount] = useState('30')
  const [payee, setPayee] = useState('shop_a')
  const [hour, setHour] = useState('12')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [captureMsg, setCaptureMsg] = useState('')

  const offline = 'Cannot reach the server on port 8000. Is uvicorn running?'

  const clear = () => {
    setError('')
    setResult(null)
    setExplanation(null)
    setConfirmed(false)
    setCaptureMsg('')
  }

  const loadExplanation = async (id: string) => {
    try {
      const res = await fetch(`${API}/decisions/${id}/explanation`)
      if (res.ok) {
        const body = await res.json()
        setExplanation({ text: body.text, source: body.source })
      }
    } catch {
      // the explanation is optional, so ignore network errors here
    }
  }

  const submit = async () => {
    setBusy(true)
    clear()
    try {
      const res = await fetch(`${API}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, payee_id: payee, hour: hour === '' ? null : Number(hour) }),
      })
      const body = await res.json().catch(() => null)

      if (res.ok) {
        setResult({ risk: body.risk, decisionId: body.decision_id, orderId: body.order_id, approveUrl: body.approve_url })
        loadExplanation(body.decision_id)
      } else if (res.status === 403 && body?.detail?.decision) {
        const d = body.detail
        setResult({
          risk: { decision: d.decision, rules_score: d.rules_score, ml_score: d.ml_score, reasons: d.reasons },
          decisionId: d.decision_id,
          orderId: null,
          approveUrl: null,
        })
        loadExplanation(d.decision_id)
      } else {
        setError(readError(body, res.status))
      }
    } catch {
      setError(offline)
    } finally {
      setBusy(false)
    }
  }

  const capture = async () => {
    if (!result?.orderId) return
    setBusy(true)
    setCaptureMsg('')
    try {
      const res = await fetch(`${API}/orders/${result.orderId}/capture?confirmed=${confirmed}`, { method: 'POST' })
      const body = await res.json().catch(() => null)
      if (res.ok) {
        setCaptureMsg(`Payment ${body.status}. Watch the PayPal and Webhook stages in the diagram above.`)
      } else if (res.status === 428) {
        setCaptureMsg('Blocked by the Trust Layer: confirmation required. Tick the box to confirm this payment.')
      } else {
        setCaptureMsg(readError(body, res.status))
      }
    } catch {
      setCaptureMsg(offline)
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    clear()
    try {
      await fetch(`${API}/demo/reset`, { method: 'POST' })
    } catch {
      setError(offline)
    }
  }

  const btn = 'rounded border border-cyan-700 px-3 py-1.5 text-sm text-cyan-200 hover:bg-cyan-900/40 disabled:opacity-40'
  const input = 'rounded bg-black px-2 py-1 text-slate-100 border border-white/10'

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm uppercase tracking-widest text-slate-400">Real PayPal sandbox payment</h2>
        <button className={btn} onClick={reset}>Reset demo data</button>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        Payer is "alice" (a demo account whose usual payment is about $34). The payment is checked by the Trust Layer
        first. Only then is a real PayPal sandbox order created.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-400">Try:</span>
        {SCENARIOS.map((s) => (
          <button key={s.name} className={btn} onClick={() => { setAmount(s.amount); setPayee(s.payee); setHour(s.hour) }}>
            {s.name}
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-3 text-sm text-slate-400">
        <label>
          Amount (USD)<br />
          <input className={`${input} w-28`} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label>
          Pay to<br />
          <select className={input} value={payee} onChange={(e) => setPayee(e.target.value)}>
            <option value="shop_a">shop_a (known)</option>
            <option value="cafe_b">cafe_b (known)</option>
            <option value="new_guy">new_guy (never paid before)</option>
          </select>
        </label>
        <label>
          Pretend time (demo)<br />
          <select className={input} value={hour} onChange={(e) => setHour(e.target.value)}>
            <option value="12">12:00 noon</option>
            <option value="3">3:00 AM</option>
            <option value="">real clock</option>
          </select>
        </label>
        <button className={btn} disabled={busy} onClick={submit}>Check and create order</button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {result && (
        <div className="rounded border border-white/10 bg-black/40 p-3 text-sm">
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <span className={`rounded border px-2 py-0.5 font-semibold ${CHIP[result.risk.decision]}`}>
              {result.risk.decision}
            </span>
            <span className="text-slate-400">rules {result.risk.rules_score} · model {result.risk.ml_score}</span>
          </div>

          <ul className="mb-2 list-disc pl-5 text-slate-300">
            {result.risk.reasons.length === 0 && <li>No unusual signals were found.</li>}
            {result.risk.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>

          {explanation && (
            <p className="mb-3 rounded bg-white/5 p-2 text-slate-200">
              {explanation.text}{' '}
              <span className="text-xs text-slate-500">
                ({explanation.source === 'claude' ? 'written by Claude' : 'built-in message'})
              </span>
            </p>
          )}

          {result.risk.decision === 'HOLD' && (
            <p className="text-red-300">Held. No PayPal order was created and no money moved.</p>
          )}

          {result.orderId && (
            <div className="space-y-2">
              <div>
                <span className="text-slate-400">Step 1: </span>
                <a className="text-cyan-300 underline" href={result.approveUrl ?? '#'} target="_blank" rel="noreferrer">
                  approve in PayPal sandbox (log in as the sandbox buyer, use a private window)
                </a>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-slate-400">Step 2: </span>
                {result.risk.decision === 'STEP_UP' && (
                  <label className="flex items-center gap-2 text-amber-300">
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                    I confirm this payment
                  </label>
                )}
                <button className={btn} disabled={busy} onClick={capture}>Capture payment</button>
              </div>
            </div>
          )}

          {captureMsg && <p className="mt-2 text-slate-200">{captureMsg}</p>}
        </div>
      )}
    </div>
  )
}