import {
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import * as maplibregl from 'maplibre-gl'

import 'maplibre-gl/dist/maplibre-gl.css'
import './App.css'

const METERS_PER_MILE =
  1609.344

const WALKING_SPEED_METERS_PER_SECOND =
  1.35

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

const STEEP_ROUTE_SOURCE_ID =
  'steep-route-sections'

const STEEP_ROUTE_LINE_ID =
  'steep-route-sections-line'

// ============================================================
// MATH
// ============================================================

function toRadians(value) {
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
  lon1,
  lat1,
  lon2,
  lat2
) {
  const radius = 6371000

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
    radius *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  )
}

// ============================================================
// FORMATTERS
// ============================================================

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

function formatNavigationDistance(
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
    meters < 15
  ) {
    return 'Now'
  }

  const feet =
    meters * 3.28084

  if (
    feet < 1000
  ) {
    return (
      `${Math.max(
        10,
        Math.round(
          feet / 10
        ) * 10
      )} ft`
    )
  }

  const miles =
    meters /
    METERS_PER_MILE

  return (
    `${miles.toFixed(
      miles < 1
        ? 1
        : 2
    )} mi`
  )
}

function formatTime(
  minutes
) {
  const rounded =
    Math.round(
      Number(minutes)
    )

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

// ============================================================
// ROUTE PROJECTION FOR NAVIGATION
// ============================================================

function buildRouteCumulative(
  coordinates
) {
  const cumulative = [0]

  for (
    let index = 1;
    index <
      coordinates.length;
    index++
  ) {
    const previous =
      coordinates[
        index - 1
      ]

    const current =
      coordinates[index]

    cumulative.push(
      cumulative[
        cumulative.length - 1
      ] +
      haversineMeters(
        previous[0],
        previous[1],
        current[0],
        current[1]
      )
    )
  }

  return cumulative
}

function projectLocationToRoute(
  location,
  coordinates
) {
  if (
    !location ||
    !Array.isArray(
      coordinates
    ) ||
    coordinates.length < 2
  ) {
    return null
  }

  const cumulative =
    buildRouteCumulative(
      coordinates
    )

  const referenceLatitude =
    location.latitude

  const metersPerDegreeLatitude =
    111320

  const metersPerDegreeLongitude =
    111320 *
    Math.cos(
      toRadians(
        referenceLatitude
      )
    )

  let bestDistance =
    Infinity

  let bestProgress = 0

  for (
    let index = 0;
    index <
      coordinates.length - 1;
    index++
  ) {
    const first =
      coordinates[index]

    const second =
      coordinates[
        index + 1
      ]

    const ax =
      (
        first[0] -
        location.longitude
      ) *
      metersPerDegreeLongitude

    const ay =
      (
        first[1] -
        location.latitude
      ) *
      metersPerDegreeLatitude

    const bx =
      (
        second[0] -
        location.longitude
      ) *
      metersPerDegreeLongitude

    const by =
      (
        second[1] -
        location.latitude
      ) *
      metersPerDegreeLatitude

    const dx = bx - ax
    const dy = by - ay

    const lengthSquared =
      dx * dx +
      dy * dy

    let t = 0

    if (
      lengthSquared > 0
    ) {
      t =
        clamp(
          -(
            ax * dx +
            ay * dy
          ) /
          lengthSquared,

          0,
          1
        )
    }

    const px =
      ax +
      t * dx

    const py =
      ay +
      t * dy

    const distance =
      Math.sqrt(
        px * px +
        py * py
      )

    if (
      distance <
      bestDistance
    ) {
      bestDistance =
        distance

      const segmentLength =
        cumulative[
          index + 1
        ] -
        cumulative[index]

      bestProgress =
        cumulative[index] +
        segmentLength * t
    }
  }

  return {
    progressMeters:
      bestProgress,

    distanceToRouteMeters:
      bestDistance,

    totalDistanceMeters:
      cumulative[
        cumulative.length - 1
      ]
  }
}

// ============================================================
// ROUTE HELPERS
// ============================================================

function routeToFeature(
  route
) {
  return {
    type: 'Feature',

    properties: {
      id:
        route.id
    },

    geometry: {
      type:
        'LineString',

      coordinates:
        route.coordinates
    }
  }
}

function steepFeaturesForRoute(
  route
) {
  const profile =
    route?.elevationProfile

  if (
    !Array.isArray(
      profile
    ) ||
    profile.length < 2
  ) {
    return []
  }

  const features = []

  for (
    let index = 1;
    index <
      profile.length;
    index++
  ) {
    const previous =
      profile[
        index - 1
      ]

    const current =
      profile[index]

    if (
      !current.steep
    ) {
      continue
    }

    if (
      !Array.isArray(
        previous.coordinate
      ) ||
      !Array.isArray(
        current.coordinate
      )
    ) {
      continue
    }

    features.push({
      type: 'Feature',

      properties: {
        gradePercent:
          current.gradePercent
      },

      geometry: {
        type:
          'LineString',

        coordinates: [
          previous.coordinate,
          current.coordinate
        ]
      }
    })
  }

  return features
}

const DEFAULT_PREFERENCES = {
  shade: 0.5,
  hills: 0.5,
  crossings: 0
}

// v2: the Comfort weights changed, so older saved slider values are ignored.
const PREFERENCES_STORAGE_KEY =
  'comfortwalk.preferences.v2'

function isCustomPreferences(preferences) {
  return Object.keys(DEFAULT_PREFERENCES).some(
    key =>
      Math.abs(
        preferences[key] - DEFAULT_PREFERENCES[key]
      ) > 0.001
  )
}

function loadPreferences() {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(
        PREFERENCES_STORAGE_KEY
      ) || 'null'
    )

    if (saved && typeof saved === 'object') {
      const read = (value, fallback) => {
        const number = Number(value)

        return Number.isFinite(number)
          ? Math.min(1, Math.max(0, number))
          : fallback
      }

      return {
        shade: read(saved.shade, DEFAULT_PREFERENCES.shade),
        hills: read(saved.hills, DEFAULT_PREFERENCES.hills),
        crossings: read(saved.crossings, DEFAULT_PREFERENCES.crossings)
      }
    }
  } catch {
    // storage can be unavailable; fall back to defaults
  }

  return { ...DEFAULT_PREFERENCES }
}

