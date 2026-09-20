import express from 'express'
import { PNG } from 'pngjs'

const app = express()

const PORT = 8787

const METERS_PER_MILE = 1609.344
const WALKING_SPEED_METERS_PER_SECOND = 1.35
const MAX_DIRECT_DISTANCE_METERS = 12000

const PHOTON_URL =
  'https://photon.komoot.io/api/'

const OVERPASS_SERVERS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter'
]

const USER_AGENT =
  'ComfortWalkStudentProject/1.0'

const TERRAIN_ZOOM = 14

const TERRAIN_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'

const FLAT_WALKING_COST = 2.5

const MAX_MODEL_GRADE = 0.45

// Reported grade is calculated at roughly this spacing.
const GRADE_SAMPLE_DISTANCE_METERS = 25

// First smoothing pass on the graph.
const GRAPH_ELEVATION_SMOOTH_RADIUS_METERS = 30

// Prevent tiny OSM edges from producing absurd routing grades.
const ROUTING_GRADE_MIN_RUN_METERS = 20

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

const MAX_GRAPH_CACHE_SIZE = 8
const MAX_TERRAIN_CACHE_SIZE = 64

const SEARCH_CACHE_TIME =
  5 * 60 * 1000

function trimMapCache(
  map,
  maximumSize
) {
  while (
    map.size >
    maximumSize
  ) {
    const firstKey =
      map.keys().next().value

    map.delete(
      firstKey
    )
  }
}

function getCachedSearch(
  key
) {
  const item =
    searchCache.get(
      key
    )

  if (!item) {
    return null
  }

  if (
    Date.now() -
      item.time >
    SEARCH_CACHE_TIME
  ) {
    searchCache.delete(
      key
    )

    return null
  }

  return item.data
}

function setCachedSearch(
  key,
  data
) {
  searchCache.set(
    key,
    {
      time:
        Date.now(),

      data
    }
  )

  trimMapCache(
    searchCache,
    100
  )
}

// ============================================================
// GENERAL MATH
// ============================================================

function toRadians(
  value
) {
  return (
    value *
    Math.PI /
    180
  )
}

function clamp(
  value,
  minimum,
  maximum
) {
  return Math.min(
    maximum,
    Math.max(
      minimum,
      value
    )
  )
}

function haversineMeters(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const earthRadius =
    6371000

  const phi1 =
    toRadians(
      lat1
    )

  const phi2 =
    toRadians(
      lat2
    )

  const deltaLatitude =
    toRadians(
      lat2 - lat1
    )

  const deltaLongitude =
    toRadians(
      lon2 - lon1
    )

  const a =
    Math.sin(
      deltaLatitude / 2
    ) ** 2 +
    Math.cos(phi1) *
    Math.cos(phi2) *
    Math.sin(
      deltaLongitude / 2
    ) ** 2

  return (
    2 *
    earthRadius *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(
        1 - a
      )
    )
  )
}

function makeBounds(
  start,
  end,
  paddingMeters
) {
  const averageLatitude =
    (
      start.lat +
      end.lat
    ) / 2

  const latitudePadding =
    paddingMeters /
    111320

  const longitudeMetersPerDegree =
    111320 *
    Math.cos(
      toRadians(
        averageLatitude
      )
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
      ) -
      latitudePadding,

    west:
      Math.min(
        start.lon,
        end.lon
      ) -
      longitudePadding,

    north:
      Math.max(
        start.lat,
        end.lat
      ) +
      latitudePadding,

    east:
      Math.max(
        start.lon,
        end.lon
      ) +
      longitudePadding
  }
}

function makeGraphCacheKey(
  bounds
) {
  return [
    bounds.south.toFixed(3),
    bounds.west.toFixed(3),
    bounds.north.toFixed(3),
    bounds.east.toFixed(3)
  ].join('|')
}

// ============================================================
// WALKING ENERGY MODEL
// ============================================================

