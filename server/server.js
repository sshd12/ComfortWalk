import express from 'express'
import { PNG } from 'pngjs'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const app = express()

const PORT = Number(process.env.PORT) || 8787

// Cloud hosts need 0.0.0.0; locally keep it private to this machine.
const HOST = process.env.PORT ? '0.0.0.0' : '127.0.0.1'

const METERS_PER_MILE = 1609.344
const WALKING_SPEED_METERS_PER_SECOND = 1.35
const MAX_DIRECT_DISTANCE_METERS = 12000

const PHOTON_URL = 'https://photon.komoot.io/api/'

// Overpass servers are queried as a staggered race: the first starts
// immediately, the next ones join after OVERPASS_STAGGER_MS, and the first
// good answer wins. One slow or dead mirror no longer stalls the request.
const OVERPASS_STAGGER_MS = 1500
const OVERPASS_TIMEOUT_MS = 25000
const OSM_CACHE_DIR = new URL('./.osm-cache/', import.meta.url)
const OSM_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const OSM_BOUNDS_GRID_DEGREES = 0.002
const TERRAIN_FETCH_TIMEOUT_MS = 15000
const CANOPY_DISK_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const OVERPASS_SERVERS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter'
]

const USER_AGENT = 'ComfortWalkStudentProject/1.0'

const TERRAIN_ZOOM = 14
const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'

const FLAT_WALKING_COST = 2.5
const MAX_MODEL_GRADE = 0.45

const GRADE_SAMPLE_DISTANCE_METERS = 25
const GRAPH_ELEVATION_SMOOTH_RADIUS_METERS = 30
const ROUTING_GRADE_MIN_RUN_METERS = 20

const STEEP_UI_THRESHOLD_PERCENT = 10

// Total ascent adds up every uphill section of the route (not end minus
// start), measured on the less-smoothed elevations. Rises smaller than
// this are treated as terrain-data noise and not counted.
const ASCENT_NOISE_METERS = 1

// Historical San Francisco Urban Tree Canopy polygons.
// This measures canopy cover, not time-of-day shadow.
// The Socrata ID in the original URL (ni2e-vpbg) is the legacy ID of the
// dataset now listed as 55pv-5zcc, so both are tried. Set CANOPY_GEOJSON_URL
// to force a specific URL.
const CANOPY_GEOJSON_URLS = [
  process.env.CANOPY_GEOJSON_URL,
  'https://data.sfgov.org/api/v3/views/55pv-5zcc/query.geojson?accessType=DOWNLOAD',
  'https://data.sfgov.org/api/geospatial/55pv-5zcc?method=export&format=GeoJSON',
  'https://data.sfgov.org/resource/55pv-5zcc.geojson?$limit=500000',
  'https://data.sf.gov/api/v3/views/ni2e-vpbg/query.geojson?accessType=DOWNLOAD'
].filter(Boolean)

const CANOPY_SAMPLE_SPACING_METERS = 5
const CANOPY_COMFORT_STRENGTH = 0.25

// ---- Comfort route preferences (set by the sliders, each 0 to 1) ----
// Defaults: hills 0.5 -> 70% hill effort / 30% distance (see makeComfortWeights),
//   shade 0.5 -> strength 0.25, crossings 0 -> crosswalks are not penalised.
const DEFAULT_PREFERENCES = { shade: 0.5, hills: 0.5, crossings: 0, accessible: false }
const MAX_CANOPY_COMFORT_STRENGTH = 0.5
// Hill share of the comfort cost at the default slider (hills = 0.5).
// hillWeight = HILL_WEIGHT_MIN + HILL_WEIGHT_RANGE * hills -> 0.4 .. 1.0
const HILL_WEIGHT_MIN = 0.4
const HILL_WEIGHT_RANGE = 0.6

// ---- Guardrails: the Comfort route may not stray too far from Shortest ----
// Allowed extra distance = 12% + 30% * shade slider (27% at default).
// Allowed extra climb    = 10% + 24% * (1 - hills slider) (22% at default),
// plus a small absolute allowance so very flat routes are not over-policed.
const GUARD_DISTANCE_BASE = 0.12
const GUARD_DISTANCE_PER_SHADE = 0.3
const GUARD_CLIMB_BASE = 0.1
const GUARD_CLIMB_PER_HILL_TOLERANCE = 0.24
const GUARD_CLIMB_SLACK_METERS = 3
const GUARD_MAX_RETRIES = 4
// Shade floor: Comfort may lose at most (1 - shadeSlider)^2 of Shortest's
// tree cover (25% at default, none at max, no limit at 0), minus 1 point.
const GUARD_SHADE_SLACK = 0.01
// Cap for the temporary shade boost used when easing for shade.
const EASING_MAX_SHADE_STRENGTH = 0.6
// Extra cost, in "meters of walking", of one crosswalk at slider = 1.
const CROSSING_MAX_PENALTY_METERS = 150

// Streets a pedestrian has to cross. Driveways and alleys (highway=service)
// and footpaths are deliberately not included.
const STREET_HIGHWAYS = new Set([
  'residential',
  'tertiary',
  'secondary',
  'primary',
  'unclassified',
  'living_street',
  'tertiary_link',
  'secondary_link',
  'primary_link'
])
// Walking straight on counts as crossing the side street; turning does not.
const STRAIGHT_ON_MIN_COSINE = Math.cos((50 * Math.PI) / 180)
// Cheapest possible hill-effort per meter relative to flat ground (steady
// gentle downhill). Used to keep the A* heuristic from overestimating.
const MIN_HILL_COST_RATIO = 0.37

function normalizePreferences(raw) {
  const read = (value, fallback) => {
    const number = Number(value)

    return Number.isFinite(number)
      ? Math.min(1, Math.max(0, number))
      : fallback
  }

  return {
    shade: read(raw?.shade, DEFAULT_PREFERENCES.shade),
    hills: read(raw?.hills, DEFAULT_PREFERENCES.hills),
    crossings: read(raw?.crossings, DEFAULT_PREFERENCES.crossings),
    accessible: raw?.accessible === true
  }
}

// ---- Wheelchair / stroller mode ----
// Steps (without a mapped ramp) and ways tagged wheelchair=no are removed
// from the graph for every route. The Comfort route also pays extra for
// steep and rough stretches. 8.3% (1:12) is the usual maximum ramp slope;
// 5% is where wheelchair users start to find a slope tiring.
const ACCESSIBLE_COMFORT_GRADE = 0.05
const ACCESSIBLE_MAX_GRADE = 0.083
const ACCESSIBLE_MAX_MULTIPLIER = 8
const ROUGH_SURFACES = new Set([
  'unpaved',
  'dirt',
  'gravel',
  'fine_gravel',
  'ground',
  'grass',
  'sand',
  'mud',
  'earth',
  'pebblestone',
  'cobblestone',
  'sett',
  'unhewn_cobblestone',
  'compacted'
])

function isBlockedForWheels(edge) {
  if (edge.wheelchair === 'no') {
    return true
  }

  return edge.highway === 'steps' && !edge.hasRamp
}

// Returns a graph view without the edges a wheelchair or stroller cannot use.
function makeStepFreeGraph(graph) {
  const adjacency = new Map()

  for (const [fromId, edges] of graph.adjacency) {
    const passable = edges.filter(
      edge => !isBlockedForWheels(edge)
    )

    if (passable.length > 0) {
      adjacency.set(fromId, passable)
    }
  }

  return { ...graph, adjacency }
}

// Cost multiplier (1 = no extra cost) for steep, rough or limited ways.
function getAccessibilityMultiplier(edge, grade) {
  const steepness = Math.abs(grade)

  let multiplier = 1

  if (steepness > ACCESSIBLE_MAX_GRADE) {
    multiplier =
      2 + (steepness - ACCESSIBLE_MAX_GRADE) * 40
  } else if (steepness > ACCESSIBLE_COMFORT_GRADE) {
    multiplier =
      1 +
      (steepness - ACCESSIBLE_COMFORT_GRADE) /
        (ACCESSIBLE_MAX_GRADE - ACCESSIBLE_COMFORT_GRADE)
  }

  if (ROUGH_SURFACES.has(edge.surface)) {
    multiplier *= 1.6
  }

  if (edge.wheelchair === 'limited') {
    multiplier *= 1.5
  }

  return Math.min(ACCESSIBLE_MAX_MULTIPLIER, multiplier)
}

function makeComfortWeights(preferences, easing = null) {
  // easing is used by the guardrail retries:
  //   prefScale     scales the shade and crosswalk preferences down,
  //   hillBoost     adds to the hill weight,
  //   crossingScale scales only the crosswalk preference,
  //   shadeBoost    adds to the shade strength (capped).
  const prefScale = easing?.prefScale ?? 1
  const hillBoost = easing?.hillBoost ?? 0
  const crossingScale = easing?.crossingScale ?? 1
  const shadeBoost = easing?.shadeBoost ?? 0
  const shade = preferences.shade * prefScale

  const baseShadeStrength =
    shade <= 0.5
      ? CANOPY_COMFORT_STRENGTH * (shade / 0.5)
      : CANOPY_COMFORT_STRENGTH +
        ((shade - 0.5) / 0.5) *
          (MAX_CANOPY_COMFORT_STRENGTH - CANOPY_COMFORT_STRENGTH)

  const shadeStrength = shadeBoost > 0
    ? Math.min(
        EASING_MAX_SHADE_STRENGTH,
        baseShadeStrength + shadeBoost
      )
    : baseShadeStrength

  const hillWeight = Math.min(
    1,
    HILL_WEIGHT_MIN +
      HILL_WEIGHT_RANGE * preferences.hills +
      hillBoost
  )

  return {
    accessible: preferences.accessible === true,
    distance: 1 - hillWeight,
    hill: hillWeight,
    shade: shadeStrength,
    crossingPenalty:
      preferences.crossings *
      prefScale *
      crossingScale *
      CROSSING_MAX_PENALTY_METERS
  }
}

function getComfortLimits(preferences, shortestRoute) {
  const maxDistance =
    shortestRoute.distanceMeters *
    (1 +
      GUARD_DISTANCE_BASE +
      GUARD_DISTANCE_PER_SHADE * preferences.shade +
      (preferences.accessible ? 0.25 : 0))

  const maxClimb =
    shortestRoute.totalAscentMeters *
      (1 +
        GUARD_CLIMB_BASE +
        GUARD_CLIMB_PER_HILL_TOLERANCE * (1 - preferences.hills)) +
    GUARD_CLIMB_SLACK_METERS

  const allowedShadeLoss =
    (1 - preferences.shade) ** 2

  const minTreeCoverPercent = Math.max(
    0,
    (Number(shortestRoute.treeCoverPercent) || 0) *
      (1 - allowedShadeLoss) -
      GUARD_SHADE_SLACK * 100
  )

  return { maxDistance, maxClimb, minTreeCoverPercent }
}

const DEFAULT_COMFORT_WEIGHTS = makeComfortWeights(DEFAULT_PREFERENCES)

// In development Vite strips "/api" before it reaches this server. In
// production the browser calls this server directly, so strip it here.
app.use((request, response, next) => {
  if (request.url.startsWith('/api/')) {
    request.url = request.url.slice(4)
  }

  next()
})