const PREFERENCE_SLIDERS = [
  { key: 'shade', icon: '🌳', label: 'Shade', low: 'Ignore', high: 'Max' },
  { key: 'hills', icon: '⛰️', label: 'Avoid hills', low: 'Ignore', high: 'Flattest' },
  { key: 'crossings', icon: '🚸', label: 'Avoid crosswalks', low: 'Ignore', high: 'Fewest' }
]

// Plain-language effort label, from how much climbing the route has per
// kilometre and how steep its steepest stretch is. (Total energy is not
// used: the energy model credits downhill, so a hilly route that ends
// where it started on level ground still scores close to flat.)
function getEffortLevel(route) {
  const distanceKm =
    Number(route?.distanceMeters) / 1000
  const ascent = Number(
    route?.totalAscentMeters
  )
  const maxGrade = Number(
    route?.maximumGradePercent
  )

  if (
    !Number.isFinite(distanceKm) ||
    distanceKm <= 0 ||
    !Number.isFinite(ascent)
  ) {
    return null
  }

  // Almost no climbing at all: always easy.
  if (ascent < 8) {
    return { key: 'easy', text: 'Easy' }
  }

  const climbPerKm = ascent / distanceKm

  let level =
    climbPerKm < 12
      ? 0
      : climbPerKm < 30
        ? 1
        : 2

  // One very steep block makes a walk harder than its average suggests.
  if (maxGrade >= 15 && level < 2) {
    level += 1
  }

  return [
    { key: 'easy', text: 'Easy' },
    { key: 'moderate', text: 'Moderate' },
    { key: 'hard', text: 'Hard' }
  ][level]
}

const INTRO_STORAGE_KEY =
  'comfortwalk.introSeen.v1'

function readIntroSeen() {
  try {
    return (
      window.localStorage.getItem(
        INTRO_STORAGE_KEY
      ) === '1'
    )
  } catch {
    return false
  }
}

function writeIntroSeen() {
  try {
    window.localStorage.setItem(
      INTRO_STORAGE_KEY,
      '1'
    )
  } catch {
    // storage unavailable: the panel just shows again next visit
  }
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

  if (
    routeId === 'comfort'
  ) {
    return 'Tuned to your settings'
  }

  return 'Minimum modeled energy'
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
    route.minutes -
    shortest.minutes

  const ascentDifference =
    route.totalAscentMeters -
    shortest.totalAscentMeters

  const energyDifference =
    shortest.energyKJPerKg > 0
      ? (
          (
            route.energyKJPerKg -
            shortest.energyKJPerKg
          ) /
          shortest.energyKJPerKg
        ) *
        100
      : 0

  const timeText =
    Math.abs(
      timeDifference
    ) < 0.05
      ? 'same time'
      : `${
          timeDifference > 0
            ? '+'
            : '−'
        }${Math.abs(
          timeDifference
        ).toFixed(1)} min`

  const climbText =
    Math.abs(
      ascentDifference
    ) < 0.5
      ? 'same climb'
      : `${
          ascentDifference < 0
            ? '−'
            : '+'
        }${Math.round(
          Math.abs(
            ascentDifference
          )
        )} m climb`

  const energyText =
    Math.abs(
      energyDifference
    ) < 0.1
      ? 'same energy'
      : `${
          energyDifference < 0
            ? '−'
            : '+'
        }${Math.abs(
          energyDifference
        ).toFixed(1)}% energy`

  const canopyDifference =
    Number(route.treeCoverPercent || 0) -
    Number(shortest.treeCoverPercent || 0)

  const canopyText =
    Math.abs(canopyDifference) < 0.5
      ? 'same tree cover'
      : `${canopyDifference > 0 ? '+' : '−'}${Math.abs(canopyDifference).toFixed(0)}% tree cover`

  return (
    `${timeText} · ${climbText} · ${energyText} · ${canopyText}`
  )
}

const WHY_BASELINE_LABEL =
  'fastest'

// Number(null) is 0, which would hide missing data as "0 m".
function numberOrNaN(value) {
  return value === null ||
    value === undefined ||
    value === ''
    ? NaN
    : Number(value)
}

