// The top of the page: what Trust Layer is, a live system check, and the moving background.

import { useEffect, useRef, useState } from 'react'
import { API } from './useStream'
import type { Status } from './useStream'

interface Health {
  paypal_configured: boolean
  webhook_configured: boolean
  claude_configured: boolean
}

type CheckState = 'ok' | 'wait' | 'off'

// ---------------------------------------------------------------------------
// The moving background: streams of payments flowing left to right.
// In the middle they squeeze through a checkpoint. Most come out blue,
// a few turn amber, and the red ones stop there and fall away.
// It is a plain 2D canvas, separate from the 3D scene further down the page.
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

const STREAM_COLORS = ['60, 110, 255', '255, 184, 74', '255, 61, 107']
const INCOMING = '120, 140, 210'
const BACKGROUND = '2, 3, 8'

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

    const GATE = 0.56
    let w = 0
    let h = 0
    const streams: Stream[] = Array.from({ length: 140 }, () => newStream(true))

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = `rgb(${BACKGROUND})`
      ctx.fillRect(0, 0, w, h)
      for (const s of streams) s.px = NaN
    }
    resize()
    const sizeWatcher = new ResizeObserver(resize)
    sizeWatcher.observe(canvas)

    let time = 0
    const step = (dt: number) => {
      time += dt
      // Painting a see-through dark layer every frame is what leaves the fading trails.
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = `rgba(${BACKGROUND}, 0.07)`
      ctx.fillRect(0, 0, w, h)

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
        const open = 0.1 + s.lane * 0.8 + wave
        const tight = 0.5 + (s.lane - 0.5) * 0.16
        const x = s.x * w + (held ? s.fall * 14 : 0)
        const y = (open + (tight - open) * squeeze) * h + (held ? s.fall * s.fall * 46 : 0)

        const past = s.x >= GATE
        const edge = Math.min(1, s.x * 8, (1.04 - s.x) * 8)
        const alpha = Math.max(0, held ? 1 - s.fall / 2.2 : edge) * (past ? 0.85 : 0.4)
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
      return () => sizeWatcher.disconnect()
    }

    // Stop drawing while the hero is scrolled out of view.
    let visible = true
    const viewWatcher = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting })
    viewWatcher.observe(canvas)

    let last = performance.now()
    let raf = 0
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      if (visible) step(dt)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      sizeWatcher.disconnect()
      viewWatcher.disconnect()
    }
  }, [])

  return <canvas ref={ref} className="hero-flow" aria-hidden="true" />
}

export default function Hero({ status }: { status: Status }) {
  const [health, setHealth] = useState<Health | null>(null)

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
    <section className="hero" id="top">
      <FlowBackdrop />
      <div className="hero-light" aria-hidden="true" />
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <p className="hero-team rise" style={{ animationDelay: '0.1s' }}>Team Cloak &amp; Dagger</p>
          <h1 className="rise" style={{ animationDelay: '0.2s' }}>The checkpoint between a payment and PayPal</h1>
          <p className="hero-lead rise" style={{ animationDelay: '0.3s' }}>
            Trust Layer scores every payment with rules and a trained model before any money moves.
            Risky payments are held, and every step is written to a tamper-evident log.
          </p>
          <div className="hero-actions rise" style={{ animationDelay: '0.4s' }}>
            <a className="btn btn-primary btn-lg" href="#live">Watch the live path</a>
            <a className="btn btn-lg" href="#pay">Make a real sandbox payment</a>
          </div>
        </div>

        <aside className="card glow rise" style={{ animationDelay: '0.5s' }} aria-label="System check">
          <div className="card-head">
            <h2>System check</h2>
            <span className={ready ? 'badge badge-ok' : 'badge'}>{ready ? 'Ready' : 'Starting'}</span>
          </div>
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.name} className={`check-${c.state}`}><b>{c.name}</b><span>{c.text}</span></li>
            ))}
          </ul>
        </aside>
      </div>
    </section>
  )
}