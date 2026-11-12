import { useState } from 'react'
import { API, useStream } from './useStream'
import { useEvents } from './useEvents'
import PathView from './PathView'
import StreamCanvas from './StreamCanvas'
import RealPayment from './RealPayment'
import AuditLog from './AuditLog'
import type { Decision, Item } from './useStream'

const RATES = [500, 1000, 2000, 5000]
const ATTACKS = [0.005, 0.01, 0.02]
const KINDS = ['drain', 'night_takeover', 'moderate', 'scam', 'card_testing']

const TEXT: Record<Decision, string> = {
  APPROVE: 'text-emerald-400',
  STEP_UP: 'text-amber-400',
  HOLD: 'text-red-400',
}

function Card({ label, value, tone = 'text-cyan-300' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-cyan-900/60 bg-white/5 p-4">
      <div className="text-xs uppercase tracking-widest text-slate-400">{label}</div>
      <div className={`mt-1 text-3xl font-semibold ${tone}`}>{value}</div>
    </div>
  )
}

function FeedRow({ item }: { item: Item }) {
  return (
    <div className="flex items-start gap-3 border-b border-white/5 px-3 py-2 text-sm">
      <span className={`w-16 shrink-0 font-semibold ${TEXT[item.decision]}`}>{item.decision}</span>
      <span className="w-24 shrink-0 text-slate-200">${item.amount.toLocaleString()}</span>
      <span className="w-20 shrink-0 text-slate-400">{item.payer}</span>
      <span className="flex-1 text-slate-300">{item.reasons?.[0]}</span>
      <span className="shrink-0 text-xs text-slate-500">
        rules {item.rules} · ml {item.ml}
        {item.label ? ` · simulated ${item.label}` : ''}
      </span>
    </div>
  )
}

export default function App() {
  const { status, tick, feed, lastHold } = useStream()
  const events = useEvents()
  const [rate, setRate] = useState(1000)
  const [attack, setAttack] = useState(0.01)
  const [message, setMessage] = useState('')

  const call = async (path: string) => {
    try {
      const res = await fetch(`${API}${path}`, { method: 'POST' })
      if (res.ok) {
        setMessage('')
        return
      }
      const body = await res.json().catch(() => null)
      setMessage(typeof body?.detail === 'string' ? body.detail : `Request failed (${res.status})`)
    } catch {
      setMessage('Cannot reach the server on port 8000. Is uvicorn running?')
    }
  }

  const dot = status === 'open' ? 'bg-emerald-400' : status === 'connecting' ? 'bg-amber-400' : 'bg-red-500'
  const totals = tick?.totals
  const btn = 'rounded border border-cyan-700 px-3 py-1.5 text-sm text-cyan-200 hover:bg-cyan-900/40'

  return (
    <div className="min-h-screen bg-black p-6 font-mono text-slate-100">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-cyan-300">PayPal Trust Layer</h1>
          <p className="text-sm text-slate-400">Live risk decisions on the payment path</p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="rounded border border-amber-500/60 px-2 py-0.5 text-amber-300">SIMULATED TRAFFIC</span>
          <span className="flex items-center gap-2 text-slate-300">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
            {status}
          </span>
        </div>
      </header>

      <section className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-4">
        <label className="text-sm text-slate-400">
          Rate{' '}
          <select className="ml-1 rounded bg-black px-2 py-1 text-slate-100" value={rate}
                  onChange={(e) => setRate(Number(e.target.value))}>
            {RATES.map((r) => <option key={r} value={r}>{r} tx/s</option>)}
          </select>
        </label>
        <label className="text-sm text-slate-400">
          Attack share{' '}
          <select className="ml-1 rounded bg-black px-2 py-1 text-slate-100" value={attack}
                  onChange={(e) => setAttack(Number(e.target.value))}>
            {ATTACKS.map((a) => <option key={a} value={a}>{a * 100}%</option>)}
          </select>
        </label>
        <button className={btn} onClick={() => call(`/sim/start?rate=${rate}&attack=${attack}`)}>Start</button>
        <button className={btn} onClick={() => call('/sim/stop')}>Stop</button>
        <span className="mx-2 text-slate-600">|</span>
        <span className="text-sm text-slate-400">Inject:</span>
        {KINDS.map((k) => (
          <button key={k} className={btn} onClick={() => call(`/sim/attack?kind=${k}&count=${k === 'card_testing' ? 1 : 3}`)}>
            {k}
          </button>
        ))}
        {message && <span className="w-full text-sm text-red-400">{message}</span>}
      </section>

      <section className="mb-6">
        <PathView tick={tick} lastHold={lastHold} events={events} />
      </section>

      <section className="mb-6">
        <StreamCanvas tick={tick} />
      </section>

      <section className="mb-6">
        <RealPayment />
      </section>

      <section className="mb-6">
        <AuditLog />
      </section>

      <section className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        <Card label="Payments / sec" value={tick ? tick.tx_per_sec.toLocaleString() : '-'} />
        <Card label="Batch time" value={tick ? `${tick.batch_ms} ms` : '-'} />
        <Card label="Approved" value={totals ? totals.APPROVE.toLocaleString() : '-'} tone="text-emerald-400" />
        <Card label="Step-up" value={totals ? totals.STEP_UP.toLocaleString() : '-'} tone="text-amber-400" />
        <Card label="Held" value={totals ? totals.HOLD.toLocaleString() : '-'} tone="text-red-400" />
      </section>

      <section className="rounded-lg border border-white/10 bg-white/5">
        <h2 className="border-b border-white/10 px-3 py-2 text-sm uppercase tracking-widest text-slate-400">
          Flagged payments (newest first)
        </h2>
        <div className="max-h-[420px] overflow-y-auto">
          {feed.length === 0 && (
            <p className="p-4 text-sm text-slate-500">Nothing yet. Press Start, then inject an attack.</p>
          )}
          {feed.map((item) => <FeedRow key={item.id} item={item} />)}
        </div>
      </section>
    </div>
  )
}