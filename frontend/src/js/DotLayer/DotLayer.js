/*
  DotLayer Efrem Rensi, 2020,
*/
import { Layer, DomUtil, Browser, setOptions } from "../myLeaflet.js"
import { Control } from "../myLeaflet.js"

import * as ViewBox from "./ViewBox.js"
import * as ActivityCollection from "./ActivityCollection.js"
import { PixelGraphics } from "./PixelGraphics.js"
import { MAP_INFO } from "../Env.js"
import { nextTask, nextAnimationFrame } from "../appUtil.js"
import { vParams } from "../Model.js"
// import * as WorkerPool from "./WorkerPool.js"

const DEBUG_BORDERS = true

import {
  options as defaultOptions,
  dotSettings as _dotSettings,
} from "./Defaults.js"

export { _dotSettings as dotSettings }

const TARGET_FPS = 30
/* In order to prevent path redraws from happening too often
 * and hogging up CPU cycles we set a minimum delay between redraws
 */
const FORCE_FULL_REDRAW = false
const CONTINUOUS_PAN_REDRAWS = true
const CONTINUOUS_PINCH_REDRAWS = true
const MIN_PAN_REDRAW_DELAY = 200 // milliseconds
const MIN_PINCH_REDRAW_DELAY = 100

let dotCanvas, pathCanvas, debugCanvas

const dotCanvasPane = "shadowPane"
const pathCanvasPane = "overlayPane"
const debugCanvasPane = "overlayPane"

let _map, _options
let _ready

let _gifPatch
let _lastRedraw = 0

/*
 * Displays for debugging
 */
let _infoBox
const InfoViewer = Control.extend({
  onAdd: function () {
    _infoBox = DomUtil.create("div")
    _infoBox.style.width = "200px"
    _infoBox.style.padding = "5px"
    _infoBox.style.background = "rgba(50,50,240,0.6)"
    _infoBox.style.textAlign = "left"
    _infoBox.innerHTML = "dotLayer infoBox"
    return _infoBox
  },
})

export const DotLayer = Layer.extend({
  options: defaultOptions,
  dotSettings: _dotSettings,
  updateDotSettings: updateDotSettings,
  redraw: redraw,
  animate: animate,

  // -- initialized is called on prototype
  initialize: function (options) {
    setOptions(this, options)
    _options = this.options
    _paused = _options.startPaused
    if (_paused) this.pause()
    // WorkerPool.initialize(_options.numWorkers)
  },

  //-------------------------------------------------------------
  onAdd: function (map) {
    _map = map
    ViewBox.canvases.length = 0

    // dotlayer canvas
    dotCanvas = addCanvasOverlay(dotCanvasPane)
    const { width: dw, height: dh } = dotCanvas
    dotCanvas.pxg = new PixelGraphics(
      dotCanvas.getContext("2d").createImageData(dw, dh)
    )

    /*
     * The Path Canvas is for activity paths, which are made up of a bunch of
     * segments.
     */
    pathCanvas = addCanvasOverlay(pathCanvasPane)
    const { width: pw, height: ph } = pathCanvas

    pathCanvas.pxg = new PixelGraphics(
      pathCanvas.getContext("2d").createImageData(pw, ph)
    )

    if (DEBUG_BORDERS) {
      // create Canvas for debugging canvas stuff
      debugCanvas = addCanvasOverlay(debugCanvasPane)
      pathCanvas.pxg.debugCanvas = debugCanvas
      dotCanvas.pxg.debugCanvas = debugCanvas
      ActivityCollection.pxg.debugCanvas = debugCanvas
    }

    ViewBox.setMap(_map)
    map.on(assignEventHandlers(), this)

    if (MAP_INFO) {
      new InfoViewer().addTo(map)
    }
  },

  addTo: function (map) {
    map.addLayer(this)
    return this
  },

  //-------------------------------------------------------------
  onRemove: function (map) {
    map._panes[dotCanvasPane].removeChild(dotCanvas)
    map._panes[pathCanvasPane].removeChild(pathCanvas)

    if (DEBUG_BORDERS) {
      map._panes[debugCanvasPane].removeChild(debugCanvas)
      debugCanvas = null
    }

    map.off(assignEventHandlers(), this)
  },

  // -------------------------------------------------------------------

  // Call this function after items are added or removed
  reset: async function () {
    if (!ActivityCollection.items.size) return

    _ready = false

    ActivityCollection.reset()
    ViewBox.updateBounds()
    ViewBox.updateZoom()
    dotCtxUpdate()
    updateDotSettings()
    _ready = true
    await redraw(true)

    if (!_paused) this.animate()
  },

  // --------------------------------------------------------------------
  pause: function () {
    _paused = true
  },
})

export const dotLayer = function (options) {
  return new DotLayer(options)
}

/*
 *
 * Auxilliary functions
 *
 */
