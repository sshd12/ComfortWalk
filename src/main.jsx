import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import {
  setWorkerUrl
} from 'maplibre-gl'

import workerUrl
  from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

import './index.css'

import App from './App.jsx'

setWorkerUrl(
  workerUrl
)

createRoot(
  document.getElementById('root')
).render(
  <StrictMode>
    <App />
  </StrictMode>
)