app.use(
  express.json({
    limit: '1mb'
  })
)

// ============================================================
// CACHE
// ============================================================

const graphCache = new Map()
const searchCache = new Map()
const terrainTileCache = new Map()

let canopyGeometryPromise = null

const MAX_GRAPH_CACHE_SIZE = 8
const MAX_TERRAIN_CACHE_SIZE = 64
const SEARCH_CACHE_TIME = 5 * 60 * 1000

function trimMapCache(map, maximumSize) {
  while (map.size > maximumSize) {
    const firstKey = map.keys().next().value
    map.delete(firstKey)
  }
}

function getCachedSearch(key) {
  const item = searchCache.get(key)

  if (!item) {
    return null
  }

  if (Date.now() - item.time > SEARCH_CACHE_TIME) {
    searchCache.delete(key)
    return null
  }

  return item.data
}

function setCachedSearch(key, data) {
  searchCache.set(key, {
    time: Date.now(),
    data
  })

  trimMapCache(searchCache, 100)
}

// ============================================================
// MATH
// ============================================================

function toRadians(value) {
  return value * Math.PI / 180
}

function toDegrees(value) {
  return value * 180 / Math.PI
}

function clamp(value, minimum, maximum) {
  return Math.min(
    maximum,
    Math.max(minimum, value)
  )
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360
}

function angleDifference(from, to) {
  return ((to - from + 540) % 360) - 180
}

function haversineMeters(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const earthRadius = 6371000

  const phi1 = toRadians(lat1)
  const phi2 = toRadians(lat2)

  const deltaLatitude =
    toRadians(lat2 - lat1)

  const deltaLongitude =
    toRadians(lon2 - lon1)

  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(phi1) *
      Math.cos(phi2) *
      Math.sin(deltaLongitude / 2) ** 2

  return (
    2 *
    earthRadius *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  )
}

function bearingDegrees(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const phi1 = toRadians(lat1)
  const phi2 = toRadians(lat2)

  const lambda1 = toRadians(lon1)
  const lambda2 = toRadians(lon2)

  const y =
    Math.sin(lambda2 - lambda1) *
    Math.cos(phi2)

  const x =
    Math.cos(phi1) *
      Math.sin(phi2) -
    Math.sin(phi1) *
      Math.cos(phi2) *
      Math.cos(lambda2 - lambda1)

  return normalizeDegrees(
    toDegrees(
      Math.atan2(y, x)
    )
  )
}

function cardinalDirection(bearing) {
  const directions = [
    'north',
    'northeast',
    'east',
    'southeast',
    'south',
    'southwest',
    'west',
    'northwest'
  ]

  const index =
    Math.round(
      normalizeDegrees(bearing) / 45
    ) % 8

  return directions[index]
}

function makeBounds(
  start,
  end,
  paddingMeters
) {
  const averageLatitude =
    (start.lat + end.lat) / 2

  const latitudePadding =
    paddingMeters / 111320

  const longitudeMetersPerDegree =
    111320 *
    Math.cos(
      toRadians(averageLatitude)
    )

  const longitudePadding =
    paddingMeters /
    Math.max(
      longitudeMetersPerDegree,
      1
    )

  return {
    south:
      Math.min(
        start.lat,
        end.lat
      ) - latitudePadding,

    west:
      Math.min(
        start.lon,
        end.lon
      ) - longitudePadding,

    north:
      Math.max(
        start.lat,
        end.lat
      ) + latitudePadding,

    east:
      Math.max(
        start.lon,
        end.lon
      ) + longitudePadding
  }
}

function makeGraphCacheKey(bounds) {
  return [
    bounds.south.toFixed(3),
    bounds.west.toFixed(3),
    bounds.north.toFixed(3),
    bounds.east.toFixed(3)
  ].join('|')
}

// ============================================================
// ENERGY MODEL
// ============================================================

function walkingEnergyCost(grade) {
  const slope =
    clamp(
      grade,
      -MAX_MODEL_GRADE,
      MAX_MODEL_GRADE
    )

  const cost =
    280.5 * slope ** 5 -
    58.7 * slope ** 4 -
    76.8 * slope ** 3 +
    51.9 * slope ** 2 +
    19.6 * slope +
    2.5

  return Math.max(
    0.5,
    cost
  )
}

function getNodeElevation(node) {
  if (
    Number.isFinite(
      node?.smoothedElevation
    )
  ) {
    return node.smoothedElevation
  }

  if (
    Number.isFinite(
      node?.elevation
    )
  ) {
    return node.elevation
  }

  return 0
}

// ============================================================
// TREE CANOPY
// ============================================================

function pointInRing(
  lon,
  lat,
  ring
) {
  let inside = false

  for (
    let index = 0,
      previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    const a = ring[index]
    const b = ring[previous]

    if (
      !Array.isArray(a) ||
      !Array.isArray(b)
    ) {
      continue
    }

    const intersects =
      (a[1] > lat) !==
        (b[1] > lat) &&
      lon <
        (
          (b[0] - a[0]) *
          (lat - a[1])
        ) /
          (
            (b[1] - a[1]) ||
            Number.EPSILON
          ) +
        a[0]

    if (intersects) {
      inside = !inside
    }
  }

  return inside
}

function pointInPolygonCoordinates(
  lon,
  lat,
  polygon
) {
  if (
    !Array.isArray(polygon) ||
    polygon.length === 0
  ) {
    return false
  }

  if (
    !pointInRing(
      lon,
      lat,
      polygon[0]
    )
  ) {
    return false
  }

  for (
    let hole = 1;
    hole < polygon.length;
    hole++
  ) {
    if (
      pointInRing(
        lon,
        lat,
        polygon[hole]
      )
    ) {
      return false
    }
  }

  return true
}

function pointInGeometry(
  lon,
  lat,
  geometry
) {
  if (!geometry) {
    return false
  }

  if (
    geometry.type ===
    'Polygon'
  ) {
    return pointInPolygonCoordinates(
      lon,
      lat,
      geometry.coordinates
    )
  }

  if (
    geometry.type ===
    'MultiPolygon'
  ) {
    return geometry.coordinates.some(
      polygon =>
        pointInPolygonCoordinates(
          lon,
          lat,
          polygon
        )
    )
  }

  return false
}

// Canopy polygons are stored in a grid index so each sample point only
// tests the few polygons near it. The old code tested every polygon in
// the city for every 5 m sample, which can block the server for minutes.
const CANOPY_GRID_CELL_DEGREES = 0.002
const CANOPY_FETCH_TIMEOUT_MS = 180000
const CANOPY_RETRY_DELAY_MS = 60000
const CANOPY_CACHE_FILE = new URL('./canopy-cache.geojson', import.meta.url)
const CANOPY_RASTER_FILE = new URL('./canopy-raster.bin', import.meta.url)

const canopyStatus = {
  available: false,
  polygons: 0,
  source: null,
  error: null,
  lastAttempt: 0
}

function addPolygonToIndex(index, coordinates) {
  const ring = coordinates?.[0]

  if (!Array.isArray(ring) || ring.length < 3) {
    return 0
  }

  let minLon = Infinity
  let maxLon = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity

  for (const point of ring) {
    const lon = point?.[0]
    const lat = point?.[1]

    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      continue
    }

    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }

  if (!Number.isFinite(minLon)) {
    return 0
  }

  // Coordinates outside lon/lat range mean the file is projected
  // (e.g. State Plane) and will never match OSM nodes.
  if (Math.abs(minLon) > 180 || Math.abs(minLat) > 90) {
    throw new Error(
      'Canopy GeoJSON is not in lon/lat (WGS84) coordinates.'
    )
  }

  const polygon = { coordinates, minLon, maxLon, minLat, maxLat }
  const cell = CANOPY_GRID_CELL_DEGREES

  for (let x = Math.floor(minLon / cell); x <= Math.floor(maxLon / cell); x++) {
    for (let y = Math.floor(minLat / cell); y <= Math.floor(maxLat / cell); y++) {
      const key = `${x},${y}`
      const bucket = index.cells.get(key)

      if (bucket) {
        bucket.push(polygon)
      } else {
        index.cells.set(key, [polygon])
      }
    }
  }

  return 1
}

function buildCanopyIndex(geojson) {
  const index = { cells: new Map(), polygons: 0 }

  const features =
    geojson?.type === 'FeatureCollection'
      ? geojson.features
      : geojson?.type === 'Feature'
        ? [geojson]
        : Array.isArray(geojson?.features)
          ? geojson.features
          : []

  for (const feature of features) {
    const geometry = feature?.geometry

    if (geometry?.type === 'Polygon') {
      index.polygons += addPolygonToIndex(index, geometry.coordinates)
    } else if (geometry?.type === 'MultiPolygon') {
      for (const polygon of geometry.coordinates) {
        index.polygons += addPolygonToIndex(index, polygon)
      }
    }
  }

  if (index.polygons === 0) {
    throw new Error('Tree canopy dataset contained no polygon geometry.')
  }

  return index
}

// The raster is a small bitmap made by scripts/build-canopy-raster.mjs.
// One bit per ~3 m cell, row 0 = southern edge.
async function loadCanopyRaster() {
  let buffer

  try {
    buffer = await readFile(CANOPY_RASTER_FILE)
  } catch {
    return null
  }

  if (buffer.length < 40 || buffer.toString('ascii', 0, 4) !== 'CNPY') {
    throw new Error('canopy-raster.bin is not a valid canopy raster.')
  }

  const width = buffer.readUInt32LE(4)
  const height = buffer.readUInt32LE(8)

  if (buffer.length < 40 + Math.ceil((width * height) / 8)) {
    throw new Error('canopy-raster.bin is truncated.')
  }

  return {
    type: 'raster',
    width,
    height,
    west: buffer.readDoubleLE(12),
    south: buffer.readDoubleLE(20),
    cell: buffer.readDoubleLE(28),
    bits: buffer.subarray(40)
  }
}

function pointUnderRaster(lon, lat, raster) {
  const x = Math.floor((lon - raster.west) / raster.cell)
  const y = Math.floor((lat - raster.south) / raster.cell)

  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) {
    return false
  }

  const index = y * raster.width + x

  return ((raster.bits[index >> 3] >> (index & 7)) & 1) === 1
}

function pointUnderCanopy(lon, lat, index) {
  if (index.type === 'raster') {
    return pointUnderRaster(lon, lat, index)
  }

  const cell = CANOPY_GRID_CELL_DEGREES
  const bucket = index.cells.get(
    `${Math.floor(lon / cell)},${Math.floor(lat / cell)}`
  )

  if (!bucket) {
    return false
  }

  for (const polygon of bucket) {
    if (
      lon >= polygon.minLon &&
      lon <= polygon.maxLon &&
      lat >= polygon.minLat &&
      lat <= polygon.maxLat &&
      pointInPolygonCoordinates(lon, lat, polygon.coordinates)
    ) {
      return true
    }
  }

  return false
}

