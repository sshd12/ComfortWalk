import {
  useEffect,
  useRef,
  useState
} from 'react'

import * as maplibregl from 'maplibre-gl'

import 'maplibre-gl/dist/maplibre-gl.css'
import './App.css'

const METERS_PER_MILE =
  1609.344

const ROUTE_SOURCE =
  'walking-route'

const ROUTE_OUTLINE =
  'walking-route-outline'

const ROUTE_LINE =
  'walking-route-line'

// ============================================================
// HELPERS
// ============================================================

function haversineMeters(
  lon1,
  lat1,
  lon2,
  lat2
) {
  const R =
    6371000

  const toRadians =
    value =>
      value *
      Math.PI /
      180

  const p1 =
    toRadians(lat1)

  const p2 =
    toRadians(lat2)

  const dLat =
    toRadians(
      lat2 - lat1
    )

  const dLon =
    toRadians(
      lon2 - lon1
    )

  const a =
    Math.sin(
      dLat / 2
    ) ** 2 +
    Math.cos(p1) *
    Math.cos(p2) *
    Math.sin(
      dLon / 2
    ) ** 2

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  )
}

function formatSearchDistance(
  meters
) {
  if (
    !Number.isFinite(
      meters
    )
  ) {
    return ''
  }

  const miles =
    meters /
    METERS_PER_MILE

  if (
    miles <
    0.1
  ) {
    return (
      `${Math.round(
        meters *
        3.28084
      )} ft`
    )
  }

  return (
    `${miles.toFixed(1)} mi`
  )
}

function formatTime(
  minutes
) {
  const value =
    Math.round(
      Number(minutes)
    )

  if (
    value <
    60
  ) {
    return (
      `${value} min`
    )
  }

  const hours =
    Math.floor(
      value /
      60
    )

  const remaining =
    value %
    60

  return (
    remaining ===
      0
      ? `${hours} hr`
      : `${hours} hr ${remaining} min`
  )
}

// ============================================================
// APP
// ============================================================