function addCanvasOverlay(pane) {
  const size = _map.getSize()
  const zoomAnimated = _map.options.zoomAnimation && Browser.any3d
  const canvas = DomUtil.create("canvas", "leaflet-layer")
  canvas.width = size.x
  canvas.height = size.y
  DomUtil.addClass(
    canvas,
    "leaflet-zoom-" + (zoomAnimated ? "animated" : "hide")
  )
  _map._panes[pane].appendChild(canvas)
  ViewBox.canvases.push(canvas)
  return canvas
}

function assignEventHandlers() {
  const events = {
    moveend: onMoveEnd,
    resize: onResize,
  }

  if (CONTINUOUS_PAN_REDRAWS) events.move = onMove
  if (CONTINUOUS_PINCH_REDRAWS) events.zoom = onZoom
  if (_map.options.zoomAnimation && Browser.any3d) {
    events.zoomanim = animateZoom
  }
  return events
}

function dotCtxUpdate() {
  const ctx = dotCanvas.getContext("2d")
  if (_options.dotShadows.enabled) {
    const shadowOpts = _options.dotShadows

    ctx.shadowOffsetX = shadowOpts.x
    ctx.shadowOffsetY = shadowOpts.y
    ctx.shadowBlur = shadowOpts.blur
    ctx.shadowColor = shadowOpts.color
  } else {
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
    ctx.shadowBlur = 0
  }
}

async function onResize() {
  const newMapSize = _map.getSize()
  const { x, y } = newMapSize
  const { width, height } = dotCanvas
  if (x === width && y === height) return

  ViewBox.resize(newMapSize)

  const { width: dw, height: dh } = dotCanvas
  dotCanvas.pxg = new PixelGraphics(
    dotCanvas.getContext("2d").createImageData(dw, dh)
  )
  dotCtxUpdate()

  /*
   * The Path Canvas is for activity paths, which are made up
   * of a bunch of segments.
   */
  const { width: pw, height: ph } = pathCanvas
  pathCanvas.pxg = new PixelGraphics(
    pathCanvas.getContext("2d").createImageData(pw, ph)
  )

  console.log("resized to ${x} x ${y}")

  await redraw(true)
}

async function onZoom(e) {
  if (!_map || !ViewBox.zoom) return

  // console.log("onzoom")

  if (e.pinch || e.flyTo) {
    const ts = Date.now()
    if (ts - _lastRedraw < MIN_PINCH_REDRAW_DELAY) {
      return
    }

    _lastRedraw = ts
    await redraw()
  }
}

/*
 * This gets called continuously as the user pans or zooms (without pinch)
 */
async function onMove() {
  // prevent redrawing more often than necessary
  const ts = Date.now()
  if (ts - _lastRedraw < MIN_PAN_REDRAW_DELAY) {
    return
  }

  _lastRedraw = ts
  await redraw()
}

/*
 * This gets called after a pan or zoom is done.
 * Leaflet moves the pixel origin so we need to reset the CSS transform
 */
async function onMoveEnd() {
  await redraw(true)
}

/*
 * This function redraws paths (and dots if paused),
 * also recalibrating the position of the canvases
 * over the map pane
 */
let _redrawing
async function redraw(force) {
  if (!_ready) return

  while (_redrawing) {
    console.log("awaiting next task")
    await nextTask()
  }

  _redrawing = true

  // reset the canvases to to align with the screen and update the ViewBox
  // location relative to the map's pxOrigin
  const { pxBounds, zoomChanged, shift } = ViewBox.update()

  if (!force && shift && !shift.x && !shift.y && !zoomChanged) {
    console.log("redraw: nothing to do!")
    _redrawing = false
    return
  }

  const fullRedraw = zoomChanged || FORCE_FULL_REDRAW || force

  // Erase the path and dot canvases, using their respective
  //  drawBounds rectangles. The underlying imageData buffers are
  //  still intact though
  for (const canvas of [pathCanvas, dotCanvas]) {
    const pxg = canvas.pxg
    pxg.transform = ViewBox.transform

    if (!pxg.drawBounds.isEmpty()) {
      const { x, y, w, h } = canvas.pxg.drawBounds.rect
      canvas.getContext("2d").clearRect(x, y, w, h)
    }
  }

  if (!fullRedraw) {
    if (_options.showPaths) {
      pathCanvas.pxg.translate(shift.x, shift.y)
      pathCanvas.pxg.putImageData(pathCanvas)
    }
    if (_paused) {
      dotCanvas.pxg.translate(shift.x, shift.y)
      dotCanvas.pxg.putImageData(dotCanvas)
    }
  }

  await ActivityCollection.updateContext(pxBounds, ViewBox.zoom)

  if (_options.showPaths) {
    drawPaths(fullRedraw)
  }

  if (_paused) {
    drawDots(_timePaused || 0, !fullRedraw)

    if (DEBUG_BORDERS) {
      drawBoundsBoxes()
    }
  }

  _redrawing = false
}

function drawPathImageData() {
  pathCanvas.pxg.putImageData(pathCanvas)
}