async function fetchCanopyGeoJson() {
  const failures = []

  // A recent copy on disk avoids a large download on every server start.
  try {
    const info = await stat(CANOPY_CACHE_FILE)

    if (
      Date.now() - info.mtimeMs <
      CANOPY_DISK_CACHE_MAX_AGE_MS
    ) {
      const geojson = JSON.parse(
        await readFile(
          CANOPY_CACHE_FILE,
          'utf8'
        )
      )

      if (
        Array.isArray(geojson?.features) &&
        geojson.features.length > 0
      ) {
        console.log(
          'Tree canopy: using recent copy from disk'
        )

        return {
          geojson,
          source: 'disk cache'
        }
      }
    }
  } catch {
    // no usable disk copy; download below
  }

  for (const url of CANOPY_GEOJSON_URLS) {
    try {
      console.log(`Tree canopy: downloading ${url}`)

      const response = await fetch(url, {
        headers: {
          Accept: 'application/geo+json, application/json',
          'User-Agent': USER_AGENT
        },
        signal: AbortSignal.timeout(CANOPY_FETCH_TIMEOUT_MS)
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const text = await response.text()

      // Socrata returns an HTML or JSON error page with a 200 sometimes.
      let geojson

      try {
        geojson = JSON.parse(text)
      } catch {
        throw new Error(
          `response was not JSON (starts with: ${text.slice(0, 80).replace(/\s+/g, ' ')})`
        )
      }

      if (geojson?.error || geojson?.message) {
        throw new Error(String(geojson.message || geojson.error))
      }

      if (!Array.isArray(geojson?.features) || geojson.features.length === 0) {
        throw new Error('response had no features')
      }

      console.log(
        `Tree canopy: ${geojson.features.length} features, ${(text.length / 1e6).toFixed(1)} MB`
      )

      try {
        await writeFile(CANOPY_CACHE_FILE, text)
      } catch {
        // disk cache is optional
      }

      return { geojson, source: url }
    } catch (error) {
      failures.push(`${url} -> ${error.message}`)
    }
  }

  // Fall back to the last good download if every URL failed.
  try {
    const text = await readFile(CANOPY_CACHE_FILE, 'utf8')

    console.log('Tree canopy: using cached copy from disk')

    return { geojson: JSON.parse(text), source: 'disk cache' }
  } catch {
    throw new Error(`All canopy sources failed:\n  ${failures.join('\n  ')}`)
  }
}

async function loadCanopyGeometries() {
  if (canopyGeometryPromise) {
    return canopyGeometryPromise
  }

  canopyGeometryPromise = (async () => {
    canopyStatus.lastAttempt = Date.now()

    // Preferred: the small precomputed bitmap (instant, tiny memory).
    const raster = await loadCanopyRaster()

    if (raster) {
      canopyStatus.available = true
      canopyStatus.polygons = null
      canopyStatus.source = 'canopy-raster.bin'
      canopyStatus.error = null

      console.log(
        `Tree canopy: loaded raster ${raster.width} x ${raster.height}`
      )

      return raster
    }

    // The raw GeoJSON is hundreds of MB. Never load it on a small host.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'canopy-raster.bin is missing. Run scripts/build-canopy-raster.mjs and redeploy.'
      )
    }

    console.log(
      'Tree canopy: no canopy-raster.bin, loading the large GeoJSON instead'
    )

    const { geojson, source } = await fetchCanopyGeoJson()
    const index = buildCanopyIndex(geojson)

    canopyStatus.available = true
    canopyStatus.polygons = index.polygons
    canopyStatus.source = source
    canopyStatus.error = null

    console.log(
      `Tree canopy: indexed ${index.polygons} polygons in ${index.cells.size} grid cells`
    )

    return index
  })().catch(error => {
    canopyGeometryPromise = null
    canopyStatus.available = false
    canopyStatus.error = error.message

    throw error
  })

  return canopyGeometryPromise
}

function edgeCanopyRatio(first, second, distance, index) {
  const sampleCount = Math.max(
    1,
    Math.ceil(distance / CANOPY_SAMPLE_SPACING_METERS)
  )

  let covered = 0

  for (let sample = 0; sample < sampleCount; sample++) {
    const t = (sample + 0.5) / sampleCount
    const lat = first.lat + (second.lat - first.lat) * t
    const lon = first.lon + (second.lon - first.lon) * t

    if (pointUnderCanopy(lon, lat, index)) {
      covered++
    }
  }

  return covered / sampleCount
}

// The tree canopy dataset only covers San Francisco. Outside it every edge
// would read 0%, which looks like "no trees" rather than "no data".
const CANOPY_COVERAGE_BOUNDS = {
  south: 37.69,
  north: 37.84,
  west: -122.53,
  east: -122.34
}

function isGraphInCanopyCoverage(graph) {
  let latSum = 0
  let lonSum = 0
  let count = 0

  for (const node of graph.nodes.values()) {
    latSum += node.lat
    lonSum += node.lon
    count++
  }

  if (count === 0) {
    return false
  }

  const lat = latSum / count
  const lon = lonSum / count

  return (
    lat >= CANOPY_COVERAGE_BOUNDS.south &&
    lat <= CANOPY_COVERAGE_BOUNDS.north &&
    lon >= CANOPY_COVERAGE_BOUNDS.west &&
    lon <= CANOPY_COVERAGE_BOUNDS.east
  )
}

async function populateGraphCanopy(graph) {
  // Don't hammer the dataset host if it just failed.
  if (
    !canopyStatus.available &&
    Date.now() - canopyStatus.lastAttempt < CANOPY_RETRY_DELAY_MS &&
    canopyStatus.lastAttempt !== 0
  ) {
    graph.canopyAvailable = false
    graph.canopyCoverage = 0
    return
  }

  let index

  try {
    index = await loadCanopyGeometries()
  } catch (error) {
    console.log('Tree canopy unavailable:', error.message)

    graph.canopyAvailable = false
    graph.canopyCoverage = 0

    return
  }

  let totalDistance = 0
  let coveredDistance = 0

  for (const [fromId, edges] of graph.adjacency) {
    const first = graph.nodes.get(fromId)

    if (!first) {
      continue
    }

    for (const edge of edges) {
      const second = graph.nodes.get(edge.to)

      if (!second) {
        edge.canopyRatio = 0
        continue
      }

      edge.canopyRatio = edgeCanopyRatio(first, second, edge.distance, index)

      totalDistance += edge.distance
      coveredDistance += edge.distance * edge.canopyRatio
    }
  }

  graph.canopyAvailable = true
  graph.canopyCoverage = totalDistance > 0 ? coveredDistance / totalDistance : 0
  graph.canopyCovered = isGraphInCanopyCoverage(graph)

  console.log(
    `Tree canopy: ${(graph.canopyCoverage * 100).toFixed(1)}% of walkable distance is under canopy`
  )

  if (graph.canopyCoverage === 0) {
    console.log(
      'Tree canopy: WARNING 0% coverage. Dataset may not overlap this area.'
    )
  }
}

// ============================================================
// ROUTING EDGE COST
// ============================================================

function getEdgeProfile(
  graph,
  fromId,
  edge
) {
  const fromNode =
    graph.nodes.get(
      fromId
    )

  const toNode =
    graph.nodes.get(
      edge.to
    )

  if (
    !fromNode ||
    !toNode
  ) {
    return {
      grade: 0,

      energyPerKgJ: 0,

      flatEquivalentMeters:
        edge.distance
    }
  }

  const elevationChange =
    getNodeElevation(toNode) -
    getNodeElevation(fromNode)

  const gradeRun =
    Math.max(
      edge.distance,
      ROUTING_GRADE_MIN_RUN_METERS
    )

  const grade =
    clamp(
      elevationChange /
        gradeRun,

      -MAX_MODEL_GRADE,

      MAX_MODEL_GRADE
    )

  const costPerMeter =
    walkingEnergyCost(
      grade
    )

  const energyPerKgJ =
    costPerMeter *
    edge.distance

  const flatEquivalentMeters =
    energyPerKgJ /
    FLAT_WALKING_COST

  return {
    grade,
    energyPerKgJ,
    flatEquivalentMeters
  }
}

function getEdgeCost(
  graph,
  fromId,
  edge,
  mode,
  weights
) {
  if (
    mode === 'shortest'
  ) {
    return edge.distance
  }

  const profile =
    getEdgeProfile(
      graph,
      fromId,
      edge
    )

  if (
    mode === 'comfort'
  ) {
    const w =
      weights ||
      DEFAULT_COMFORT_WEIGHTS

    const canopyRatio =
      clamp(
        Number(
          edge.canopyRatio
        ) || 0,
        0,
        1
      )

    const base =
      (w.distance *
        edge.distance +
      w.hill *
        profile
          .flatEquivalentMeters) *
      (w.accessible
        ? getAccessibilityMultiplier(
            edge,
            profile.grade
          )
        : 1)

    return (
      base *
        (1 -
          w.shade *
            canopyRatio) +
      (edge.isCrossing ||
      edge.crossesStreet
        ? w.crossingPenalty
        : 0)
    )
  }

  const balancedCost =
    0.5 *
      edge.distance +
    0.5 *
      profile
        .flatEquivalentMeters

  if (
    mode === 'balanced'
  ) {
    return balancedCost
  }

  return (
    profile
      .flatEquivalentMeters
  )
}

function getHeuristicMultiplier(
  mode,
  weights
) {
  if (
    mode === 'shortest'
  ) {
    return 1
  }

  if (
    mode === 'balanced'
  ) {
    return 0.6
  }

  if (
    mode === 'comfort'
  ) {
    const w =
      weights ||
      DEFAULT_COMFORT_WEIGHTS

    // Lowest possible comfort cost per meter of straight-line distance.
    return (
      0.99 *
      (w.distance +
        w.hill *
          MIN_HILL_COST_RATIO) *
      (1 - w.shade)
    )
  }

  return 0.2
}

// ============================================================
// SEARCH
// ============================================================

function buildPhotonAddress(
  properties
) {
  const parts = []

  const street =
    [
      properties.housenumber,
      properties.street
    ]
      .filter(Boolean)
      .join(' ')

  if (street) {
    parts.push(street)
  }

  const city =
    properties.city ||
    properties.town ||
    properties.village ||
    properties.district ||
    properties.county

  if (
    city &&
    !parts.includes(city)
  ) {
    parts.push(city)
  }

  if (
    properties.state &&
    !parts.includes(
      properties.state
    )
  ) {
    parts.push(
      properties.state
    )
  }

  if (
    properties.postcode
  ) {
    parts.push(
      properties.postcode
    )
  }

  return parts.join(', ')
}

function normalizePhotonFeature(
  feature,
  index
) {
  const properties =
    feature.properties ||
    {}

  const coordinates =
    feature.geometry
      ?.coordinates ||
    []

  const longitude =
    Number(
      coordinates[0]
    )

  const latitude =
    Number(
      coordinates[1]
    )

  if (
    !Number.isFinite(
      longitude
    ) ||
    !Number.isFinite(
      latitude
    )
  ) {
    return null
  }

  const street =
    [
      properties.housenumber,
      properties.street
    ]
      .filter(Boolean)
      .join(' ')

  const name =
    properties.name ||
    street ||
    properties.street ||
    properties.city ||
    properties.town ||
    properties.village ||
    'Unknown place'

  return {
    id:
      [
        properties.osm_type ||
          'place',

        properties.osm_id ||
          index,

        latitude,

        longitude
      ].join('-'),

    name,

    address:
      buildPhotonAddress(
        properties
      ),

    latitude,
    longitude
  }
}

