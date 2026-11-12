// The whole page, top to bottom:
// navigation, hero, how it works, live path, quarantine, real payment, audit log, built with, footer.

import { useState } from 'react'
import type { ReactNode } from 'react'
import { API, useStream } from './useStream'
import { useEvents } from './useEvents'
import Hero from './Hero'
import Scene3D from './Scene3D'
import type { AuditStatus } from './Scene3D'
import RealPayment from './RealPayment'
import AuditLog from './AuditLog'
import QuarantineGrid from './QuarantineGrid'

const RATES = [500, 1000, 2000, 5000]
const SHARES = [0.005, 0.01, 0.02]
const ATTACKS = [
  { kind: 'drain', name: 'Account drain' },
  { kind: 'night_takeover', name: 'Night takeover' },
  { kind: 'moderate', name: 'Moderate anomaly' },
  { kind: 'scam', name: 'Scam payment (mostly missed)' },
  { kind: 'card_testing', name: 'Card testing burst' },
]

const NAV = [
  ['#how', 'How it works'],
  ['#live', 'Live path'],
  ['#quarantine', 'Quarantine'],
  ['#pay', 'Real payment'],
  ['#audit', 'Audit log'],
  ['#built', 'Built with'],
]

const STEPS = [
  { title: 'Score', text: 'Fixed rules and a trained Isolation Forest model score each payment in milliseconds.' },
  { title: 'Decide', text: 'The payment is approved, sent back for the payer to confirm, or held.' },
  { title: 'Pay', text: 'Only approved payments reach PayPal. A held payment never creates an order.' },
  { title: 'Prove', text: 'PayPal webhooks are signature-checked, and every step goes into a hash-chained audit log.' },
]

const STACK = [
  ['PayPal sandbox', 'Orders v2 API for real orders and captures, and signed webhooks for confirmation.'],
  ['Risk engine', 'Python rules plus a scikit-learn Isolation Forest trained on synthetic payment history.'],
  ['Explanations', 'Claude turns the risk facts into plain language. A built-in template is the fallback.'],
  ['Server', 'FastAPI, with a WebSocket that streams decisions to this page.'],
  ['Audit log', 'SQLite, where each entry carries the SHA-256 hash of the one before it.'],
  ['Dashboard', 'React and TypeScript, three.js for the 3D path, AG Grid for the audit table.'],
]

const STATUS_TEXT = { open: 'Connected', connecting: 'Connecting', closed: 'Server offline' }

function Section({ id, title, lead, children }: { id: string; title: string; lead: string; children: ReactNode }) {
  return (
    <section className="section" id={id}>
      <div className="wrap">
        <header className="section-head">
          <h2>{title}</h2>
          <p>{lead}</p>
        </header>
        {children}
      </div>
    </section>
  )
}

