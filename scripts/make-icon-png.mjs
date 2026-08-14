// Generate a 1024x1024 placeholder app icon (solid rounded square, blue),
// written as raw PNG via node:zlib. No external image deps.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SIZE = 1024
const R = 180 // corner radius
const [r0, g0, b0] = [31, 111, 235]   // base blue
const [r1, g1, b1] = [120, 180, 255] // lighter top-left gradient
const cx = SIZE / 2

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  for (let x = 0; x < SIZE; x++) {
    const o = y * (SIZE * 4 + 1) + 1 + x * 4
    // rounded-corner alpha
    let alpha = 255
    const dx = Math.max(0, R - Math.min(x, SIZE - 1 - x))
    const dy = Math.max(0, R - Math.min(y, SIZE - 1 - y))
    const dist = Math.hypot(dx, dy)
    if (dist > R) alpha = 0
    else if (dist > R - 1) alpha = Math.round(255 * (R - dist))
    const t = (x + y) / (2 * SIZE)
    raw[o] = Math.round(r0 + (r1 - r0) * t)
    raw[o + 1] = Math.round(g0 + (g1 - g0) * t)
    raw[o + 2] = Math.round(b0 + (b1 - b0) * t)
    raw[o + 3] = alpha
    void cx
  }
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}
function crc32(buf) {
  let c
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8  // bit depth
ihdr[9] = 6  // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
const out = join(dirname(new URL(import.meta.url).pathname), '..', 'src-tauri', 'icons')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'app-icon.png'), png)
console.log('wrote', join(out, 'app-icon.png'))