async function photonSearch(
  query,
  latitude,
  longitude,
  useBias
) {
  const url =
    new URL(
      PHOTON_URL
    )

  url.searchParams.set(
    'q',
    query
  )

  url.searchParams.set(
    'limit',
    '12'
  )

  url.searchParams.set(
    'lang',
    'en'
  )

  if (
    useBias &&
    Number.isFinite(
      latitude
    ) &&
    Number.isFinite(
      longitude
    )
  ) {
    url.searchParams.set(
      'lat',
      String(latitude)
    )

    url.searchParams.set(
      'lon',
      String(longitude)
    )
  }

  const response =
    await fetch(
      url,
      {
        headers: {
          Accept:
            'application/json',

          'User-Agent':
            USER_AGENT
        }
      }
    )

  if (!response.ok) {
    throw new Error(
      `Photon returned ${response.status}`
    )
  }

  const data =
    await response.json()

  return (
    data.features ||
    []
  )
}

app.get(
  '/search',
  async (
    request,
    response
  ) => {
    try {
      const query =
        String(
          request.query.q ||
          ''
        ).trim()

      if (
        query.length < 3
      ) {
        return response.json(
          []
        )
      }

      const latitude =
        Number(
          request.query.lat
        )

      const longitude =
        Number(
          request.query.lon
        )

      const cacheKey =
        [
          query.toLowerCase(),

          Number.isFinite(
            latitude
          )
            ? latitude.toFixed(2)
            : '',

          Number.isFinite(
            longitude
          )
            ? longitude.toFixed(2)
            : ''
        ].join('|')

      const cached =
        getCachedSearch(
          cacheKey
        )

      if (cached) {
        return response.json(
          cached
        )
      }

      const nearby =
        await photonSearch(
          query,
          latitude,
          longitude,
          true
        )

      let features = [
        ...nearby
      ]

      if (
        features.length < 6
      ) {
        try {
          const wider =
            await photonSearch(
              query,
              latitude,
              longitude,
              false
            )

          features.push(
            ...wider
          )
        } catch (
          error
        ) {
          console.log(
            'Photon fallback:',
            error.message
          )
        }
      }

      const normalized =
        features
          .map(
            (
              feature,
              index
            ) =>
              normalizePhotonFeature(
                feature,
                index
              )
          )
          .filter(Boolean)

      const results = []
      const seen =
        new Set()

      for (
        const item
        of normalized
      ) {
        const key =
          [
            item.name
              .toLowerCase(),

            item.latitude
              .toFixed(5),

            item.longitude
              .toFixed(5)
          ].join('|')

        if (
          seen.has(key)
        ) {
          continue
        }

        seen.add(key)

        results.push(item)

        if (
          results.length >= 10
        ) {
          break
        }
      }

      setCachedSearch(
        cacheKey,
        results
      )

      return response.json(
        results
      )
    } catch (
      error
    ) {
      console.error(
        'SEARCH ERROR:',
        error
      )

      return response
        .status(502)
        .json({
          error:
            'Search failed.'
        })
    }
  }
)

// ============================================================
// PRIORITY QUEUE
// ============================================================

class MinHeap {
  constructor() {
    this.items = []
  }

  get size() {
    return this.items.length
  }

  push(item) {
    this.items.push(
      item
    )

    this.bubbleUp(
      this.items.length - 1
    )
  }

  pop() {
    if (
      this.items.length ===
      0
    ) {
      return null
    }

    if (
      this.items.length ===
      1
    ) {
      return this.items.pop()
    }

    const smallest =
      this.items[0]

    this.items[0] =
      this.items.pop()

    this.bubbleDown(0)

    return smallest
  }

  bubbleUp(index) {
    while (
      index > 0
    ) {
      const parent =
        Math.floor(
          (index - 1) /
          2
        )

      if (
        this.items[parent]
          .priority <=
        this.items[index]
          .priority
      ) {
        break
      }

      const temporary =
        this.items[parent]

      this.items[parent] =
        this.items[index]

      this.items[index] =
        temporary

      index = parent
    }
  }

  bubbleDown(index) {
    while (true) {
      let smallest =
        index

      const left =
        index * 2 + 1

      const right =
        index * 2 + 2

      if (
        left <
          this.items.length &&
        this.items[left]
          .priority <
          this.items[smallest]
            .priority
      ) {
        smallest = left
      }

      if (
        right <
          this.items.length &&
        this.items[right]
          .priority <
          this.items[smallest]
            .priority
      ) {
        smallest = right
      }

      if (
        smallest === index
      ) {
        break
      }

      const temporary =
        this.items[index]

      this.items[index] =
        this.items[smallest]

      this.items[smallest] =
        temporary

      index = smallest
    }
  }
}

// ============================================================
// OVERPASS
// ============================================================

function makeOverpassQuery(
  bounds
) {
  return `
[out:json][timeout:20];

(
  way
    ["highway"]
    ["highway"!~"^(motorway|motorway_link|trunk|trunk_link|construction|proposed|raceway)$"]
    ["foot"!="no"]
    ["access"!="no"]
    ["access"!="private"]
    ["area"!="yes"]
    (
      ${bounds.south},
      ${bounds.west},
      ${bounds.north},
      ${bounds.east}
    );
);

out body;

>;

out skel qt;
`
}

async function readOsmCache(
  query
) {
  try {
    const file = new URL(
      `${createHash('sha1').update(query).digest('hex')}.json`,
      OSM_CACHE_DIR
    )

    const info = await stat(file)

    if (
      Date.now() - info.mtimeMs >
      OSM_CACHE_MAX_AGE_MS
    ) {
      return null
    }

    return JSON.parse(
      await readFile(file, 'utf8')
    )
  } catch {
    return null
  }
}

async function writeOsmCache(
  query,
  data
) {
  try {
    await mkdir(OSM_CACHE_DIR, { recursive: true })

    await writeFile(
      new URL(
        `${createHash('sha1').update(query).digest('hex')}.json`,
        OSM_CACHE_DIR
      ),
      JSON.stringify(data)
    )
  } catch {
    // disk cache is optional
  }
}

async function fetchOverpass(
  query
) {
  const cached = await readOsmCache(query)

  if (cached) {
    console.log('Overpass: using disk cache')

    return cached
  }

  const controllers =
    OVERPASS_SERVERS.map(
      () => new AbortController()
    )

  let finished = false

  const attempts =
    OVERPASS_SERVERS.map(
      async (server, index) => {
        const label = new URL(server).host

        try {
          if (index > 0) {
            await new Promise(
              resolve =>
                setTimeout(
                  resolve,
                  index * OVERPASS_STAGGER_MS
                )
            )
          }

          if (finished) {
            throw new Error('skipped')
          }

          const body = new URLSearchParams()

          body.set('data', query)

          const result = await fetch(
            server,
            {
              method: 'POST',
              headers: {
                Accept: 'application/json',
                'Content-Type':
                  'application/x-www-form-urlencoded;charset=UTF-8',
                'User-Agent': USER_AGENT
              },
              body: body.toString(),
              signal: AbortSignal.any([
                controllers[index].signal,
                AbortSignal.timeout(
                  OVERPASS_TIMEOUT_MS
                )
              ])
            }
          )

          if (!result.ok) {
            throw new Error(
              `HTTP ${result.status}`
            )
          }

          const data = await result.json()

          // Overpass can answer 200 with a runtime-error remark and no data.
          if (
            !Array.isArray(data?.elements) ||
            data.elements.length === 0
          ) {
            throw new Error(
              data?.remark ||
                'empty response'
            )
          }

          return { data, label }
        } catch (error) {
          if (!finished) {
            console.log(
              `Overpass ${label} failed: ${
                error.name ===
                  'TimeoutError' ||
                error.name ===
                  'AbortError'
                  ? 'timed out'
                  : error.message
              }`
            )
          }

          throw error
        }
      }
    )

  const startedAt = Date.now()

  try {
    const { data, label } =
      await Promise.any(attempts)

    finished = true

    // Cancel the slower requests.
    controllers.forEach(
      controller =>
        controller.abort()
    )

    console.log(
      `Overpass: ${label} answered in ${(
        (Date.now() - startedAt) /
        1000
      ).toFixed(1)}s`
    )

    await writeOsmCache(query, data)

    return data
  } catch {
    finished = true

    throw new Error(
      'All Overpass servers failed.'
    )
  }
}

// ============================================================
// GRAPH
// ============================================================

function buildGraph(
  osmData
) {
  const nodes =
    new Map()

  const adjacency =
    new Map()

  for (
    const element
    of osmData.elements ||
    []
  ) {
    if (
      element.type !==
      'node'
    ) {
      continue
    }

    nodes.set(
      element.id,
      {
        id:
          element.id,

        lat:
          Number(
            element.lat
          ),

        lon:
          Number(
            element.lon
          ),

        elevation:
          null,

        smoothedElevation:
          null
      }
    )
  }

  function addEdge(
    from,
    to,
    way
  ) {
    const first =
      nodes.get(from)

    const second =
      nodes.get(to)

    if (
      !first ||
      !second
    ) {
      return
    }

    const distance =
      haversineMeters(
        first.lat,
        first.lon,
        second.lat,
        second.lon
      )

    if (
      !Number.isFinite(
        distance
      ) ||
      distance <= 0
    ) {
      return
    }

    if (
      !adjacency.has(
        from
      )
    ) {
      adjacency.set(
        from,
        []
      )
    }

    adjacency
      .get(from)
      .push({
        to,

        distance,

        name:
          way.tags?.name ||
          '',

        highway:
          way.tags
            ?.highway ||
          '',

        wayId:
          way.id,

        // Tags used by wheelchair / stroller mode.
        surface:
          way.tags
            ?.surface ||
          '',

        wheelchair:
          way.tags
            ?.wheelchair ||
          '',

        hasRamp:
          way.tags?.ramp ===
            'yes' ||
          way.tags?.[
            'ramp:wheelchair'
          ] === 'yes' ||
          way.tags?.[
            'ramp:stroller'
          ] === 'yes',

        // Marked crosswalks are mapped as separate footway=crossing ways.
        isCrossing:
          way.tags
            ?.footway ===
            'crossing' ||
          way.tags
            ?.highway ===
            'crossing'
      })
  }

  for (
    const element
    of osmData.elements ||
    []
  ) {
    if (
      element.type !==
        'way' ||
      !Array.isArray(
        element.nodes
      )
    ) {
      continue
    }

    for (
      let index = 0;
      index <
        element.nodes.length -
          1;
      index++
    ) {
      const first =
        element.nodes[
          index
        ]

      const second =
        element.nodes[
          index + 1
        ]

      addEdge(
        first,
        second,
        element
      )

      addEdge(
        second,
        first,
        element
      )
    }
  }

  return {
    nodes,
    adjacency,
    elevationCoverage: 0,
    canopyAvailable: false,
    canopyCoverage: 0
  }
}

// ============================================================
// TERRAIN
// ============================================================

