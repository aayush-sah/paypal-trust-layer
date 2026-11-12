import { useEffect, useState } from 'react'
import { API } from './useStream'

export interface EventEntry {
  event_type: string | null
  order_id: string | null
  status: 'OK' | 'ANOMALY' | 'REJECTED'
  findings: string[]
  time: string
}

export function useEvents() {
  const [events, setEvents] = useState<EventEntry[]>([])

  useEffect(() => {
    let stopped = false

    const load = async () => {
      try {
        const res = await fetch(`${API}/events`)
        if (res.ok && !stopped) setEvents(await res.json())
      } catch {
        // server offline: keep the last known events
      }
    }

    load()
    const timer = window.setInterval(load, 2000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [])

  return events
}