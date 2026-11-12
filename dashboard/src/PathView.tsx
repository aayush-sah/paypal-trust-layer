import { ReactFlow, Handle, Position } from '@xyflow/react'
import type { Edge, Node, NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Tick } from './useStream'
import type { EventEntry } from './useEvents'

type Tone = 'cyan' | 'green' | 'amber' | 'red' | 'grey'

type StageData = {
  title: string
  line1?: string
  line2?: string
  tag?: string
  tone: Tone
}

type StageNode = Node<StageData, 'stage'>

const TONES: Record<Tone, string> = {
  cyan: 'border-cyan-500/70 text-cyan-200 shadow-[0_0_18px_rgba(34,211,238,0.35)]',
  green: 'border-emerald-500/70 text-emerald-200 shadow-[0_0_18px_rgba(16,185,129,0.35)]',
  amber: 'border-amber-500/70 text-amber-200 shadow-[0_0_18px_rgba(245,158,11,0.4)]',
  red: 'border-red-500 text-red-200 shadow-[0_0_26px_rgba(239,68,68,0.65)]',
  grey: 'border-slate-700 text-slate-500',
}

function Stage({ data }: NodeProps<StageNode>) {
  return (
    <div className={`w-40 rounded-lg border bg-black/80 px-3 py-2 text-center font-mono transition-all duration-300 ${TONES[data.tone]}`}>
      <Handle type="target" position={Position.Left} id="left" className="!bg-slate-600" />
      <Handle type="target" position={Position.Top} id="top" className="!bg-slate-600" />
      <div className="text-sm font-semibold">{data.title}</div>
      {data.line1 && <div className="mt-1 text-xs text-slate-300">{data.line1}</div>}
      {data.line2 && <div className="text-xs text-slate-400">{data.line2}</div>}
      {data.tag && <div className="mt-1 text-[10px] uppercase tracking-widest text-slate-500">{data.tag}</div>}
      <Handle type="source" position={Position.Right} id="right" className="!bg-slate-600" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-slate-600" />
    </div>
  )
}

const nodeTypes = { stage: Stage }

const CYAN = '#22d3ee'
const RED = '#ef4444'
const DIM = '#334155'

interface Props {
  tick: Tick | null
  lastHold: number
  events: EventEntry[]
}

export default function PathView({ tick, lastHold, events }: Props) {
  const live = tick !== null
  const holdFlash = tick !== null && tick.ts - lastHold < 1.2
  const totals = tick?.totals ?? { APPROVE: 0, STEP_UP: 0, HOLD: 0 }

  const captures = events.filter((e) => e.event_type === 'PAYMENT.CAPTURE.COMPLETED' && e.status === 'OK').length
  const ok = events.filter((e) => e.status === 'OK').length
  const anomaly = events.filter((e) => e.status === 'ANOMALY').length
  const rejected = events.filter((e) => e.status === 'REJECTED').length

  const nodes: StageNode[] = [
    { id: 'payer', type: 'stage', position: { x: 0, y: 40 }, data: {
      title: 'Payer', line1: tick ? `${tick.tx_per_sec.toLocaleString()} payments/s` : 'waiting for stream',
      tag: 'simulated', tone: live ? 'cyan' : 'grey' } },
    { id: 'pre', type: 'stage', position: { x: 200, y: 40 }, data: {
      title: 'Pre-flight AI', line1: 'rules + model', line2: tick ? `${tick.batch_ms} ms per batch` : '',
      tag: 'simulated', tone: live ? 'cyan' : 'grey' } },
    { id: 'gate', type: 'stage', position: { x: 400, y: 40 }, data: {
      title: 'Risk Gate', line1: `Approve ${totals.APPROVE.toLocaleString()}`,
      line2: `Step-up ${totals.STEP_UP.toLocaleString()}`, tag: 'simulated',
      tone: holdFlash ? 'red' : live ? 'green' : 'grey' } },
    { id: 'hold', type: 'stage', position: { x: 400, y: 190 }, data: {
      title: 'Hold lane', line1: `${totals.HOLD.toLocaleString()} held`, line2: 'no money moved',
      tone: holdFlash ? 'red' : 'grey' } },
    { id: 'paypal', type: 'stage', position: { x: 600, y: 40 }, data: {
      title: 'PayPal', line1: `${captures} real captures`, line2: 'sandbox', tag: 'real payments only',
      tone: captures > 0 ? 'green' : 'grey' } },
    { id: 'webhook', type: 'stage', position: { x: 800, y: 40 }, data: {
      title: 'Webhook verify', line1: `${ok} ok · ${anomaly} anomaly`, line2: `${rejected} rejected`,
      tag: 'real events', tone: anomaly + rejected > 0 ? 'amber' : ok > 0 ? 'green' : 'grey' } },
    { id: 'audit', type: 'stage', position: { x: 1000, y: 40 }, data: {
      title: 'Audit log', line1: 'hash chain', line2: 'coming next', tone: 'grey' } },
    { id: 'payee', type: 'stage', position: { x: 1200, y: 40 }, data: {
      title: 'Payee', line1: `${(totals.APPROVE + totals.STEP_UP).toLocaleString()} released`,
      tag: 'simulated', tone: live ? 'cyan' : 'grey' } },
  ]

  const line = (animated: boolean, color = CYAN) => ({ animated, style: { stroke: animated ? color : DIM, strokeWidth: 2 } })

  const edges: Edge[] = [
    { id: 'e1', source: 'payer', sourceHandle: 'right', target: 'pre', targetHandle: 'left', ...line(live) },
    { id: 'e2', source: 'pre', sourceHandle: 'right', target: 'gate', targetHandle: 'left', ...line(live) },
    { id: 'e3', source: 'gate', sourceHandle: 'right', target: 'paypal', targetHandle: 'left', ...line(live) },
    { id: 'e4', source: 'paypal', sourceHandle: 'right', target: 'webhook', targetHandle: 'left', ...line(captures > 0) },
    { id: 'e5', source: 'webhook', sourceHandle: 'right', target: 'audit', targetHandle: 'left', ...line(false) },
    { id: 'e6', source: 'audit', sourceHandle: 'right', target: 'payee', targetHandle: 'left', ...line(false) },
    { id: 'e7', source: 'gate', sourceHandle: 'bottom', target: 'hold', targetHandle: 'top', ...line(holdFlash, RED) },
  ]

  return (
    <div>
      <div className="h-[340px] rounded-lg border border-white/10 bg-white/5">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.1 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          zoomOnPinch={false}
          preventScrolling={false}
        />
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Stages tagged "simulated" run on the simulated stream. PayPal and Webhook show only real sandbox
        payments and events. The Audit log is the next step.
      </p>
    </div>
  )
}