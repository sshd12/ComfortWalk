import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import polyline from '@mapbox/polyline'
import 'maplibre-gl/dist/maplibre-gl.css'
import './App.css'

// ==========================================
// HELPERS
// ==========================================

function clamp(
  value,
  min = 0,
  max = 100
) {
  return Math.max(
    min,
    Math.min(max, value)
  )
}

function getRouteIcon(label) {
  if (label === 'Fastest') return '🚀'
  if (label === 'Balanced') return '⚖️'
  if (label === 'Comfort') return '🛡️'
  return '🚶'
}

function haversineMeters(
  lon1,
  lat1,
  lon2,
  lat2
) {
  const R = 6371000

  const p1 =
    lat1 * Math.PI / 180

  const p2 =
    lat2 * Math.PI / 180

  const dLat =
    (lat2 - lat1) *
    Math.PI /
    180

  const dLon =
    (lon2 - lon1) *
    Math.PI /
    180

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p1) *
      Math.cos(p2) *
      Math.sin(dLon / 2) ** 2

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  )
}

// ==========================================
// SEARCH NORMALIZATION
// ==========================================

function normalizeSearchText(
  text
) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(
        /[^\p{L}\p{N}]+/gu,
        ' '
      )
      .replace(
        /\s+/g,
        ' '
      )
      .trim()
  )
}

function expandSearchToken(
  token
) {
  const aliases = {
    sf: [
      'sf',
      'san',
      'francisco',
      'san francisco'
    ],

    s_f: [
      'sf',
      'san',
      'francisco',
      'san francisco'
    ],

    st: [
      'st',
      'saint'
    ],

    mt: [
      'mt',
      'mount'
    ],

    mart: [
      'mart',
      'market',
      'mart'
    ],

    ctr: [
      'ctr',
      'center',
      'centre'
    ]
  }

  return (
    aliases[token] || [
      token
    ]
  )
}

function tokenMatches(
  queryToken,
  text
) {
  const normalizedText =
    normalizeSearchText(text)

  const words =
    normalizedText.split(' ')

  const alternatives =
    expandSearchToken(
      queryToken
    )

  for (
    const alternative
    of alternatives
  ) {
    const normalized =
      normalizeSearchText(
        alternative
      )

    if (!normalized) {
      continue
    }

    if (
      normalizedText.includes(
        normalized
      )
    ) {
      return true
    }

    const altWords =
      normalized.split(' ')

    const allWordsMatch =
      altWords.every(
        word =>
          words.some(
            textWord =>
              textWord === word ||
              textWord.startsWith(word)
          )
      )

    if (
      allWordsMatch
    ) {
      return true
    }
  }

  return false
}

function searchMatchScore(
  query,
  place
) {
  const queryNormalized =
    normalizeSearchText(
      query
    )

  if (
    !queryNormalized
  ) {
    return {
      matched: false,
      score: 999
    }
  }

  const queryTokens =
    queryNormalized
      .split(' ')
      .filter(Boolean)

  const name =
    normalizeSearchText(
      place._searchName
    )

  const searchableText =
    normalizeSearchText(
      place._searchText
    )

  const nameWords =
    name.split(' ')

  let matchedTokens =
    0

  let exactTokenMatches =
    0

  let prefixTokenMatches =
    0

  for (
    const token
    of queryTokens
  ) {
    const alternatives =
      expandSearchToken(
        token
      )

    let tokenMatched =
      false

    let exact =
      false

    let prefix =
      false

    for (
      const alternative
      of alternatives
    ) {
      const normalizedAlternative =
        normalizeSearchText(
          alternative
        )

      if (!normalizedAlternative) {
        continue
      }

      const alternativeWords =
        normalizedAlternative
          .split(' ')

      // Exact phrase
      if (
        name ===
        normalizedAlternative
      ) {
        tokenMatched = true
        exact = true
        break
      }

      // Phrase contained in name
      if (
        name.includes(
          normalizedAlternative
        )
      ) {
        tokenMatched = true
        break
      }

      for (
        const alternativeWord
        of alternativeWords
      ) {
        const exactWord =
          nameWords.some(
            word =>
              word ===
              alternativeWord
          )

        const prefixWord =
          nameWords.some(
            word =>
              word.startsWith(
                alternativeWord
              )
          )

        if (
          exactWord
        ) {
          tokenMatched = true
          exact = true
        } else if (
          prefixWord
        ) {
          tokenMatched = true
          prefix = true
        }
      }

      if (
        tokenMatched
      ) {
        break
      }
    }

    // Also search the complete searchable text.
    if (
      !tokenMatched &&
      tokenMatches(
        token,
        searchableText
      )
    ) {
      tokenMatched = true
    }

    if (
      tokenMatched
    ) {
      matchedTokens++

      if (exact) {
        exactTokenMatches++
      }

      if (prefix) {
        prefixTokenMatches++
      }
    }
  }

  if (
    matchedTokens <
    queryTokens.length
  ) {
    return {
      matched: false,
      score: 999
    }
  }

  let score = 100

  // Full name exact match
  if (
    name ===
    queryNormalized
  ) {
    score -= 60
  }

  // Entire query appears in name
  if (
    name.includes(
      queryNormalized
    )
  ) {
    score -= 30
  }

  score -=
    exactTokenMatches * 8

  score -=
    prefixTokenMatches * 4

  // Shorter names get a small preference
  score +=
    Math.max(
      0,
      nameWords.length -
        queryTokens.length
    ) *
    1.5

  return {
    matched: true,
    score
  }
}

// ==========================================
// APP
// ==========================================

