import type { Decision, Item, Tick } from './useStream'

type Phase = 'approach' | 'passed' | 'held'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  kind: Decision
  phase: Phase
  age: number
  life: number
  size: number
  label: string | null
}

const RGB: Record<Decision, string> = {
  APPROVE: '34, 211, 238',
  STEP_UP: '245, 158, 11',
  HOLD: '239, 68, 68',
}

const MAX_PARTICLES = 2500
const SAMPLE_PER_TICK = 16
const HELD_LIFE = 3.5

function shorten(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function makeLabel(item: Item) {
  const reason = (item.reasons?.[0] ?? '').replace(/^\[[a-z]+\]\s*/, '')
  return shorten(`$${item.amount.toLocaleString()} · ${reason}`, 52)
}

export class StreamField {
  width = 900
  height = 260
  gateFlash = 0
  particles: Particle[] = []

  get gateX() {
    return this.width * 0.55
  }

  get laneY() {
    return this.height - 30
  }

  resize(width: number, height: number) {
    this.width = width
    this.height = height
  }

  ingest(tick: Tick) {
    if (typeof document !== 'undefined' && document.hidden) return
    if (this.particles.length < MAX_PARTICLES) {
      for (const item of tick.sample.slice(0, SAMPLE_PER_TICK)) this.spawn(item)
    }
    for (const item of tick.flagged) this.spawn(item)
  }

  private spawn(item: Item) {
    const top = 36
    const bottom = this.height * 0.62
    const speed = this.gateX / (1.7 + Math.random() * 0.8)
    this.particles.push({
      x: -Math.random() * speed * 0.1,
      y: top + Math.random() * (bottom - top),
      vx: speed,
      vy: 0,
      kind: item.decision,
      phase: 'approach',
      age: 0,
      life: Infinity,
      size: item.decision === 'APPROVE' ? 1.6 : 2.6,
      label: item.decision === 'HOLD' ? makeLabel(item) : null,
    })
  }

  update(dt: number) {
    this.gateFlash = Math.max(0, this.gateFlash - dt * 1.6)
    const gateX = this.gateX
    const laneY = this.laneY
    let keep = 0

    for (const p of this.particles) {
      p.age += dt
      p.x += p.vx * dt
      p.y += p.vy * dt

      if (p.phase === 'approach' && p.x >= gateX) {
        if (p.kind === 'HOLD') {
          p.phase = 'held'
          p.vx *= 0.25
          p.vy = (laneY - p.y) / 0.7
          p.age = 0
          p.life = HELD_LIFE
          this.gateFlash = 1
        } else {
          p.phase = 'passed'
          if (p.kind === 'STEP_UP') p.vx *= 0.55
        }
      }

      if (p.phase === 'held' && p.y >= laneY) {
        p.y = laneY
        p.vy = 0
      }

      if (p.x < this.width + 20 && p.age < p.life) {
        this.particles[keep++] = p
      }
    }
    this.particles.length = keep
  }

  draw(ctx: CanvasRenderingContext2D) {
    const w = this.width
    const h = this.height
    const gateX = this.gateX
    const laneY = this.laneY
    ctx.clearRect(0, 0, w, h)

    ctx.fillStyle = 'rgba(239, 68, 68, 0.06)'
    ctx.fillRect(gateX, laneY - 16, w - gateX, 32)
    ctx.font = '11px ui-monospace, Consolas, monospace'
    ctx.fillStyle = 'rgba(248, 113, 113, 0.55)'
    ctx.fillText('HOLD LANE · no money moved', gateX + 10, laneY + 4)

    ctx.fillStyle = 'rgba(148, 163, 184, 0.7)'
    ctx.fillText('PAYERS (simulated)', 10, 18)
    ctx.fillText('RELEASED', w - 78, 18)

    const flash = this.gateFlash
    ctx.lineWidth = 2
    ctx.strokeStyle = flash > 0.05
      ? `rgba(239, 68, 68, ${0.4 + 0.6 * flash})`
      : 'rgba(34, 211, 238, 0.35)'
    ctx.beginPath()
    ctx.moveTo(gateX, 28)
    ctx.lineTo(gateX, h - 8)
    ctx.stroke()
    ctx.fillStyle = flash > 0.05 ? 'rgba(252, 165, 165, 0.95)' : 'rgba(103, 232, 249, 0.8)'
    ctx.fillText('RISK GATE', gateX - 30, 18)

    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    for (const p of this.particles) {
      let alpha = 1
      let size = p.size
      if (p.phase === 'passed') alpha = Math.min(1, Math.max(0, (w - p.x) / (w * 0.2)))
      if (p.phase === 'held') {
        alpha = Math.max(0, 1 - p.age / p.life)
        size = p.size * (1 + 0.3 * Math.sin(p.age * 14))
      }
      if (p.phase === 'approach') alpha = Math.min(1, p.age / 0.25 + 0.2)

      const rgb = RGB[p.kind]
      ctx.strokeStyle = `rgba(${rgb}, ${alpha * 0.55})`
      ctx.lineWidth = size
      ctx.beginPath()
      ctx.moveTo(p.x - p.vx * 0.07, p.y - p.vy * 0.07)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()

      ctx.fillStyle = `rgba(${rgb}, ${alpha * 0.12})`
      ctx.beginPath()
      ctx.arc(p.x, p.y, size * 3.2, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = `rgba(${rgb}, ${alpha})`
      ctx.beginPath()
      ctx.arc(p.x, p.y, size * 0.9, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'

    let slot = 0
    for (let i = this.particles.length - 1; i >= 0 && slot < 4; i--) {
      const p = this.particles[i]
      if (p.phase === 'held' && p.label && p.age < 2.6) {
        ctx.fillStyle = `rgba(254, 202, 202, ${Math.max(0, 1 - p.age / 2.6)})`
        ctx.fillText(`⚠ ${p.label}`, gateX + 12, laneY - 30 - slot * 16)
        slot++
      }
    }
  }
}