function terrainPosition(
  lat,
  lon,
  zoom
) {
  const n =
    2 ** zoom

  const latitude =
    clamp(
      lat,
      -85.05112878,
      85.05112878
    )

  const x =
    (
      lon + 180
    ) /
    360 *
    n

  const latitudeRadians =
    toRadians(
      latitude
    )

  const y =
    (
      1 -
      (
        Math.log(
          Math.tan(
            latitudeRadians
          ) +
          1 /
          Math.cos(
            latitudeRadians
          )
        ) /
        Math.PI
      )
    ) /
    2 *
    n

  const tileX =
    Math.floor(x)

  const tileY =
    Math.floor(y)

  return {
    tileX,
    tileY,

    fractionX:
      x - tileX,

    fractionY:
      y - tileY
  }
}

async function loadTerrainTile(
  zoom,
  x,
  y
) {
  const key =
    `${zoom}/${x}/${y}`

  if (
    terrainTileCache.has(
      key
    )
  ) {
    return terrainTileCache.get(
      key
    )
  }

  const response =
    await fetch(
      `${TERRAIN_URL}/${zoom}/${x}/${y}.png`,
      {
        headers: {
          'User-Agent':
            USER_AGENT
        },

        signal:
          AbortSignal.timeout(
            TERRAIN_FETCH_TIMEOUT_MS
          )
      }
    )

  if (!response.ok) {
    throw new Error(
      `Terrain tile returned ${response.status}`
    )
  }

  const arrayBuffer =
    await response
      .arrayBuffer()

  const png =
    PNG.sync.read(
      Buffer.from(
        arrayBuffer
      )
    )

  terrainTileCache.set(
    key,
    png
  )

  trimMapCache(
    terrainTileCache,
    MAX_TERRAIN_CACHE_SIZE
  )

  return png
}

function decodeTerrariumElevation(
  png,
  fractionX,
  fractionY
) {
  const pixelX =
    clamp(
      Math.floor(
        fractionX *
        png.width
      ),
      0,
      png.width - 1
    )

  const pixelY =
    clamp(
      Math.floor(
        fractionY *
        png.height
      ),
      0,
      png.height - 1
    )

  const index =
    (
      pixelY *
        png.width +
      pixelX
    ) *
    4

  const red =
    png.data[index]

  const green =
    png.data[
      index + 1
    ]

  const blue =
    png.data[
      index + 2
    ]

  return (
    red * 256 +
    green +
    blue / 256 -
    32768
  )
}

async function populateGraphElevations(
  graph
) {
  const groups =
    new Map()

  const nodeIds =
    Array.from(
      graph.adjacency.keys()
    )

  for (
    const nodeId
    of nodeIds
  ) {
    const node =
      graph.nodes.get(
        nodeId
      )

    if (!node) {
      continue
    }

    const position =
      terrainPosition(
        node.lat,
        node.lon,
        TERRAIN_ZOOM
      )

    const key =
      `${TERRAIN_ZOOM}/${position.tileX}/${position.tileY}`

    if (
      !groups.has(key)
    ) {
      groups.set(
        key,
        {
          x:
            position.tileX,

          y:
            position.tileY,

          samples: []
        }
      )
    }

    groups
      .get(key)
      .samples
      .push({
        node,

        fractionX:
          position.fractionX,

        fractionY:
          position.fractionY
      })
  }

  let assigned = 0

  // Load all terrain tiles at the same time instead of one by one.
  await Promise.all(
    Array.from(
      groups.values()
    ).map(async group => {
    try {
      const png =
        await loadTerrainTile(
          TERRAIN_ZOOM,
          group.x,
          group.y
        )

      for (
        const sample
        of group.samples
      ) {
        const elevation =
          decodeTerrariumElevation(
            png,
            sample.fractionX,
            sample.fractionY
          )

        if (
          Number.isFinite(
            elevation
          )
        ) {
          sample.node
            .elevation =
            elevation

          assigned++
        }
      }
    } catch (
      error
    ) {
      console.log(
        'Terrain tile failed:',
        error.message
      )
    }
    })
  )

  graph.elevationCoverage =
    nodeIds.length > 0
      ? assigned /
        nodeIds.length
      : 0

  if (
    graph.elevationCoverage <
    0.8
  ) {
    throw new Error(
      'Not enough elevation data.'
    )
  }
}

// ============================================================
// ELEVATION SMOOTHING
// ============================================================

function smoothGraphElevations(
  graph
) {
  const nodes =
    Array.from(
      graph.adjacency.keys()
    )
      .map(
        id =>
          graph.nodes.get(
            id
          )
      )
      .filter(
        node =>
          node &&
          Number.isFinite(
            node.elevation
          )
      )

  const next =
    new Map()

  for (
    const node
    of nodes
  ) {
    let total =
      node.elevation * 2

    let weight = 2

    const edges =
      graph.adjacency.get(
        node.id
      ) || []

    for (
      const edge
      of edges
    ) {
      if (
        edge.distance >
        GRAPH_ELEVATION_SMOOTH_RADIUS_METERS
      ) {
        continue
      }

      const neighbor =
        graph.nodes.get(
          edge.to
        )

      if (
        !neighbor ||
        !Number.isFinite(
          neighbor.elevation
        )
      ) {
        continue
      }

      total +=
        neighbor.elevation

      weight++
    }

    next.set(
      node.id,
      total / weight
    )
  }

  for (
    const [
      id,
      elevation
    ]
    of next
  ) {
    const node =
      graph.nodes.get(
        id
      )

    if (node) {
      node.smoothedElevation =
        elevation
    }
  }
}

// ============================================================
// GRAPH LOADING
// ============================================================

function snapBoundsOutward(
  bounds
) {
  const grid =
    OSM_BOUNDS_GRID_DEGREES

  return {
    south:
      Math.floor(
        bounds.south / grid
      ) * grid,

    west:
      Math.floor(
        bounds.west / grid
      ) * grid,

    north:
      Math.ceil(
        bounds.north / grid
      ) * grid,

    east:
      Math.ceil(
        bounds.east / grid
      ) * grid
  }
}

async function getWalkingGraph(
  requestedBounds
) {
  // Snapping to a grid means nearby routes share one download/cache entry
  // (and the cached area is guaranteed to cover the request).
  const bounds =
    snapBoundsOutward(
      requestedBounds
    )

  const cacheKey =
    makeGraphCacheKey(
      bounds
    )

  if (
    graphCache.has(
      cacheKey
    )
  ) {
    const cachedGraph =
      graphCache.get(
        cacheKey
      )

    // Canopy failed when this graph was built; try again.
    if (!cachedGraph.canopyAvailable) {
      await populateGraphCanopy(
        cachedGraph
      )
    }

    return cachedGraph
  }

  const timings = {}

  let mark = Date.now()

  const lap = name => {
    timings[name] =
      ((Date.now() - mark) / 1000)
        .toFixed(1) + 's'

    mark = Date.now()
  }

  const osmData =
    await fetchOverpass(
      makeOverpassQuery(
        bounds
      )
    )

  lap('overpass')

  const graph =
    buildGraph(
      osmData
    )

  markStreetCrossings(
    graph
  )

  lap('build')

  await populateGraphElevations(
    graph
  )

  smoothGraphElevations(
    graph
  )

  lap('elevation')

  await populateGraphCanopy(
    graph
  )

  lap('canopy')

  console.log(
    'Graph timings:',
    timings
  )

  graphCache.set(
    cacheKey,
    graph
  )

  trimMapCache(
    graphCache,
    MAX_GRAPH_CACHE_SIZE
  )

  return graph
}

// ============================================================
// NEAREST NODE
// ============================================================

function findNearestNode(
  graph,
  point
) {
  let closestId = null

  let closestDistance =
    Infinity

  for (
    const nodeId
    of graph.adjacency.keys()
  ) {
    const node =
      graph.nodes.get(
        nodeId
      )

    if (!node) {
      continue
    }

    const distance =
      haversineMeters(
        point.lat,
        point.lon,
        node.lat,
        node.lon
      )

    if (
      distance <
      closestDistance
    ) {
      closestDistance =
        distance

      closestId =
        nodeId
    }
  }

  return {
    nodeId:
      closestId,

    distance:
      closestDistance
  }
}

// ============================================================
// A*
// ============================================================

function aStar(
  graph,
  startNodeId,
  goalNodeId,
  mode,
  weights
) {
  const startNode =
    graph.nodes.get(
      startNodeId
    )

  const goalNode =
    graph.nodes.get(
      goalNodeId
    )

  if (
    !startNode ||
    !goalNode
  ) {
    return null
  }

  const open =
    new MinHeap()

  const gScore =
    new Map()

  const cameFrom =
    new Map()

  const closed =
    new Set()

  gScore.set(
    startNodeId,
    0
  )

  open.push({
    nodeId:
      startNodeId,

    priority:
      haversineMeters(
        startNode.lat,
        startNode.lon,
        goalNode.lat,
        goalNode.lon
      ) *
      getHeuristicMultiplier(mode, weights)
  })

  while (
    open.size > 0
  ) {
    const current =
      open.pop()

    const currentId =
      current.nodeId

    if (
      closed.has(
        currentId
      )
    ) {
      continue
    }

    if (
      currentId ===
      goalNodeId
    ) {
      const path = []

      let nodeId =
        goalNodeId

      while (
        nodeId !==
        undefined
      ) {
        path.push(
          nodeId
        )

        if (
          nodeId ===
          startNodeId
        ) {
          break
        }

        nodeId =
          cameFrom.get(
            nodeId
          )
      }

      path.reverse()

      return {
        path,

        cost:
          gScore.get(
            goalNodeId
          ),

        visitedNodes:
          closed.size + 1
      }
    }

    closed.add(
      currentId
    )

    const currentCost =
      gScore.get(
        currentId
      )

    const edges =
      graph.adjacency.get(
        currentId
      ) || []

    for (
      const edge
      of edges
    ) {
      if (
        closed.has(
          edge.to
        )
      ) {
        continue
      }

      const tentative =
        currentCost +
        getEdgeCost(graph, currentId, edge, mode, weights)

      const oldCost =
        gScore.get(
          edge.to
        ) ??
        Infinity

      if (
        tentative >=
        oldCost
      ) {
        continue
      }

      gScore.set(
        edge.to,
        tentative
      )

      cameFrom.set(
        edge.to,
        currentId
      )

      const neighbor =
        graph.nodes.get(
          edge.to
        )

      if (!neighbor) {
        continue
      }

      const heuristic =
        haversineMeters(
          neighbor.lat,
          neighbor.lon,
          goalNode.lat,
          goalNode.lon
        ) *
        getHeuristicMultiplier(mode, weights)

      open.push({
        nodeId:
          edge.to,

        priority:
          tentative +
          heuristic
      })
    }
  }

  return null
}

// ============================================================
// PATH HELPERS
// ============================================================

function getPathEdge(
  graph,
  fromId,
  toId
) {
  const edges =
    graph.adjacency.get(
      fromId
    ) || []

  return (
    edges.find(
      edge =>
        edge.to === toId
    ) ||
    null
  )
}

