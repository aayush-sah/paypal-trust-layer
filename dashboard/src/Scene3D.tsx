// React wrapper around the 3D engine.
// It owns the <canvas>, runs the animation loop, and places HTML labels
// on top of the 3D stages (the engine tells it where each stage is on screen).

import { useEffect, useRef, useState } from 'react'
import { Flow3D } from './flow3d'
import type { AnchorId, StageId, StageMood } from './flow3d'
import type { Tick } from './useStream'
import type { EventEntry } from './useEvents'

export interface AuditStatus {
  ok: boolean
  count: number
  broken_at: number | null
}

interface Props {
  tick: Tick | null
  live: boolean
  events: EventEntry[]
  audit: AuditStatus | null
  onOpenHeld: () => void
}

interface Label {
  id: StageId
  title: string
  mood: StageMood
}

const ORDER: AnchorId[] = ['payer', 'preflight', 'gate', 'paypal', 'webhook', 'audit', 'payee', 'quarantine']

export default function Scene3D({ tick, live, events, audit, onOpenHeld }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Flow3D | null>(null)
  const labelRefs = useRef<Partial<Record<AnchorId, HTMLElement | null>>>({})
  const lastCaptures = useRef(0)
  const mountedAt = useRef(performance.now())
  const visible = useRef(true)
  const [failed, setFailed] = useState(false)

  // Create the engine once, start the animation loop, clean up when the page closes.
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    let engine: Flow3D
    try {
      engine = new Flow3D(canvas)
    } catch {
      setFailed(true)
      return
    }
    engineRef.current = engine

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    engine.reducedMotion = motion.matches
    const onMotion = () => { engine.reducedMotion = motion.matches }
    motion.addEventListener('change', onMotion)

    const resize = () => engine.resize(wrap.clientWidth, wrap.clientHeight)
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)

    // Do no drawing work while the scene is scrolled out of view.
    const watcher = new IntersectionObserver(([entry]) => { visible.current = entry.isIntersecting })
    watcher.observe(wrap)

    const onPointer = (e: PointerEvent) => {
      engine.setPointer((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1)
    }
    window.addEventListener('pointermove', onPointer)

    let last = performance.now()
    let raf = 0
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      raf = requestAnimationFrame(frame)
      if (!visible.current) return
      engine.frame(dt)
      // Move each HTML label to where its stage currently is on screen.
      for (const id of ORDER) {
        const el = labelRefs.current[id]
        if (!el) continue
        const p = engine.project(id)
        el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`
      }
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      watcher.disconnect()
      window.removeEventListener('pointermove', onPointer)
      motion.removeEventListener('change', onMotion)
      engine.dispose()
      engineRef.current = null
    }
  }, [])

  // Each message from the server becomes new particles.
  useEffect(() => {
    if (tick && visible.current) engineRef.current?.ingest(tick)
  }, [tick])

  const held = tick?.totals.HOLD ?? 0
  const captures = events.filter((e) => e.event_type === 'PAYMENT.CAPTURE.COMPLETED' && e.status === 'OK').length
  const verified = events.filter((e) => e.status === 'OK').length
  const problems = events.filter((e) => e.status !== 'OK').length

  // A real sandbox capture sends one white pulse down the path.
  useEffect(() => {
    // The first few seconds are skipped: that is old history loading, not a new payment.
    const settled = performance.now() - mountedAt.current > 5000
    if (settled && captures > lastCaptures.current) engineRef.current?.pulseReal()
    lastCaptures.current = captures
  }, [captures])

  const flow: StageMood = live ? 'active' : 'idle'
  const labels: Label[] = [
    { id: 'payer', title: 'Payers', mood: flow },
    { id: 'preflight', title: 'Pre-flight AI', mood: flow },
    { id: 'gate', title: 'Risk gate', mood: flow },
    { id: 'paypal', title: 'PayPal', mood: captures > 0 ? 'active' : 'idle' },
    { id: 'webhook', title: 'Webhook', mood: problems > 0 ? 'alert' : verified > 0 ? 'active' : 'idle' },
    { id: 'audit', title: 'Audit log', mood: audit && !audit.ok ? 'alert' : audit && audit.count > 0 ? 'active' : 'idle' },
    { id: 'payee', title: 'Payees', mood: flow },
  ]

  // Ring colours in the 3D scene follow the same moods as the labels.
  const moods = labels.map((l) => `${l.id}:${l.mood}`).join(',')
  useEffect(() => {
    for (const pair of moods.split(',')) {
      const [id, mood] = pair.split(':')
      engineRef.current?.setMood(id as StageId, mood as StageMood)
    }
  }, [moods])

  return (
    <div ref={wrapRef} className="scene">
      <canvas ref={canvasRef} className="scene-canvas" aria-hidden="true" />
      <div className="scene-shade" />
      {failed && (
        <p className="scene-fallback">
          This browser could not start 3D graphics (WebGL). The numbers and panels still work.
        </p>
      )}
      <div className="scene-labels">
        {labels.map((l) => (
          <div key={l.id} ref={(el) => { labelRefs.current[l.id] = el }} className={`stage stage-${l.mood}`}>
            {l.title}
          </div>
        ))}
        <button ref={(el) => { labelRefs.current.quarantine = el }} type="button"
                className="stage stage-bay" onClick={onOpenHeld}>
          <span>Quarantine</span>
          <span className="stage-bay-count">{held.toLocaleString()} held</span>
        </button>
      </div>
    </div>
  )
}