function getComfortReasons(
  route,
  baseline
) {
  if (
    !route ||
    !baseline ||
    route.id !== 'comfort' ||
    route === baseline
  ) {
    return []
  }

  const reasons = []

  // Both lines always appear, each with the real numbers behind it.

  // ---- Shade ----
  const shadeKnown =
    route.canopyDataAvailable !==
      false &&
    baseline.canopyDataAvailable !==
      false &&
    Number.isFinite(
      numberOrNaN(
        route.treeCoverPercent
      )
    ) &&
    Number.isFinite(
      numberOrNaN(
        baseline.treeCoverPercent
      )
    )

  if (!shadeKnown) {
    reasons.push({
      icon: '🌳',

      good: false,

      text:
        'Shade: tree data unavailable'
    })
  } else {
    const routeShade =
      Number(
        route.treeCoverPercent
      )

    const baselineShade =
      Number(
        baseline.treeCoverPercent
      )


    if (baselineShade < 0.5) {
      reasons.push({
        icon: '🌳',

        good:
          routeShade >=
          baselineShade,

        text:
          routeShade < 0.5
            ? `No shade on either route`
            : `${routeShade.toFixed(
                1
              )}% shaded (${WHY_BASELINE_LABEL} has almost none)`
      })
    } else {
      const shadeChange =
        (
          (
            routeShade -
            baselineShade
          ) /
          baselineShade
        ) *
        100

      const shadeSize =
        Math.abs(shadeChange)

      reasons.push({
        icon: '🌳',

        good:
          shadeChange >= 0,

        text:
          shadeSize < 0.5
            ? `Same shade as ${WHY_BASELINE_LABEL}`
            : `${
                shadeSize < 10
                  ? shadeSize.toFixed(
                      1
                    )
                  : Math.round(
                      shadeSize
                    )
              }% ${
                shadeChange > 0
                  ? 'more'
                  : 'less'
              } shade than ${WHY_BASELINE_LABEL}`
      })
    }
  }

  // ---- Hills ----
  const routeClimb =
    numberOrNaN(
      route.totalAscentMeters
    )

  const baselineClimb =
    numberOrNaN(
      baseline.totalAscentMeters
    )

  if (
    !Number.isFinite(
      routeClimb
    ) ||
    !Number.isFinite(
      baselineClimb
    )
  ) {
    reasons.push({
      icon: '⛰️',

      good: false,

      text:
        'Hill: elevation data unavailable'
    })
  } else {

    if (baselineClimb < 1) {
      reasons.push({
        icon: '⛰️',

        good:
          routeClimb < 1,

        text:
          routeClimb < 1
            ? `Flat, same as ${WHY_BASELINE_LABEL}`
            : `${routeClimb.toFixed(
                0
              )} m of climb (${WHY_BASELINE_LABEL} is flat)`
      })
    } else {
      const climbChange =
        (
          (
            baselineClimb -
            routeClimb
          ) /
          baselineClimb
        ) *
        100

      const climbSize =
        Math.abs(climbChange)

      reasons.push({
        icon: '⛰️',

        good:
          climbChange >= 0,

        text:
          climbSize < 0.5
            ? `Same hill as ${WHY_BASELINE_LABEL}`
            : `${
                climbSize < 10
                  ? climbSize.toFixed(
                      1
                    )
                  : Math.round(
                      climbSize
                    )
              }% ${
                climbChange > 0
                  ? 'less'
                  : 'more'
              } hill than ${WHY_BASELINE_LABEL}`
      })
    }
  }

  return reasons
}

function maneuverSymbol(
  modifier
) {
  if (
    modifier === 'left'
  ) {
    return '↰'
  }

  if (
    modifier === 'right'
  ) {
    return '↱'
  }

  if (
    modifier === 'slight-left'
  ) {
    return '↖'
  }

  if (
    modifier === 'slight-right'
  ) {
    return '↗'
  }

  if (
    modifier === 'sharp-left'
  ) {
    return '←'
  }

  if (
    modifier === 'sharp-right'
  ) {
    return '→'
  }

  if (
    modifier === 'arrive'
  ) {
    return '●'
  }

  return '↑'
}

// ============================================================
// ELEVATION GRAPH
// ============================================================

