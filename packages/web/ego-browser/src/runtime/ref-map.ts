// @ts-nocheck — ported from ego-browser v2.0.0-beta.4 (strict:false); vendor exemption, not strict-checked.
export class RefMap {
  map: Map<string, any>

  constructor() {
    this.map = new Map()
  }

  add(refId, backendNodeId, role, name, nth = undefined) {
    this.addWithFrame(refId, backendNodeId, role, name, nth, undefined)
  }

  addWithFrame(
    refId,
    backendNodeId,
    role,
    name,
    nth = undefined,
    frameId = undefined,
  ) {
    this.map.set(refId, {
      backendNodeId,
      role,
      name,
      nth,
      frameId,
    })
  }

  get(refId) {
    return this.map.get(refId)
  }

  clear() {
    this.map.clear()
  }
}

export function parseRef(input) {
  const trimmed = String(input || '').trim()
  for (const candidate of [
    trimmed.startsWith('@') ? trimmed.slice(1) : null,
    trimmed.startsWith('ref=') ? trimmed.slice(4) : null,
    trimmed,
  ]) {
    if (candidate && /^\d+$/.test(candidate)) {
      return candidate
    }
  }
  return null
}