function Kpi({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`kpi ${tone}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

interface Summary {
  text: string
  source: string
  stats: {
    held: number
    payers: number
    total_amount: number
    night_share: number
    top_reasons: { reason: string; count: number }[]
  }
}

export default function App() {
  const { status, tick, held, review, live } = useStream()
  const events = useEvents()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [summaryBusy, setSummaryBusy] = useState(false)
  const [summaryError, setSummaryError] = useState('')
  const [audit, setAudit] = useState<AuditStatus | null>(null)
  const [rate, setRate] = useState(1000)
  const [share, setShare] = useState(0.01)
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

  // Ask the server for an analyst note about the recent holds.
  const summarise = async () => {
    setSummaryBusy(true)
    setSummaryError('')
    try {
      const res = await fetch(`${API}/incidents/summary`, { method: 'POST' })
      const body = await res.json().catch(() => null)
      if (res.ok) setSummary(body)
      else setSummaryError(typeof body?.detail === 'string' ? body.detail : `Request failed (${res.status})`)
    } catch {
      setSummaryError('Cannot reach the server.')
    } finally {
      setSummaryBusy(false)
    }
  }

  const goTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  const totals = tick?.totals ?? { APPROVE: 0, STEP_UP: 0, HOLD: 0 }
  const captures = events.filter((e) => e.event_type === 'PAYMENT.CAPTURE.COMPLETED' && e.status === 'OK').length
  const verified = events.filter((e) => e.status === 'OK').length
  const refused = events.filter((e) => e.status !== 'OK').length

  return (
    <>
      <header className="nav">
        <div className="wrap nav-row">
          <a className="logo" href="#top"><span aria-hidden="true" />Trust Layer</a>
          <nav aria-label="Sections">
            {NAV.map(([href, name]) => <a key={href} href={href}>{name}</a>)}
          </nav>
          <span className={`link link-${status}`}>{STATUS_TEXT[status]}</span>
        </div>
      </header>

      <main>
        <Hero status={status} />

        <Section id="how" title="How a payment travels"
                 lead="Four steps, in this order, for every payment. The checks happen before PayPal is ever called.">
          <ol className="how">
            {STEPS.map((s) => (
              <li key={s.title} className="card"><h3>{s.title}</h3><p>{s.text}</p></li>
            ))}
          </ol>
        </Section>

        <Section id="live" title="Live payment path"
                 lead="Simulated traffic flows through the same scoring engine that guards real payments. Start it, then inject an attack and watch the risk gate react.">
          <div className="card live">
            <dl className="kpis">
              <Kpi label="Payments a second" value={live && tick ? tick.tx_per_sec.toLocaleString() : '0'} />
              <Kpi label="Scoring time per batch" value={live && tick ? `${tick.batch_ms} ms` : 'Stopped'} />
              <Kpi label="Approved" value={totals.APPROVE.toLocaleString()} tone="kpi-approve" />
              <Kpi label="Needs confirmation" value={totals.STEP_UP.toLocaleString()} tone="kpi-review" />
              <Kpi label="Held" value={totals.HOLD.toLocaleString()} tone="kpi-held" />
            </dl>

            <div className="live-scene">
              <Scene3D tick={tick} live={live} events={events} audit={audit} onOpenHeld={() => goTo('quarantine')} />
              {!live && <p className="live-hint">No traffic is running. Press Start traffic below.</p>}
            </div>

            <div className="controls">
              <label className="field">
                <span>Rate</span>
                <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
                  {RATES.map((r) => <option key={r} value={r}>{r.toLocaleString()} a second</option>)}
                </select>
              </label>
              <label className="field">
                <span>Attack share</span>
                <select value={share} onChange={(e) => setShare(Number(e.target.value))}>
                  {SHARES.map((a) => <option key={a} value={a}>{a * 100}%</option>)}
                </select>
              </label>
              <button type="button" className="btn btn-primary" onClick={() => call(`/sim/start?rate=${rate}&attack=${share}`)}>
                Start traffic
              </button>
              <button type="button" className="btn" onClick={() => call('/sim/stop')}>Stop</button>
              <label className="field">
                <span>Inject an attack</span>
                <select value="" onChange={(e) => {
                  const kind = e.target.value
                  if (kind) call(`/sim/attack?kind=${kind}&count=${kind === 'card_testing' ? 1 : 3}`)
                }}>
                  <option value="">Choose one</option>
                  {ATTACKS.map((a) => <option key={a.kind} value={a.kind}>{a.name}</option>)}
                </select>
              </label>
              <ul className="legend" aria-label="What the colours mean">
                <li className="legend-approve">Approved</li>
                <li className="legend-review">Needs confirmation</li>
                <li className="legend-held">Held</li>
                <li className="legend-real">Real sandbox payment</li>
              </ul>
              {message && <p className="controls-message" role="alert">{message}</p>}
            </div>
          </div>
        </Section>

        <Section id="quarantine" title="Quarantine"
                 lead="Every flagged payment with its reasons, in a table you can sort, filter, search and export. An AI analyst note sums up what the holds have in common.">
          <div className="q-top">
            <div>
              <dl className="kpis kpis-stack">
                <Kpi label="Held, no money moved" value={totals.HOLD.toLocaleString()} tone="kpi-held" />
                <Kpi label="Sent back for confirmation" value={totals.STEP_UP.toLocaleString()} tone="kpi-review" />
              </dl>
              <p className="note">
                A held payment is stopped at the risk gate. No PayPal order is created, so there is nothing to
                refund. A payment that needs confirmation is captured only after the payer confirms it.
              </p>
            </div>

            <div className="card">
              <div className="card-head">
                <h2>AI incident note</h2>
                <button type="button" className="btn btn-primary" disabled={summaryBusy} onClick={summarise}>
                  {summaryBusy ? 'Reading the holds' : summary ? 'Refresh the note' : 'Summarise the recent holds'}
                </button>
              </div>
              {summaryError && <p className="controls-message" role="alert">{summaryError}</p>}
              {!summary && !summaryError && (
                <p className="note">
                  The server counts the recent held payments: how many, from how many payers, at what hours and
                  for which reasons. Claude turns those counts into a short note for a reviewer. It sees only
                  the counts and cannot change any decision.
                </p>
              )}
              {summary && (
                <>
                  <p className="ai-note">{summary.text}</p>
                  <p className="note">
                    {summary.source === 'claude' ? 'Written by Claude' : 'Built-in summary (Claude was not available)'} from
                    these counts: {summary.stats.held} held payments, {summary.stats.payers} payers,
                    ${summary.stats.total_amount.toLocaleString()} in total, {Math.round(summary.stats.night_share * 100)}% between
                    midnight and 6 AM.
                  </p>
                  <ul className="reason-counts">
                    {summary.stats.top_reasons.map((r) => (
                      <li key={r.reason}><b>{r.count}</b>{r.reason}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>

          <div className="card">
            <QuarantineGrid held={held} review={review} />
          </div>
        </Section>

        <Section id="pay" title="Real PayPal sandbox payment"
                 lead="This part is not simulated. The payment is scored first, and only then is a real order created through the PayPal sandbox API.">
          <div className="split">
            <div className="split-side">
              <dl className="kpis kpis-stack">
                <Kpi label="Payments captured" value={captures.toLocaleString()} />
                <Kpi label="Webhooks verified" value={refused > 0 ? `${verified}, ${refused} refused` : verified.toLocaleString()}
                     tone={refused > 0 ? 'kpi-held' : ''} />
              </dl>
              <p className="note">
                Try the three presets. A normal payment is approved, an unusual payee needs confirmation, and a
                large payment at 3 AM is held before PayPal is called.
              </p>
            </div>
            <div className="card">
              <RealPayment events={events} />
            </div>
          </div>
        </Section>

        <Section id="audit" title="Audit log"
                 lead="Each entry contains the hash of the entry before it, so changing or deleting any old entry breaks the chain. Tamper with it to see the break detected.">
          <div className="card">
            <AuditLog onStatus={setAudit} />
          </div>
        </Section>

        <Section id="built" title="Built with"
                 lead="What each part of the project runs on.">
          <dl className="stack">
            {STACK.map(([name, text]) => (
              <div key={name} className="card"><dt>{name}</dt><dd>{text}</dd></div>
            ))}
          </dl>
          <p className="note note-wide">
            What is simulated and what is real: the moving traffic and its counts are simulated, so the system can
            be seen at scale. Payments made in the Real payment section, their webhooks and the audit log are real
            PayPal sandbox activity. The risk model is trained on synthetic data.
          </p>
        </Section>
      </main>

      <footer className="footer">
        <div className="wrap footer-row">
          <p><b>Team Cloak &amp; Dagger</b>Aayush and Riya</p>
          <p>Built for the Build What's Next with PayPal and AI hackathon.</p>
        </div>
        <p className="footer-mark" aria-hidden="true">Trust Layer</p>
      </footer>
    </>
  )
}