function calculateRoutingEnergy(
  graph,
  path
) {
  let totalEnergyPerKgJ =
    0

  let totalFlatEquivalentMeters =
    0

  for (
    let index = 0;
    index <
      path.length - 1;
    index++
  ) {
    const fromId =
      path[index]

    const toId =
      path[
        index + 1
      ]

    const edge =
      getPathEdge(
        graph,
        fromId,
        toId
      )

    if (!edge) {
      continue
    }

    const profile =
      getEdgeProfile(
        graph,
        fromId,
        edge
      )

    totalEnergyPerKgJ +=
      profile.energyPerKgJ

    totalFlatEquivalentMeters +=
      profile
        .flatEquivalentMeters
  }

  return {
    totalEnergyPerKgJ,
    totalFlatEquivalentMeters
  }
}

// A side street is "crossed" at a node when the walker passes through and
// another street (different way and name) meets there.
function hasCrossStreet(
  graph,
  fromId,
  edge,
  nodeId
) {
  if (
    !STREET_HIGHWAYS.has(
      edge.highway
    )
  ) {
    return false
  }

  const arms =
    graph.adjacency.get(
      nodeId
    ) || []

  return arms.some(
    arm =>
      arm.to !== fromId &&
      arm.wayId !==
        edge.wayId &&
      STREET_HIGHWAYS.has(
        arm.highway
      ) &&
      (!edge.name ||
        arm.name !==
          edge.name)
  )
}

// Flags every street edge that ends at an intersection, so the
// "avoid crosswalks" slider can discourage them while routing.
function markStreetCrossings(
  graph
) {
  for (
    const [
      fromId,
      edges
    ] of graph.adjacency
  ) {
    for (const edge of edges) {
      edge.crossesStreet =
        !edge.isCrossing &&
        hasCrossStreet(
          graph,
          fromId,
          edge,
          edge.to
        )
    }
  }
}

function findCrosswalks(
  graph,
  path
) {
  const crossings = []

  let previousCrossingWayId =
    null

  for (
    let index = 0;
    index < path.length - 1;
    index++
  ) {
    const edge =
      getPathEdge(
        graph,
        path[index],
        path[index + 1]
      )

    if (!edge) {
      previousCrossingWayId =
        null

      continue
    }

    // 1. A marked crosswalk (separate crossing way). One way = one crossing.
    if (edge.isCrossing) {
      if (
        edge.wayId !==
        previousCrossingWayId
      ) {
        const node =
          graph.nodes.get(
            path[index]
          )

        if (node) {
          crossings.push({
            lat: node.lat,
            lon: node.lon,
            type: 'marked'
          })
        }
      }

      previousCrossingWayId =
        edge.wayId

      continue
    }

    previousCrossingWayId =
      null

    // 2. Walking straight through an intersection while on a street.
    if (index === 0) {
      continue
    }

    const previousEdge =
      getPathEdge(
        graph,
        path[index - 1],
        path[index]
      )

    if (
      !previousEdge ||
      previousEdge.isCrossing ||
      !STREET_HIGHWAYS.has(
        previousEdge.highway
      ) ||
      !STREET_HIGHWAYS.has(
        edge.highway
      )
    ) {
      continue
    }

    const before =
      graph.nodes.get(
        path[index - 1]
      )

    const here =
      graph.nodes.get(
        path[index]
      )

    const after =
      graph.nodes.get(
        path[index + 1]
      )

    if (
      !before ||
      !here ||
      !after
    ) {
      continue
    }

    const scale =
      Math.cos(
        (here.lat *
          Math.PI) /
          180
      )

    const inX =
      (here.lon -
        before.lon) *
      scale

    const inY =
      here.lat -
      before.lat

    const outX =
      (after.lon -
        here.lon) *
      scale

    const outY =
      after.lat -
      here.lat

    const lengths =
      Math.hypot(inX, inY) *
      Math.hypot(outX, outY)

    if (lengths === 0) {
      continue
    }

    const cosine =
      (inX * outX +
        inY * outY) /
      lengths

    if (
      cosine <
      STRAIGHT_ON_MIN_COSINE
    ) {
      continue
    }

    const arms =
      graph.adjacency.get(
        path[index]
      ) || []

    const crossesSideStreet =
      arms.some(
        arm =>
          arm.to !==
            path[index - 1] &&
          arm.to !==
            path[index + 1] &&
          arm.wayId !==
            previousEdge.wayId &&
          arm.wayId !==
            edge.wayId &&
          STREET_HIGHWAYS.has(
            arm.highway
          ) &&
          (!edge.name ||
            arm.name !==
              edge.name)
      )

    if (crossesSideStreet) {
      crossings.push({
        lat: here.lat,
        lon: here.lon,
        type: 'unmarked'
      })
    }
  }

  return crossings
}

function calculateSteepOverLimitMeters(
  graph,
  path
) {
  let total = 0

  for (
    let index = 0;
    index < path.length - 1;
    index++
  ) {
    const edge = getPathEdge(
      graph,
      path[index],
      path[index + 1]
    )

    if (!edge) {
      continue
    }

    const profile = getEdgeProfile(
      graph,
      path[index],
      edge
    )

    if (
      Math.abs(profile.grade) >
      ACCESSIBLE_MAX_GRADE
    ) {
      total += edge.distance
    }
  }

  return total
}

function calculateRouteCanopy(
  graph,
  path
) {
  let totalDistance = 0
  let coveredDistance = 0

  for (
    let index = 0;
    index <
      path.length - 1;
    index++
  ) {
    const edge =
      getPathEdge(
        graph,
        path[index],
        path[index + 1]
      )

    if (!edge) {
      continue
    }

    const ratio =
      clamp(
        Number(
          edge.canopyRatio
        ) || 0,
        0,
        1
      )

    totalDistance +=
      edge.distance

    coveredDistance +=
      edge.distance *
      ratio
  }

  return {
    coveredDistanceMeters:
      coveredDistance,

    treeCoverRatio:
      totalDistance > 0
        ? coveredDistance /
          totalDistance
        : 0
  }
}

// ============================================================
// ROUTE RESAMPLING
// ============================================================

function makeOrderedPathPoints(
  graph,
  path
) {
  const points = []

  let totalDistance = 0

  for (
    let index = 0;
    index < path.length;
    index++
  ) {
    const node =
      graph.nodes.get(
        path[index]
      )

    if (!node) {
      continue
    }

    if (
      points.length > 0
    ) {
      const previous =
        points[
          points.length - 1
        ]

      totalDistance +=
        haversineMeters(
          previous.lat,
          previous.lon,
          node.lat,
          node.lon
        )
    }

    points.push({
      lat:
        node.lat,

      lon:
        node.lon,

      elevation:
        getNodeElevation(
          node
        ),

      rawElevation:
        Number.isFinite(
          node.elevation
        )
          ? node.elevation
          : getNodeElevation(
              node
            ),

      distanceAlong:
        totalDistance
    })
  }

  return {
    points,
    totalDistance
  }
}

function interpolateProfilePoint(
  first,
  second,
  targetDistance
) {
  const segmentDistance =
    second.distanceAlong -
    first.distanceAlong

  if (
    segmentDistance <= 0
  ) {
    return {
      lat:
        first.lat,

      lon:
        first.lon,

      elevation:
        first.elevation,

      rawElevation:
        first.rawElevation ??
        first.elevation,

      distanceAlong:
        targetDistance
    }
  }

  const fraction =
    (
      targetDistance -
      first.distanceAlong
    ) /
    segmentDistance

  return {
    lat:
      first.lat +
      (
        second.lat -
        first.lat
      ) *
      fraction,

    lon:
      first.lon +
      (
        second.lon -
        first.lon
      ) *
      fraction,

    elevation:
      first.elevation +
      (
        second.elevation -
        first.elevation
      ) *
      fraction,

    rawElevation:
      (
        first.rawElevation ??
        first.elevation
      ) +
      (
        (
          second.rawElevation ??
          second.elevation
        ) -
        (
          first.rawElevation ??
          first.elevation
        )
      ) *
      fraction,

    distanceAlong:
      targetDistance
  }
}

function resampleRouteProfile(
  graph,
  path
) {
  const {
    points,
    totalDistance
  } =
    makeOrderedPathPoints(
      graph,
      path
    )

  if (
    points.length < 2 ||
    totalDistance <= 0
  ) {
    return {
      samples:
        points,

      totalDistance,

      spacing:
        totalDistance
    }
  }

  const segmentCount =
    Math.max(
      1,

      Math.round(
        totalDistance /
        GRADE_SAMPLE_DISTANCE_METERS
      )
    )

  const spacing =
    totalDistance /
    segmentCount

  const samples = []

  let sourceIndex = 0

  for (
    let sampleIndex = 0;
    sampleIndex <=
      segmentCount;
    sampleIndex++
  ) {
    const targetDistance =
      sampleIndex ===
      segmentCount
        ? totalDistance
        : sampleIndex *
          spacing

    while (
      sourceIndex <
        points.length - 2 &&
      points[
        sourceIndex + 1
      ].distanceAlong <
        targetDistance
    ) {
      sourceIndex++
    }

    const first =
      points[
        sourceIndex
      ]

    const second =
      points[
        Math.min(
          sourceIndex + 1,
          points.length - 1
        )
      ]

    samples.push(
      interpolateProfilePoint(
        first,
        second,
        targetDistance
      )
    )
  }

  return {
    samples,
    totalDistance,
    spacing
  }
}

function smoothRouteSamples(
  samples
) {
  if (
    samples.length < 3
  ) {
    return samples.map(
      sample => ({
        ...sample,

        smoothedElevation:
          sample.elevation
      })
    )
  }

  return samples.map(
    (
      sample,
      index
    ) => {
      let weightedElevation =
        0

      let totalWeight =
        0

      for (
        let offset = -1;
        offset <= 1;
        offset++
      ) {
        const neighborIndex =
          index + offset

        if (
          neighborIndex < 0 ||
          neighborIndex >=
            samples.length
        ) {
          continue
        }

        const neighbor =
          samples[
            neighborIndex
          ]

        const weight =
          offset === 0
            ? 2
            : 1

        weightedElevation +=
          neighbor.elevation *
          weight

        totalWeight +=
          weight
      }

      return {
        ...sample,

        smoothedElevation:
          weightedElevation /
          totalWeight
      }
    }
  )
}

// ============================================================
// HILL METRICS + PROFILE
// ============================================================

function calculateTotalAscent(
  samples
) {
  if (
    !Array.isArray(samples) ||
    samples.length < 2
  ) {
    return 0
  }

  let ascent = 0

  let anchor =
    samples[0].rawElevation ??
    samples[0].elevation

  for (
    let index = 1;
    index < samples.length;
    index++
  ) {
    const elevation =
      samples[index]
        .rawElevation ??
      samples[index].elevation

    if (
      !Number.isFinite(
        elevation
      )
    ) {
      continue
    }

    if (
      elevation >
      anchor +
        ASCENT_NOISE_METERS
    ) {
      // A real climb: count all of it, then keep going from here.
      ascent +=
        elevation - anchor

      anchor = elevation
    } else if (
      elevation < anchor
    ) {
      // Going downhill (or dipping): next climb starts from this low.
      anchor = elevation
    }
  }

  return ascent
}

