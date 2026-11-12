import { useCallback, useEffect, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz } from 'ag-grid-community'
import type { ColDef, RowClassParams } from 'ag-grid-community'
import { API } from './useStream'

ModuleRegistry.registerModules([AllCommunityModule])

const theme = themeQuartz.withPart(colorSchemeDark).withParams({
  backgroundColor: '#070b18',
  foregroundColor: '#eef2ff',
  headerBackgroundColor: '#0c1430',
  borderColor: 'rgba(80, 120, 255, 0.2)',
  fontFamily: 'inherit',
})

interface AuditRow {
  id: number
  ts: string
  kind: string
  ref: string
  summary: string
  hash: string
  prev_hash: string
}

interface Verify {
  ok: boolean
  count: number
  broken_at: number | null
  reason: string
  head: string
}

const BAD_KINDS = ['capture_failed', 'webhook_rejected', 'capture_blocked']

function tone(row: AuditRow | undefined) {
  if (!row) return ''
  if (row.summary.startsWith('HOLD') || BAD_KINDS.includes(row.kind) || row.summary.includes('ANOMALY')) {
    return 'text-red-400'
  }
  if (row.summary.startsWith('STEP_UP')) return 'text-amber-400'
  if (row.summary.startsWith('APPROVE') || row.kind === 'capture') return 'text-emerald-400'
  return 'text-slate-300'
}

const columns: ColDef<AuditRow>[] = [
  { field: 'id', headerName: '#', width: 80 },
  {
    field: 'ts',
    headerName: 'Time',
    width: 120,
    valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleTimeString() : ''),
  },
  { field: 'kind', headerName: 'Event', width: 160, cellClass: (p) => tone(p.data) },
  { field: 'summary', headerName: 'What happened', flex: 1, minWidth: 300, cellClass: (p) => tone(p.data), tooltipField: 'summary' },
  {
    field: 'hash',
    headerName: 'Entry hash',
    width: 150,
    valueFormatter: (p) => (p.value ? `${String(p.value).slice(0, 12)}…` : ''),
    tooltipField: 'hash',
    cellClass: 'font-mono text-slate-400',
  },
  {
    field: 'prev_hash',
    headerName: 'Previous hash',
    width: 150,
    valueFormatter: (p) => (p.value ? `${String(p.value).slice(0, 12)}…` : ''),
    tooltipField: 'prev_hash',
    cellClass: 'font-mono text-slate-500',
  },
]

interface Props {
  // Lets the 3D scene show the chain status on the Audit log ring.
  onStatus?: (status: Verify) => void
}

export default function AuditLog({ onStatus }: Props) {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [verify, setVerify] = useState<Verify | null>(null)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    try {
      const [rowsRes, verifyRes] = await Promise.all([
        fetch(`${API}/audit?limit=200`),
        fetch(`${API}/audit/verify`),
      ])
      if (rowsRes.ok) setRows(await rowsRes.json())
      if (verifyRes.ok) {
        const status: Verify = await verifyRes.json()
        setVerify(status)
        onStatus?.(status)
      }
    } catch {
      // server offline: keep what we have
    }
  }, [onStatus])

  useEffect(() => {
    load()
    const timer = window.setInterval(load, 2000)
    return () => window.clearInterval(timer)
  }, [load])

  const post = async (path: string) => {
    try {
      const res = await fetch(`${API}${path}`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setMessage(typeof body?.detail === 'string' ? body.detail : `Request failed (${res.status})`)
      } else {
        setMessage('')
      }
      await load()
    } catch {
      setMessage('Cannot reach the server on port 8000. Is uvicorn running?')
    }
  }

  const btn = 'btn'

  return (
    <div>
      <div className="panel-head panel-head-wrap">
        {verify && verify.ok && (
          <span className="badge badge-ok">
            Chain verified, {verify.count} entries
          </span>
        )}
        {verify && !verify.ok && (
          <span className="badge badge-bad">
            Chain broken at entry {verify.broken_at}
          </span>
        )}
        <span className="flex-1" />
        <button className={btn} onClick={() => post('/audit/tamper')}>Simulate tampering</button>
        <button className={btn} onClick={() => post('/audit/untamper')}>Undo tampering</button>
      </div>

      {verify && !verify.ok && <p className="mb-2 text-sm text-red-300">Reason: {verify.reason}.</p>}
      {message && <p className="mb-2 text-sm text-red-400">{message}</p>}
      <p className="panel-note mb-3">
        Every real decision, order, capture and webhook is written here, and each entry contains the hash of the one
        before it. Changing or removing any old entry breaks the chain. Simulated traffic is not logged per payment,
        and "Reset demo data" does not clear this log. Latest hash:{' '}
        <span className="font-mono">{verify ? `${verify.head.slice(0, 16)}…` : '-'}</span>
      </p>

      <div className="h-[380px]">
        <AgGridReact<AuditRow>
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={{ sortable: true, resizable: true }}
          getRowId={(p) => String(p.data.id)}
          getRowClass={(p: RowClassParams<AuditRow>) => (verify && p.data?.id === verify.broken_at ? 'row-broken' : undefined)}
        />
      </div>
    </div>
  )
}