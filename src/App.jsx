import {
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import * as maplibregl from 'maplibre-gl'

import 'maplibre-gl/dist/maplibre-gl.css'
import './App.css'

const METERS_PER_MILE = 1609.344

const ALL_ROUTES_SOURCE_ID =
  'all-walking-routes'

const ALL_ROUTES_OUTLINE_ID =
  'all-walking-routes-outline'

const ALL_ROUTES_LINE_ID =
  'all-walking-routes-line'

const SELECTED_ROUTE_SOURCE_ID =
  'selected-walking-route'

const SELECTED_ROUTE_OUTLINE_ID =
  'selected-walking-route-outline'

const SELECTED_ROUTE_LINE_ID =
  'selected-walking-route-line'

// ============================================================
// HELPERS
// ============================================================

function haversineMeters(
  lon1,
  lat1,
  lon2,
  lat2
) {
  const earthRadius =
    6371000

  const toRadians =
    value =>
      value *
      Math.PI /
      180

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
    miles < 0.1
  ) {
    return (
      `${Math.round(
        meters * 3.28084
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
    Number(minutes)

  if (
    !Number.isFinite(
      value
    )
  ) {
    return ''
  }

  const rounded =
    Math.round(value)

  if (
    rounded < 60
  ) {
    return (
      `${rounded} min`
    )
  }

  const hours =
    Math.floor(
      rounded / 60
    )

  const remaining =
    rounded % 60

  if (
    remaining === 0
  ) {
    return (
      `${hours} hr`
    )
  }

  return (
    `${hours} hr ${remaining} min`
  )
}

function getRoutePurpose(
  routeId
) {
  if (
    routeId === 'shortest'
  ) {
    return 'Minimum distance'
  }

  if (
    routeId === 'balanced'
  ) {
    return 'Distance + effort'
  }

  return 'Minimum modeled energy'
}

function getSameRouteText(
  route
) {
  if (
    route.samePathAs ===
    'shortest'
  ) {
    return 'Same path as Shortest'
  }

  if (
    route.samePathAs ===
    'balanced'
  ) {
    return 'Same path as Balanced'
  }

  return ''
}

function getTradeoffText(
  route,
  shortest
) {
  if (
    !route ||
    !shortest
  ) {
    return ''
  }

  if (
    route.id === 'shortest'
  ) {
    return 'Baseline route'
  }

  const timeDifference =
    Number(route.minutes) -
    Number(shortest.minutes)

  const ascentDifference =
    Number(
      route.totalAscentMeters
    ) -
    Number(
      shortest.totalAscentMeters
    )

  let energyDifferencePercent = 0

  if (
    Number(
      shortest.energyKJPerKg
    ) > 0
  ) {
    energyDifferencePercent =
      (
        (
          Number(
            route.energyKJPerKg
          ) -
          Number(
            shortest.energyKJPerKg
          )
        ) /
        Number(
          shortest.energyKJPerKg
        )
      ) *
      100
  }

  let timeText

  if (
    Math.abs(
      timeDifference
    ) < 0.05
  ) {
    timeText =
      'same time'
  } else {
    timeText =
      `${
        timeDifference >= 0
          ? '+'
          : '−'
      }${Math.abs(
        timeDifference
      ).toFixed(1)} min`
  }

  let ascentText

  if (
    Math.abs(
      ascentDifference
    ) < 0.5
  ) {
    ascentText =
      'same climb'
  } else {
    ascentText =
      `${
        ascentDifference < 0
          ? '−'
          : '+'
      }${Math.round(
        Math.abs(
          ascentDifference
        )
      )} m climb`
  }

  let energyText

  if (
    Math.abs(
      energyDifferencePercent
    ) < 0.1
  ) {
    energyText =
      'same energy'
  } else {
    energyText =
      `${
        energyDifferencePercent < 0
          ? '−'
          : '+'
      }${Math.abs(
        energyDifferencePercent
      ).toFixed(1)}% energy`
  }

  return (
    `${timeText} · ${ascentText} · ${energyText}`
  )
}

function routeToFeature(
  route
) {
  return {
    type:
      'Feature',

    properties: {
      id:
        route.id,

      label:
        route.label
    },

    geometry: {
      type:
        'LineString',

      coordinates:
        route.coordinates
    }
  }
}

// ============================================================
// APP
// ============================================================

function App() {
  const mapContainerRef =
    useRef(null)

  const mapRef =
    useRef(null)

  const currentMarkerRef =
    useRef(null)

  const destinationMarkerRef =
    useRef(null)

  const currentLocationRef =
    useRef(null)

  const watchIdRef =
    useRef(null)

  const hasCenteredRef =
    useRef(false)

  const pendingDestinationRef =
    useRef(null)

  const searchAbortControllerRef =
    useRef(null)

  const searchRequestIdRef =
    useRef(0)

  const searchLockedRef =
    useRef(false)

  const [
    search,
    setSearch
  ] =
    useState('')

  const [
    searchResults,
    setSearchResults
  ] =
    useState([])

  const [
    searchLoading,
    setSearchLoading
  ] =
    useState(false)

  const [
    destination,
    setDestination
  ] =
    useState(null)

  const [
    routes,
    setRoutes
  ] =
    useState([])

  const [
    selectedRouteId,
    setSelectedRouteId
  ] =
    useState(
      'shortest'
    )

  const [
    routeLoading,
    setRouteLoading
  ] =
    useState(false)

  const [
    navigationStarted,
    setNavigationStarted
  ] =
    useState(false)

  const [
    errorMessage,
    setErrorMessage
  ] =
    useState('')

  const selectedRoute =
    useMemo(
      () => {
        return (
          routes.find(
            route =>
              route.id ===
              selectedRouteId
          ) ||
          routes[0] ||
          null
        )
      },
      [
        routes,
        selectedRouteId
      ]
    )

  const shortestRoute =
    useMemo(
      () => {
        return (
          routes.find(
            route =>
              route.id ===
              'shortest'
          ) ||
          routes[0] ||
          null
        )
      },
      [
        routes
      ]
    )

  // ============================================================
  // MAP
  // ============================================================

  useEffect(
    () => {
      if (
        !mapContainerRef.current
      ) {
        return
      }

      const map =
        new maplibregl.Map({
          container:
            mapContainerRef.current,

          style: {
            version: 8,

            sources: {
              osm: {
                type:
                  'raster',

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

          zoom: 13
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
          navigator
            .geolocation
            .clearWatch(
              watchIdRef.current
            )
        }

        map.remove()

        mapRef.current =
          null
      }
    },
    []
  )

  // ============================================================
  // ROUTE MAP LAYERS
  // ============================================================

  function createRouteLayers() {
    const map =
      mapRef.current

    if (
      !map ||
      !map.isStyleLoaded()
    ) {
      return false
    }

    if (
      !map.getSource(
        ALL_ROUTES_SOURCE_ID
      )
    ) {
      map.addSource(
        ALL_ROUTES_SOURCE_ID,
        {
          type:
            'geojson',

          data: {
            type:
              'FeatureCollection',

            features: []
          }
        }
      )
    }

    if (
      !map.getLayer(
        ALL_ROUTES_OUTLINE_ID
      )
    ) {
      map.addLayer({
        id:
          ALL_ROUTES_OUTLINE_ID,

        type:
          'line',

        source:
          ALL_ROUTES_SOURCE_ID,

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
            9,

          'line-opacity':
            0.55
        }
      })
    }

    if (
      !map.getLayer(
        ALL_ROUTES_LINE_ID
      )
    ) {
      map.addLayer({
        id:
          ALL_ROUTES_LINE_ID,

        type:
          'line',

        source:
          ALL_ROUTES_SOURCE_ID,

        layout: {
          'line-cap':
            'round',

          'line-join':
            'round'
        },

        paint: {
          'line-color': [
            'match',
            [
              'get',
              'id'
            ],

            'shortest',
            '#4A9BFF',

            'balanced',
            '#8B72FF',

            'energy',
            '#42B98C',

            '#80AFFF'
          ],

          'line-width':
            5,

          'line-opacity':
            0.34
        }
      })
    }

    if (
      !map.getSource(
        SELECTED_ROUTE_SOURCE_ID
      )
    ) {
      map.addSource(
        SELECTED_ROUTE_SOURCE_ID,
        {
          type:
            'geojson',

          data: {
            type:
              'FeatureCollection',

            features: []
          }
        }
      )
    }

    if (
      !map.getLayer(
        SELECTED_ROUTE_OUTLINE_ID
      )
    ) {
      map.addLayer({
        id:
          SELECTED_ROUTE_OUTLINE_ID,

        type:
          'line',

        source:
          SELECTED_ROUTE_SOURCE_ID,

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
            0.97
        }
      })
    }

    if (
      !map.getLayer(
        SELECTED_ROUTE_LINE_ID
      )
    ) {
      map.addLayer({
        id:
          SELECTED_ROUTE_LINE_ID,

        type:
          'line',

        source:
          SELECTED_ROUTE_SOURCE_ID,

        layout: {
          'line-cap':
            'round',

          'line-join':
            'round'
        },

        paint: {
          'line-color': [
            'match',
            [
              'get',
              'id'
            ],

            'shortest',
            '#087BFF',

            'balanced',
            '#7657FF',

            'energy',
            '#15966B',

            '#087BFF'
          ],

          'line-width':
            7,

          'line-opacity':
            1
        }
      })
    }

    return true
  }

  // ============================================================
  // ROUTE DRAWING
  // ============================================================

  function clearRouteDrawing() {
    const map =
      mapRef.current

    if (
      !map ||
      !map.isStyleLoaded()
    ) {
      return
    }

    const allSource =
      map.getSource(
        ALL_ROUTES_SOURCE_ID
      )

    if (allSource) {
      allSource.setData({
        type:
          'FeatureCollection',

        features: []
      })
    }

    const selectedSource =
      map.getSource(
        SELECTED_ROUTE_SOURCE_ID
      )

    if (selectedSource) {
      selectedSource.setData({
        type:
          'FeatureCollection',

        features: []
      })
    }
  }

  function drawRoutes(
    allRoutes,
    selected
  ) {
    const map =
      mapRef.current

    if (
      !map ||
      !Array.isArray(
        allRoutes
      ) ||
      allRoutes.length === 0 ||
      !selected
    ) {
      return
    }

    if (
      !map.isStyleLoaded()
    ) {
      map.once(
        'load',
        () => {
          drawRoutes(
            allRoutes,
            selected
          )
        }
      )

      return
    }

    createRouteLayers()

    const validRoutes =
      allRoutes.filter(
        route =>
          route &&
          Array.isArray(
            route.coordinates
          ) &&
          route.coordinates
            .length >= 2
      )

    const allSource =
      map.getSource(
        ALL_ROUTES_SOURCE_ID
      )

    if (allSource) {
      allSource.setData({
        type:
          'FeatureCollection',

        features:
          validRoutes.map(
            route =>
              routeToFeature(
                route
              )
          )
      })
    }

    const selectedSource =
      map.getSource(
        SELECTED_ROUTE_SOURCE_ID
      )

    if (
      selectedSource &&
      Array.isArray(
        selected.coordinates
      ) &&
      selected.coordinates
        .length >= 2
    ) {
      selectedSource.setData(
        routeToFeature(
          selected
        )
      )
    }

    console.log(
      'ROUTE DRAWN:',
      selected.id,
      selected.coordinates.length
    )
  }

  function fitRoute(
    route
  ) {
    const map =
      mapRef.current

    if (
      !map ||
      !route ||
      !Array.isArray(
        route.coordinates
      )
    ) {
      return
    }

    const bounds =
      new maplibregl
        .LngLatBounds()

    for (
      const coordinate
      of route.coordinates
    ) {
      if (
        !Array.isArray(
          coordinate
        ) ||
        coordinate.length < 2
      ) {
        continue
      }

      const longitude =
        Number(
          coordinate[0]
        )

      const latitude =
        Number(
          coordinate[1]
        )

      if (
        !Number.isFinite(
          longitude
        ) ||
        !Number.isFinite(
          latitude
        )
      ) {
        continue
      }

      bounds.extend([
        longitude,
        latitude
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
          top: 115,

          bottom: 300,

          left: 55,

          right: 55
        },

        maxZoom: 17,

        duration: 650
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
        setErrorMessage(
          'Location is not supported.'
        )

        return
      }

      watchIdRef.current =
        navigator
          .geolocation
          .watchPosition(
            position => {
              const location = {
                longitude:
                  position.coords
                    .longitude,

                latitude:
                  position.coords
                    .latitude
              }

              currentLocationRef.current =
                location

              updateCurrentLocationMarker(
                location
              )

              if (
                !hasCenteredRef.current &&
                mapRef.current
              ) {
                hasCenteredRef.current =
                  true

                mapRef.current.flyTo({
                  center: [
                    location.longitude,
                    location.latitude
                  ],

                  zoom: 15,

                  duration: 650
                })
              }

              if (
                pendingDestinationRef.current
              ) {
                const pending =
                  pendingDestinationRef.current

                pendingDestinationRef.current =
                  null

                calculateRoutes(
                  location,
                  pending
                )
              }
            },

            error => {
              console.log(
                'LOCATION ERROR:',
                error
              )

              setErrorMessage(
                'Please allow location access.'
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
          .addTo(map)
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
        query.length < 3
      ) {
        if (
          searchAbortControllerRef.current
        ) {
          searchAbortControllerRef.current
            .abort()
        }

        setSearchResults([])

        setSearchLoading(false)

        return
      }

      const timer =
        setTimeout(
          async () => {
            const requestId =
              ++searchRequestIdRef.current

            if (
              searchAbortControllerRef.current
            ) {
              searchAbortControllerRef.current
                .abort()
            }

            const controller =
              new AbortController()

            searchAbortControllerRef.current =
              controller

            setSearchLoading(true)

            try {
              const parameters =
                new URLSearchParams()

              parameters.set(
                'q',
                query
              )

              const location =
                currentLocationRef.current

              if (location) {
                parameters.set(
                  'lat',
                  String(
                    location.latitude
                  )
                )

                parameters.set(
                  'lon',
                  String(
                    location.longitude
                  )
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
                searchRequestIdRef.current
              ) {
                return
              }

              if (
                !response.ok
              ) {
                throw new Error(
                  data.error ||
                  'Search failed.'
                )
              }

              const results =
                data
                  .map(
                    item => {
                      const longitude =
                        Number(
                          item.longitude
                        )

                      const latitude =
                        Number(
                          item.latitude
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

                      let distance =
                        Infinity

                      if (
                        location
                      ) {
                        distance =
                          haversineMeters(
                            location.longitude,
                            location.latitude,
                            longitude,
                            latitude
                          )
                      }

                      return {
                        ...item,

                        longitude,
                        latitude,
                        distance
                      }
                    }
                  )
                  .filter(Boolean)

              setSearchResults(
                results
              )

              setErrorMessage('')
            } catch (
              error
            ) {
              if (
                error.name ===
                'AbortError'
              ) {
                return
              }

              console.error(
                'SEARCH ERROR:',
                error
              )
            } finally {
              if (
                requestId ===
                searchRequestIdRef.current
              ) {
                setSearchLoading(
                  false
                )
              }
            }
          },
          350
        )

      return () => {
        clearTimeout(timer)
      }
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

    setErrorMessage('')
  }

  function resetSearch() {
    searchLockedRef.current =
      false

    searchRequestIdRef.current++

    if (
      searchAbortControllerRef.current
    ) {
      searchAbortControllerRef.current
        .abort()
    }

    setSearch('')

    setSearchResults([])

    setDestination(null)

    setRoutes([])

    setSelectedRouteId(
      'shortest'
    )

    setNavigationStarted(
      false
    )

    clearRouteDrawing()

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

    searchRequestIdRef.current++

    if (
      searchAbortControllerRef.current
    ) {
      searchAbortControllerRef.current
        .abort()
    }

    setSearchResults([])

    setSearchLoading(false)

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

    setRoutes([])

    setSelectedRouteId(
      'shortest'
    )

    clearRouteDrawing()

    if (
      destinationMarkerRef.current
    ) {
      destinationMarkerRef.current
        .remove()
    }

    if (
      mapRef.current
    ) {
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
    }

    const current =
      currentLocationRef.current

    if (!current) {
      pendingDestinationRef.current =
        selected

      setErrorMessage(
        'Getting your current location...'
      )

      return
    }

    calculateRoutes(
      current,
      selected
    )
  }

  // ============================================================
  // ROUTING
  // ============================================================

  async function calculateRoutes(
    start,
    end
  ) {
    setRouteLoading(true)

    setErrorMessage('')

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
          'Could not calculate routes.'
        )
      }

      if (
        !Array.isArray(
          data.routes
        )
      ) {
        throw new Error(
          'Server response does not contain routes.'
        )
      }

      const validRoutes =
        data.routes.filter(
          route =>
            route &&
            Array.isArray(
              route.coordinates
            ) &&
            route.coordinates
              .length >= 2
        )

      if (
        validRoutes.length ===
        0
      ) {
        throw new Error(
          'No valid routes were returned.'
        )
      }

      console.log('')
      console.log(
        '=== EXACT ROUTE METRICS ==='
      )

      console.table(
        validRoutes.map(
          route => ({
            Route:
              route.label,

            'Distance m':
              Number(
                route.distanceMeters
              ).toFixed(2),

            'Distance mi':
              Number(
                route.distanceMiles
              ).toFixed(5),

            'Time min':
              Number(
                route.minutes
              ).toFixed(3),

            'Ascent m':
              Number(
                route.totalAscentMeters
              ).toFixed(2),

            'Avg grade %':
              Number(
                route.averageGradePercent
              ).toFixed(3),

            'Max grade %':
              Number(
                route.maximumGradePercent
              ).toFixed(3),

            'Energy kJ/kg':
              Number(
                route.energyKJPerKg
              ).toFixed(4),

            'Flat effort':
              Number(
                route.effortRatio
              ).toFixed(4),

            'Grade spacing m':
              Number(
                route.gradeSampleSpacingMeters
              ).toFixed(2)
          })
        )
      )

      setRoutes(
        validRoutes
      )

      const shortest =
        validRoutes.find(
          route =>
            route.id ===
            'shortest'
        ) ||
        validRoutes[0]

      setSelectedRouteId(
        shortest.id
      )

      drawRoutes(
        validRoutes,
        shortest
      )

      fitRoute(
        shortest
      )
    } catch (
      error
    ) {
      console.error(
        'ROUTE ERROR:',
        error
      )

      setErrorMessage(
        error.message
      )
    } finally {
      setRouteLoading(false)
    }
  }

  function selectRoute(
    route
  ) {
    if (!route) {
      return
    }

    setSelectedRouteId(
      route.id
    )

    drawRoutes(
      routes,
      route
    )

    fitRoute(
      route
    )
  }

  // ============================================================
  // NAVIGATION
  // ============================================================

  function startNavigation() {
    if (
      !selectedRoute
    ) {
      return
    }

    setNavigationStarted(
      true
    )

    const current =
      currentLocationRef.current

    if (
      current &&
      mapRef.current
    ) {
      mapRef.current.flyTo({
        center: [
          current.longitude,
          current.latitude
        ],

        zoom: 17,

        duration: 700
      })
    }
  }

  function stopNavigation() {
    setNavigationStarted(
      false
    )

    if (
      selectedRoute
    ) {
      setTimeout(
        () => {
          drawRoutes(
            routes,
            selectedRoute
          )
        },
        50
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
          mapContainerRef
        }
      />

      {!navigationStarted && (
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

              spellCheck="false"
            />

            {searchLoading && (
              <span
                className="search-progress"
              >
                •••
              </span>
            )}

            {search &&
              !searchLoading && (
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

          {searchResults.length >
            0 && (
            <div
              className="autocomplete"
            >
              {searchResults.map(
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
          <div
            className="route-spinner"
          />

          <div>
            <strong>
              Calculating routes
            </strong>

            <span>
              Comparing distance and elevation
            </span>
          </div>
        </div>
      )}

      {routes.length >
        0 &&
        !navigationStarted && (
          <div
            className="route-sheet"
          >
            <div
              className="route-options"
            >
              {routes.map(
                route => (
                  <button
                    key={
                      route.id
                    }

                    type="button"

                    className={
                      [
                        'route-option',

                        `route-option-${route.id}`,

                        route.id ===
                        selectedRouteId
                          ? 'route-option-selected'
                          : ''
                      ]
                        .filter(Boolean)
                        .join(' ')
                    }

                    onClick={
                      () => {
                        selectRoute(
                          route
                        )
                      }
                    }
                  >
                    <div
                      className="route-option-top"
                    >
                      <div>
                        <div
                          className="route-option-name"
                        >
                          {route.label}
                        </div>

                        <div
                          className="route-option-purpose"
                        >
                          {getRoutePurpose(
                            route.id
                          )}
                        </div>
                      </div>

                      <div
                        className="route-color-dot"
                      />
                    </div>

                    <div
                      className="route-option-time"
                    >
                      {formatTime(
                        route.minutes
                      )}
                    </div>

                    <div
                      className="route-option-distance"
                    >
                      {Number(
                        route.distanceMiles
                      ).toFixed(2)}
                      {' '}mi
                    </div>

                    <div
                      className="route-tradeoff"
                    >
                      {getTradeoffText(
                        route,
                        shortestRoute
                      )}
                    </div>

                    {route.samePathAs && (
                      <div
                        className="same-route"
                      >
                        {getSameRouteText(
                          route
                        )}
                      </div>
                    )}
                  </button>
                )
              )}
            </div>

            {selectedRoute && (
              <div
                className="route-details"
              >
                <div
                  className="route-detail"
                >
                  <strong>
                    ↑{' '}
                    {Number(
                      selectedRoute
                        .totalAscentMeters ||
                      0
                    ).toFixed(0)}
                    {' '}m
                  </strong>

                  <span>
                    Ascent
                  </span>
                </div>

                <div
                  className="route-detail"
                >
                  <strong>
                    {Number(
                      selectedRoute
                        .averageGradePercent ||
                      0
                    ).toFixed(1)}
                    %
                  </strong>

                  <span>
                    Avg grade
                  </span>
                </div>

                <div
                  className="route-detail"
                >
                  <strong>
                    {Number(
                      selectedRoute
                        .maximumGradePercent ||
                      0
                    ).toFixed(1)}
                    %
                  </strong>

                  <span>
                    Max grade
                  </span>
                </div>

                <div
                  className="route-detail"
                >
                  <strong>
                    {Number(
                      selectedRoute
                        .energyKJPerKg ||
                      0
                    ).toFixed(2)}
                  </strong>

                  <span>
                    kJ/kg energy
                  </span>
                </div>
              </div>
            )}

            <button
              type="button"

              className="start-button"

              onClick={
                startNavigation
              }
            >
              Start
            </button>
          </div>
        )}

      {navigationStarted &&
        selectedRoute && (
          <div
            className="navigation-card"
          >
            <button
              type="button"

              className="navigation-back"

              onClick={
                stopNavigation
              }
            >
              ‹
            </button>

            <div
              className="navigation-main"
            >
              <strong>
                {destination?.name}
              </strong>

              <span>
                {selectedRoute.label}
                {' · '}
                {formatTime(
                  selectedRoute.minutes
                )}
                {' · '}
                {Number(
                  selectedRoute.distanceMiles
                ).toFixed(2)}
                {' '}mi
              </span>
            </div>

            <div
              className="navigation-ascent"
            >
              ↑{' '}
              {Number(
                selectedRoute
                  .totalAscentMeters ||
                0
              ).toFixed(0)}
              {' '}m
            </div>
          </div>
        )}

      {errorMessage && (
        <div
          className="error-toast"
        >
          {errorMessage}
        </div>
      )}
    </div>
  )
}

export default App