function calculateHillMetrics(
  graph,
  path
) {
  const {
    samples,
    totalDistance,
    spacing
  } =
    resampleRouteProfile(
      graph,
      path
    )

  const smoothed =
    smoothRouteSamples(
      samples
    )

  const totalAscent =
    calculateTotalAscent(
      samples
    )

  let weightedAbsoluteGrade =
    0

  let maximumGrade = 0

  const elevationProfile =
    []

  for (
    let index = 0;
    index <
      smoothed.length;
    index++
  ) {
    const sample =
      smoothed[index]

    let grade = 0

    if (
      index > 0
    ) {
      const previous =
        smoothed[
          index - 1
        ]

      const horizontalDistance =
        sample.distanceAlong -
        previous.distanceAlong

      if (
        horizontalDistance > 0
      ) {
        const elevationChange =
          sample
            .smoothedElevation -
          previous
            .smoothedElevation

        grade =
          clamp(
            elevationChange /
              horizontalDistance,

            -MAX_MODEL_GRADE,

            MAX_MODEL_GRADE
          )

        weightedAbsoluteGrade +=
          Math.abs(
            grade
          ) *
          horizontalDistance

        maximumGrade =
          Math.max(
            maximumGrade,

            Math.abs(
              grade
            )
          )
      }
    }

    elevationProfile.push({
      distanceMeters:
        sample.distanceAlong,

      elevationMeters:
        sample
          .smoothedElevation,

      gradePercent:
        grade * 100,

      coordinate: [
        sample.lon,
        sample.lat
      ],

      steep:
        Math.abs(
          grade * 100
        ) >=
        STEEP_UI_THRESHOLD_PERCENT
    })
  }

  return {
    totalDistance,

    totalAscent,

    averageGrade:
      totalDistance > 0
        ? weightedAbsoluteGrade /
          totalDistance
        : 0,

    maximumGrade,

    spacing,

    elevationProfile
  }
}

// ============================================================
// TURN BY TURN
// ============================================================

function cleanStreetName(
  value
) {
  return String(
    value || ''
  ).trim()
}

function fallbackStreetName(
  highway
) {
  if (
    highway === 'footway'
  ) {
    return 'pedestrian path'
  }

  if (
    highway === 'path'
  ) {
    return 'path'
  }

  if (
    highway === 'steps'
  ) {
    return 'steps'
  }

  if (
    highway === 'pedestrian'
  ) {
    return 'pedestrian street'
  }

  if (
    highway === 'service'
  ) {
    return 'service road'
  }

  return ''
}

function makePathEdges(
  graph,
  path
) {
  const edges = []

  let cumulativeDistance =
    0

  for (
    let index = 0;
    index <
      path.length - 1;
    index++
  ) {
    const fromId =
      path[index]

    const toId =
      path[
        index + 1
      ]

    const fromNode =
      graph.nodes.get(
        fromId
      )

    const toNode =
      graph.nodes.get(
        toId
      )

    if (
      !fromNode ||
      !toNode
    ) {
      continue
    }

    const graphEdge =
      getPathEdge(
        graph,
        fromId,
        toId
      )

    const distance =
      graphEdge
        ?.distance ??
      haversineMeters(
        fromNode.lat,
        fromNode.lon,
        toNode.lat,
        toNode.lon
      )

    const name =
      cleanStreetName(
        graphEdge?.name
      )

    const highway =
      graphEdge?.highway ||
      ''

    const displayName =
      name ||
      fallbackStreetName(
        highway
      )

    const bearing =
      bearingDegrees(
        fromNode.lat,
        fromNode.lon,
        toNode.lat,
        toNode.lon
      )

    edges.push({
      fromId,
      toId,

      fromCoordinate: [
        fromNode.lon,
        fromNode.lat
      ],

      toCoordinate: [
        toNode.lon,
        toNode.lat
      ],

      distance,

      cumulativeStart:
        cumulativeDistance,

      cumulativeEnd:
        cumulativeDistance +
        distance,

      name,
      displayName,
      highway,
      bearing
    })

    cumulativeDistance +=
      distance
  }

  return edges
}

function groupPathEdges(
  edges
) {
  if (
    edges.length === 0
  ) {
    return []
  }

  const segments = []

  let current = {
    displayName:
      edges[0]
        .displayName,

    highway:
      edges[0]
        .highway,

    distance:
      edges[0]
        .distance,

    cumulativeStart:
      edges[0]
        .cumulativeStart,

    cumulativeEnd:
      edges[0]
        .cumulativeEnd,

    startCoordinate:
      edges[0]
        .fromCoordinate,

    endCoordinate:
      edges[0]
        .toCoordinate,

    startBearing:
      edges[0]
        .bearing,

    endBearing:
      edges[0]
        .bearing
  }

  for (
    let index = 1;
    index <
      edges.length;
    index++
  ) {
    const edge =
      edges[index]

    const previous =
      edges[
        index - 1
      ]

    const bearingChange =
      Math.abs(
        angleDifference(
          previous.bearing,
          edge.bearing
        )
      )

    const sameName =
      current.displayName ===
      edge.displayName

    const unnamedCompatible =
      !current.displayName &&
      !edge.displayName &&
      current.highway ===
      edge.highway

    const continueSegment =
      (
        sameName &&
        bearingChange < 55
      ) ||
      (
        unnamedCompatible &&
        bearingChange < 35
      )

    if (
      continueSegment
    ) {
      current.distance +=
        edge.distance

      current.cumulativeEnd =
        edge.cumulativeEnd

      current.endCoordinate =
        edge.toCoordinate

      current.endBearing =
        edge.bearing

      continue
    }

    segments.push(
      current
    )

    current = {
      displayName:
        edge.displayName,

      highway:
        edge.highway,

      distance:
        edge.distance,

      cumulativeStart:
        edge.cumulativeStart,

      cumulativeEnd:
        edge.cumulativeEnd,

      startCoordinate:
        edge.fromCoordinate,

      endCoordinate:
        edge.toCoordinate,

      startBearing:
        edge.bearing,

      endBearing:
        edge.bearing
    }
  }

  segments.push(
    current
  )

  return segments
}

function makeTurnModifier(
  difference
) {
  const absolute =
    Math.abs(
      difference
    )

  if (
    absolute < 20
  ) {
    return 'straight'
  }

  if (
    absolute < 45
  ) {
    return (
      difference > 0
        ? 'slight-right'
        : 'slight-left'
    )
  }

  if (
    absolute < 135
  ) {
    return (
      difference > 0
        ? 'right'
        : 'left'
    )
  }

  return (
    difference > 0
      ? 'sharp-right'
      : 'sharp-left'
  )
}

function makeTurnInstruction(
  modifier,
  streetName
) {
  const suffix =
    streetName
      ? ` onto ${streetName}`
      : ''

  if (
    modifier === 'straight'
  ) {
    return (
      streetName
        ? `Continue on ${streetName}`
        : 'Continue straight'
    )
  }

  if (
    modifier ===
    'slight-right'
  ) {
    return (
      `Keep slightly right${suffix}`
    )
  }

  if (
    modifier ===
    'slight-left'
  ) {
    return (
      `Keep slightly left${suffix}`
    )
  }

  if (
    modifier === 'right'
  ) {
    return (
      `Turn right${suffix}`
    )
  }

  if (
    modifier === 'left'
  ) {
    return (
      `Turn left${suffix}`
    )
  }

  if (
    modifier ===
    'sharp-right'
  ) {
    return (
      `Make a sharp right${suffix}`
    )
  }

  return (
    `Make a sharp left${suffix}`
  )
}

function buildManeuvers(
  graph,
  path
) {
  const edges =
    makePathEdges(
      graph,
      path
    )

  const segments =
    groupPathEdges(
      edges
    )

  if (
    segments.length === 0
  ) {
    return []
  }

  const maneuvers = []

  const first =
    segments[0]

  const direction =
    cardinalDirection(
      first.startBearing
    )

  maneuvers.push({
    index: 0,

    type: 'start',

    modifier:
      'straight',

    instruction:
      first.displayName
        ? `Head ${direction} on ${first.displayName}`
        : `Head ${direction}`,

    streetName:
      first.displayName,

    maneuverCoordinate:
      first.startCoordinate,

    cumulativeDistanceMeters:
      first.cumulativeStart,

    segmentDistanceMeters:
      first.distance
  })

  for (
    let index = 1;
    index <
      segments.length;
    index++
  ) {
    const previous =
      segments[
        index - 1
      ]

    const current =
      segments[index]

    const difference =
      angleDifference(
        previous.endBearing,
        current.startBearing
      )

    const modifier =
      makeTurnModifier(
        difference
      )

    maneuvers.push({
      index:
        maneuvers.length,

      type:
        modifier ===
          'straight'
          ? 'continue'
          : 'turn',

      modifier,

      instruction:
        makeTurnInstruction(
          modifier,
          current.displayName
        ),

      streetName:
        current.displayName,

      maneuverCoordinate:
        current.startCoordinate,

      cumulativeDistanceMeters:
        current.cumulativeStart,

      segmentDistanceMeters:
        current.distance
    })
  }

  const finalSegment =
    segments[
      segments.length - 1
    ]

  maneuvers.push({
    index:
      maneuvers.length,

    type: 'arrive',

    modifier:
      'arrive',

    instruction:
      'Arrive at your destination',

    streetName: '',

    maneuverCoordinate:
      finalSegment
        .endCoordinate,

    cumulativeDistanceMeters:
      finalSegment
        .cumulativeEnd,

    segmentDistanceMeters:
      0
  })

  return maneuvers
}

// ============================================================
// ROUTE RESULT
// ============================================================

// Runs the Comfort search and checks the result against the limits in
// getComfortLimits (not much longer, not much steeper, not much less
// shaded than Shortest). If a limit is broken it searches again with eased
// preferences. firstResult is the search with the unmodified preferences;
// shortestRoute needs distanceMeters, totalAscentMeters, treeCoverPercent.
// Returns { result, eased, easedReason } where easedReason is 'shade' when
// only the shade floor was broken, otherwise 'detour'.
function routeComfortWithGuardrails(
  graph,
  startId,
  endId,
  preferences,
  firstResult,
  shortestRoute
) {
  const limits = getComfortLimits(
    preferences,
    shortestRoute
  )

  const check = candidate => {
    const metrics = calculateHillMetrics(
      graph,
      candidate.path
    )

    const canopy = calculateRouteCanopy(
      graph,
      candidate.path
    )

    const detourBroken =
      metrics.totalDistance > limits.maxDistance ||
      metrics.totalAscent > limits.maxClimb

    const shadeBroken =
      canopy.treeCoverRatio * 100 <
      limits.minTreeCoverPercent

    return { detourBroken, shadeBroken }
  }

  const first = check(firstResult)

  if (!first.detourBroken && !first.shadeBroken) {
    return {
      result: firstResult,
      eased: false,
      easedReason: null
    }
  }

  const easedReason =
    first.shadeBroken && !first.detourBroken
      ? 'shade'
      : 'detour'

  const strategies = attempt => {
    // Too long or too steep: tone down shade and crosswalk preferences
    // and lean harder on hills.
    const detour = {
      prefScale: Math.pow(0.5, attempt),
      hillBoost: 0.1 * attempt
    }

    // Not enough shade: stop avoiding crosswalks as hard and boost shade.
    const shade = {
      crossingScale: Math.pow(0.5, attempt),
      shadeBoost: 0.1 * attempt
    }

    return easedReason === 'shade'
      ? [shade, detour]
      : [detour, shade]
  }

  for (
    let attempt = 1;
    attempt <= GUARD_MAX_RETRIES;
    attempt++
  ) {
    for (const easing of strategies(attempt)) {
      const candidate = aStar(
        graph,
        startId,
        endId,
        'comfort',
        makeComfortWeights(preferences, easing)
      )

      if (!candidate) {
        continue
      }

      const result = check(candidate)

      if (!result.detourBroken && !result.shadeBroken) {
        return { result: candidate, eased: true, easedReason }
      }
    }
  }

  // Last resort: the direct route is always within the limits.
  const direct = aStar(
    graph,
    startId,
    endId,
    'shortest'
  )

  return {
    result: direct || firstResult,
    eased: true,
    easedReason
  }
}


