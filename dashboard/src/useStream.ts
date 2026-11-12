import { useEffect, useState } from 'react'

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

export function useStream() {
  const [status, setStatus] = useState<Status>('connecting')
  const [tick, setTick] = useState<Tick | null>(null)
  const [feed, setFeed] = useState<Item[]>([])
  const [history, setHistory] = useState<number[]>([])
  const [lastHold, setLastHold] = useState(0)

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
        setHistory((h) => [...h.slice(-59), t.tx_per_sec])
        if (t.counts.HOLD > 0) setLastHold(t.ts)
        if (t.flagged.length > 0) {
          setFeed((f) => [...t.flagged, ...f].slice(0, 60))
        }
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
    return () => {
      stopped = true
      window.clearTimeout(timer)
      ws?.close()
    }
  }, [])

  return { status, tick, feed, history, lastHold }
}