async function drawPaths(forceFullRedraw) {
  if (!_ready) return 0
  const drawDiff = !forceFullRedraw
  const pxg = pathCanvas.pxg
  const count = ActivityCollection.drawPaths(pxg.imageData, drawDiff)
  drawPathImageData()
}

function drawDotImageData() {
  if (_options.dotShadows.enabled) {
    dotCanvas.pxg.drawImageData(dotCanvas)
  } else {
    dotCanvas.pxg.putImageData(dotCanvas)
  }
}

async function drawDots(tsecs, drawDiff) {
  if (!_ready) return 0

  const pxg = dotCanvas.pxg
  if (_options.dotShadows.enabled && !pxg.drawBounds.isEmpty()) {
    const { x, y, w, h } = pxg.drawBounds.rect
    dotCanvas.getContext("2d").clearRect(x, y, w, h)
  }

  const count = ActivityCollection.drawDots(
    pxg.imageData,
    +vParams.sz,
    +vParams.T,
    +vParams.tau,
    tsecs,
    drawDiff
  )
  drawDotImageData()

  if (DEBUG_BORDERS) drawBoundsBoxes()

  return count
}

function drawBoundsBoxes() {
  const ctx = debugCanvas.getContext("2d")

  ViewBox.clear(ctx)
  ctx.lineWidth = 4
  ctx.setLineDash([6, 5])
  ctx.strokeStyle = "rgba(255,0,0,0.8)"
  ViewBox.draw(ctx)

  if (!pathCanvas.pxg.drawBounds.isEmpty()) {
    ctx.lineWidth = 1
    ctx.strokeStyle = "rgba(0,255,0,0.8)"
    ViewBox.draw(ctx, pathCanvas.pxg.drawBounds.rect)
  }

  if (!dotCanvas.pxg.drawBounds.isEmpty()) {
    ctx.lineWidth = 1
    ctx.strokeStyle = "rgba(0,0,255,0.8)"
    ViewBox.draw(ctx, dotCanvas.pxg.drawBounds.rect)
  }
}

/*
 * Dot settings
 *
 */
function updateDotSettings(shadowSettings) {
  const ds = _dotSettings

  ds._timeScale = +vParams.tau
  ds._period = +vParams.T

  const dotScale = +vParams.sz
  ds._dotSize = Math.max(1, ~~(dotScale * Math.log(ViewBox.zoom) + 0.5))
  ds.alpha = (+vParams.alpha * 256) | 0

  if (shadowSettings) {
    Object.assign(_options.dotShadows, shadowSettings)
    dotCtxUpdate()
  }

  if (_paused) {
    drawDots(_timePaused || 0)
  }
  return ds
}

/*
 * Animation
 */
let _drawingDots, _timePaused, _paused
async function animate() {
  // this prevents accidentally running multiple animation loops
  if (_drawingDots || !_ready) return

  _drawingDots = true
  _paused = false

  const fpsInterval = 1000 / TARGET_FPS
  const timeOrigin = performance.timing.navigationStart
  const timeOffset = _timePaused
    ? 1000 * _timePaused - performance.now() + fpsInterval
    : timeOrigin

  let lastFrameTime = performance.now() + fpsInterval
  let nowInSeconds

  while (!_paused) {
    const timeStamp = await nextAnimationFrame()
    const frameDelay = timeStamp - lastFrameTime

    if (frameDelay > fpsInterval) {
      lastFrameTime = timeStamp - (frameDelay % fpsInterval)

      // ts is in milliseconds since navigationStart
      nowInSeconds = (timeStamp + timeOffset) / 1000

      // draw the dots
      const count = await drawDots(nowInSeconds)

      if (MAP_INFO) {
        updateInfoBox(frameDelay, count)
      }
    }
  }

  _drawingDots = false
  _timePaused = nowInSeconds
}

function animateZoom(e) {
  const m = _map
  const z = e.zoom
  const scale = m.getZoomScale(z)

  const offset = m._latLngToNewLayerPoint(
    m.getBounds().getNorthWest(),
    z,
    e.center
  )
  ViewBox.setCSStransform(offset, scale)
  // console.log({ offset, scale })
}

// for debug display
const fpsRegister = []
let fpsSum = 0
let _roundCount, _duration
const fpsRegisterSize = 32
function updateInfoBox(dt, count) {
  fpsSum += dt
  fpsRegister.push(dt)
  if (fpsRegister.length !== fpsRegisterSize) return

  const roundCount = 10 * Math.round(count / 10)
  const duration = Math.round(fpsSum / fpsRegisterSize)
  const fps = Math.round(1000 / duration)
  // const [dx, dy, dw, dh] = dotCanvas.pxg.imageData.drawBounds
  if (roundCount !== _roundCount || duration !== _duration) {
    _infoBox.innerHTML = `${duration} ms (${fps}fps), ${roundCount} pts`
    // + `<br>${dx}, ${dy}, ${dw}, ${dh}`
  }
  _roundCount = roundCount
  _duration = duration
  fpsSum -= fpsRegister.shift()
}