function ElevationProfile({
  route
}) {
  const profile =
    route?.elevationProfile

  if (
    !Array.isArray(
      profile
    ) ||
    profile.length < 2
  ) {
    return null
  }

  const width = 1000
  const height = 145

  const topPadding = 10
  const bottomPadding = 12

  const elevations =
    profile.map(
      point =>
        Number(
          point.elevationMeters
        )
    )

  let minimumElevation =
    Math.min(
      ...elevations
    )

  let maximumElevation =
    Math.max(
      ...elevations
    )

  if (
    maximumElevation -
      minimumElevation <
    5
  ) {
    maximumElevation += 2.5
    minimumElevation -= 2.5
  }

  const elevationRange =
    maximumElevation -
    minimumElevation

  const totalDistance =
    Math.max(
      1,
      profile[
        profile.length - 1
      ].distanceMeters
    )

  function xFor(
    point
  ) {
    return (
      point.distanceMeters /
      totalDistance *
      width
    )
  }

  function yFor(
    point
  ) {
    const ratio =
      (
        point.elevationMeters -
        minimumElevation
      ) /
      elevationRange

    return (
      height -
      bottomPadding -
      ratio *
      (
        height -
        topPadding -
        bottomPadding
      )
    )
  }

  const areaPoints = [
    `0,${height}`,

    ...profile.map(
      point =>
        `${xFor(point)},${yFor(point)}`
    ),

    `${width},${height}`
  ].join(' ')

  const middleDistance =
    totalDistance /
    2 /
    METERS_PER_MILE

  const totalMiles =
    totalDistance /
    METERS_PER_MILE

  return (
    <div
      className="elevation-panel"
    >
      <div
        className="elevation-header"
      >
        <div>
          <strong>
            Elevation profile
          </strong>

          <span>
            {route.label}
          </span>
        </div>

        <div
          className="steep-legend"
        >
          <span
            className="steep-legend-line"
          />

          ≥{' '}
          {route.steepThresholdPercent ||
            10}
          % grade
        </div>
      </div>

      <div
        className="elevation-chart"
      >
        <div
          className="elevation-max"
        >
          {Math.round(
            maximumElevation
          )}
          {' '}m
        </div>

        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
          <polygon
            className="elevation-area"
            points={
              areaPoints
            }
          />

          {profile
            .slice(1)
            .map(
              (
                point,
                index
              ) => {
                const previous =
                  profile[index]

                return (
                  <line
                    key={
                      index
                    }

                    x1={
                      xFor(
                        previous
                      )
                    }

                    y1={
                      yFor(
                        previous
                      )
                    }

                    x2={
                      xFor(
                        point
                      )
                    }

                    y2={
                      yFor(
                        point
                      )
                    }

                    className={
                      point.steep
                        ? 'elevation-line elevation-line-steep'
                        : 'elevation-line'
                    }
                  />
                )
              }
            )}
        </svg>

        <div
          className="elevation-min"
        >
          {Math.round(
            minimumElevation
          )}
          {' '}m
        </div>
      </div>

      <div
        className="elevation-axis"
      >
        <span>
          0 mi
        </span>

        <span>
          {middleDistance.toFixed(
            1
          )}
          {' '}mi
        </span>

        <span>
          {totalMiles.toFixed(
            1
          )}
          {' '}mi
        </span>
      </div>
    </div>
  )
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

  const navigationStartedRef =
    useRef(false)

  const selectedRouteRef =
    useRef(null)

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
    navigationProgressMeters,
    setNavigationProgressMeters
  ] =
    useState(0)

  const [
    distanceToRouteMeters,
    setDistanceToRouteMeters
  ] =
    useState(0)

  const [
    activeManeuverIndex,
    setActiveManeuverIndex
  ] =
    useState(0)

    const [
    errorMessage,
    setErrorMessage
  ] =
    useState('')

  const [
    preferences,
    setPreferences
  ] =
    useState(loadPreferences)

  const [
    sheetCollapsed,
    setSheetCollapsed
  ] =
    useState(false)

  const [introOpen, setIntroOpen] =
    useState(() => !readIntroSeen())

  const closeIntro = () => {
    writeIntroSeen()
    setIntroOpen(false)
  }

  const preferencesRef =
    useRef(preferences)

    const preferencesFirstRunRef =
    useRef(true)

    const routeRequestIdRef =
    useRef(0)

  const crosswalkMarkersRef =
    useRef([])

  const selectedRoute =
    useMemo(
      () =>
        routes.find(
          route =>
            route.id ===
            selectedRouteId
        ) ||
        routes[0] ||
        null,

      [
        routes,
        selectedRouteId
      ]
    )

  // True when every route follows exactly the same streets.
  // The server removes pathFingerprint before replying and instead sets
  // samePathAs on any route that repeats an earlier route's streets.
  const allRoutesSame =
    routes.length > 1 &&
    routes
      .slice(1)
      .every(route => Boolean(route.samePathAs))

  const shortestRoute =
    useMemo(
      () =>
        routes.find(
          route =>
            route.id ===
            'shortest'
        ) ||
        routes[0] ||
        null,

      [
        routes
      ]
    )

  // When a slider changes, remember it and (after a short pause) get new routes.
  useEffect(() => {
    preferencesRef.current =
      preferences

    try {
      window.localStorage.setItem(
        PREFERENCES_STORAGE_KEY,
        JSON.stringify(preferences)
      )
    } catch {
      // storage can be unavailable
    }

    if (preferencesFirstRunRef.current) {
      preferencesFirstRunRef.current =
        false

      return undefined
    }

    const current =
      currentLocationRef.current

    if (
      !destination ||
      !current ||
      routes.length === 0
    ) {
      return undefined
    }

    const timer = setTimeout(
      () => {
        calculateRoutes(
          current,
          destination,
          { keepSelection: true }
        )
      },
      700
    )

    return () =>
      clearTimeout(timer)
    // Only re-run when the sliders move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences])

  useEffect(
    () => {
      navigationStartedRef.current =
        navigationStarted
    },
    [
      navigationStarted
    ]
  )

  useEffect(
    () => {
      selectedRouteRef.current =
        selectedRoute
    },
    [
      selectedRoute
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
                type: 'raster',

                tiles: [
                  'https\://tile.openstreetmap.org/{z}/{x}/{y}.png'
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

        mapRef.current =
          null
      }
    },
    []
  )

  // ============================================================
  // MAP LAYERS
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
        ALL_ROUTES_SOURCE_ID
      )
    ) {
      map.addSource(
        ALL_ROUTES_SOURCE_ID,
        {
          type: 'geojson',

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

        type: 'line',

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

        type: 'line',

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

            'comfort',
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
          type: 'geojson',

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

        type: 'line',

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

        type: 'line',

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

            'comfort',
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

    if (
      !map.getSource(
        STEEP_ROUTE_SOURCE_ID
      )
    ) {
      map.addSource(
        STEEP_ROUTE_SOURCE_ID,
        {
          type: 'geojson',

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
        STEEP_ROUTE_LINE_ID
      )
    ) {
      map.addLayer({
        id:
          STEEP_ROUTE_LINE_ID,

        type: 'line',

        source:
          STEEP_ROUTE_SOURCE_ID,

        layout: {
          'line-cap':
            'round',

          'line-join':
            'round'
        },

        paint: {
          'line-color':
            '#ff9500',

          'line-width':
            8,

          'line-opacity':
            0.92
        }
      })
    }
  }

  // ============================================================
  // DRAW ROUTES
  // ============================================================

  function updateSteepLayer(
    route
  ) {
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
        STEEP_ROUTE_SOURCE_ID
      )

    if (!source) {
      return
    }

    source.setData({
      type:
        'FeatureCollection',

      features:
        steepFeaturesForRoute(
          route
        )
    })
  }

  function clearCrosswalkMarkers() {
    for (
      const marker
      of crosswalkMarkersRef.current
    ) {
      marker.remove()
    }

    crosswalkMarkersRef.current =
      []
  }

  // Purple dots on the map show every crosswalk counted for this route.
  function showCrosswalkMarkers(
    route
  ) {
    clearCrosswalkMarkers()

    const map =
      mapRef.current

    if (
      !map ||
      !Array.isArray(
        route?.crosswalks
      )
    ) {
      return
    }

    for (
      const crossing
      of route.crosswalks
    ) {
      const element =
        document.createElement(
          'div'
        )

      element.className =
        'crosswalk-dot'

      element.title =
        crossing.type ===
        'marked'
          ? 'Marked crosswalk'
          : 'Street crossing'

      crosswalkMarkersRef.current
        .push(
          new maplibregl.Marker({
            element
          })
            .setLngLat([
              crossing.lon,
              crossing.lat
            ])
            .addTo(map)
        )
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

    const allSource =
      map.getSource(
        ALL_ROUTES_SOURCE_ID
      )

    const selectedSource =
      map.getSource(
        SELECTED_ROUTE_SOURCE_ID
      )

    if (allSource) {
      allSource.setData({
        type:
          'FeatureCollection',

        features:
          allRoutes.map(
            route =>
              routeToFeature(
                route
              )
          )
      })
    }

    if (
      selectedSource
    ) {
      selectedSource.setData(
        routeToFeature(
          selected
        )
      )
    }

        updateSteepLayer(
      selected
    )

    showCrosswalkMarkers(
      selected
    )
  }

  function drawNavigationRoute(
    route
  ) {
    const map =
      mapRef.current

    if (
      !map ||
      !route
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

    if (
      selectedSource
    ) {
      selectedSource.setData(
        routeToFeature(
          route
        )
      )
    }

    updateSteepLayer(
      route
    )
  }

    function clearRoutes() {
    clearCrosswalkMarkers()

    const map =
      mapRef.current

    if (
      !map ||
      !map.isStyleLoaded()
    ) {
      return
    }

    const sourceIds = [
      ALL_ROUTES_SOURCE_ID,
      SELECTED_ROUTE_SOURCE_ID,
      STEEP_ROUTE_SOURCE_ID
    ]

    for (
      const sourceId
      of sourceIds
    ) {
      const source =
        map.getSource(
          sourceId
        )

      if (source) {
        source.setData({
          type:
            'FeatureCollection',

          features: []
        })
      }
    }
  }

  // Space at the bottom of the map that the route sheet covers. Uses the
  // sheet's real height when it is on screen, otherwise the height the CSS
  // will give it, but always leaves at least 200px of map for the route.
  function getSheetPaddingPx(map) {
    const mapHeight =
      map.getContainer().clientHeight

    const sheetElement =
      document.querySelector(
        '.route-sheet'
      )

    const sheetHeight =
      sheetElement
        ? sheetElement.offsetHeight
        : window.innerWidth <= 600
          ? mapHeight * 0.68
          : Math.min(
              mapHeight - 120,
              560
            )

    return Math.round(
      Math.max(
        90,
        Math.min(
          sheetHeight + 24,
          mapHeight - 115 - 200
        )
      )
    )
  }

  function fitRoute(
    route
  ) {
    const map =
      mapRef.current

    if (
      !map ||
      !route
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
      bounds.extend(
        coordinate
      )
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

          bottom:
            getSheetPaddingPx(map),

          left: 55,

          right: 55
        },

        maxZoom: 17,

        duration: 650
      }
    )
  }

  // ============================================================
  // NAVIGATION PROGRESS
  // ============================================================

  function updateNavigationProgress(
    location,
    route
  ) {
    if (
      !route ||
      !Array.isArray(
        route.coordinates
      )
    ) {
      return
    }

    const projection =
      projectLocationToRoute(
        location,
        route.coordinates
      )

    if (!projection) {
      return
    }

    setNavigationProgressMeters(
      projection.progressMeters
    )

    setDistanceToRouteMeters(
      projection.distanceToRouteMeters
    )

    const maneuvers =
      route.maneuvers || []

    let activeIndex = 0

    for (
      let index = 0;
      index <
        maneuvers.length;
      index++
    ) {
      if (
        projection.progressMeters >=
        maneuvers[
          index
        ].cumulativeDistanceMeters -
        12
      ) {
        activeIndex = index
      }
    }

    setActiveManeuverIndex(
      activeIndex
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
        navigator.geolocation
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

              if (
                navigationStartedRef.current &&
                selectedRouteRef.current
              ) {
                updateNavigationProgress(
                  location,
                  selectedRouteRef.current
                )
              }
            },

            error => {
              console.log(
                'LOCATION ERROR:',
                error
              )
            },

            {
              enableHighAccuracy:
                true,

              maximumAge:
                1500,

              timeout:
                15000
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
      }
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

    if (
      navigationStartedRef.current
    ) {
      map.easeTo({
        center: [
          location.longitude,
          location.latitude
        ],

        duration: 400
      })
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

              if (!response.ok) {
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
    setNavigationStarted(false)

    clearRoutes()

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

    setDestination(selected)

    setSearch(
      selected.name
    )

    setRoutes([])

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
    end,
        options = {}
  ) {
    const requestId =
      ++routeRequestIdRef.current

    setRouteLoading(true)
    setErrorMessage('')

    try {
      const response =
        await fetch(
          '/api/route',
          {
            method: 'POST',

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
                },
                preferences:
                  preferencesRef.current
              })
          }
        )

            const data =
        await response.json()

      // A newer request (for example another slider move) replaced this one.
      if (
        requestId !==
        routeRequestIdRef.current
      ) {
        return
      }

      if (!response.ok) {
        throw new Error(
          data.error ||
          'Could not calculate routes.'
        )
      }

      const validRoutes =
        data.routes.filter(
          route =>
            Array.isArray(
              route.coordinates
            ) &&
            route.coordinates.length >
              1
        )

      if (
        validRoutes.length === 0
      ) {
        throw new Error(
          'No valid routes returned.'
        )
      }

            setRoutes(
        validRoutes
      )

      const keptRoute =
        options.keepSelection
          ? validRoutes.find(
              route =>
                route.id ===
                selectedRouteId
            )
          : null

      const shortest =
        keptRoute ||
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

      // Don't move the map when only a slider changed.
      if (!keptRoute) {
        fitRoute(
          shortest
        )
      }

      console.log(
        'ELEVATION PROFILE:',
        shortest.elevationProfile
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
      if (
        requestId ===
        routeRequestIdRef.current
      ) {
        setRouteLoading(false)
      }
    }
  }

  function selectRoute(
    route
  ) {
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
    if (!selectedRoute) {
      return
    }

    setNavigationStarted(true)

    setActiveManeuverIndex(0)

    setNavigationProgressMeters(0)

    drawNavigationRoute(
      selectedRoute
    )

    const current =
      currentLocationRef.current

    if (current) {
      updateNavigationProgress(
        current,
        selectedRoute
      )

      mapRef.current.flyTo({
        center: [
          current.longitude,
          current.latitude
        ],

        zoom: 17.5,

        duration: 700
      })
    }
  }

  function stopNavigation() {
    setNavigationStarted(false)

    drawRoutes(
      routes,
      selectedRoute
    )

    fitRoute(
      selectedRoute
    )
  }

  const maneuvers =
    selectedRoute
      ?.maneuvers || []

  const currentManeuver =
    maneuvers[
      activeManeuverIndex
    ] ||
    maneuvers[0] ||
    null

  const nextManeuver =
    maneuvers[
      Math.min(
        activeManeuverIndex + 1,
        maneuvers.length - 1
      )
    ] ||
    currentManeuver

  const distanceToNextManeuver =
    nextManeuver
      ? Math.max(
          0,

          nextManeuver
            .cumulativeDistanceMeters -
          navigationProgressMeters
        )
      : 0

  const remainingDistance =
    selectedRoute
      ? Math.max(
          0,

          selectedRoute
            .distanceMeters -
          navigationProgressMeters
        )
      : 0

  const remainingMinutes =
    remainingDistance /
    WALKING_SPEED_METERS_PER_SECOND /
    60

  const offRoute =
    navigationStarted &&
    distanceToRouteMeters >
      40

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
                event => {
                  searchLockedRef.current =
                    false

                  setSearch(
                    event.target.value
                  )
                }
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
                  type="button"

                  className="search-clear"

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
          Calculating routes...
        </div>
      )}

      {!navigationStarted && (
        introOpen ? (
          <aside
            className="intro-panel"
            aria-label="About Comfort Walk"
          >
            <button
              type="button"
              className="intro-close"
              onClick={closeIntro}
              aria-label="Close"
            >
              ✕
            </button>

            <h2>Comfort Walk</h2>

            <p className="intro-lead">
              Walking routes for San Francisco
              that spare your legs: fewer hills,
              more shade, fewer street crossings.
            </p>

            <h3>How to use it</h3>

            <ol>
              <li>
                <strong>Search</strong> for a
                destination in the box at the top.
                Your start is your current
                location.
              </li>
              <li>
                Three routes appear:{' '}
                <strong>Shortest</strong>,{' '}
                <strong>Balanced</strong> and{' '}
                <strong>Comfort</strong>. Tap a
                card to see it on the map.
              </li>
              <li>
                Open{' '}
                <strong>
                  ⚙️ Comfort route settings
                </strong>{' '}
                to choose how much you care about
                shade, hills and crossings.
              </li>
              <li>
                Tap <strong>Start</strong> for
                turn-by-turn directions.
              </li>
            </ol>

            <h3>Reading the numbers</h3>

            <ul>
              <li>
                <strong>Easy / Moderate / Hard</strong>{' '}
                reflects how much uphill the route
                has for its length and how steep
                its steepest stretch is.
              </li>
              <li>
                <strong>🌳 Tree cover</strong> is
                the share of the route under tree
                canopy.
              </li>
              <li>
                <strong>🚸</strong> is the number
                of street crossings.
              </li>
              <li>
                Orange parts of the elevation
                chart are steep.
              </li>
            </ul>

            <p className="intro-note">
              Tree data covers San Francisco only,
              and the routes only differ where
              there are hills or trees. Try a
              destination across a hilly area such
              as Nob Hill.
            </p>

            <button
              type="button"
              className="intro-ok"
              onClick={closeIntro}
            >
              Got it
            </button>
          </aside>
        ) : (
          <button
            type="button"
            className="intro-help"
            onClick={() =>
              setIntroOpen(true)
            }
            aria-label="How to use Comfort Walk"
          >
            ?
          </button>
        )
      )}

      {routes.length >
        0 &&
        !navigationStarted && (
          <div
            className={
              sheetCollapsed
                ? 'route-sheet route-sheet-collapsed'
                : 'route-sheet'
            }
          >
            <div
              className="sheet-handle"
            >
              {sheetCollapsed && (
                <span
                  className="sheet-handle-summary"
                >
                  {selectedRoute
                    ? `${selectedRoute.label} · ${formatTime(
                        selectedRoute.minutes
                      )} · ${selectedRoute.distanceMiles.toFixed(
                        2
                      )} mi · 🚸 ${
                        selectedRoute.crosswalkCount ?? 0
                      }`
                    : 'Routes'}
                </span>
              )}

              <button
                type="button"
                className="sheet-toggle"
                onClick={() =>
                  setSheetCollapsed(
                    previous => !previous
                  )
                }
              >
                {sheetCollapsed
                  ? '▲ Show routes'
                  : '▼ Hide'}
              </button>

              {sheetCollapsed && (
                <button
                  type="button"
                  className="start-button sheet-start-compact"
                  onClick={
                    startNavigation
                  }
                >
                  Start
                </button>
              )}
            </div>

            {!sheetCollapsed && (
              <>
            <details
              className="prefs"
            >
              <summary
                className="prefs-summary"
              >
                ⚙️ Comfort route settings
                {isCustomPreferences(
                  preferences
                ) && ' · custom'}
              </summary>

              <div
                className="prefs-body"
              >
                {PREFERENCE_SLIDERS.map(
                  slider => (
                    <label
                      key={slider.key}
                      className="pref-row"
                    >
                      <span
                        className="pref-label"
                      >
                        {slider.icon}{' '}
                        {slider.label}
                      </span>

                      <input
                        type="range"
                        className="pref-slider"
                        min="0"
                        max="100"
                        step="5"
                        value={Math.round(
                          preferences[
                            slider.key
                          ] * 100
                        )}
                        onChange={event =>
                          setPreferences(
                            previous => ({
                              ...previous,
                              [slider.key]:
                                Number(
                                  event
                                    .target
                                    .value
                                ) / 100
                            })
                          )
                        }
                      />

                      <span
                        className="pref-scale"
                      >
                        <span>
                          {slider.low}
                        </span>

                        <span>
                          {slider.high}
                        </span>
                      </span>
                    </label>
                  )
                )}

                <button
                  type="button"
                  className="pref-reset"
                  onClick={() =>
                    setPreferences({
                      ...DEFAULT_PREFERENCES
                    })
                  }
                >
                  Reset
                </button>
              </div>
            </details>

            {allRoutesSame && (
              <div
                className="route-same"
              >
                <strong>
                  All routes are the same here
                </strong>
                <span>
                  The shortest way is also the
                  easiest. Try a trip with hills
                  or trees along the way to see
                  the routes differ.
                </span>
              </div>
            )}

            <div
              className={
                allRoutesSame
                  ? 'route-options route-options-single'
                  : 'route-options'
              }
            >
              {(allRoutesSame
                ? routes.slice(0, 1)
                : routes
              ).map(
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
                          selectedRouteId ||
                        allRoutesSame
                          ? 'route-option-selected'
                          : ''
                      ]
                        .filter(Boolean)
                        .join(' ')
                    }

                    onClick={
                      () =>
                        selectRoute(
                          route
                        )
                    }
                  >
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
                                            {route.distanceMiles.toFixed(
                        2
                      )}
                      {' '}mi
                    </div>

                    {getEffortLevel(
                      route
                    ) && (
                      <div
                        className={`route-option-effort effort-${
                          getEffortLevel(
                            route
                          ).key
                        }`}
                      >
                        {
                          getEffortLevel(
                            route
                          ).text
                        } walk
                      </div>
                    )}

                    <div
                      className="route-option-crossings"
                    >
                      🚸{' '}
                      {route.crosswalkCount ?? 0}
                    </div>

                    <div
                      className="route-tradeoff"
                    >
                      {getTradeoffText(
                        route,
                        shortestRoute
                      )}
                    </div>

                    {route.id ===
                      'comfort' &&
                      route.eased && (
                        <div
                          className="route-eased"
                        >
                          {route.easedReason ===
                          'shade'
                            ? 'ℹ️ Eased crosswalk avoidance to keep more shade'
                            : 'ℹ️ Eased to avoid a big detour or climb'}
                        </div>
                      )}

                    {route.id ===
                      'comfort' && (
                      <div
                        className="route-why"
                      >
                        {getComfortReasons(
                          route,
                          shortestRoute
                        ).map(
                          reason => (
                            <div
                              key={
                                reason.text
                              }

                              className={
                                reason.good
                                  ? 'route-why-line route-why-good'
                                  : 'route-why-line route-why-bad'
                              }
                            >
                              <span
                                aria-hidden="true"
                              >
                                {reason.icon}
                              </span>

                              {' '}

                              {reason.text}
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </button>
                )
              )}
            </div>

            {selectedRoute && (
              <>
                <div
                  className="route-details"
                >
                  <div
                    className="route-detail"
                  >
                    <strong>
                      ↑{' '}
                      {selectedRoute.totalAscentMeters.toFixed(
                        0
                      )}
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
                      {selectedRoute.averageGradePercent.toFixed(
                        1
                      )}
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
                      {selectedRoute.maximumGradePercent.toFixed(
                        1
                      )}
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
                      {selectedRoute.energyKJPerKg.toFixed(
                        2
                      )}
                    </strong>

                    <span>
                      kJ/kg
                    </span>

                    {getEffortLevel(
                      selectedRoute
                    ) && (
                      <em
                        className={`effort-badge effort-${
                          getEffortLevel(
                            selectedRoute
                          ).key
                        }`}
                      >
                        {
                          getEffortLevel(
                            selectedRoute
                          ).text
                        }
                      </em>
                    )}
                  </div>

                  <div
                    className="route-detail"
                  >
                    <strong>
                      🌳{' '}
                      {Number(
                        selectedRoute.treeCoverPercent || 0
                      ).toFixed(0)}%
                    </strong>

                                        <span>
                      Tree cover
                    </span>
                  </div>

                  <div
                    className="route-detail"
                  >
                    <strong>
                      🚸{' '}
                      {selectedRoute.crosswalkCount ?? 0}
                    </strong>

                    <span>
                      Crosswalks
                    </span>
                  </div>
                </div>

                <ElevationProfile
                  route={
                    selectedRoute
                  }
                />
              </>
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
              </>
            )}
          </div>
        )}

      {navigationStarted &&
        selectedRoute && (
          <>
            <div
              className={
                offRoute
                  ? 'navigation-instruction navigation-instruction-offroute'
                  : 'navigation-instruction'
              }
            >
              <div
                className="navigation-arrow"
              >
                {maneuverSymbol(
                  nextManeuver
                    ?.modifier
                )}
              </div>

              <div
                className="navigation-instruction-main"
              >
                <div
                  className="navigation-distance"
                >
                  {offRoute
                    ? 'Off route'
                    : formatNavigationDistance(
                        distanceToNextManeuver
                      )}
                </div>

                <div
                  className="navigation-instruction-text"
                >
                  {offRoute
                    ? 'Return to the highlighted route'
                    : nextManeuver
                        ?.instruction ||
                      'Continue'}
                </div>

                {currentManeuver
                  ?.streetName && (
                  <div
                    className="navigation-current-street"
                  >
                    On{' '}
                    {currentManeuver.streetName}
                  </div>
                )}
              </div>
            </div>

            <div
              className="navigation-bottom"
            >
              <div
                className="navigation-stat"
              >
                <strong>
                  {formatTime(
                    remainingMinutes
                  )}
                </strong>

                <span>
                  remaining
                </span>
              </div>

              <div
                className="navigation-stat"
              >
                <strong>
                  {formatNavigationDistance(
                    remainingDistance
                  )}
                </strong>

                <span>
                  distance
                </span>
              </div>

              <div
                className="navigation-stat"
              >
                <strong>
                  {selectedRoute.label}
                </strong>

                <span>
                  route
                </span>
              </div>

              <button
                type="button"

                className="end-navigation-button"

                onClick={
                  stopNavigation
                }
              >
                End
              </button>
            </div>
          </>
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