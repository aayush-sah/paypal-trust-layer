import { useEffect, useRef, useState } from 'react'

export const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:8000'
const WS_URL = `${API.replace(/^http/, 'ws')}/ws`

export type Decision = 'APPROVE' | 'STEP_UP' | 'HOLD'

export interface Item {
  id: number
  payer: string
  payee: string
  amount: number
  hour: number
  decision: Decision
  rules: number
  ml: number
  label: string | null
  reasons?: string[]
}

export interface Tick {
  type: 'tick'
  ts: number
  n: number
  tx_per_sec: number
  batch_ms: number
  counts: Record<Decision, number>
  totals: Record<Decision, number>
  sample: Item[]
  flagged: Item[]
  flagged_total: number
}

export type Status = 'connecting' | 'open' | 'closed'

const KEEP = 300

export function useStream() {
  const [status, setStatus] = useState<Status>('connecting')
  const [tick, setTick] = useState<Tick | null>(null)
  // Two separate lists, so a burst of step-ups can never push the holds out of view.
  const [held, setHeld] = useState<Item[]>([])
  const [review, setReview] = useState<Item[]>([])
  // "live" means payments are flowing right now. It turns off when messages stop arriving.
  const [live, setLive] = useState(false)
  const lastTickAt = useRef(0)

  useEffect(() => {
    let ws: WebSocket | null = null
    let stopped = false
    let timer: number | undefined

    const connect = () => {
      ws = new WebSocket(WS_URL)
      ws.onopen = () => setStatus('open')
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.type !== 'tick') return
        const t = msg as Tick
        setTick(t)
        lastTickAt.current = Date.now()
        setLive(t.tx_per_sec > 0)
        const holds = t.flagged.filter((i) => i.decision === 'HOLD')
        const stepUps = t.flagged.filter((i) => i.decision === 'STEP_UP')
        if (holds.length > 0) setHeld((f) => [...holds, ...f].slice(0, KEEP))
        if (stepUps.length > 0) setReview((f) => [...stepUps, ...f].slice(0, KEEP))
      }
      ws.onclose = () => {
        if (stopped) return
        setStatus('closed')
        timer = window.setTimeout(() => {
          setStatus('connecting')
          connect()
        }, 1500)
      }
      ws.onerror = () => ws?.close()
    }

    connect()
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastTickAt.current > 2500) setLive(false)
    }, 1000)
    return () => {
      stopped = true
      window.clearInterval(watchdog)
      window.clearTimeout(timer)
      ws?.close()
    }
  }, [])

  return { status, tick, held, review, live }
}