function App() {
  const mapContainer =
    useRef(null)

  const mapRef =
    useRef(null)

  const locationMarkerRef =
    useRef(null)

  const destinationMarkerRef =
    useRef(null)

  const watchIdRef =
    useRef(null)

  const routeSvgRef =
    useRef(null)

  const routesRef =
    useRef([])

  const selectedRouteIndexRef =
    useRef(0)

  const poiCacheRef =
    useRef(new Map())

  const searchPlacesRef =
    useRef([])

  const searchPlacesLoadedRef =
    useRef(false)

  const searchPlacesCenterRef =
    useRef(null)

  const [search, setSearch] =
    useState('')

  const [
    suggestions,
    setSuggestions
  ] = useState([])

  const [
    searching,
    setSearching
  ] = useState(false)

  const [
    currentLocation,
    setCurrentLocation
  ] = useState(null)

  const [
    destination,
    setDestination
  ] = useState(null)

  const [
    route,
    setRoute
  ] = useState(null)

  const [
    routes,
    setRoutes
  ] = useState([])

  const [
    selectedRouteIndex,
    setSelectedRouteIndex
  ] = useState(0)

  const [
    routeLoading,
    setRouteLoading
  ] = useState(false)

  const [
    navigationStarted,
    setNavigationStarted
  ] = useState(false)

  // ==========================================
  // MAP
  // ==========================================

  useEffect(() => {
    if (
      !mapContainer.current
    ) {
      return
    }

    const map =
      new maplibregl.Map({
        container:
          mapContainer.current,

        style: {
          version: 8,

          sources: {
            osm: {
              type: 'raster',

              tiles: [
                'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
              ],

              tileSize: 256,

              attribution:
                '© OpenStreetMap contributors'
            }
          },

          layers: [
            {
              id: 'osm',
              type: 'raster',
              source: 'osm'
            }
          ]
        },

        center: [
          -122.4194,
          37.7749
        ],

        zoom: 13
      })

    mapRef.current =
      map

    const redrawRoutes =
      () => {
        if (
          routesRef.current.length >
          0
        ) {
          drawRoutes(
            routesRef.current,
            selectedRouteIndexRef.current
          )
        }
      }

    map.on(
      'move',
      redrawRoutes
    )

    map.on(
      'zoom',
      redrawRoutes
    )

    map.on(
      'resize',
      redrawRoutes
    )

    map.on(
      'load',
      () => {
        console.log(
          '🗺️ MAP LOADED'
        )

        redrawRoutes()
      }
    )

    map.on(
      'error',
      event => {
        console.error(
          'MAPLIBRE ERROR:',
          event
        )
      }
    )

    return () => {
      map.off(
        'move',
        redrawRoutes
      )

      map.off(
        'zoom',
        redrawRoutes
      )

      map.off(
        'resize',
        redrawRoutes
      )

      if (
        watchIdRef.current !==
        null
      ) {
        navigator.geolocation.clearWatch(
          watchIdRef.current
        )
      }

      map.remove()

      mapRef.current =
        null
    }
  }, [])

  // ==========================================
  // SEARCH PLACE NAME
  // ==========================================

  function getSearchPlaceName(
    place
  ) {
    const tags =
      place.tags || {}

    const candidates = [
      tags.name,
      tags['name:en'],
      tags['name:ko'],
      tags['name:zh'],
      tags.brand,
      tags['brand:en'],
      tags['brand:ko'],
      tags.operator,
      tags.alt_name,
      tags.short_name,
      place.name,
      place.brand,
      place.operator
    ]

    for (
      const candidate
      of candidates
    ) {
      if (
        typeof candidate ===
          'string' &&
        candidate.trim()
      ) {
        return candidate.trim()
      }
    }

    return 'Unnamed place'
  }

  // ==========================================
  // SEARCH ADDRESS
  // ==========================================

  function getSearchPlaceAddress(
    place
  ) {
    const tags =
      place.tags || {}

    if (
      tags['addr:housenumber'] &&
      tags['addr:street']
    ) {
      return `${tags['addr:housenumber']} ${tags['addr:street']}`
    }

    if (
      tags['addr:street']
    ) {
      return tags['addr:street']
    }

    if (
      tags['addr:city']
    ) {
      return tags['addr:city']
    }

    return (
      tags.shop ||
      tags.amenity ||
      tags.tourism ||
      ''
    )
  }

  // ==========================================
  // SEARCH CATEGORY
  // ==========================================

  function getSearchCategory(
    place
  ) {
    const tags =
      place.tags || {}

    const shop =
      (
        tags.shop ||
        ''
      ).toLowerCase()

    const amenity =
      (
        tags.amenity ||
        ''
      ).toLowerCase()

    const tourism =
      (
        tags.tourism ||
        ''
      ).toLowerCase()

    if (
      shop ===
      'supermarket'
    ) {
      return 'Supermarket'
    }

    if (
      shop ===
      'convenience'
    ) {
      return 'Convenience store'
    }

    if (
      shop ===
      'grocery'
    ) {
      return 'Grocery'
    }

    if (
      shop ===
      'greengrocer'
    ) {
      return 'Grocery'
    }

    if (
      shop ===
      'general'
    ) {
      return 'General store'
    }

    if (
      shop
    ) {
      return shop
    }

    if (
      amenity
    ) {
      return amenity
    }

    if (
      tourism
    ) {
      return tourism
    }

    return ''
  }

  // ==========================================
  // OVERPASS
  // ==========================================

  async function fetchOverpass(
    query
  ) {
    const encoded =
      encodeURIComponent(
        query
      )

    try {
      const response =
        await fetch(
          '/overpass/api/interpreter',
          {
            method:
              'POST',

            headers: {
              'Content-Type':
                'application/x-www-form-urlencoded'
            },

            body:
              `data=${encoded}`
          }
        )

      if (
        response.ok
      ) {
        return await response.json()
      }

      console.warn(
        'OVERPASS POST FAILED:',
        response.status
      )
    } catch (
      error
    ) {
      console.warn(
        'OVERPASS POST ERROR:',
        error
      )
    }

    const response =
      await fetch(
        `/overpass/api/interpreter?data=${encoded}`
      )

    if (
      !response.ok
    ) {
      throw new Error(
        `Overpass failed: ${response.status}`
      )
    }

    return await response.json()
  }

  // ==========================================
  // PRELOAD SEARCH PLACES
  // ==========================================

  async function preloadNearbyPlaces(
    latitude,
    longitude
  ) {
    if (
      searchPlacesLoadedRef.current &&
      searchPlacesCenterRef.current
    ) {
      const [
        oldLat,
        oldLon
      ] =
        searchPlacesCenterRef.current

      const moved =
        haversineMeters(
          oldLon,
          oldLat,
          longitude,
          latitude
        )

      if (
        moved < 2000
      ) {
        return
      }
    }

    try {
      console.log(
        '🔎 Loading nearby search places...'
      )

      setSearching(
        search.trim().length > 0
      )

      const query = `
[out:json][timeout:25];

(
  nwr["name"](
    around:10000,
    ${latitude},
    ${longitude}
  );

  nwr["brand"](
    around:10000,
    ${latitude},
    ${longitude}
  );

  nwr["shop"](
    around:10000,
    ${latitude},
    ${longitude}
  );

  nwr["amenity"](
    around:10000,
    ${latitude},
    ${longitude}
  );

  nwr["tourism"](
    around:10000,
    ${latitude},
    ${longitude}
  );

  nwr["leisure"](
    around:10000,
    ${latitude},
    ${longitude}
  );

  nwr["public_transport"](
    around:10000,
    ${latitude},
    ${longitude}
  );

  nwr["office"](
    around:10000,
    ${latitude},
    ${longitude}
  );

  nwr["craft"](
    around:10000,
    ${latitude},
    ${longitude}
  );

  nwr["healthcare"](
    around:10000,
    ${latitude},
    ${longitude}
  );
);

out center tags;
`

      const data =
        await fetchOverpass(
          query
        )

      const seen =
        new Set()

      const places =
        (
          data.elements ||
          []
        )
          .map(
            place => {
              let lon = null
              let lat = null

              if (
                place.type ===
                'node'
              ) {
                lon =
                  Number(
                    place.lon
                  )

                lat =
                  Number(
                    place.lat
                  )
              } else if (
                place.center
              ) {
                lon =
                  Number(
                    place.center.lon
                  )

                lat =
                  Number(
                    place.center.lat
                  )
              }

              if (
                !Number.isFinite(
                  lon
                ) ||
                !Number.isFinite(
                  lat
                )
              ) {
                return null
              }

              const key =
                `${place.type}:${place.id}`

              if (
                seen.has(
                  key
                )
              ) {
                return null
              }

              seen.add(
                key
              )

              const tags =
                place.tags ||
                {}

              const name =
                getSearchPlaceName(
                  place
                )

              const searchableText =
                [
                  name,
                  tags['name:en'],
                  tags['name:ko'],
                  tags['name:zh'],
                  tags.brand,
                  tags['brand:en'],
                  tags['brand:ko'],
                  tags.operator,
                  tags.alt_name,
                  tags.short_name,
                  tags.shop,
                  tags.amenity,
                  tags.tourism,
                  tags.craft,
                  tags.healthcare,
                  tags['addr:street'],
                  tags['addr:city']
                ]
                  .filter(
                    value =>
                      typeof value ===
                        'string' &&
                      value.trim()
                  )
                  .join(' ')
                  .toLowerCase()

              const shop =
                (
                  tags.shop ||
                  ''
                ).toLowerCase()

              let shopBonus =
                0

              if (
                shop ===
                  'supermarket' ||
                shop ===
                  'convenience' ||
                shop ===
                  'grocery' ||
                shop ===
                  'greengrocer' ||
                shop ===
                  'general'
              ) {
                shopBonus =
                  -1
              }

              return {
                ...place,

                _lon:
                  lon,

                _lat:
                  lat,

                _searchName:
                  name,

                _searchText:
                  searchableText,

                _shopBonus:
                  shopBonus
              }
            }
          )
          .filter(
            Boolean
          )

      searchPlacesRef.current =
        places

      searchPlacesLoadedRef.current =
        true

      searchPlacesCenterRef.current =
        [
          latitude,
          longitude
        ]

      console.log(
        '✅ SEARCH PLACES LOADED:',
        places.length
      )

      updateLocalSuggestions(
        search,
        places
      )
    } catch (
      error
    ) {
      console.error(
        'SEARCH PLACE LOAD ERROR:',
        error
      )
    } finally {
      setSearching(false)
    }
  }

  // ==========================================
  // LOCAL AUTOCOMPLETE
  // ==========================================

  function updateLocalSuggestions(
    rawQuery,
    places =
      searchPlacesRef.current
  ) {
    const query =
      rawQuery.trim()

    if (
      query.length === 0
    ) {
      setSuggestions([])
      return
    }

    if (
      places.length === 0
    ) {
      setSuggestions([])
      return
    }

    const ranked =
      places
        .map(
          place => {
            const match =
              searchMatchScore(
                query,
                place
              )

            if (
              !match.matched
            ) {
              return null
            }

            const distance =
              currentLocation
                ? haversineMeters(
                    currentLocation.longitude,
                    currentLocation.latitude,
                    place._lon,
                    place._lat
                  )
                : Infinity

            return {
              ...place,

              _distanceMeters:
                distance,

              _searchScore:
                match.score
            }
          }
        )
        .filter(
          Boolean
        )
        .sort(
          (
            a,
            b
          ) => {
            // Name quality first
            if (
              a._searchScore !==
              b._searchScore
            ) {
              return (
                a._searchScore -
                b._searchScore
              )
            }

            // Then nearby
            return (
              a._distanceMeters -
              b._distanceMeters
            )
          }
        )
        .slice(
          0,
          8
        )

    console.log(
      '🔍 AUTOCOMPLETE:',
      query,
      ranked.map(
        place => ({
          name:
            place._searchName,
          distance:
            place._distanceMeters
        })
      )
    )

    setSuggestions(
      ranked
    )
  }

  // ==========================================
  // SEARCH EFFECT
  // ==========================================

  useEffect(() => {
    updateLocalSuggestions(
      search
    )
  }, [
    search,
    currentLocation
  ])

  // ==========================================
  // GPS
  // ==========================================

  function startLocationTracking() {
    if (
      !navigator.geolocation
    ) {
      alert(
        'Geolocation is not supported by this browser.'
      )

      return
    }

    if (
      watchIdRef.current !==
      null
    ) {
      navigator.geolocation.clearWatch(
        watchIdRef.current
      )
    }

    watchIdRef.current =
      navigator.geolocation.watchPosition(
        position => {
          const longitude =
            position.coords.longitude

          const latitude =
            position.coords.latitude

          const heading =
            position.coords.heading

          const location = {
            longitude,
            latitude,
            heading
          }

          setCurrentLocation(
            location
          )

          updateLocationMarker(
            longitude,
            latitude,
            heading
          )

          preloadNearbyPlaces(
            latitude,
            longitude
          )
        },

        error => {
          console.error(
            'Location error:',
            error
          )

          if (
            error.code ===
            1
          ) {
            alert(
              'Please allow location access.'
            )
          }
        },

        {
          enableHighAccuracy:
            true,

          maximumAge:
            1000,

          timeout:
            15000
        }
      )
  }

  // ==========================================
  // LOCATION MARKER
  // ==========================================

  function updateLocationMarker(
    longitude,
    latitude,
    heading
  ) {
    const map =
      mapRef.current

    if (
      !map
    ) {
      return
    }

    if (
      !locationMarkerRef.current
    ) {
      const element =
        document.createElement(
          'div'
        )

      element.className =
        'location-marker'

      element.innerHTML = `
        <div class="heading-arrow"></div>
        <div class="location-dot"></div>
      `

      locationMarkerRef.current =
        new maplibregl.Marker({
          element
        })
          .setLngLat([
            longitude,
            latitude
          ])
          .addTo(map)
    } else {
      locationMarkerRef.current
        .setLngLat([
          longitude,
          latitude
        ])
    }

    if (
      heading !== null &&
      heading !== undefined &&
      !Number.isNaN(
        heading
      )
    ) {
      const arrow =
        locationMarkerRef.current
          .getElement()
          .querySelector(
            '.heading-arrow'
          )

      if (
        arrow
      ) {
        arrow.style.transform =
          `translateX(-50%) rotate(${heading}deg)`
      }
    }
  }

  // ==========================================
  // SELECT DESTINATION
  // ==========================================

  async function selectDestination(
    place
  ) {
    const destinationPoint = {
      longitude:
        Number(
          place._lon ??
          place.lon
        ),

      latitude:
        Number(
          place._lat ??
          place.lat
        )
    }

    if (
      !Number.isFinite(
        destinationPoint.longitude
      ) ||
      !Number.isFinite(
        destinationPoint.latitude
      )
    ) {
      console.error(
        'INVALID DESTINATION:',
        place
      )

      return
    }

    const name =
      place._searchName ||
      getSearchPlaceName(
        place
      )

    const newDestination = {
      ...destinationPoint,
      name
    }

    setDestination(
      newDestination
    )

    setSearch(
      name
    )

    setSuggestions(
      []
    )

    routesRef.current =
      []

    selectedRouteIndexRef.current =
      0

    setRoutes([])
    setRoute(null)

    setSelectedRouteIndex(
      0
    )

    const map =
      mapRef.current

    if (
      !map
    ) {
      return
    }

    if (
      destinationMarkerRef.current
    ) {
      destinationMarkerRef.current.remove()
    }

    destinationMarkerRef.current =
      new maplibregl.Marker({
        color:
          '#FF3B30'
      })
        .setLngLat([
          destinationPoint.longitude,
          destinationPoint.latitude
        ])
        .addTo(map)

    if (
      !currentLocation
    ) {
      startLocationTracking()

      alert(
        'Getting your current location... Click My location first, then search again.'
      )

      return
    }

    await getWalkingRoutes(
      currentLocation,
      destinationPoint
    )
  }

  // ==========================================
  // VALHALLA ROUTES
  // ==========================================

  async function getWalkingRoutes(
    start,
    end
  ) {
    if (
      !start ||
      !end
    ) {
      return
    }

    setRouteLoading(
      true
    )

    try {
      const response =
        await fetch(
          '/valhalla/route',
          {
            method:
              'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                locations: [
                  {
                    lat:
                      start.latitude,

                    lon:
                      start.longitude
                  },

                  {
                    lat:
                      end.latitude,

                    lon:
                      end.longitude
                  }
                ],

                costing:
                  'pedestrian',

                units:
                  'miles',

                shape_format:
                  'polyline6',

                alternates:
                  2
              })
          }
        )

      const text =
        await response.text()

      console.log(
        'VALHALLA STATUS:',
        response.status
      )

      console.log(
        'VALHALLA RESPONSE:',
        text
      )

      if (
        !response.ok
      ) {
        throw new Error(
          `Valhalla returned ${response.status}: ${text}`
        )
      }

      const data =
        JSON.parse(
          text
        )

      if (
        !data.trip
      ) {
        throw new Error(
          'Valhalla did not return a main route.'
        )
      }

      const trips = [
        data.trip,

        ...(
          Array.isArray(
            data.alternates
          )
            ? data.alternates
                .map(
                  item =>
                    item.trip
                )
                .filter(
                  Boolean
                )
            : []
        )
      ]

      console.log(
        'NUMBER OF ROUTES:',
        trips.length
      )

      const convertedRoutes =
        trips
          .map(
            (
              trip,
              index
            ) => {
              const shape =
                trip
                  .legs?.[0]
                  ?.shape

              if (
                !shape
              ) {
                return null
              }

              try {
                const decoded =
                  polyline.decode(
                    shape,
                    6
                  )

                const coordinates =
                  decoded.map(
                    ([lat, lon]) => [
                      lon,
                      lat
                    ]
                  )

                const validCoordinates =
                  coordinates.filter(
                    (
                      [lon, lat]
                    ) =>
                      Number.isFinite(
                        lon
                      ) &&
                      Number.isFinite(
                        lat
                      ) &&
                      lon >= -180 &&
                      lon <= 180 &&
                      lat >= -90 &&
                      lat <= 90
                  )

                if (
                  validCoordinates.length <
                  2
                ) {
                  return null
                }

                const summary =
                  trip.summary

                return {
                  originalIndex:
                    index,

                  geojson: {
                    type:
                      'Feature',

                    properties:
                      {},

                    geometry: {
                      type:
                        'LineString',

                      coordinates:
                        validCoordinates
                    }
                  },

                  miles:
                    summary.length,

                  minutes:
                    summary.time /
                    60,

                  maneuvers:
                    trip
                      .legs[0]
                      .maneuvers
                }
              } catch (
                error
              ) {
                console.error(
                  'ROUTE CONVERSION ERROR:',
                  error
                )

                return null
              }
            }
          )
          .filter(
            Boolean
          )

      if (
        convertedRoutes.length ===
        0
      ) {
        throw new Error(
          'No usable routes were returned.'
        )
      }

      const scoredRoutes =
        await scoreRoutes(
          convertedRoutes
        )

      routesRef.current =
        scoredRoutes

      selectedRouteIndexRef.current =
        0

      setRoutes(
        scoredRoutes
      )

      setSelectedRouteIndex(
        0
      )

      setRoute(
        scoredRoutes[0]
      )

      drawRoutes(
        scoredRoutes,
        0
      )

      fitRoute(
        scoredRoutes[0]
          .geojson
      )
    } catch (
      error
    ) {
      console.error(
        'WALKING ROUTE ERROR:',
        error
      )

      alert(
        `Could not calculate walking directions.\n\n${error.message}`
      )
    } finally {
      setRouteLoading(
        false
      )
    }
  }

  // ==========================================
  // ROUTE BBOX
  // ==========================================

  function getRouteBBox(
    coordinates,
    paddingMeters = 150
  ) {
    let minLon =
      Infinity

    let minLat =
      Infinity

    let maxLon =
      -Infinity

    let maxLat =
      -Infinity

    for (
      const [lon, lat]
      of coordinates
    ) {
      minLon =
        Math.min(
          minLon,
          lon
        )

      minLat =
        Math.min(
          minLat,
          lat
        )

      maxLon =
        Math.max(
          maxLon,
          lon
        )

      maxLat =
        Math.max(
          maxLat,
          lat
        )
    }

    const midLat =
      (
        minLat +
        maxLat
      ) /
      2

    const latPadding =
      paddingMeters /
      111000

    const lonPadding =
      paddingMeters /
      (
        111000 *
        Math.max(
          Math.cos(
            midLat *
              Math.PI /
              180
          ),
          0.1
        )
      )

    return {
      south:
        minLat -
        latPadding,

      west:
        minLon -
        lonPadding,

      north:
        maxLat +
        latPadding,

      east:
        maxLon +
        lonPadding
    }
  }

  // ==========================================
  // POI POSITION
  // ==========================================

  function getPoiPosition(
    element
  ) {
    if (
      Number.isFinite(
        element._lon
      ) &&
      Number.isFinite(
        element._lat
      )
    ) {
      return [
        element._lon,
        element._lat
      ]
    }

    if (
      element.type ===
      'node'
    ) {
      return [
        Number(
          element.lon
        ),
        Number(
          element.lat
        )
      ]
    }

    if (
      element.center
    ) {
      return [
        Number(
          element.center.lon
        ),
        Number(
          element.center.lat
        )
      ]
    }

    return null
  }

  // ==========================================
  // GET ROUTE POIS
  // ==========================================

  async function getRoutePOIs(
    coordinates
  ) {
    const bbox =
      getRouteBBox(
        coordinates,
        150
      )

    const cacheKey =
      [
        bbox.south.toFixed(3),
        bbox.west.toFixed(3),
        bbox.north.toFixed(3),
        bbox.east.toFixed(3)
      ].join(',')

    const cached =
      poiCacheRef.current.get(
        cacheKey
      )

    if (
      cached
    ) {
      return cached
    }

    const query = `
[out:json][timeout:25];

(
  nwr["name"](
    ${bbox.south},
    ${bbox.west},
    ${bbox.north},
    ${bbox.east}
  );

  nwr["brand"](
    ${bbox.south},
    ${bbox.west},
    ${bbox.north},
    ${bbox.east}
  );
);

out center tags;
`

    const data =
      await fetchOverpass(
        query
      )

    const elements =
      data.elements ||
      []

    const seen =
      new Set()

    const normalized =
      elements
        .map(
          element => {
            const position =
              getPoiPosition(
                element
              )

            if (
              !position
            ) {
              return null
            }

            const key =
              `${element.type}:${element.id}`

            if (
              seen.has(key)
            ) {
              return null
            }

            seen.add(key)

            return {
              ...element,

              _lon:
                position[0],

              _lat:
                position[1]
            }
          }
        )
        .filter(
          Boolean
        )

    console.log(
      '📍 ROUTE POIS:',
      normalized.length
    )

    poiCacheRef.current.set(
      cacheKey,
      normalized
    )

    return normalized
  }

  // ==========================================
  // POI PRESENCE
  // ==========================================

  async function calculateStreetPresence(
    routeItem,
    allPOIs
  ) {
    const coordinates =
      routeItem
        .geojson
        .geometry
        .coordinates

    const routeMiles =
      Math.max(
        routeItem.miles,
        0.1
      )

    let nearbyPoiCount =
      0

    const seen =
      new Set()

    for (
      const poi
      of allPOIs
    ) {
      const position =
        getPoiPosition(
          poi
        )

      if (
        !position
      ) {
        continue
      }

      let nearest =
        Infinity

      for (
        let i = 0;
        i <
          coordinates.length;
        i += 4
      ) {
        const distance =
          haversineMeters(
            position[0],
            position[1],
            coordinates[i][0],
            coordinates[i][1]
          )

        if (
          distance <
          nearest
        ) {
          nearest =
            distance
        }

        if (
          nearest <=
          100
        ) {
          break
        }
      }

      if (
        nearest <=
        100
      ) {
        const id =
          `${poi.type}:${poi.id}`

        if (
          !seen.has(
            id
          )
        ) {
          seen.add(
            id
          )

          nearbyPoiCount++
        }
      }
    }

    const density =
      nearbyPoiCount /
      routeMiles

    const score =
      clamp(
        (
          density /
          8
        ) *
          100
      )

    return {
      score:
        Math.round(
          score
        ),

      poiCount:
        nearbyPoiCount,

      poiDensity:
        Math.round(
          density * 10
        ) /
        10
    }
  }

  // ==========================================
  // SCORE ROUTES
  // ==========================================

  async function scoreRoutes(
    routeList
  ) {
    if (
      routeList.length ===
      0
    ) {
      return []
    }

    const allCoordinates =
      routeList.flatMap(
        route =>
          route
            .geojson
            .geometry
            .coordinates
      )

    let allPOIs =
      []

    try {
      allPOIs =
        await getRoutePOIs(
          allCoordinates
        )
    } catch (
      error
    ) {
      console.error(
        '❌ POI LOOKUP FAILED:',
        error
      )
    }

    console.log(
      '📊 TOTAL POIS:',
      allPOIs.length
    )

    const fastestTime =
      Math.min(
        ...routeList.map(
          route =>
            route.minutes
        )
      )

    const shortestDistance =
      Math.min(
        ...routeList.map(
          route =>
            route.miles
        )
      )

    const scored =
      await Promise.all(
        routeList.map(
          async routeItem => {
            const maneuvers =
              routeItem.maneuvers ||
              []

            const turnCount =
              maneuvers.filter(
                maneuver =>
                  /turn/i.test(
                    maneuver.instruction ||
                    ''
                  )
              ).length

            const maxTurns =
              Math.max(
                ...routeList.map(
                  route =>
                    (
                      route.maneuvers ||
                      []
                    ).filter(
                      maneuver =>
                        /turn/i.test(
                          maneuver.instruction ||
                          ''
                        )
                    ).length
                ),
                1
              )

            const turnScore =
              clamp(
                100 -
                  (
                    turnCount /
                    maxTurns
                  ) *
                    60
              )

            let majorRoadCount =
              0

            let namedStreetCount =
              0

            for (
              const maneuver
              of maneuvers
            ) {
              const names =
                maneuver.street_names ||
                []

              if (
                names.length >
                0
              ) {
                namedStreetCount++
              }

              const text =
                names
                  .join(' ')
                  .toLowerCase()

              if (
                /\bus\s?\d+/i.test(
                  text
                ) ||
                /\bstate route\b/i.test(
                  text
                ) ||
                /\bhighway\b/i.test(
                  text
                ) ||
                /\bfreeway\b/i.test(
                  text
                ) ||
                /\binterstate\b/i.test(
                  text
                )
              ) {
                majorRoadCount++
              }
            }

            const maneuverCount =
              Math.max(
                maneuvers.length,
                1
              )

            const majorRoadRatio =
              majorRoadCount /
              maneuverCount

            const roadEnvironmentScore =
              clamp(
                100 -
                  majorRoadRatio *
                    100
              )

            const namedRatio =
              namedStreetCount /
              maneuverCount

            const streetTypeScore =
              clamp(
                55 +
                  namedRatio *
                    45 -
                  majorRoadRatio *
                    35
              )

            let poiPresence

            try {
              poiPresence =
                await calculateStreetPresence(
                  routeItem,
                  allPOIs
                )
            } catch {
              poiPresence = {
                score:
                  allPOIs.length >
                    0
                    ? 50
                    : 0,

                poiCount:
                  0,

                poiDensity:
                  0
              }
            }

            const crossingCount =
              maneuvers.filter(
                maneuver =>
                  /cross|crossing|intersection/i.test(
                    maneuver.instruction ||
                    ''
                  )
              ).length

            const maxCrossings =
              Math.max(
                ...routeList.map(
                  route =>
                    (
                      route.maneuvers ||
                      []
                    ).filter(
                      maneuver =>
                        /cross|crossing|intersection/i.test(
                          maneuver.instruction ||
                          ''
                        )
                    ).length
                ),
                1
              )

            const crossingScore =
              clamp(
                100 -
                  (
                    crossingCount /
                    maxCrossings
                  ) *
                    60
              )

            const detourScore =
              clamp(
                (
                  shortestDistance /
                  Math.max(
                    routeItem.miles,
                    0.001
                  )
                ) *
                  100
              )

            const timeScore =
              clamp(
                (
                  fastestTime /
                  Math.max(
                    routeItem.minutes,
                    0.001
                  )
                ) *
                  100
              )

            const comfortScore =
              0.25 *
                poiPresence.score +
              0.20 *
                streetTypeScore +
              0.15 *
                roadEnvironmentScore +
              0.15 *
                crossingScore +
              0.10 *
                turnScore +
              0.10 *
                detourScore +
              0.05 *
                timeScore

            return {
              ...routeItem,

              score: {
                comfort:
                  Math.round(
                    clamp(
                      comfortScore
                    ) *
                      10
                  ) /
                  10,

                streetPresence:
                  poiPresence.score,

                poiCount:
                  poiPresence.poiCount,

                poiDensity:
                  poiPresence.poiDensity,

                streetType:
                  Math.round(
                    streetTypeScore
                  ),

                roadEnvironment:
                  Math.round(
                    roadEnvironmentScore
                  ),

                crossings:
                  Math.round(
                    crossingScore
                  ),

                turns:
                  Math.round(
                    turnScore
                  ),

                detour:
                  Math.round(
                    detourScore
                  ),

                travelTime:
                  Math.round(
                    timeScore
                  ),

                turnCount,

                crossingCount,

                majorRoadCount
              }
            }
          }
        )
      )

    const fastestIndex =
      scored.reduce(
        (
          bestIndex,
          item,
          index,
          array
        ) =>
          item.minutes <
          array[
            bestIndex
          ].minutes
            ? index
            : bestIndex,
        0
      )

    let comfortIndex =
      scored.reduce(
        (
          bestIndex,
          item,
          index,
          array
        ) =>
          item.score.comfort >
          array[
            bestIndex
          ].score.comfort
            ? index
            : bestIndex,
        0
      )

    if (
      comfortIndex ===
        fastestIndex &&
      scored.length >
        1
    ) {
      const candidates =
        scored
          .map(
            (_, index) =>
              index
          )
          .filter(
            index =>
              index !==
              fastestIndex
          )

      comfortIndex =
        candidates.reduce(
          (
            bestIndex,
            index
          ) =>
            scored[
              index
            ].score.comfort >
            scored[
              bestIndex
            ].score.comfort
              ? index
              : bestIndex,
          candidates[0]
        )
    }

    const balancedValues =
      scored.map(
        item =>
          0.50 *
            item.score.travelTime +
          0.50 *
            item.score.comfort
      )

    const balancedCandidates =
      scored
        .map(
          (_, index) =>
            index
        )
        .filter(
          index =>
            index !==
              fastestIndex &&
            index !==
              comfortIndex
        )

    let balancedIndex

    if (
      balancedCandidates.length >
      0
    ) {
      balancedIndex =
        balancedCandidates.reduce(
          (
            bestIndex,
            index
          ) =>
            balancedValues[
              index
            ] >
            balancedValues[
              bestIndex
            ]
              ? index
              : bestIndex,
          balancedCandidates[0]
        )
    } else {
      balancedIndex =
        fastestIndex
    }

    return scored.map(
      (
        item,
        index
      ) => ({
        ...item,

        label:
          index === fastestIndex
            ? 'Fastest'
            : index === balancedIndex
              ? 'Balanced'
              : index === comfortIndex
                ? 'Comfort'
                : `Route ${
                    index + 1
                  }`
      })
    )
  }

  // ==========================================
  // DRAW ROUTES
  // ==========================================

  function drawRoutes(
    routeList,
    selectedIndex
  ) {
    const map =
      mapRef.current

    const svg =
      routeSvgRef.current

    if (
      !map ||
      !svg
    ) {
      return
    }

    if (
      !routeList ||
      routeList.length ===
        0
    ) {
      svg.innerHTML =
        ''

      return
    }

    const width =
      map
        .getContainer()
        .clientWidth

    const height =
      map
        .getContainer()
        .clientHeight

    svg.setAttribute(
      'width',
      width
    )

    svg.setAttribute(
      'height',
      height
    )

    svg.setAttribute(
      'viewBox',
      `0 0 ${width} ${height}`
    )

    const colors = [
      '#007AFF',
      '#34C759',
      '#AF52DE'
    ]

    const lines =
      routeList
        .map(
          (
            routeItem,
            index
          ) => {
            const coordinates =
              routeItem
                .geojson
                .geometry
                .coordinates

            const points =
              coordinates
                .map(
                  ([lon, lat]) => {
                    const point =
                      map.project([
                        lon,
                        lat
                      ])

                    return `${point.x},${point.y}`
                  }
                )
                .join(' ')

            const selected =
              index ===
              selectedIndex

            const color =
              colors[index] ||
              '#007AFF'

            return `
              ${
                selected
                  ? `
                    <polyline
                      points="${points}"
                      fill="none"
                      stroke="white"
                      stroke-width="15"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      opacity="0.95"
                    />
                  `
                  : ''
              }

              <polyline
                points="${points}"
                fill="none"
                stroke="${color}"
                stroke-width="${
                  selected
                    ? 9
                    : 6
                }"
                stroke-linecap="round"
                stroke-linejoin="round"
                opacity="${
                  selected
                    ? 1
                    : 0.45
                }"
              />
            `
          }
        )
        .join('')

    svg.innerHTML =
      lines

    svg.style.display =
      'block'
  }

  // ==========================================
  // SELECT ROUTE
  // ==========================================

  function selectRoute(
    index
  ) {
    const selected =
      routesRef.current[index]

    if (
      !selected
    ) {
      return
    }

    selectedRouteIndexRef.current =
      index

    setSelectedRouteIndex(
      index
    )

    setRoute(
      selected
    )

    drawRoutes(
      routesRef.current,
      index
    )

    fitRoute(
      selected.geojson
    )
  }

  // ==========================================
  // FIT ROUTE
  // ==========================================

  function fitRoute(
    geojson
  ) {
    const map =
      mapRef.current

    if (
      !map
    ) {
      return
    }

    const coordinates =
      geojson?.geometry?.coordinates

    if (
      !coordinates ||
      coordinates.length <
        2
    ) {
      return
    }

    const bounds =
      new maplibregl
        .LngLatBounds()

    coordinates.forEach(
      ([lon, lat]) => {
        if (
          Number.isFinite(
            lon
          ) &&
          Number.isFinite(
            lat
          )
        ) {
          bounds.extend([
            lon,
            lat
          ])
        }
      }
    )

    map.fitBounds(
      bounds,
      {
        padding: {
          top: 160,
          bottom: 300,
          left: 50,
          right: 50
        },

        maxZoom: 16,

        duration: 800
      }
    )
  }

  // ==========================================
  // START NAVIGATION
  // ==========================================

  function startNavigation() {
    if (
      !currentLocation ||
      !destination ||
      !route
    ) {
      return
    }

    setNavigationStarted(
      true
    )

    const map =
      mapRef.current

    if (
      !map
    ) {
      return
    }

    map.flyTo({
      center: [
        currentLocation.longitude,
        currentLocation.latitude
      ],

      zoom: 17,

      duration: 1000
    })
  }

  // ==========================================
  // STOP NAVIGATION
  // ==========================================

  function stopNavigation() {
    setNavigationStarted(
      false
    )

    drawRoutes(
      routesRef.current,
      selectedRouteIndexRef.current
    )
  }

  // ==========================================
  // PLACE NAME
  // ==========================================

  function getPlaceName(
    place
  ) {
    const address =
      place.address ||
      {}

    const names =
      place.namedetails ||
      {}

    const candidates = [
      names.name,
      names['name:en'],
      names['name:ko'],
      names['name:zh'],
      names.brand,
      names.operator,
      names.alt_name,
      place.name,
      place.brand,
      place.operator
    ]

    for (
      const candidate
      of candidates
    ) {
      if (
        typeof candidate ===
          'string' &&
        candidate.trim() &&
        !/^\d+$/.test(
          candidate.trim()
        )
      ) {
        return candidate.trim()
      }
    }

    if (
      address.amenity
    ) {
      return address.amenity
    }

    if (
      address.shop
    ) {
      return address.shop
    }

    if (
      address.tourism
    ) {
      return address.tourism
    }

    if (
      address.house_number &&
      address.road
    ) {
      return `${address.house_number} ${address.road}`
    }

    return (
      address.road ||
      place.display_name
        ?.split(',')
        .slice(0, 2)
        .join(', ') ||
      'Unnamed place'
    )
  }

  // ==========================================
  // ADDRESS
  // ==========================================

  function getAddress(
    place
  ) {
    const address =
      place.address ||
      {}

    if (
      address.house_number &&
      address.road
    ) {
      return `${address.house_number} ${address.road}`
    }

    if (
      address.road
    ) {
      return address.road
    }

    return (
      place.display_name
        ?.split(',')
        .slice(1, 3)
        .join(',')
        .trim() ||
      ''
    )
  }

  // ==========================================
  // DISTANCE
  // ==========================================

  function formatDistance(
    meters
  ) {
    if (
      !Number.isFinite(
        meters
      )
    ) {
      return ''
    }

    if (
      meters < 1609
    ) {
      return `${Math.round(
        meters
      )} ft`
    }

    return `${(
      meters /
      1609.344
    ).toFixed(
      1
    )} mi`
  }

  // ==========================================
  // TIME
  // ==========================================

  function formatTime(
    minutes
  ) {
    const rounded =
      Math.round(
        minutes
      )

    if (
      rounded < 60
    ) {
      return `${rounded} min`
    }

    const hours =
      Math.floor(
        rounded /
          60
      )

    const mins =
      rounded %
      60

    if (
      mins === 0
    ) {
      return `${hours} hr`
    }

    return `${hours} hr ${mins} min`
  }

  // ==========================================
  // UI
  // ==========================================

  return (
    <div className="app">

      {/* MAP */}

      <div
        ref={mapContainer}
        className="map"
      >
        <svg
          ref={routeSvgRef}
          className="route-svg"
        />
      </div>

      {/* SEARCH */}

      {!navigationStarted && (
        <div className="search-container">

          <div className="search-box">

            <span className="search-icon">
              🔍
            </span>

            <input
              value={search}

              onChange={event =>
                setSearch(
                  event.target.value
                )
              }

              placeholder="Search destination"

              aria-label="Search destination"
            />

            {searching && (
              <span className="search-loading">
                •••
              </span>
            )}

          </div>

          {/* AUTOCOMPLETE */}

          {suggestions.length >
            0 && (
            <div className="suggestions">

              {suggestions.map(
                place => (
                  <button
                    key={
                      `${place.type}-${place.id}`
                    }

                    className="suggestion"

                    onClick={() =>
                      selectDestination(
                        place
                      )
                    }
                  >

                    <span className="suggestion-icon">
                      📍
                    </span>

                    <span className="place-info">

                      <strong>
                        {getSearchPlaceName(
                          place
                        )}
                      </strong>

                      <small>
                        {getSearchPlaceAddress(
                          place
                        )}

                        {getSearchCategory(
                          place
                        ) &&
                          ` • ${getSearchCategory(
                            place
                          )}`}

                        {Number.isFinite(
                          place._distanceMeters
                        ) &&
                          ` • ${formatDistance(
                            place._distanceMeters
                          )}`}
                      </small>

                    </span>

                  </button>
                )
              )}

            </div>
          )}

          <button
            className="my-location"
            onClick={
              startLocationTracking
            }
          >
            📍{' '}

            {currentLocation
              ? 'Location found'
              : 'My location'}

          </button>

        </div>
      )}

      {/* ROUTE OPTIONS */}

      {routes.length >
        0 &&
        !navigationStarted && (
        <div className="route-options">

          {routes.map(
            (
              routeItem,
              index
            ) => (
              <button
                key={
                  routeItem.originalIndex ??
                  index
                }

                className={
                  index ===
                  selectedRouteIndex
                    ? 'route-option selected'
                    : 'route-option'
                }

                onClick={() =>
                  selectRoute(
                    index
                  )
                }
              >

                <div className="route-option-top">

                  <strong>
                    {getRouteIcon(
                      routeItem.label
                    )}{' '}

                    {routeItem.label}
                  </strong>

                  <span>
                    {Math.round(
                      routeItem.minutes
                    )}{' '}
                    min
                  </span>

                </div>

                <div className="route-option-bottom">

                  <span>
                    {routeItem.miles.toFixed(
                      1
                    )}{' '}
                    mi
                  </span>

                  <small>
                    Comfort{' '}
                    {routeItem.score?.comfort ??
                      '—'}
                    /100
                  </small>

                </div>

                <div className="route-score-details">

                  <span>
                    POIs{' '}
                    {routeItem.score?.poiCount ??
                      '—'}
                  </span>

                  <span>
                    {routeItem.score?.poiDensity ??
                      '—'}
                    /mi
                  </span>

                  <span>
                    Street{' '}
                    {routeItem.score?.streetType ??
                      '—'}
                  </span>

                </div>

              </button>
            )
          )}

          <button
            className="start-button"
            onClick={
              startNavigation
            }
          >
            Start
          </button>

        </div>
      )}

      {/* NAVIGATION */}

      {navigationStarted && (
        <div className="navigation-panel">

          <div className="navigation-top">

            <button
              className="back-button"
              onClick={
                stopNavigation
              }
            >
              ‹
            </button>

            <div>

              <strong>
                {route?.label ||
                  'Walking'}
              </strong>

              <span>
                {destination?.name}
              </span>

            </div>

          </div>

          {route && (
            <div className="navigation-stats">

              <strong>
                {formatTime(
                  route.minutes
                )}
              </strong>

              <span>
                {route.miles.toFixed(
                  1
                )}{' '}
                mi
              </span>

            </div>
          )}

          <div className="navigation-placeholder">

            <span>
              ↑
            </span>

            <strong>
              Follow the blue route
            </strong>

            <small>
              Turn-by-turn directions
            </small>

          </div>

        </div>
      )}

      {/* LOADING */}

      {routeLoading && (
        <div className="loading-route">
          Finding walking routes...
        </div>
      )}

    </div>
  )
}

export default App