import express from 'express'

const app = express()

const PORT = 8787

const METERS_PER_MILE = 1609.344

const WALKING_SPEED_METERS_PER_SECOND =
  1.35

const MAX_DIRECT_DISTANCE_METERS =
  12000

const PHOTON_URL =
  'https://photon.komoot.io/api/'

const OVERPASS_SERVERS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter'
]

const OVERPASS_USER_AGENT =
  'ComfortWalkStudentProject/1.0'

app.use(
  express.json({
    limit: '1mb'
  })
)

// ============================================================
// CACHE
// ============================================================

const graphCache =
  new Map()

const searchCache =
  new Map()

const MAX_GRAPH_CACHE_SIZE =
  8

const SEARCH_CACHE_TIME =
  5 * 60 * 1000

function getCachedSearch(
  key
) {
  const item =
    searchCache.get(key)

  if (!item) {
    return null
  }

  if (
    Date.now() -
      item.time >
    SEARCH_CACHE_TIME
  ) {
    searchCache.delete(key)

    return null
  }

  return item.data
}

function saveSearchCache(
  key,
  data
) {
  searchCache.set(
    key,
    {
      time: Date.now(),
      data
    }
  )

  while (
    searchCache.size >
    100
  ) {
    const firstKey =
      searchCache
        .keys()
        .next()
        .value

    searchCache.delete(
      firstKey
    )
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

function saveGraphCache(
  key,
  graph
) {
  graphCache.set(
    key,
    graph
  )

  while (
    graphCache.size >
    MAX_GRAPH_CACHE_SIZE
  ) {
    const firstKey =
      graphCache
        .keys()
        .next()
        .value

    graphCache.delete(
      firstKey
    )
  }
}

// ============================================================
// MATH
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

function haversineMeters(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const earthRadius =
    6371000

  const phi1 =
    toRadians(lat1)

  const phi2 =
    toRadians(lat2)

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
      Math.sqrt(1 - a)
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

// ============================================================
// PHOTON AUTOCOMPLETE
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
            OVERPASS_USER_AGENT
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
    data.features || []
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
        query.length <
        3
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

      const firstResults =
        await photonSearch(
          query,
          latitude,
          longitude,
          true
        )

      let features = [
        ...firstResults
      ]

      if (
        features.length <
        6
      ) {
        try {
          const backupResults =
            await photonSearch(
              query,
              latitude,
              longitude,
              false
            )

          features = [
            ...features,
            ...backupResults
          ]
        } catch (
          error
        ) {
          console.log(
            'Photon fallback failed:',
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

      const uniqueResults =
        []

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

        uniqueResults.push(
          item
        )

        if (
          uniqueResults.length >=
          10
        ) {
          break
        }
      }

      saveSearchCache(
        cacheKey,
        uniqueResults
      )

      return response.json(
        uniqueResults
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
            'Search service failed.'
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
      index >
      0
    ) {
      const parentIndex =
        Math.floor(
          (index - 1) /
          2
        )

      if (
        this.items[
          parentIndex
        ].priority <=
        this.items[
          index
        ].priority
      ) {
        break
      }

      const temporary =
        this.items[
          parentIndex
        ]

      this.items[
        parentIndex
      ] =
        this.items[
          index
        ]

      this.items[
        index
      ] =
        temporary

      index =
        parentIndex
    }
  }

  bubbleDown(
    index
  ) {
    while (true) {
      let smallest =
        index

      const left =
        index * 2 +
        1

      const right =
        index * 2 +
        2

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
// OVERPASS QUERY
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

// ============================================================
// OVERPASS FETCH
// ============================================================

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

      const response =
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
                OVERPASS_USER_AGENT
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

      const elapsed =
        Date.now() -
        started

      console.log(
        'Overpass status:',
        response.status,
        'time:',
        `${elapsed} ms`
      )

      if (
        !response.ok
      ) {
        const errorText =
          await response
            .text()

        console.log(
          'Overpass response:',
          errorText.slice(
            0,
            300
          )
        )

        throw new Error(
          `Overpass returned ${response.status}`
        )
      }

      const data =
        await response.json()

      console.log(
        'Overpass success:',
        server
      )

      return data
    } catch (
      error
    ) {
      clearTimeout(
        timeoutId
      )

      console.error(
        'Overpass attempt failed:',
        server,
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
          )
      }
    )
  }

  function addEdge(
    from,
    to,
    way
  ) {
    const fromNode =
      nodes.get(from)

    const toNode =
      nodes.get(to)

    if (
      !fromNode ||
      !toNode
    ) {
      return
    }

    const distance =
      haversineMeters(
        fromNode.lat,
        fromNode.lon,
        toNode.lat,
        toNode.lon
      )

    if (
      !Number.isFinite(
        distance
      ) ||
      distance <=
        0
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

        wayId:
          way.id,

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
    adjacency
  }
}

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

  const query =
    makeOverpassQuery(
      bounds
    )

  const started =
    Date.now()

  const osmData =
    await fetchOverpass(
      query
    )

  const graph =
    buildGraph(
      osmData
    )

  console.log(
    'Graph built:',
    graph.nodes.size,
    'nodes,',
    graph.adjacency.size,
    'connected nodes,',
    `${Date.now() - started} ms`
  )

  saveGraphCache(
    cacheKey,
    graph
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
// CUSTOM A*
// ============================================================

function aStar(
  graph,
  startNodeId,
  goalNodeId
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
      )
  })

  while (
    open.size >
    0
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
      const path =
        []

      let node =
        goalNodeId

      while (
        node !==
        undefined
      ) {
        path.push(
          node
        )

        if (
          node ===
          startNodeId
        ) {
          break
        }

        node =
          cameFrom.get(
            node
          )
      }

      path.reverse()

      return {
        path,

        distance:
          gScore.get(
            goalNodeId
          ),

        visitedNodes:
          closed.size +
          1
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

      const tentativeCost =
        currentCost +
        edge.distance

      const oldCost =
        gScore.get(
          edge.to
        ) ??
        Infinity

      if (
        tentativeCost >=
        oldCost
      ) {
        continue
      }

      cameFrom.set(
        edge.to,
        currentId
      )

      gScore.set(
        edge.to,
        tentativeCost
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
        )

      open.push({
        nodeId:
          edge.to,

        priority:
          tentativeCost +
          heuristic
      })
    }
  }

  return null
}

// ============================================================
// PATH TO COORDINATES
// ============================================================

function pathToCoordinates(
  graph,
  path
) {
  return path
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
}

// ============================================================
// ROUTE
// ============================================================

app.post(
  '/route',
  async (
    request,
    response
  ) => {
    const totalStart =
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

      let foundGraph =
        false

      let lastPathProblem =
        'No connected walking route found.'

      for (
        const paddingMeters
        of paddingOptions
      ) {
        console.log('')
        console.log(
          'ROUTE ATTEMPT:',
          `${paddingMeters} m padding`
        )

        let graph

        try {
          const bounds =
            makeBounds(
              start,
              end,
              paddingMeters
            )

          graph =
            await getWalkingGraph(
              bounds
            )

          foundGraph =
            true
        } catch (
          error
        ) {
          console.error(
            'Graph download failed:',
            error.message
          )

          continue
        }

        if (
          graph.adjacency.size ===
          0
        ) {
          lastPathProblem =
            'Walking graph was empty.'

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
          lastPathProblem =
            'Could not connect the locations to the street network.'

          continue
        }

        const algorithmStart =
          performance.now()

        const result =
          aStar(
            graph,
            nearestStart.nodeId,
            nearestEnd.nodeId
          )

        console.log(
          'A* time:',
          Math.round(
            performance.now() -
            algorithmStart
          ),
          'ms'
        )

        if (!result) {
          lastPathProblem =
            `No connected path with ${paddingMeters} m padding.`

          continue
        }

        const coordinates =
          pathToCoordinates(
            graph,
            result.path
          )

        if (
          coordinates.length <
          2
        ) {
          lastPathProblem =
            'Route geometry was empty.'

          continue
        }

        const miles =
          result.distance /
          METERS_PER_MILE

        const minutes =
          result.distance /
          WALKING_SPEED_METERS_PER_SECOND /
          60

        console.log(
          'ROUTE SUCCESS'
        )

        console.log(
          'Distance:',
          Math.round(
            result.distance
          ),
          'm'
        )

        console.log(
          'Coordinates:',
          coordinates.length
        )

        console.log(
          'Total time:',
          Date.now() -
            totalStart,
          'ms'
        )

        return response.json({
          algorithm:
            'A*',

          cost:
            'distance',

          paddingMeters,

          distanceMeters:
            Math.round(
              result.distance
            ),

          distanceMiles:
            Math.round(
              miles *
              100
            ) /
            100,

          minutes:
            Math.round(
              minutes *
              10
            ) /
            10,

          visitedNodes:
            result.visitedNodes,

          graphNodes:
            graph.nodes.size,

          snappedStartMeters:
            Math.round(
              nearestStart.distance
            ),

          snappedEndMeters:
            Math.round(
              nearestEnd.distance
            ),

          coordinates
        })
      }

      if (
        !foundGraph
      ) {
        return response
          .status(502)
          .json({
            error:
              'OpenStreetMap road data could not be downloaded.'
          })
      }

      return response
        .status(404)
        .json({
          error:
            lastPathProblem
        })
    } catch (
      error
    ) {
      console.error(
        'ROUTE SERVER ERROR:',
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

      search:
        'photon',

      overpassMirrors:
        OVERPASS_SERVERS.length
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
      'OSM query: bounding box'
    )
    console.log(
      'Overpass User-Agent: ON'
    )
    console.log('')
  }
)