// Wire facts cross-checked against libgphoto2 v2.5.34; see docs/camera-control.md.
import { CameraError } from './model.ts'

export class Packet {
  data: Buffer
  offset = 0
  constructor(data: Buffer) {
    this.data = data
  }
  take(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.offset + bytes > this.data.length)
      throw new CameraError('invalid-packet', 'Truncated or oversized PTP packet.')
    const result = this.data.subarray(this.offset, this.offset + bytes)
    this.offset += bytes
    return result
  }
  u8() {
    return this.take(1).readUInt8()
  }
  u16() {
    return this.take(2).readUInt16LE()
  }
  u32() {
    return this.take(4).readUInt32LE()
  }
  string() {
    return this.take(this.u8() * 2)
      .toString('utf16le')
      .replace(/\0$/, '')
  }
  array(width = 2): number[] {
    const count = this.u32()
    if (count > 65536) throw new CameraError('invalid-packet', 'Oversized PTP array.')
    return Array.from({ length: count }, () => (width === 2 ? this.u16() : this.u32()))
  }
  value(type: number): number | string {
    if (type === 0xffff) return this.string()
    if (type & 0x4000) {
      const count = this.u32()
      if (count > 65536) throw new CameraError('invalid-packet', 'Oversized property array.')
      return JSON.stringify(Array.from({ length: count }, () => this.value(type & ~0x4000)))
    }
    const width = Math.pow(2, Math.floor((type - 1) / 2))
    if (type < 1 || type > 10)
      throw new CameraError('invalid-packet', `Unsupported PTP value type ${type}.`)
    const bytes = this.take(width)
    if (width > 6) return bytes.toString('hex')
    return type % 2 ? bytes.readIntLE(0, width) : bytes.readUIntLE(0, width)
  }
}
export interface SonyProperty {
  code: number
  type: number
  getSet: number
  enabled: number
  value: number | string
  choices: (number | string)[]
  range?: (number | string)[]
}
export function sonyProperties(data: Buffer): SonyProperty[] {
  const packet = new Packet(data),
    count = packet.u32()
  packet.u32()
  if (count > 2048) throw new CameraError('invalid-packet', 'Too many Sony properties.')
  const properties: SonyProperty[] = []
  for (let i = 0; i < count; i++) {
    const code = packet.u16(),
      type = packet.u16(),
      getSet = packet.u8(),
      enabled = packet.u8()
    packet.value(type)
    const value = packet.value(type),
      form = packet.u8()
    let choices: (number | string)[] = [],
      range: (number | string)[] | undefined
    if (form === 1) range = [packet.value(type), packet.value(type), packet.value(type)]
    else if (form === 2) choices = Array.from({ length: packet.u16() }, () => packet.value(type))
    else if (form !== 0) throw new CameraError('invalid-packet', 'Unknown Sony property form.')
    if (
      i < count - 1 &&
      packet.data.length - packet.offset >= 2 &&
      packet.data.readUInt16LE(packet.offset) < 0x200
    )
      choices = Array.from({ length: packet.u16() }, () => packet.value(type))
    properties.push({ code, type, getSet, enabled, value, choices, range })
  }
  if (packet.offset !== data.length)
    throw new CameraError('invalid-packet', 'Unexpected Sony packet remainder.')
  return properties
}
export function deviceInfo(data: Buffer) {
  const packet = new Packet(data)
  packet.u16()
  packet.u32()
  packet.u16()
  packet.string()
  packet.u16()
  const operations = packet.array()
  for (let i = 0; i < 4; i++) packet.array()
  return {
    operations,
    manufacturer: packet.string(),
    model: packet.string(),
    firmware: packet.string(),
    serial: packet.string(),
  }
}
export function objectInfo(data: Buffer) {
  const packet = new Packet(data)
  packet.u32()
  const format = packet.u16()
  packet.u16()
  const bytes = packet.u32()
  packet.take(40)
  return { format, bytes, filename: packet.string(), capturedAt: packet.string() }
}
export function encodeValue(type: number, value: number) {
  const width = Math.pow(2, Math.floor((type - 1) / 2)),
    result = Buffer.alloc(width)
  if (type % 2) result.writeIntLE(value, 0, width)
  else result.writeUIntLE(value, 0, width)
  return result
}