function walkingEnergyCost(
  grade
) {
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

function getNodeElevation(
  node
) {
  if (
    Number.isFinite(
      node?.smoothedElevation
    )
  ) {
    return node
      .smoothedElevation
  }

  if (
    Number.isFinite(
      node?.elevation
    )
  ) {
    return node
      .elevation
  }

  return 0
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
    getNodeElevation(
      toNode
    ) -
    getNodeElevation(
      fromNode
    )

  // Small OSM edges can be only a couple meters long.
  // Using at least 20 m for grade reduces terrain-pixel noise.
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
  mode
) {
  if (
    mode ===
    'shortest'
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
    mode ===
    'balanced'
  ) {
    return (
      0.5 *
        edge.distance +
      0.5 *
        profile.flatEquivalentMeters
    )
  }

  return (
    profile
      .flatEquivalentMeters
  )
}

// Lower-bound multipliers so A* heuristic stays conservative.
function getHeuristicMultiplier(
  mode
) {
  if (
    mode ===
    'shortest'
  ) {
    return 1
  }

  if (
    mode ===
    'balanced'
  ) {
    return 0.6
  }

  return 0.2
}

// ============================================================
// PHOTON SEARCH
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
    parts.push(
      street
    )
  }

  const city =
    properties.city ||
    properties.town ||
    properties.village ||
    properties.district ||
    properties.county

  if (
    city &&
    !parts.includes(
      city
    )
  ) {
    parts.push(
      city
    )
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
    feature.properties || {}

  const coordinates =
    feature.geometry
      ?.coordinates || []

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

  if (
    !response.ok
  ) {
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

        results.push(
          item
        )

        if (
          results.length >=
          10
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
    return (
      this.items.length
    )
  }

  push(
    item
  ) {
    this.items.push(
      item
    )

    this.bubbleUp(
      this.items.length -
      1
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
      return (
        this.items.pop()
      )
    }

    const smallest =
      this.items[0]

    this.items[0] =
      this.items.pop()

    this.bubbleDown(0)

    return smallest
  }

  bubbleUp(
    index
  ) {
    while (
      index > 0
    ) {
      const parent =
        Math.floor(
          (index - 1) /
          2
        )

      if (
        this.items[
          parent
        ].priority <=
        this.items[
          index
        ].priority
      ) {
        break
      }

      const temporary =
        this.items[
          parent
        ]

      this.items[
        parent
      ] =
        this.items[
          index
        ]

      this.items[
        index
      ] =
        temporary

      index =
        parent
    }
  }

  bubbleDown(
    index
  ) {
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
        this.items[
          left
        ].priority <
        this.items[
          smallest
        ].priority
      ) {
        smallest =
          left
      }

      if (
        right <
          this.items.length &&
        this.items[
          right
        ].priority <
        this.items[
          smallest
        ].priority
      ) {
        smallest =
          right
      }

      if (
        smallest ===
        index
      ) {
        break
      }

      const temporary =
        this.items[index]

      this.items[index] =
        this.items[
          smallest
        ]

      this.items[
        smallest
      ] =
        temporary

      index =
        smallest
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

async function fetchOverpass(
  query
) {
  let lastError =
    null

  for (
    const server
    of OVERPASS_SERVERS
  ) {
    const controller =
      new AbortController()

    const timeoutId =
      setTimeout(
        () => {
          controller.abort()
        },
        18000
      )

    try {
      console.log(
        'Trying Overpass:',
        server
      )

      const body =
        new URLSearchParams()

      body.set(
        'data',
        query
      )

      const started =
        Date.now()

      const result =
        await fetch(
          server,
          {
            method:
              'POST',

            headers: {
              Accept:
                'application/json',

              'Content-Type':
                'application/x-www-form-urlencoded;charset=UTF-8',

              'User-Agent':
                USER_AGENT
            },

            body:
              body.toString(),

            signal:
              controller.signal
          }
        )

      clearTimeout(
        timeoutId
      )

      console.log(
        'Overpass:',
        result.status,
        `${Date.now() - started} ms`
      )

      if (
        !result.ok
      ) {
        throw new Error(
          `Overpass returned ${result.status}`
        )
      }

      return (
        await result.json()
      )
    } catch (
      error
    ) {
      clearTimeout(
        timeoutId
      )

      console.log(
        'Overpass failed:',
        error.message
      )

      lastError =
        error
    }
  }

  throw (
    lastError ||
    new Error(
      'All Overpass servers failed.'
    )
  )
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
      nodes.get(
        from
      )

    const second =
      nodes.get(
        to
      )

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
          way.tags
            ?.name ||
          '',

        highway:
          way.tags
            ?.highway ||
          ''
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
    elevationCoverage: 0
  }
}

// ============================================================
// TERRAIN TILES
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
    return (
      terrainTileCache.get(
        key
      )
    )
  }

  const controller =
    new AbortController()

  const timeoutId =
    setTimeout(
      () => {
        controller.abort()
      },
      12000
    )

  try {
    const response =
      await fetch(
        `${TERRAIN_URL}/${zoom}/${x}/${y}.png`,
        {
          signal:
            controller.signal,

          headers: {
            'User-Agent':
              USER_AGENT
          }
        }
      )

    clearTimeout(
      timeoutId
    )

    if (
      !response.ok
    ) {
      throw new Error(
        `Terrain tile returned ${response.status}`
      )
    }

    const arrayBuffer =
      await response
        .arrayBuffer()

    const buffer =
      Buffer.from(
        arrayBuffer
      )

    const png =
      PNG.sync.read(
        buffer
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
  } catch (
    error
  ) {
    clearTimeout(
      timeoutId
    )

    throw error
  }
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
    png.data[
      index
    ]

  const green =
    png.data[
      index + 1
    ]

  const blue =
    png.data[
      index + 2
    ]

  const alpha =
    png.data[
      index + 3
    ]

  if (
    alpha === 0
  ) {
    return null
  }

  const elevation =
    red * 256 +
    green +
    blue / 256 -
    32768

  if (
    elevation < -500 ||
    elevation > 9000
  ) {
    return null
  }

  return elevation
}