function makeRouteResult(
  graph,
  path,
  mode,
  visitedNodes
) {
  const coordinates =
    path
      .map(
        nodeId => {
          const node =
            graph.nodes.get(
              nodeId
            )

          if (!node) {
            return null
          }

          return [
            node.lon,
            node.lat
          ]
        }
      )
      .filter(Boolean)

  const hillMetrics =
    calculateHillMetrics(
      graph,
      path
    )

  const routingEnergy =
    calculateRoutingEnergy(
      graph,
      path
    )

  const canopy =
    calculateRouteCanopy(
      graph,
      path
    )

  const crosswalks =
    findCrosswalks(
      graph,
      path
    )

  const distanceMiles =
    hillMetrics
      .totalDistance /
    METERS_PER_MILE

  const minutes =
    hillMetrics
      .totalDistance /
    WALKING_SPEED_METERS_PER_SECOND /
    60

  const flatEnergyPerKgJ =
    FLAT_WALKING_COST *
    hillMetrics
      .totalDistance

  const effortRatio =
    flatEnergyPerKgJ > 0
      ? routingEnergy
          .totalEnergyPerKgJ /
        flatEnergyPerKgJ
      : 1

  const labels = {
    shortest:
      'Shortest',

    balanced:
      'Balanced',

    energy:
      'Less Energy',

    comfort:
      'Comfort'
  }

  return {
    id:
      mode,

    label:
      labels[mode],

    algorithm:
      'A*',

    distanceMeters:
      hillMetrics
        .totalDistance,

    distanceMiles,

    minutes,

    totalAscentMeters:
      hillMetrics
        .totalAscent,

    averageGradePercent:
      hillMetrics
        .averageGrade *
      100,

    maximumGradePercent:
      hillMetrics
        .maximumGrade *
      100,

    energyKJPerKg:
      routingEnergy
        .totalEnergyPerKgJ /
      1000,

    effortRatio,

    treeCoverPercent:
      canopy.treeCoverRatio *
      100,

    crosswalkCount:
      crosswalks.length,

    crosswalkMarkedCount:
      crosswalks.filter(
        crossing =>
          crossing.type ===
          'marked'
      ).length,

    crosswalks,

    treeCoveredDistanceMeters:
      canopy
        .coveredDistanceMeters,

    canopyDataAvailable:
      graph.canopyAvailable &&
      graph.canopyCovered !== false,

    flatEquivalentMeters:
      routingEnergy
        .totalFlatEquivalentMeters,

    gradeSampleSpacingMeters:
      hillMetrics.spacing,

    steepThresholdPercent:
      STEEP_UI_THRESHOLD_PERCENT,

    elevationProfile:
      hillMetrics
        .elevationProfile,

    visitedNodes,

    graphNodes:
      graph.nodes.size,

    coordinates,

    maneuvers:
      buildManeuvers(
        graph,
        path
      ),

    // Length of the route steeper than the usual 8.3% ramp limit.
    steepOverLimitMeters:
      calculateSteepOverLimitMeters(
        graph,
        path
      ),

    pathFingerprint:
      path.join('-')
  }
}

// ============================================================
// ROUTE API
// ============================================================

app.post(
  '/route',
  async (
    request,
    response
  ) => {
    try {
      const start = {
        lat:
          Number(
            request.body
              ?.start
              ?.lat
          ),

        lon:
          Number(
            request.body
              ?.start
              ?.lon
          )
      }

      const end = {
        lat:
          Number(
            request.body
              ?.end
              ?.lat
          ),

        lon:
          Number(
            request.body
              ?.end
              ?.lon
          )
      }

      if (
        !Number.isFinite(
          start.lat
        ) ||
        !Number.isFinite(
          start.lon
        ) ||
        !Number.isFinite(
          end.lat
        ) ||
        !Number.isFinite(
          end.lon
        )
      ) {
        return response
          .status(400)
          .json({
            error:
              'Invalid coordinates.'
          })
      }

      const directDistance =
        haversineMeters(
          start.lat,
          start.lon,
          end.lat,
          end.lon
        )

      if (
        directDistance >
        MAX_DIRECT_DISTANCE_METERS
      ) {
        return response
          .status(400)
          .json({
            error:
              'Destination is too far for this prototype.'
          })
      }

      const preferences =
        normalizePreferences(
          request.body
            ?.preferences
        )

      const comfortWeights =
        makeComfortWeights(
          preferences
        )

      const paddingOptions = [
        350,
        650,
        1100
      ]

      let lastError =
        preferences.accessible
          ? 'No step-free route found.'
          : 'No route found.'

      for (
        const paddingMeters
        of paddingOptions
      ) {
        try {
          const bounds =
            makeBounds(
              start,
              end,
              paddingMeters
            )

          const fullGraph =
            await getWalkingGraph(
              bounds
            )

          // Wheelchair / stroller mode: no steps for any of the routes.
          const graph =
            preferences.accessible
              ? makeStepFreeGraph(
                  fullGraph
                )
              : fullGraph

          const nearestStart =
            findNearestNode(
              graph,
              start
            )

          const nearestEnd =
            findNearestNode(
              graph,
              end
            )

          if (
            nearestStart.nodeId ===
              null ||
            nearestEnd.nodeId ===
              null
          ) {
            continue
          }

          const modes = [
            'shortest',
            'balanced',
            'comfort'
          ]

          const routes = []

          let failed = false

          for (
            const mode
            of modes
          ) {
            let result =
              aStar(
                graph,
                nearestStart.nodeId,
                nearestEnd.nodeId,
                mode,
                mode === 'comfort'
                  ? comfortWeights
                  : undefined
              )

            if (!result) {
              failed = true
              break
            }

            let eased = false

            let easedReason = null

            if (mode === 'comfort') {
              const guarded =
                routeComfortWithGuardrails(
                  graph,
                  nearestStart.nodeId,
                  nearestEnd.nodeId,
                  preferences,
                  result,
                  routes[0]
                )

              result =
                guarded.result

              eased =
                guarded.eased

              easedReason =
                guarded.easedReason
            }

            const route =
              makeRouteResult(
                graph,
                result.path,
                mode,
                result.visitedNodes
              )

            if (eased) {
              route.eased = true

              route.easedReason =
                easedReason
            }

            routes.push(route)
          }

          if (failed) {
            continue
          }

          for (
            let index = 0;
            index <
              routes.length;
            index++
          ) {
            for (
              let compare = 0;
              compare < index;
              compare++
            ) {
              if (
                routes[index]
                  .pathFingerprint ===
                routes[compare]
                  .pathFingerprint
              ) {
                routes[index]
                  .samePathAs =
                  routes[
                    compare
                  ].id
              }
            }
          }

          for (
            const route
            of routes
          ) {
            delete route
              .pathFingerprint
          }

          console.log('')

          console.log(
            '=== ROUTE METRICS ==='
          )

          console.table(
            routes.map(
              route => ({
                Route:
                  route.label,

                'Distance m':
                  route
                    .distanceMeters
                    .toFixed(2),

                'Ascent m':
                  route
                    .totalAscentMeters
                    .toFixed(2),

                'Avg grade %':
                  route
                    .averageGradePercent
                    .toFixed(2),

                'Max grade %':
                  route
                    .maximumGradePercent
                    .toFixed(2),

                'Energy kJ/kg':
                  route
                    .energyKJPerKg
                    .toFixed(4),

                Crosswalks:
                  `${route.crosswalkCount} (${route.crosswalkMarkedCount} marked)`,
                'Tree cover %':
                  route
                    .treeCoverPercent
                    .toFixed(1),

                'Profile samples':
                  route
                    .elevationProfile
                    .length
              })
            )
          )

          return response.json({
            routes,

            paddingMeters,

            elevationCoverage:
              graph
                .elevationCoverage *
              100,

            canopyDataAvailable:
              graph.canopyAvailable &&
              graph.canopyCovered !== false,

            routingEngine:
              'Custom A*',

            steepVisualizationThresholdPercent:
              STEEP_UI_THRESHOLD_PERCENT
          })
        } catch (
          error
        ) {
          console.log(
            'Route attempt failed:',
            error.message
          )

          lastError =
            error.message
        }
      }

      return response
        .status(404)
        .json({
          error:
            lastError
        })
    } catch (
      error
    ) {
      console.error(
        'ROUTE ERROR:',
        error
      )

      return response
        .status(500)
        .json({
          error:
            error.message ||
            'Routing failed.'
        })
    }
  }
)

// ============================================================
// HEALTH
// ============================================================

app.get(
  '/health',
  (
    request,
    response
  ) => {
    response.json({
      status:
        'ok',

      routing:
        'custom-a-star',

      elevation:
        true,

      elevationProfile:
        true,

      treeCanopy:
        canopyStatus.available,

      treeCanopyDetails:
        canopyStatus,

      steepVisualizationThresholdPercent:
        STEEP_UI_THRESHOLD_PERCENT,

      turnByTurn:
        true,

      search:
        'photon'
    })
  }
)

// ============================================================
// START
// ============================================================

// Serve the built front end (npm run build -> dist/) in production.
const DIST_DIR = new URL('../dist/', import.meta.url)

app.use(
  express.static(
    DIST_DIR.pathname,
    { index: false }
  )
)

app.use((request, response, next) => {
  if (
    request.method !== 'GET' ||
    request.path === '/health'
  ) {
    return next()
  }

  response.sendFile(
    new URL('index.html', DIST_DIR).pathname,
    error => {
      if (error) {
        next()
      }
    }
  )
})

app.listen(
  PORT,
  HOST,
  () => {
    // Start loading tree canopy now so the first route doesn't wait for it.
    loadCanopyGeometries().catch(error => {
      console.log(
        'Tree canopy prewarm failed:',
        error.message
      )
    })

    console.log('')

    console.log(
      'Comfort Walk server'
    )

    console.log(
      `http://${HOST}:${PORT}`
    )

    console.log('')

    console.log(
      'Custom A*: ON'
    )

    console.log(
      'Elevation profile: ON'
    )

    console.log(
      'Tree canopy routing: loads on first route'
    )

    console.log(
      `Steep visualization: >= ${STEEP_UI_THRESHOLD_PERCENT}%`
    )

    console.log(
      'Turn-by-turn: ON'
    )

    console.log('')
  }
)