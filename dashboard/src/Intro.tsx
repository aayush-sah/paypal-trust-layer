// The first screen. It explains what the project is and what it is built with,
// and it runs live checks against the server (GET /health) before you go in.

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { API } from './useStream'
import type { Status } from './useStream'

interface Health {
  paypal_configured: boolean
  webhook_configured: boolean
  claude_configured: boolean
}

type CheckState = 'ok' | 'wait' | 'off'

const STEPS = [
  { title: 'Score', text: 'Fixed rules and a trained Isolation Forest model score each payment in milliseconds.' },
  { title: 'Decide', text: 'The payment is approved, sent back for the payer to confirm, or held.' },
  { title: 'Pay', text: 'Only approved payments reach PayPal. A held payment never creates an order.' },
  { title: 'Prove', text: 'PayPal webhooks are signature-checked, and every step goes into a hash-chained audit log.' },
]

const STACK = [
  ['PayPal sandbox', 'Orders v2 API and signed webhooks'],
  ['Risk engine', 'Python rules and scikit-learn Isolation Forest'],
  ['Explanations', 'Claude, with a built-in template as fallback'],
  ['Server', 'FastAPI with a WebSocket live stream'],
  ['Audit log', 'SQLite with a SHA-256 hash chain'],
  ['Dashboard', 'React, three.js and AG Grid'],
]

const TITLE = 'Trust Layer'

// ---------------------------------------------------------------------------
// The moving background: streams of payments flowing left to right.
// In the middle they squeeze through a checkpoint. Most come out blue,
// a few turn amber, and the red ones stop there and fall away.
// It is a plain 2D canvas, separate from the 3D scene of the dashboard.
// ---------------------------------------------------------------------------

interface Stream {
  x: number
  lane: number      // 0 to 1: this stream's height on the screen
  amp: number       // how far it sways
  phase: number
  speed: number
  kind: 0 | 1 | 2   // 0 approved, 1 needs confirmation, 2 held
  fall: number      // how far a held stream has fallen after the checkpoint
  px: number
  py: number
}

const STREAM_COLORS = ['91, 124, 255', '255, 184, 74', '255, 61, 107']
const INCOMING = '150, 160, 220'

function newStream(startAnywhere: boolean): Stream {
  const roll = Math.random()
  return {
    x: startAnywhere ? Math.random() : -0.05 - Math.random() * 0.1,
    lane: Math.random(),
    amp: 0.01 + Math.random() * 0.035,
    phase: Math.random() * Math.PI * 2,
    speed: 0.05 + Math.random() * 0.07,
    kind: roll < 0.05 ? 2 : roll < 0.13 ? 1 : 0,
    fall: 0,
    px: NaN,
    py: NaN,
  }
}

function FlowBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const GATE = 0.5
    let w = 0
    let h = 0
    const streams: Stream[] = Array.from({ length: 150 }, () => newStream(true))

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#050818'
      ctx.fillRect(0, 0, w, h)
      for (const s of streams) s.px = NaN
    }
    resize()
    window.addEventListener('resize', resize)

    let time = 0
    const step = (dt: number) => {
      time += dt
      // Painting a see-through dark layer every frame is what leaves the fading trails.
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = 'rgba(5, 8, 24, 0.07)'
      ctx.fillRect(0, 0, w, h)

      // The checkpoint: a soft vertical line of light.
      const gx = GATE * w
      const glow = ctx.createLinearGradient(0, 0, 0, h)
      glow.addColorStop(0, 'rgba(91, 124, 255, 0)')
      glow.addColorStop(0.5, 'rgba(140, 160, 255, 0.05)')
      glow.addColorStop(1, 'rgba(91, 124, 255, 0)')
      ctx.fillStyle = glow
      ctx.fillRect(gx - 1, 0, 2, h)

      ctx.globalCompositeOperation = 'lighter'
      ctx.lineCap = 'round'
      for (let i = 0; i < streams.length; i++) {
        const s = streams[i]
        const held = s.kind === 2 && s.x >= GATE
        if (held) s.fall += dt
        else s.x += s.speed * dt * (s.kind === 1 && s.x > GATE ? 0.6 : 1)

        // Near the checkpoint every lane is pulled towards the middle, then released.
        const d = (s.x - GATE) / 0.16
        const squeeze = Math.exp(-d * d)
        const wave = Math.sin(s.x * 7 + s.phase + time * 0.35) * s.amp
        const open = 0.12 + s.lane * 0.76 + wave
        const tight = 0.5 + (s.lane - 0.5) * 0.16
        const x = s.x * w + (held ? s.fall * 14 : 0)
        const y = (open + (tight - open) * squeeze) * h + (held ? s.fall * s.fall * 46 : 0)

        const past = s.x >= GATE
        const edge = Math.min(1, s.x * 8, (1.04 - s.x) * 8)
        const alpha = Math.max(0, held ? 1 - s.fall / 2.2 : edge) * (past ? 0.85 : 0.5)
        if (!Number.isNaN(s.px) && alpha > 0) {
          ctx.strokeStyle = `rgba(${past ? STREAM_COLORS[s.kind] : INCOMING}, ${alpha})`
          ctx.lineWidth = past && s.kind !== 0 ? 2 : 1.3
          ctx.beginPath()
          ctx.moveTo(s.px, s.py)
          ctx.lineTo(x, y)
          ctx.stroke()
        }
        s.px = x
        s.py = y

        if (s.x > 1.05 || s.fall > 2.2) streams[i] = newStream(false)
      }
    }

    // People who ask their system for less motion get one still picture instead.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (let i = 0; i < 240; i++) step(1 / 30)
      return () => window.removeEventListener('resize', resize)
    }

    let last = performance.now()
    let raf = 0
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      step(dt)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={ref} className="intro-flow" aria-hidden="true" />
}