async function populateGraphElevations(
  graph
) {
  const groups =
    new Map()

  const connectedNodeIds =
    Array.from(
      graph.adjacency.keys()
    )

  for (
    const nodeId
    of connectedNodeIds
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
      !groups.has(
        key
      )
    ) {
      groups.set(
        key,
        {
          zoom:
            TERRAIN_ZOOM,

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

  const groupList =
    Array.from(
      groups.values()
    )

  let assigned = 0

  const batchSize = 8

  for (
    let start = 0;
    start <
      groupList.length;
    start += batchSize
  ) {
    const batch =
      groupList.slice(
        start,
        start + batchSize
      )

    await Promise.all(
      batch.map(
        async group => {
          try {
            const png =
              await loadTerrainTile(
                group.zoom,
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
              group.x,
              group.y,
              error.message
            )
          }
        }
      )
    )
  }

  const coverage =
    connectedNodeIds.length >
      0
      ? assigned /
        connectedNodeIds.length
      : 0

  graph.elevationCoverage =
    coverage

  console.log(
    'Elevation coverage:',
    `${(
      coverage *
      100
    ).toFixed(1)}%`
  )

  if (
    coverage < 0.8
  ) {
    throw new Error(
      'Not enough elevation data.'
    )
  }
}

// ============================================================
// GRAPH ELEVATION SMOOTHING
// ============================================================

function smoothGraphElevations(
  graph,
  radiusMeters =
    GRAPH_ELEVATION_SMOOTH_RADIUS_METERS
) {
  const connectedNodes =
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

  if (
    connectedNodes.length ===
    0
  ) {
    return
  }

  let latitudeSum = 0

  for (
    const node
    of connectedNodes
  ) {
    latitudeSum +=
      node.lat
  }

  const averageLatitude =
    latitudeSum /
    connectedNodes.length

  const latitudeCellSize =
    radiusMeters /
    111320

  const longitudeCellSize =
    radiusMeters /
    (
      111320 *
      Math.cos(
        toRadians(
          averageLatitude
        )
      )
    )

  const buckets =
    new Map()

  function getBucketPosition(
    node
  ) {
    return {
      x:
        Math.floor(
          node.lon /
          longitudeCellSize
        ),

      y:
        Math.floor(
          node.lat /
          latitudeCellSize
        )
    }
  }

  function getBucketKey(
    x,
    y
  ) {
    return `${x}:${y}`
  }

  for (
    const node
    of connectedNodes
  ) {
    const position =
      getBucketPosition(
        node
      )

    const key =
      getBucketKey(
        position.x,
        position.y
      )

    if (
      !buckets.has(
        key
      )
    ) {
      buckets.set(
        key,
        []
      )
    }

    buckets
      .get(key)
      .push(
        node
      )
  }

  const sigma =
    radiusMeters /
    2

  const nextElevations =
    new Map()

  for (
    const node
    of connectedNodes
  ) {
    const position =
      getBucketPosition(
        node
      )

    let weightedElevation = 0
    let totalWeight = 0

    for (
      let dx = -1;
      dx <= 1;
      dx++
    ) {
      for (
        let dy = -1;
        dy <= 1;
        dy++
      ) {
        const key =
          getBucketKey(
            position.x + dx,
            position.y + dy
          )

        const nearby =
          buckets.get(
            key
          ) || []

        for (
          const neighbor
          of nearby
        ) {
          const distance =
            haversineMeters(
              node.lat,
              node.lon,
              neighbor.lat,
              neighbor.lon
            )

          if (
            distance >
            radiusMeters
          ) {
            continue
          }

          const weight =
            Math.exp(
              -0.5 *
              (
                distance /
                sigma
              ) ** 2
            )

          weightedElevation +=
            neighbor.elevation *
            weight

          totalWeight +=
            weight
        }
      }
    }

    if (
      totalWeight > 0
    ) {
      nextElevations.set(
        node.id,
        weightedElevation /
        totalWeight
      )
    } else {
      nextElevations.set(
        node.id,
        node.elevation
      )
    }
  }

  for (
    const node
    of connectedNodes
  ) {
    node.smoothedElevation =
      nextElevations.get(
        node.id
      )
  }

  console.log(
    'Graph elevation smoothing:',
    `${radiusMeters} m radius`
  )
}

// ============================================================
// GRAPH LOADING
// ============================================================

async function getWalkingGraph(
  bounds
) {
  const cacheKey =
    makeGraphCacheKey(
      bounds
    )

  if (
    graphCache.has(
      cacheKey
    )
  ) {
    console.log(
      'GRAPH CACHE HIT'
    )

    return (
      graphCache.get(
        cacheKey
      )
    )
  }

  const started =
    Date.now()

  const query =
    makeOverpassQuery(
      bounds
    )

  const osmData =
    await fetchOverpass(
      query
    )

  const graph =
    buildGraph(
      osmData
    )

  console.log(
    'Graph:',
    graph.nodes.size,
    'nodes'
  )

  const elevationStarted =
    Date.now()

  await populateGraphElevations(
    graph
  )

  smoothGraphElevations(
    graph
  )

  console.log(
    'Elevation + smoothing:',
    `${Date.now() - elevationStarted} ms`
  )

  graphCache.set(
    cacheKey,
    graph
  )

  trimMapCache(
    graphCache,
    MAX_GRAPH_CACHE_SIZE
  )

  console.log(
    'Total graph load:',
    `${Date.now() - started} ms`
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
  let closestId =
    null

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
  mode
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
      getHeuristicMultiplier(
        mode
      )
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

      const stepCost =
        getEdgeCost(
          graph,
          currentId,
          edge,
          mode
        )

      const tentative =
        currentCost +
        stepCost

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
        getHeuristicMultiplier(
          mode
        )

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
// ROUTE PROFILE
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
      samples: points,
      totalDistance,
      sampleSpacingMeters:
        totalDistance
    }
  }

  // Use an integer number of equal-length segments.
  // For normal walking routes this gives roughly 20–30 m per sample.
  const segmentCount =
    Math.max(
      1,
      Math.round(
        totalDistance /
        GRADE_SAMPLE_DISTANCE_METERS
      )
    )

  const sampleSpacingMeters =
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
          sampleSpacingMeters

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
    sampleSpacingMeters
  }
}

// ============================================================
// ROUTE-SPECIFIC ELEVATION SMOOTHING
// ============================================================

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
      let weightedElevation = 0
      let totalWeight = 0

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
// FINAL ROUTE METRICS
// ============================================================

function calculateRouteMetrics(
  graph,
  path
) {
  const {
    samples,
    totalDistance,
    sampleSpacingMeters
  } =
    resampleRouteProfile(
      graph,
      path
    )

  const smoothedSamples =
    smoothRouteSamples(
      samples
    )

  let totalAscent = 0

  let weightedAbsoluteGrade = 0

  let maximumGrade = 0

  let totalEnergyPerKgJ = 0

  for (
    let index = 1;
    index <
      smoothedSamples.length;
    index++
  ) {
    const first =
      smoothedSamples[
        index - 1
      ]

    const second =
      smoothedSamples[
        index
      ]

    const horizontalDistance =
      second.distanceAlong -
      first.distanceAlong

    if (
      horizontalDistance <= 0
    ) {
      continue
    }

    const elevationChange =
      second.smoothedElevation -
      first.smoothedElevation

    if (
      elevationChange > 0
    ) {
      totalAscent +=
        elevationChange
    }

    const grade =
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

    totalEnergyPerKgJ +=
      walkingEnergyCost(
        grade
      ) *
      horizontalDistance
  }

  const averageGrade =
    totalDistance > 0
      ? weightedAbsoluteGrade /
        totalDistance
      : 0

  const flatEnergyPerKgJ =
    FLAT_WALKING_COST *
    totalDistance

  const effortRatio =
    flatEnergyPerKgJ > 0
      ? totalEnergyPerKgJ /
        flatEnergyPerKgJ
      : 1

  return {
    totalDistance,
    totalAscent,
    averageGrade,
    maximumGrade,
    totalEnergyPerKgJ,
    effortRatio,
    sampleSpacingMeters,
    sampleCount:
      smoothedSamples.length
  }
}

// ============================================================
// ROUTE RESULT
// ============================================================

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

  const metrics =
    calculateRouteMetrics(
      graph,
      path
    )

  const distanceMiles =
    metrics.totalDistance /
    METERS_PER_MILE

  const minutes =
    metrics.totalDistance /
    WALKING_SPEED_METERS_PER_SECOND /
    60

  const labels = {
    shortest:
      'Shortest',

    balanced:
      'Balanced',

    energy:
      'Less Energy'
  }

  return {
    id:
      mode,

    label:
      labels[mode],

    algorithm:
      'A*',

    // Keep the full precision in the API.
    distanceMeters:
      metrics.totalDistance,

    distanceMiles,

    minutes,

    totalAscentMeters:
      metrics.totalAscent,

    averageGradePercent:
      metrics.averageGrade *
      100,

    maximumGradePercent:
      metrics.maximumGrade *
      100,

    energyKJPerKg:
      metrics.totalEnergyPerKgJ /
      1000,

    effortRatio:
      metrics.effortRatio,

    gradeSampleSpacingMeters:
      metrics.sampleSpacingMeters,

    gradeSampleCount:
      metrics.sampleCount,

    visitedNodes,

    graphNodes:
      graph.nodes.size,

    coordinates,

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
    const totalStarted =
      Date.now()

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

      const paddingOptions = [
        350,
        650,
        1100
      ]

      let lastError =
        'No connected walking route found.'

      for (
        const paddingMeters
        of paddingOptions
      ) {
        try {
          console.log('')
          console.log(
            `ROUTE ATTEMPT: ${paddingMeters} m`
          )

          const bounds =
            makeBounds(
              start,
              end,
              paddingMeters
            )

          const graph =
            await getWalkingGraph(
              bounds
            )

          if (
            graph.adjacency.size ===
            0
          ) {
            continue
          }

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
            'energy'
          ]

          const routes = []

          let failed =
            false

          for (
            const mode
            of modes
          ) {
            const algorithmStarted =
              performance.now()

            const result =
              aStar(
                graph,
                nearestStart.nodeId,
                nearestEnd.nodeId,
                mode
              )

            console.log(
              `${mode} A*:`,
              `${(
                performance.now() -
                algorithmStarted
              ).toFixed(2)} ms`
            )

            if (!result) {
              failed =
                true

              break
            }

            routes.push(
              makeRouteResult(
                graph,
                result.path,
                mode,
                result.visitedNodes
              )
            )
          }

          if (failed) {
            lastError =
              `Could not calculate all routes with ${paddingMeters} m padding.`

            continue
          }

          // Detect identical paths.
          for (
            let index = 0;
            index <
              routes.length;
            index++
          ) {
            for (
              let compare = 0;
              compare <
                index;
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

                break
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
            '=== COMFORT WALK ROUTE METRICS ==='
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

                'Distance mi':
                  route
                    .distanceMiles
                    .toFixed(5),

                'Ascent m':
                  route
                    .totalAscentMeters
                    .toFixed(2),

                'Avg grade %':
                  route
                    .averageGradePercent
                    .toFixed(3),

                'Max grade %':
                  route
                    .maximumGradePercent
                    .toFixed(3),

                'Energy kJ/kg':
                  route
                    .energyKJPerKg
                    .toFixed(4),

                'Flat effort':
                  route
                    .effortRatio
                    .toFixed(4),

                'Grade spacing m':
                  route
                    .gradeSampleSpacingMeters
                    .toFixed(2),

                Samples:
                  route
                    .gradeSampleCount
              })
            )
          )

          console.log(
            'Total route request:',
            `${Date.now() - totalStarted} ms`
          )

          return response.json({
            routes,

            paddingMeters,

            elevationCoverage:
              graph.elevationCoverage *
              100,

            elevationSource:
              'Terrain Tiles',

            elevationSmoothingRadiusMeters:
              GRAPH_ELEVATION_SMOOTH_RADIUS_METERS,

            targetGradeSampleDistanceMeters:
              GRADE_SAMPLE_DISTANCE_METERS,

            routingEngine:
              'Custom A*'
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

      routeModes: [
        'shortest',
        'balanced',
        'energy'
      ],

      elevation:
        'terrain-tiles',

      graphElevationSmoothingMeters:
        GRAPH_ELEVATION_SMOOTH_RADIUS_METERS,

      gradeSampleTargetMeters:
        GRADE_SAMPLE_DISTANCE_METERS,

      search:
        'photon'
    })
  }
)

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  '127.0.0.1',
  () => {
    console.log('')
    console.log(
      'Comfort Walk server'
    )

    console.log(
      `http://127.0.0.1:${PORT}`
    )

    console.log('')

    console.log(
      'Routing: custom A*'
    )

    console.log(
      'Modes: Shortest / Balanced / Less Energy'
    )

    console.log(
      `Elevation smoothing: ${GRAPH_ELEVATION_SMOOTH_RADIUS_METERS} m`
    )

    console.log(
      `Grade sampling target: ${GRADE_SAMPLE_DISTANCE_METERS} m`
    )

    console.log('')
  }
)