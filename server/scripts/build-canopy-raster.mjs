// One-time tool: turns the huge canopy GeoJSON into a small bitmap that the
// server can load instantly and look up in constant time.
//
//   cd server
//   node --max-old-space-size=8192 scripts/build-canopy-raster.mjs
//
// Input : server/canopy-cache.geojson   (made by running the server once)
// Output: server/canopy-raster.bin      (a few MB)

import { readFile, writeFile } from 'node:fs/promises'

const INPUT = new URL('../canopy-cache.geojson', import.meta.url)
const OUTPUT = new URL('../canopy-raster.bin', import.meta.url)

// San Francisco mainland. Points outside this box count as "no canopy".
const WEST = -122.53
const EAST = -122.33
const SOUTH = 37.69
const NORTH = 37.84

// About 3 m per cell (the server samples routes every 5 m).
const CELL = 0.00003

const width = Math.ceil((EAST - WEST) / CELL)
const height = Math.ceil((NORTH - SOUTH) / CELL)
const bits = new Uint8Array(Math.ceil((width * height) / 8))

function setBit(x, y) {
  const index = y * width + x

  bits[index >> 3] |= 1 << (index & 7)
}

// Even-odd scanline fill for one polygon (outer ring + holes).
function fillPolygon(rings) {
  let minLat = Infinity
  let maxLat = -Infinity

  for (const ring of rings) {
    for (const point of ring) {
      if (point[1] < minLat) minLat = point[1]
      if (point[1] > maxLat) maxLat = point[1]
    }
  }

  const rowStart = Math.max(0, Math.ceil((minLat - SOUTH) / CELL - 0.5))
  const rowEnd = Math.min(height - 1, Math.floor((maxLat - SOUTH) / CELL - 0.5))

  if (rowEnd < rowStart) {
    return
  }

  const crossings = new Map()

  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i]
      const [x2, y2] = ring[i + 1]

      if (y1 === y2) {
        continue
      }

      const low = Math.min(y1, y2)
      const high = Math.max(y1, y2)

      const first = Math.max(rowStart, Math.ceil((low - SOUTH) / CELL - 0.5))
      const last = Math.min(rowEnd, Math.ceil((high - SOUTH) / CELL - 0.5) - 1)

      for (let row = first; row <= last; row++) {
        const lat = SOUTH + (row + 0.5) * CELL
        const x = x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1)

        let list = crossings.get(row)

        if (!list) {
          list = []
          crossings.set(row, list)
        }

        list.push(x)
      }
    }
  }

  for (const [row, list] of crossings) {
    list.sort((a, b) => a - b)

    for (let i = 0; i + 1 < list.length; i += 2) {
      const from = Math.max(0, Math.ceil((list[i] - WEST) / CELL - 0.5))
      const to = Math.min(width - 1, Math.ceil((list[i + 1] - WEST) / CELL - 0.5) - 1)

      for (let column = from; column <= to; column++) {
        setBit(column, row)
      }
    }
  }
}

console.log('Reading canopy GeoJSON (this can take a minute)...')

const geojson = JSON.parse(await readFile(INPUT, 'utf8'))
const features = geojson.features ?? []

console.log(`${features.length} features. Rasterizing ${width} x ${height} cells...`)

let polygons = 0

for (let i = 0; i < features.length; i++) {
  const geometry = features[i]?.geometry

  if (geometry?.type === 'Polygon') {
    fillPolygon(geometry.coordinates)
    polygons++
  } else if (geometry?.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      fillPolygon(polygon)
      polygons++
    }
  }

  if (i % 20000 === 0 && i > 0) {
    console.log(`  ${i} / ${features.length}`)
  }
}

if (polygons === 0) {
  throw new Error('No polygons found in the canopy file.')
}

let covered = 0

for (const byte of bits) {
  let value = byte

  while (value) {
    covered += value & 1
    value >>= 1
  }
}

const header = Buffer.alloc(40)

header.write('CNPY', 0, 'ascii')
header.writeUInt32LE(width, 4)
header.writeUInt32LE(height, 8)
header.writeDoubleLE(WEST, 12)
header.writeDoubleLE(SOUTH, 20)
header.writeDoubleLE(CELL, 28)

await writeFile(OUTPUT, Buffer.concat([header, Buffer.from(bits)]))

console.log(
  `Done. ${polygons} polygons -> ${(bits.length / 1e6).toFixed(1)} MB. ` +
    `${((covered / (width * height)) * 100).toFixed(1)}% of the map area is canopy.`
)
console.log('Wrote server/canopy-raster.bin')