function App() {
  const mapElementRef =
    useRef(null)

  const mapRef =
    useRef(null)

  const currentMarkerRef =
    useRef(null)

  const destinationMarkerRef =
    useRef(null)

  const locationRef =
    useRef(null)

  const watchIdRef =
    useRef(null)

  const centeredRef =
    useRef(false)

  const searchAbortRef =
    useRef(null)

  const searchRequestRef =
    useRef(0)

  const searchLockedRef =
    useRef(false)

  const pendingDestinationRef =
    useRef(null)

  const [
    search,
    setSearch
  ] =
    useState('')

  const [
    results,
    setResults
  ] =
    useState([])

  const [
    searching,
    setSearching
  ] =
    useState(false)

  const [
    destination,
    setDestination
  ] =
    useState(null)

  const [
    route,
    setRoute
  ] =
    useState(null)

  const [
    routeLoading,
    setRouteLoading
  ] =
    useState(false)

  const [
    navigation,
    setNavigation
  ] =
    useState(false)

  const [
    error,
    setError
  ] =
    useState('')

  // ============================================================
  // MAP
  // ============================================================

  useEffect(
    () => {
      if (
        !mapElementRef.current
      ) {
        return
      }

      const map =
        new maplibregl.Map({
          container:
            mapElementRef.current,

          style: {
            version:
              8,

            sources: {
              osm: {
                type:
                  'raster',

                tiles: [
                  'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
                ],

                tileSize:
                  256,

                attribution:
                  '© OpenStreetMap contributors'
              }
            },

            layers: [
              {
                id:
                  'osm',

                type:
                  'raster',

                source:
                  'osm'
              }
            ]
          },

          center: [
            -122.4194,
            37.7749
          ],

          zoom:
            13
        })

      mapRef.current =
        map

      map.on(
        'load',
        () => {
          createRouteLayers()
        }
      )

      return () => {
        if (
          watchIdRef.current !==
          null
        ) {
          navigator.geolocation
            .clearWatch(
              watchIdRef.current
            )
        }

        map.remove()
      }
    },
    []
  )

  // ============================================================
  // ROUTE LAYER
  // ============================================================

  function createRouteLayers() {
    const map =
      mapRef.current

    if (
      !map ||
      !map.isStyleLoaded()
    ) {
      return
    }

    if (
      !map.getSource(
        ROUTE_SOURCE
      )
    ) {
      map.addSource(
        ROUTE_SOURCE,
        {
          type:
            'geojson',

          data: {
            type:
              'FeatureCollection',

            features:
              []
          }
        }
      )
    }

    if (
      !map.getLayer(
        ROUTE_OUTLINE
      )
    ) {
      map.addLayer({
        id:
          ROUTE_OUTLINE,

        type:
          'line',

        source:
          ROUTE_SOURCE,

        layout: {
          'line-cap':
            'round',

          'line-join':
            'round'
        },

        paint: {
          'line-color':
            '#ffffff',

          'line-width':
            12,

          'line-opacity':
            0.96
        }
      })
    }

    if (
      !map.getLayer(
        ROUTE_LINE
      )
    ) {
      map.addLayer({
        id:
          ROUTE_LINE,

        type:
          'line',

        source:
          ROUTE_SOURCE,

        layout: {
          'line-cap':
            'round',

          'line-join':
            'round'
        },

        paint: {
          'line-color':
            '#087bff',

          'line-width':
            7,

          'line-opacity':
            1
        }
      })
    }
  }

  function drawRoute(
    routeData
  ) {
    const map =
      mapRef.current

    if (
      !map ||
      !routeData
    ) {
      return
    }

    if (
      !map.isStyleLoaded()
    ) {
      map.once(
        'load',
        () =>
          drawRoute(
            routeData
          )
      )

      return
    }

    createRouteLayers()

    const coordinates =
      routeData.coordinates
        .map(
          coordinate => [
            Number(
              coordinate[0]
            ),

            Number(
              coordinate[1]
            )
          ]
        )
        .filter(
          coordinate =>
            Number.isFinite(
              coordinate[0]
            ) &&
            Number.isFinite(
              coordinate[1]
            )
        )

    const source =
      map.getSource(
        ROUTE_SOURCE
      )

    source.setData({
      type:
        'Feature',

      properties: {},

      geometry: {
        type:
          'LineString',

        coordinates
      }
    })

    console.log(
      'ROUTE DRAWN:',
      coordinates.length
    )
  }

  function clearRoute() {
    const map =
      mapRef.current

    if (
      !map ||
      !map.isStyleLoaded()
    ) {
      return
    }

    const source =
      map.getSource(
        ROUTE_SOURCE
      )

    if (source) {
      source.setData({
        type:
          'FeatureCollection',

        features: []
      })
    }
  }

  function fitRoute(
    routeData
  ) {
    const map =
      mapRef.current

    if (!map) {
      return
    }

    const bounds =
      new maplibregl
        .LngLatBounds()

    for (
      const coordinate
      of routeData.coordinates
    ) {
      bounds.extend([
        Number(
          coordinate[0]
        ),

        Number(
          coordinate[1]
        )
      ])
    }

    if (
      bounds.isEmpty()
    ) {
      return
    }

    map.fitBounds(
      bounds,
      {
        padding: {
          top:
            110,

          bottom:
            190,

          left:
            55,

          right:
            55
        },

        maxZoom:
          17,

        duration:
          700
      }
    )
  }

  // ============================================================
  // GPS
  // ============================================================

  useEffect(
    () => {
      if (
        !navigator.geolocation
      ) {
        return
      }

      watchIdRef.current =
        navigator.geolocation
          .watchPosition(
            position => {
              const location = {
                longitude:
                  position.coords
                    .longitude,

                latitude:
                  position.coords
                    .latitude,

                heading:
                  position.coords
                    .heading
              }

              locationRef.current =
                location

              updateCurrentLocationMarker(
                location
              )

              if (
                !centeredRef.current &&
                mapRef.current
              ) {
                centeredRef.current =
                  true

                mapRef.current
                  .flyTo({
                    center: [
                      location.longitude,
                      location.latitude
                    ],

                    zoom:
                      15,

                    duration:
                      650
                  })
              }

              if (
                pendingDestinationRef.current
              ) {
                const pending =
                  pendingDestinationRef.current

                pendingDestinationRef.current =
                  null

                calculateRoute(
                  location,
                  pending
                )
              }
            },

            error => {
              console.log(
                'LOCATION:',
                error
              )
            },

            {
              enableHighAccuracy:
                true,

              maximumAge:
                2500,

              timeout:
                15000
            }
          )
    },
    []
  )

  function updateCurrentLocationMarker(
    location
  ) {
    const map =
      mapRef.current

    if (!map) {
      return
    }

    if (
      !currentMarkerRef.current
    ) {
      const element =
        document.createElement(
          'div'
        )

      element.className =
        'user-location'

      element.innerHTML = `
        <div class="user-location-halo"></div>
        <div class="user-location-dot"></div>
      `

      currentMarkerRef.current =
        new maplibregl.Marker({
          element,

          anchor:
            'center'
        })
          .setLngLat([
            location.longitude,
            location.latitude
          ])
          .addTo(
            map
          )
    } else {
      currentMarkerRef.current
        .setLngLat([
          location.longitude,
          location.latitude
        ])
    }
  }

  // ============================================================
  // AUTOCOMPLETE
  // ============================================================

  useEffect(
    () => {
      if (
        searchLockedRef.current
      ) {
        return
      }

      const query =
        search.trim()

      if (
        query.length <
        3
      ) {
        if (
          searchAbortRef.current
        ) {
          searchAbortRef.current
            .abort()
        }

        setResults([])
        setSearching(false)

        return
      }

      const timer =
        setTimeout(
          async () => {
            const requestId =
              ++searchRequestRef.current

            if (
              searchAbortRef.current
            ) {
              searchAbortRef.current
                .abort()
            }

            const controller =
              new AbortController()

            searchAbortRef.current =
              controller

            setSearching(true)

            try {
              const parameters =
                new URLSearchParams()

              parameters.set(
                'q',
                query
              )

              const location =
                locationRef.current

              if (location) {
                parameters.set(
                  'lat',
                  location.latitude
                )

                parameters.set(
                  'lon',
                  location.longitude
                )
              }

              const response =
                await fetch(
                  `/api/search?${parameters.toString()}`,
                  {
                    signal:
                      controller.signal
                  }
                )

              const data =
                await response.json()

              if (
                requestId !==
                searchRequestRef.current
              ) {
                return
              }

              if (
                !response.ok
              ) {
                throw new Error(
                  'Search failed'
                )
              }

              const nextResults =
                data.map(
                  item => {
                    let distance =
                      Infinity

                    if (
                      location
                    ) {
                      distance =
                        haversineMeters(
                          location.longitude,
                          location.latitude,
                          Number(
                            item.longitude
                          ),
                          Number(
                            item.latitude
                          )
                        )
                    }

                    return {
                      ...item,

                      longitude:
                        Number(
                          item.longitude
                        ),

                      latitude:
                        Number(
                          item.latitude
                        ),

                      distance
                    }
                  }
                )

              console.log(
                'SEARCH RESULTS:',
                nextResults
              )

              setResults(
                nextResults
              )
            } catch (
              error
            ) {
              if (
                error.name !==
                'AbortError'
              ) {
                console.log(
                  'SEARCH ERROR:',
                  error
                )
              }
            } finally {
              if (
                requestId ===
                searchRequestRef.current
              ) {
                setSearching(
                  false
                )
              }
            }
          },
          350
        )

      return () =>
        clearTimeout(
          timer
        )
    },
    [
      search
    ]
  )

  function handleSearchChange(
    event
  ) {
    searchLockedRef.current =
      false

    setSearch(
      event.target.value
    )

    setError('')
  }

  function resetSearch() {
    searchLockedRef.current =
      false

    searchRequestRef.current++

    if (
      searchAbortRef.current
    ) {
      searchAbortRef.current
        .abort()
    }

    setSearch('')
    setResults([])
    setDestination(null)
    setRoute(null)

    clearRoute()

    if (
      destinationMarkerRef.current
    ) {
      destinationMarkerRef.current
        .remove()

      destinationMarkerRef.current =
        null
    }
  }

  // ============================================================
  // DESTINATION
  // ============================================================

  function selectDestination(
    place
  ) {
    searchLockedRef.current =
      true

    searchRequestRef.current++

    if (
      searchAbortRef.current
    ) {
      searchAbortRef.current
        .abort()
    }

    setResults([])
    setSearching(false)

    const selected = {
      name:
        place.name,

      address:
        place.address,

      longitude:
        place.longitude,

      latitude:
        place.latitude
    }

    setDestination(
      selected
    )

    setSearch(
      selected.name
    )

    setRoute(null)

    clearRoute()

    if (
      destinationMarkerRef.current
    ) {
      destinationMarkerRef.current
        .remove()
    }

    destinationMarkerRef.current =
      new maplibregl.Marker({
        color:
          '#ff3b30'
      })
        .setLngLat([
          selected.longitude,
          selected.latitude
        ])
        .addTo(
          mapRef.current
        )

    const current =
      locationRef.current

    if (!current) {
      pendingDestinationRef.current =
        selected

      setError(
        'Getting your current location...'
      )

      return
    }

    calculateRoute(
      current,
      selected
    )
  }

  // ============================================================
  // ROUTING
  // ============================================================

  async function calculateRoute(
    start,
    end
  ) {
    setRouteLoading(
      true
    )

    setError('')

    try {
      const response =
        await fetch(
          '/api/route',
          {
            method:
              'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                start: {
                  lat:
                    start.latitude,

                  lon:
                    start.longitude
                },

                end: {
                  lat:
                    end.latitude,

                  lon:
                    end.longitude
                }
              })
          }
        )

      const data =
        await response.json()

      if (
        !response.ok
      ) {
        throw new Error(
          data.error ||
          'Could not calculate route.'
        )
      }

      console.log(
        'CUSTOM A*:',
        data
      )

      setRoute(
        data
      )

      drawRoute(
        data
      )

      fitRoute(
        data
      )
    } catch (
      error
    ) {
      console.error(
        error
      )

      setError(
        error.message
      )
    } finally {
      setRouteLoading(
        false
      )
    }
  }

  // ============================================================
  // UI
  // ============================================================

  return (
    <div
      className="app"
    >
      <div
        className="map"
        ref={
          mapElementRef
        }
      />

      {!navigation && (
        <div
          className="search-wrapper"
        >
          <div
            className="search-bar"
          >
            <span
              className="magnifier"
            >
              ⌕
            </span>

            <input
              value={
                search
              }

              onChange={
                handleSearchChange
              }

              placeholder="Search for a destination"

              autoComplete="off"
            />

            {searching && (
              <span
                className="search-progress"
              >
                •••
              </span>
            )}

            {search &&
              !searching && (
                <button
                  className="search-clear"
                  type="button"
                  onClick={
                    resetSearch
                  }
                >
                  ×
                </button>
              )}
          </div>

          {results.length >
            0 && (
            <div
              className="autocomplete"
            >
              {results.map(
                (
                  place,
                  index
                ) => (
                  <button
                    type="button"

                    className="autocomplete-item"

                    key={
                      `${place.id}-${index}`
                    }

                    onPointerDown={
                      event => {
                        event.preventDefault()

                        selectDestination(
                          place
                        )
                      }
                    }
                  >
                    <div
                      className="autocomplete-pin"
                    >
                      ●
                    </div>

                    <div
                      className="autocomplete-text"
                    >
                      <strong>
                        {place.name}
                      </strong>

                      <span>
                        {place.address}
                      </span>
                    </div>

                    {Number.isFinite(
                      place.distance
                    ) && (
                      <div
                        className="autocomplete-distance"
                      >
                        {formatSearchDistance(
                          place.distance
                        )}
                      </div>
                    )}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      )}

      {routeLoading && (
        <div
          className="route-loading"
        >
          Finding route…
        </div>
      )}

      {route &&
        !navigation && (
          <div
            className="route-bottom"
          >
            <div
              className="route-card"
            >
              <div
                className="route-card-top"
              >
                <strong>
                  My A* Route
                </strong>

                <strong
                  className="route-time"
                >
                  {formatTime(
                    route.minutes
                  )}
                </strong>
              </div>

              <div
                className="route-summary"
              >
                <span>
                  {Number(
                    route.distanceMiles
                  ).toFixed(1)}
                  {' '}mi
                </span>

                <span>
                  Custom routing
                </span>
              </div>

              <div
                className="route-debug"
              >
                <span>
                  Algorithm: A*
                </span>

                <span>
                  Cost: distance
                </span>
              </div>

              <div
                className="route-debug"
              >
                <span>
                  {route.visitedNodes}
                  {' '}nodes visited
                </span>

                <span>
                  {route.graphNodes}
                  {' '}graph nodes
                </span>
              </div>
            </div>

            <button
              className="start-button"
              type="button"

              onClick={
                () => {
                  setNavigation(
                    true
                  )

                  const current =
                    locationRef.current

                  if (
                    current &&
                    mapRef.current
                  ) {
                    mapRef.current.flyTo({
                      center: [
                        current.longitude,
                        current.latitude
                      ],

                      zoom:
                        17,

                      duration:
                        700
                    })
                  }
                }
              }
            >
              Start
            </button>
          </div>
        )}

      {navigation &&
        route && (
          <div
            className="navigation-card"
          >
            <button
              type="button"

              onClick={
                () =>
                  setNavigation(
                    false
                  )
              }
            >
              ‹
            </button>

            <div>
              <strong>
                {destination?.name}
              </strong>

              <span>
                {formatTime(
                  route.minutes
                )}
                {' · '}
                {Number(
                  route.distanceMiles
                ).toFixed(1)}
                {' '}mi
              </span>
            </div>
          </div>
        )}

      {error && (
        <div
          className="error-toast"
        >
          {error}
        </div>
      )}
    </div>
  )
}

export default App