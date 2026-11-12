// The 3D scene engine. No React in here: it only knows about three.js.
//
// Idea: the payment path is a corridor along the X axis. Every stage of the
// path is a glowing ring. Payments are particles that fly through the rings.
// At the Risk Gate each particle gets its colour from the real decision:
//   APPROVE -> keeps flying to the payee
//   STEP_UP -> turns amber, slows down and takes a raised "review" arc
//   HOLD    -> turns red and is pulled out of the corridor into the quarantine bay

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { Decision, Item, Tick } from './useStream'

export type StageId = 'payer' | 'preflight' | 'gate' | 'paypal' | 'webhook' | 'audit' | 'payee'
export type AnchorId = StageId | 'quarantine'
export type StageMood = 'idle' | 'active' | 'alert'

interface StageDef {
  id: StageId
  x: number
  radius: number
}

// Where each stage sits on the X axis, and how big its ring is.
const STAGES: StageDef[] = [
  { id: 'payer', x: -38, radius: 4.2 },
  { id: 'preflight', x: -25, radius: 5.6 },
  { id: 'gate', x: -11, radius: 7.2 },
  { id: 'paypal', x: 4, radius: 5.6 },
  { id: 'webhook', x: 16, radius: 5 },
  { id: 'audit', x: 27, radius: 5 },
  { id: 'payee', x: 38, radius: 4.2 },
]

const X_START = -43
const X_END = 43
const GATE_X = -11
const PAYPAL_X = 4
const LANE_RADIUS = 3.6
const BAY = new THREE.Vector3(-8, -12, 14) // centre of the quarantine bay
const BAY_SIZE = new THREE.Vector3(12, 5, 9)

const MAX_PARTICLES = 3000
const SAMPLE_PER_TICK = 16
const FLAGGED_PER_TICK = 40
const HELD_LIFE = 9

// Colours as plain r, g, b numbers (0 to 1) so they are cheap to write into buffers.
const COLOR_INCOMING = [0.42, 0.46, 0.72]
const COLOR: Record<Decision, number[]> = {
  APPROVE: [0.2, 0.45, 1.0],
  STEP_UP: [1.0, 0.68, 0.2],
  HOLD: [1.0, 0.16, 0.36],
}
const COLOR_REAL = [1.0, 1.0, 1.0]

const MOOD_COLOR: Record<StageMood, THREE.Color> = {
  idle: new THREE.Color(0x1c2a66),
  active: new THREE.Color(0x3d6bff),
  alert: new THREE.Color(0xff3d6b),
}

// The life stages of one particle.
const Phase = { Approach: 0, Passed: 1, Review: 2, Divert: 3, Held: 4 } as const
type Phase = (typeof Phase)[keyof typeof Phase]

interface Particle {
  x: number; y: number; z: number
  px: number; py: number; pz: number // previous position, used to draw the trail
  oy: number; oz: number             // this particle's own lane inside the corridor
  speed: number
  kind: Decision
  phase: Phase
  real: boolean
  age: number
  size: number
  // used only while a held particle travels to, and circles inside, the bay
  sx: number; sy: number; sz: number
  tx: number; ty: number; tz: number
  angle: number
}

// The corridor narrows as it passes through each ring, like thread through a needle.
function pinch(x: number) {
  let squeeze = 0
  for (const s of STAGES) {
    const d = (x - s.x) / 3.5
    squeeze = Math.max(squeeze, Math.exp(-d * d))
  }
  return 1 - 0.5 * squeeze
}

const POINT_VERTEX = `
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uScale;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / -mv.z;   // farther away = smaller on screen
    gl_Position = projectionMatrix * mv;
  }
`
const POINT_FRAGMENT = `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float glow = smoothstep(0.5, 0.0, d);    // soft round dot instead of a square
    gl_FragColor = vec4(vColor * glow, 1.0);
  }
`