// A frosted-glass card. The light spot inside it follows the mouse.
function Glass({ order, children }: { order: number; children: ReactNode }) {
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--mx', `${e.clientX - box.left}px`)
    e.currentTarget.style.setProperty('--my', `${e.clientY - box.top}px`)
  }
  return (
    <section className="glass rise" style={{ '--i': order } as CSSProperties} onPointerMove={onMove}>
      {children}
    </section>
  )
}

export default function Intro({ status, onEnter }: { status: Status; onEnter: () => void }) {
  const [health, setHealth] = useState<Health | null>(null)
  const [leaving, setLeaving] = useState(false)

  // Ask the server how it is configured. Keep trying until it answers.
  useEffect(() => {
    if (health) return
    let stopped = false
    const load = async () => {
      try {
        const res = await fetch(`${API}/health`)
        if (res.ok && !stopped) setHealth(await res.json())
      } catch {
        // server not running yet: the timer tries again
      }
    }
    load()
    const timer = window.setInterval(load, 2000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [health])

  // Play the closing animation first, then tell the app to show the dashboard.
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(onEnter, 520)
    return () => window.clearTimeout(timer)
  }, [leaving, onEnter])

  const flag = (on: boolean | undefined): CheckState => (on === undefined ? 'wait' : on ? 'ok' : 'off')
  const checks: { name: string; state: CheckState; text: string }[] = [
    { name: 'Server', state: health ? 'ok' : 'wait', text: health ? 'Running' : 'Waiting for the backend on port 8000' },
    { name: 'Live stream', state: status === 'open' ? 'ok' : 'wait', text: status === 'open' ? 'Connected' : 'Connecting' },
    { name: 'PayPal sandbox', state: flag(health?.paypal_configured),
      text: !health ? 'Checking' : health.paypal_configured ? 'Keys loaded' : 'Keys missing, real payments are off' },
    { name: 'Webhook check', state: flag(health?.webhook_configured),
      text: !health ? 'Checking' : health.webhook_configured ? 'Webhook ID loaded' : 'Webhook ID missing' },
    { name: 'Explanations', state: flag(health?.claude_configured),
      text: !health ? 'Checking' : health.claude_configured ? 'Claude key loaded' : 'Using the built-in template' },
  ]
  const ready = health !== null && status === 'open'

  return (
    <div className={leaving ? 'intro intro-leaving' : 'intro'} role="dialog" aria-modal="true" aria-label="About Trust Layer">
      <FlowBackdrop />
      <div className="intro-aurora" aria-hidden="true" />

      <div className="intro-inner">
        <p className="intro-team rise" style={{ '--i': 0 } as CSSProperties}>
          Team Cloak &amp; Dagger<span>Aayush and Riya</span>
        </p>

        <div className="intro-cols">
          <Glass order={1}>
            <h2>How a payment travels</h2>
            <ol className="intro-steps">
              {STEPS.map((s) => (
                <li key={s.title}><b>{s.title}</b>{s.text}</li>
              ))}
            </ol>
          </Glass>

          <Glass order={2}>
            <h2>What it is built with</h2>
            <dl className="intro-stack">
              {STACK.map(([name, text]) => (
                <div key={name}><dt>{name}</dt><dd>{text}</dd></div>
              ))}
            </dl>
          </Glass>

          <Glass order={3}>
            <h2>System check</h2>
            <ul className="intro-checks">
              {checks.map((c, n) => (
                <li key={c.name} className={`check-${c.state}`} style={{ '--n': n } as CSSProperties}>
                  <b>{c.name}</b>{c.text}
                </li>
              ))}
            </ul>
            <p className="intro-note">
              The moving traffic is simulated so you can see the system at scale. Payments made in the
              Real payment panel are real PayPal sandbox orders.
            </p>
          </Glass>
        </div>

        <div className="intro-foot">
          <div>
            <h1 aria-label={TITLE}>
              {TITLE.split('').map((letter, n) => (
                <span key={n} aria-hidden="true" style={{ '--n': n } as CSSProperties}>
                  {letter === ' ' ? ' ' : letter}
                </span>
              ))}
            </h1>
            <p className="rise" style={{ '--i': 7 } as CSSProperties}>
              An AI checkpoint in front of PayPal. Every payment is scored before any money moves.
            </p>
          </div>
          <button type="button" className={ready ? 'pill pill-ready rise' : 'pill rise'}
                  style={{ '--i': 8 } as CSSProperties} onClick={() => setLeaving(true)} autoFocus>
            {ready ? 'Open the dashboard' : 'Open the dashboard anyway'}
          </button>
        </div>
      </div>
    </div>
  )
}