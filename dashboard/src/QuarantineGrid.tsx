// The quarantine table, built with AG Grid.
// Sort by any column, filter from the column menus, search, page through results, export to CSV.
// Selecting a row shows every signal behind that decision.

import { useMemo, useRef, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz } from 'ag-grid-community'
import type { ColDef, ICellRendererParams, SelectionChangedEvent } from 'ag-grid-community'
import type { Item } from './useStream'

ModuleRegistry.registerModules([AllCommunityModule])

const theme = themeQuartz.withPart(colorSchemeDark).withParams({
  backgroundColor: '#070b18',
  foregroundColor: '#eef2ff',
  headerBackgroundColor: '#0c1430',
  borderColor: 'rgba(80, 120, 255, 0.2)',
  fontFamily: 'inherit',
})

type View = 'all' | 'HOLD' | 'STEP_UP'

const DECISION_NAME = { HOLD: 'Held', STEP_UP: 'Needs confirmation', APPROVE: 'Approved' }

function cleanReason(reason: string) {
  return reason.replace(/^\[[a-z]+\]\s*/, '')
}

function DecisionCell({ data }: ICellRendererParams<Item>) {
  if (!data) return null
  return <span className={`chip chip-${data.decision}`}>{DECISION_NAME[data.decision]}</span>
}

// A score from 0 to 100 drawn as a small bar with the number next to it.
function ScoreCell({ value }: ICellRendererParams<Item, number>) {
  const score = Math.max(0, Math.min(100, value ?? 0))
  return (
    <span className="score">
      <span className="score-track"><span style={{ width: `${score}%` }} /></span>
      {Math.round(score)}
    </span>
  )
}

const columns: ColDef<Item>[] = [
  { field: 'id', hide: true, sort: 'desc' },   // hidden, but keeps the newest payment on top
  { headerName: 'Decision', width: 170, valueGetter: (p) => (p.data ? DECISION_NAME[p.data.decision] : ''), cellRenderer: DecisionCell },
  {
    field: 'amount', headerName: 'Amount', width: 130, type: 'rightAligned', filter: 'agNumberColumnFilter',
    valueFormatter: (p) => (p.value == null ? '' : `$${Number(p.value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`),
  },
  { field: 'payer', headerName: 'Payer', width: 105 },
  { field: 'payee', headerName: 'Payee', width: 115 },
  { field: 'hour', headerName: 'Hour', width: 88, filter: 'agNumberColumnFilter', valueFormatter: (p) => (p.value == null ? '' : `${p.value}:00`) },
  { headerName: 'Main reason', flex: 1, minWidth: 190, valueGetter: (p) => cleanReason(p.data?.reasons?.[0] ?? ''), tooltipValueGetter: (p) => String(p.value ?? '') },
  { field: 'rules', headerName: 'Rules score', width: 125, filter: 'agNumberColumnFilter', cellRenderer: ScoreCell },
  { field: 'ml', headerName: 'Model score', width: 125, filter: 'agNumberColumnFilter', cellRenderer: ScoreCell },
  { headerName: 'Simulated attack', width: 150, valueGetter: (p) => p.data?.label ?? 'none' },
]

export default function QuarantineGrid({ held, review }: { held: Item[]; review: Item[] }) {
  const gridRef = useRef<AgGridReact<Item>>(null)
  const [view, setView] = useState<View>('HOLD')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Item | null>(null)
  const [frozen, setFrozen] = useState<Item[] | null>(null)   // a snapshot, while updates are paused

  const liveRows = useMemo(() => {
    if (view === 'HOLD') return held
    if (view === 'STEP_UP') return review
    return [...held, ...review]
  }, [view, held, review])
  const rows = frozen ?? liveRows

  const changeView = (next: View) => {
    setView(next)
    setFrozen(null)
  }

  return (
    <div>
      <div className="grid-bar">
        <div className="seg" role="tablist">
          <button type="button" role="tab" aria-selected={view === 'HOLD'} onClick={() => changeView('HOLD')}>Held</button>
          <button type="button" role="tab" aria-selected={view === 'STEP_UP'} onClick={() => changeView('STEP_UP')}>Needs confirmation</button>
          <button type="button" role="tab" aria-selected={view === 'all'} onClick={() => changeView('all')}>Both</button>
        </div>
        <input className="input grid-search" type="search" placeholder="Search payer, payee or reason" aria-label="Search the table"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <button type="button" className="btn" aria-pressed={frozen !== null} onClick={() => setFrozen(frozen ? null : liveRows)}>
          {frozen ? 'Resume live updates' : 'Pause updates'}
        </button>
        <button type="button" className="btn" disabled={rows.length === 0}
                onClick={() => gridRef.current?.api.exportDataAsCsv({ fileName: 'trust-layer-quarantine.csv' })}>
          Export CSV
        </button>
      </div>

      <div className="grid-box">
        <AgGridReact<Item>
          ref={gridRef}
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={(p) => String(p.data.id)}
          quickFilterText={search}
          pagination
          paginationPageSize={10}
          paginationPageSizeSelector={[10, 25, 50]}
          rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
          onSelectionChanged={(e: SelectionChangedEvent<Item>) => setSelected(e.api.getSelectedRows()[0] ?? null)}
          overlayNoRowsTemplate="Nothing here yet. Start the traffic, then inject an attack."
        />
      </div>

      <div className="grid-detail" aria-live="polite">
        {selected ? (
          <>
            <h3>
              ${selected.amount.toLocaleString()} from {selected.payer} to {selected.payee}
              <span className={`chip chip-${selected.decision}`}>{DECISION_NAME[selected.decision]}</span>
            </h3>
            <ul>
              {(selected.reasons ?? []).map((r) => <li key={r}>{cleanReason(r)}</li>)}
            </ul>
            <p>
              Rules score {selected.rules}, model score {selected.ml}, at {selected.hour}:00.
              {selected.label ? ` Simulated attack type: ${selected.label}.` : ''}
            </p>
          </>
        ) : (
          <p>Select a row to see every signal behind that decision.</p>
        )}
      </div>
    </div>
  )
}