export class Flow3D {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400)
  private composer: EffectComposer
  private bloom: UnrealBloomPass

  private particles: Particle[] = []
  private linePos = new Float32Array(MAX_PARTICLES * 6)
  private lineCol = new Float32Array(MAX_PARTICLES * 6)
  private pointPos = new Float32Array(MAX_PARTICLES * 3)
  private pointCol = new Float32Array(MAX_PARTICLES * 3)
  private pointSize = new Float32Array(MAX_PARTICLES)
  private lines: THREE.LineSegments
  private points: THREE.Points
  private pointMaterial: THREE.ShaderMaterial

  private rings = new Map<StageId, { mesh: THREE.Mesh; inner: THREE.Mesh; mood: StageMood }>()
  private bayBox!: THREE.LineSegments
  private gateFlash = 0
  private bayFlash = 0
  private time = 0

  private width = 1
  private height = 1
  private camBase = new THREE.Vector3()
  private camLook = new THREE.Vector3(0, -8, 0)
  private pointerX = 0
  private pointerY = 0
  private swayX = 0
  private swayY = 0
  private tmp = new THREE.Vector3()

  reducedMotion = false

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.scene.background = new THREE.Color(0x03050d)
    this.scene.fog = new THREE.FogExp2(0x03050d, 0.0075)

    this.buildFloor()
    this.buildCorridor()
    this.buildBay()

    // Trails: one short line per particle. Additive blending makes overlaps glow.
    const lineGeo = new THREE.BufferGeometry()
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3))
    lineGeo.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3))
    this.lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    this.lines.frustumCulled = false
    this.scene.add(this.lines)

    // Heads: one glowing dot per particle.
    const pointGeo = new THREE.BufferGeometry()
    pointGeo.setAttribute('position', new THREE.BufferAttribute(this.pointPos, 3))
    pointGeo.setAttribute('aColor', new THREE.BufferAttribute(this.pointCol, 3))
    pointGeo.setAttribute('aSize', new THREE.BufferAttribute(this.pointSize, 1))
    this.pointMaterial = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 1 } },
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    })
    this.points = new THREE.Points(pointGeo, this.pointMaterial)
    this.points.frustumCulled = false
    this.scene.add(this.points)

    // Bloom is the "glow" filter that runs over the finished picture.
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.5, 0.15)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
  }

  private buildFloor() {
    const grid = new THREE.GridHelper(320, 80, 0x1f3fb0, 0x0f1c52)
    grid.position.y = -15
    const mat = grid.material as THREE.Material
    mat.transparent = true
    mat.opacity = 0.55
    this.scene.add(grid)
  }

  private buildCorridor() {
    for (const s of STAGES) {
      // A torus with 6 segments around is a hexagon ring.
      const material = new THREE.MeshBasicMaterial({ color: MOOD_COLOR.idle.clone() })
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(s.radius, 0.12, 6, 6), material)
      mesh.position.set(s.x, 0, 0)
      mesh.rotation.y = Math.PI / 2
      this.scene.add(mesh)

      const inner = new THREE.Mesh(
        new THREE.TorusGeometry(s.radius * 0.8, 0.035, 6, 6),
        new THREE.MeshBasicMaterial({ color: MOOD_COLOR.idle.clone(), transparent: true, opacity: 0.7 }),
      )
      inner.position.copy(mesh.position)
      inner.rotation.y = Math.PI / 2
      this.scene.add(inner)

      this.rings.set(s.id, { mesh, inner, mood: 'idle' })
    }

    // A faint centre line so the path reads even when no traffic is flowing.
    const spine = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(X_START, 0, 0), new THREE.Vector3(X_END, 0, 0),
    ])
    this.scene.add(new THREE.Line(spine, new THREE.LineBasicMaterial({ color: 0x1f2c6e, transparent: true, opacity: 0.8 })))
  }

  private buildBay() {
    const box = new THREE.BoxGeometry(BAY_SIZE.x, BAY_SIZE.y, BAY_SIZE.z)
    this.bayBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0xff3d6b, transparent: true, opacity: 0.55 }),
    )
    this.bayBox.position.copy(BAY)
    this.scene.add(this.bayBox)

    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(BAY_SIZE.x, BAY_SIZE.z),
      new THREE.MeshBasicMaterial({ color: 0xff3d6b, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }),
    )
    pad.rotation.x = -Math.PI / 2
    pad.position.set(BAY.x, BAY.y - BAY_SIZE.y / 2, BAY.z)
    this.scene.add(pad)

    // The chute from the Risk Gate down into the bay.
    const chute = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(GATE_X, -2, 0),
      new THREE.Vector3(GATE_X + 4, -9, 4),
      new THREE.Vector3(BAY.x, BAY.y + 1, BAY.z - 1),
    )
    this.scene.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(chute.getPoints(24)),
      new THREE.LineBasicMaterial({ color: 0xff3d6b, transparent: true, opacity: 0.22 }),
    ))
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.renderer.setSize(this.width, this.height, false)
    this.composer.setSize(this.width, this.height)
    this.bloom.resolution.set(this.width, this.height)

    const aspect = this.width / this.height
    this.camera.aspect = aspect
    // Narrow screens see less sideways, so pull the camera back until the whole path fits.
    const fit = Math.max(0.84, 1.95 / aspect)
    this.camBase.set(-6 * fit, 9 * fit, 66 * fit)
    this.camera.updateProjectionMatrix()

    const fovRad = (this.camera.fov * Math.PI) / 180
    this.pointMaterial.uniforms.uScale.value = (this.renderer.domElement.height * 0.5) / Math.tan(fovRad / 2)
  }

  setPointer(nx: number, ny: number) {
    this.pointerX = nx
    this.pointerY = ny
  }

  setMood(id: StageId, mood: StageMood) {
    const ring = this.rings.get(id)
    if (ring) ring.mood = mood
  }

  ingest(tick: Tick) {
    if (typeof document !== 'undefined' && document.hidden) return
    if (this.particles.length < MAX_PARTICLES - 200) {
      for (const item of tick.sample.slice(0, SAMPLE_PER_TICK)) this.spawn(item.decision, false)
    }
    // Every flagged payment is drawn. Holds go first if a tick has too many.
    const flagged = [...tick.flagged].sort((a: Item, b: Item) => Number(b.decision === 'HOLD') - Number(a.decision === 'HOLD'))
    for (const item of flagged.slice(0, FLAGGED_PER_TICK)) this.spawn(item.decision, false)
  }

  // One bright white particle for a real PayPal sandbox payment.
  pulseReal() {
    this.spawn('APPROVE', true)
  }

  private spawn(kind: Decision, real: boolean) {
    if (this.particles.length >= MAX_PARTICLES) return
    // Random point inside a circle, so lanes fill the corridor evenly.
    const a = Math.random() * Math.PI * 2
    const r = real ? 0 : Math.sqrt(Math.random()) * LANE_RADIUS
    const x = X_START - Math.random() * 2
    this.particles.push({
      x, y: 0, z: 0, px: x, py: 0, pz: 0,
      oy: Math.sin(a) * r, oz: Math.cos(a) * r,
      speed: real ? 11 : 13 + Math.random() * 7,
      kind, phase: Phase.Approach, real, age: 0,
      size: real ? 1.3 : 0.42,
      sx: 0, sy: 0, sz: 0, tx: 0, ty: 0, tz: 0, angle: 0,
    })
  }

  private update(dt: number) {
    this.gateFlash = Math.max(0, this.gateFlash - dt * 1.4)
    this.bayFlash = Math.max(0, this.bayFlash - dt * 1.2)
    let keep = 0

    for (const p of this.particles) {
      p.age += dt
      p.px = p.x; p.py = p.y; p.pz = p.z

      if (p.phase === Phase.Approach || p.phase === Phase.Passed || p.phase === Phase.Review) {
        let lift = 0
        let speed = p.speed
        if (p.phase === Phase.Review) {
          const u = (p.x - GATE_X) / (PAYPAL_X - GATE_X)
          lift = 5 * Math.sin(Math.PI * Math.min(1, u))
          speed *= 0.5
          if (u >= 1) p.phase = Phase.Passed
        }
        p.x += speed * dt
        const squeeze = pinch(p.x)
        p.y = p.oy * squeeze + lift
        p.z = p.oz * squeeze

        // The decision becomes visible at the Risk Gate.
        if (p.phase === Phase.Approach && p.x >= GATE_X) {
          if (p.kind === 'HOLD') {
            p.phase = Phase.Divert
            p.age = 0
            p.size = 0.8
            p.sx = p.x; p.sy = p.y; p.sz = p.z
            p.tx = BAY.x + (Math.random() - 0.5) * (BAY_SIZE.x - 3)
            p.ty = BAY.y + (Math.random() - 0.5) * (BAY_SIZE.y - 2)
            p.tz = BAY.z + (Math.random() - 0.5) * (BAY_SIZE.z - 3)
            this.gateFlash = 1
          } else if (p.kind === 'STEP_UP') {
            p.phase = Phase.Review
            p.size = 0.6
          } else {
            p.phase = Phase.Passed
          }
        }
        if (p.x > X_END) continue
      } else if (p.phase === Phase.Divert) {
        // Curve from the gate to a spot in the bay (a quadratic Bezier curve).
        const u = Math.min(1, p.age / 1.1)
        const e = u * u * (3 - 2 * u)
        const cx = p.sx + 4, cy = p.sy - 8, cz = p.sz + 4
        const k0 = (1 - e) * (1 - e), k1 = 2 * (1 - e) * e, k2 = e * e
        p.x = k0 * p.sx + k1 * cx + k2 * p.tx
        p.y = k0 * p.sy + k1 * cy + k2 * p.ty
        p.z = k0 * p.sz + k1 * cz + k2 * p.tz
        if (u >= 1) {
          p.phase = Phase.Held
          p.age = 0
          p.angle = Math.random() * Math.PI * 2
          this.bayFlash = 1
        }
      } else {
        // Held: drift in a small circle inside the bay, then fade out.
        p.angle += dt * 1.3
        p.x = p.tx + Math.cos(p.angle) * 0.5
        p.y = p.ty + Math.sin(p.angle * 0.7) * 0.25
        p.z = p.tz + Math.sin(p.angle) * 0.5
        if (p.age > HELD_LIFE) continue
      }

      this.particles[keep++] = p
    }
    this.particles.length = keep
  }

  private writeBuffers(dt: number) {
    // Trail length is a fixed slice of time, whatever the frame rate is.
    const stretch = Math.min(6, 0.085 / Math.max(dt, 0.001))
    let i = 0
    for (const p of this.particles) {
      let alpha = 1
      let c = COLOR_INCOMING
      if (p.real) c = COLOR_REAL
      else if (p.phase !== Phase.Approach) c = COLOR[p.kind]

      if (p.phase === Phase.Approach) alpha = Math.min(1, (p.x - X_START + 2) / 6)
      if (p.phase === Phase.Passed) alpha = Math.min(1, (X_END - p.x) / 8)
      if (p.phase === Phase.Held) {
        alpha = Math.min(1, (HELD_LIFE - p.age) / 2.5) * (0.75 + 0.25 * Math.sin(p.age * 6 + p.angle))
      }
      
      const r = c[0] * alpha, g = c[1] * alpha, b = c[2] * alpha
      const l = i * 6
      this.linePos[l] = p.x + (p.px - p.x) * stretch
      this.linePos[l + 1] = p.y + (p.py - p.y) * stretch
      this.linePos[l + 2] = p.z + (p.pz - p.z) * stretch
      this.linePos[l + 3] = p.x
      this.linePos[l + 4] = p.y
      this.linePos[l + 5] = p.z
      this.lineCol[l] = 0; this.lineCol[l + 1] = 0; this.lineCol[l + 2] = 0 // tail end fades to nothing
      this.lineCol[l + 3] = r; this.lineCol[l + 4] = g; this.lineCol[l + 5] = b

      const q = i * 3
      this.pointPos[q] = p.x; this.pointPos[q + 1] = p.y; this.pointPos[q + 2] = p.z
      this.pointCol[q] = r; this.pointCol[q + 1] = g; this.pointCol[q + 2] = b
      this.pointSize[i] = p.size
      i++
    }

    const lineGeo = this.lines.geometry
    lineGeo.setDrawRange(0, i * 2)
    lineGeo.attributes.position.needsUpdate = true
    lineGeo.attributes.color.needsUpdate = true
    const pointGeo = this.points.geometry
    pointGeo.setDrawRange(0, i)
    pointGeo.attributes.position.needsUpdate = true
    pointGeo.attributes.aColor.needsUpdate = true
    pointGeo.attributes.aSize.needsUpdate = true
  }

  private updateStage(dt: number) {
    for (const [id, ring] of this.rings) {
      const target = id === 'gate' && this.gateFlash > 0.05 ? MOOD_COLOR.alert : MOOD_COLOR[ring.mood]
      const mat = ring.mesh.material as THREE.MeshBasicMaterial
      mat.color.lerp(target, Math.min(1, dt * 8))
      ;(ring.inner.material as THREE.MeshBasicMaterial).color.copy(mat.color)
      if (!this.reducedMotion) ring.inner.rotation.x += dt * (ring.mood === 'idle' ? 0.08 : 0.35)
    }
    const bayMat = this.bayBox.material as THREE.LineBasicMaterial
    bayMat.opacity = 0.4 + 0.6 * this.bayFlash

    // The camera leans a little towards the pointer. This is what gives the depth feeling.
    const ease = Math.min(1, dt * 2.5)
    this.swayX += ((this.reducedMotion ? 0 : this.pointerX) - this.swayX) * ease
    this.swayY += ((this.reducedMotion ? 0 : this.pointerY) - this.swayY) * ease
    this.camera.position.set(
      this.camBase.x + this.swayX * 9,
      this.camBase.y - this.swayY * 5,
      this.camBase.z,
    )
    this.camera.lookAt(this.camLook)
  }

  frame(dt: number) {
    this.time += dt
    this.update(dt)
    this.writeBuffers(dt)
    this.updateStage(dt)
    this.composer.render()
  }

  // Turn a 3D point into a pixel position, so HTML labels can sit on top of the scene.
  project(id: AnchorId) {
    if (id === 'quarantine') {
      this.tmp.set(BAY.x, BAY.y - BAY_SIZE.y / 2 - 0.6, BAY.z + BAY_SIZE.z / 2)
    } else {
      const s = STAGES.find((stage) => stage.id === id)!
      this.tmp.set(s.x, s.radius + 1.2, 0)
    }
    this.tmp.project(this.camera)
    return {
      x: (this.tmp.x * 0.5 + 0.5) * this.width,
      y: (-this.tmp.y * 0.5 + 0.5) * this.height,
    }
  }

  get heldInBay() {
    let n = 0
    for (const p of this.particles) if (p.phase === Phase.Held) n++
    return n
  }

  dispose() {
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      mesh.geometry?.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material?.dispose()
    })
    this.composer.dispose()
    this.renderer.dispose()
  }
}