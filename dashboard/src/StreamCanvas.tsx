import { useEffect, useRef, useState } from 'react'
import type { Tick } from './useStream'
import { StreamField } from './streams'

export default function StreamCanvas({ tick }: { tick: Tick | null }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [field] = useState(() => new StreamField())

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!wrap || !canvas || !ctx) return

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const width = wrap.clientWidth
      const height = wrap.clientHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      field.resize(width, height)
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)

    let last = performance.now()
    let raf = 0
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      field.update(dt)
      field.draw(ctx)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [field])

  useEffect(() => {
    if (tick) field.ingest(tick)
  }, [tick, field])

  return (
    <div>
      <div ref={wrapRef} className="relative h-[260px] overflow-hidden rounded-lg border border-white/10 bg-black">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      </div>
      <p className="mt-2 text-xs text-slate-500">
        <span className="text-cyan-300">Cyan</span> dots are a sample of approved payments (simulated).
        Every <span className="text-amber-300">step-up</span> and <span className="text-red-400">held</span> payment
        is drawn. Held payments turn red and drop into the hold lane.
      </p>
    </div>
  )
}