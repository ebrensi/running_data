/*
  DotLayer Efrem Rensi, 2020,
*/

import { Layer, DomUtil, Browser, setOptions } from "../myLeaflet.js"
import { Control } from "../myLeaflet.js"

import * as ViewBox from "./ViewBox.js"
import * as DrawBox from "./DrawBox.js"
import * as ActivityCollection from "./ActivityCollection.js"
import { MAP_INFO } from "../Env.js"
import { nextTask, nextAnimationFrame } from "../appUtil.js"
import { DEBUG_BORDERS } from "../Env.js"
import { vParams } from "../Model.js"
// import * as WorkerPool from "./WorkerPool.js"

import {
  options as defaultOptions,
  dotSettings as _dotSettings,
} from "./Defaults.js"

export { _dotSettings as dotSettings }

/* In order to prevent path redraws from happening too often
 * and hogging up CPU cycles we set a minimum delay between redraws
 */
const FORCE_FULL_REDRAW = true
const CONTINUOUS_REDRAWS = false
const MIN_REDRAW_DELAY = 1000 // milliseconds
const TWO_PI = 2 * Math.PI
const TARGET_FPS = 30

const _drawFunction = {
  square: null,
  circle: null,
}

let dotCanvas, pathCanvas, debugCanvas
let dotImageData

const dotCanvasPane = "shadowPane"
const pathCanvasPane = "overlayPane"
const debugCanvasPane = "overlayPane"

let _map, _options
let _ready

let _gifPatch
let _dotStyleGroups
let _lastRedraw = 0
let _lastDotDrawBox

/*
 * Display for debugging
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

    /*
     * The Path Canvas is for activity paths, which are made up of a bunch of
     * segments.
     */
    pathCanvas = addCanvasOverlay(pathCanvasPane)
    const ctx = pathCanvas.getContext("2d")
    ctx.lineCap = "round"
    ctx.lineJoin = "round"

    if (DEBUG_BORDERS) {
      // create Canvas for debugging canvas stuff
      debugCanvas = addCanvasOverlay(debugCanvasPane)
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
    updateDrawDotFuncs.imageDataTest()
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
    zoom: onZoom,
    resize: onResize,
  }

  if (CONTINUOUS_REDRAWS) {
    events.move = onMove
  }

  if (_map.options.zoomAnimation && Browser.any3d) {
    events.zoomanim = _animateZoom
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
  dotCtxUpdate()
  await redraw(true)
}

async function onZoom(e) {
  if (!_map || !ViewBox.zoom) return

  // console.log("onzoom")

  if (e.pinch || e.flyTo) {
    await redraw(true)
  }
}

/*
 * This gets called continuously as the user pans or zooms (without pinch)
 */
async function onMove() {
  // prevent redrawing more often than necessary
  const ts = Date.now()
  if (ts - _lastRedraw < MIN_REDRAW_DELAY) {
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
  await redraw()
}

function moveDrawBox() {
  // const t0 = Date.now()

  // Get the current draw rectangle in screen coordinates (relative to map pane position)
  const D = DrawBox.getScreenRect()

  // Get the last recorded ViewBox (screen) rectangle
  // in pane coordinates (relative to pxOrigin)
  const V = ViewBox.getPaneRect()

  // reset the canvases to to align with the screen and update the ViewBox location
  // relative to the map's pxOrigin
  const V_ = ViewBox.calibrate()

  // Move the visible portion of currently drawn segments and dots
  // to the new location after calibration
  const dVx = V_.x - V.x
  const Dx1 = D.x + dVx
  const Dx2 = Dx1 + D.w
  const DxLeft = Math.max(0, Dx1)
  const DxRight = Math.min(Dx2, V.w)
  const Cx = ~~(DxLeft - dVx)
  const Cw = ~~(0.5 + DxRight - DxLeft)

  const dVy = V_.y - V.y
  const Dy1 = ~~(D.y + dVy)
  const Dy2 = Dy1 + D.h
  const DyTop = Math.max(0, Dy1)
  const DyBottom = Math.min(Dy2, V.h)
  const Cy = ~~(DyTop - dVy)
  const Ch = ~~(0.5 + DyBottom - DyTop)

  // We copy if any of the DrawBox is still on screen
  if (DxLeft < V.w && DxRight > 0 && DyTop < V.h && DyBottom > 0) {
    // const copyRect = { x: Cx, y: Cy, w: Cw, h: Ch }
    // const pasteRect = { x: DxLeft, y: DyTop, w: Cw, h: Ch }
    // const debugCtx = _debugCanvas.getContext("2d")
    // debugCtx.strokeStyle = "#222222"
    // DrawBox.draw(debugCtx, copyRect) // draw source rect
    // debugCtx.fillText("Copy", copyRect.x + 20, copyRect.y + 20)
    // debugCtx.strokeStyle = "#000000"
    // DrawBox.draw(debugCtx, pasteRect) // draw dest rect
    // debugCtx.fillText("Paste", pasteRect.x + 20, pasteRect.y + 20)

    const canvasesToMove = [pathCanvas]
    for (const canvas of canvasesToMove) {
      const ctx = canvas.getContext("2d")
      const imageData = ctx.getImageData(Cx, Cy, Cw, Ch)
      DrawBox.clear(ctx, D)
      ctx.putImageData(imageData, DxLeft, DyTop)
    }

    DrawBox.clear(dotCanvas.getContext("2d"), D)
  } else {
    // If none of the last DrawBox is still on screen we just clear it
    const canvasesToClear = [pathCanvas, dotCanvas]
    for (const canvas of canvasesToClear) {
      DrawBox.clear(canvas.getContext("2d"), D)
    }
  }

  // console.log(`moveDrawBox: ${D.w}x${D.h} -- ${Date.now() - t0}ms`)
}

async function redraw(force) {
  if (!_ready) return

  await nextTask()

  const boundsChanged = ViewBox.updateBounds()
  const zoomChanged = ViewBox.updateZoom()
  if (!force && !boundsChanged && !zoomChanged) {
    return
  }

  // console.log("onmoveend")
  const fullRedraw = zoomChanged || FORCE_FULL_REDRAW || force

  // Recalibrate the DrawBox (and possible move it)
  if (fullRedraw) {
    const oldDrawBoxDim = DrawBox.getScreenRect()
    ViewBox.calibrate()
    const canvasesToClear = [pathCanvas, dotCanvas]
    for (const canvas of canvasesToClear) {
      DrawBox.clear(canvas.getContext("2d"), oldDrawBoxDim)
    }
  } else {
    moveDrawBox()
  }

  DrawBox.reset()

  if (fullRedraw) {
    ActivityCollection.resetSegMasks()
  }

  const styleGroups = await ActivityCollection.updateGroups()
  _dotStyleGroups = styleGroups.dot

  const D = DrawBox.getScreenRect()
  if (
    !dotImageData ||
    dotImageData.width !== D.w ||
    dotImageData.height !== D.h
  ) {
    dotImageData = new ImageData(D.w, D.h)
  }

  if (DEBUG_BORDERS) {
    drawBoundsBoxes()
  }

  if (_paused) {
    await nextTask()
    drawDots(_timePaused || 0, styleGroups.dot)
  }


  if (_options.showPaths) {
    await nextTask()
    drawPaths(styleGroups.path, fullRedraw)
  }
}

function drawTransformedSegment(ctx, x1, y1, x2, y2) {
  const p1 = ViewBox.transform(x1, y1)
  ctx.moveTo(p1[0], p1[1])
  const p2 = ViewBox.transform(x2, y2)
  ctx.lineTo(p2[0], p2[1])
}

function drawPaths(pathStyleGroups, forceFullRedraw) {
  if (!_ready) return

  const alphaScale = _dotSettings.alphaScale
  const drawAll = forceFullRedraw || FORCE_FULL_REDRAW
  const ctx = pathCanvas.getContext("2d")
  const drawSegment = (x1, y1, x2, y2) =>
    drawTransformedSegment(ctx, x1, y1, x2, y2)
  let count = 0

  for (const { spec, items } of pathStyleGroups) {
    Object.assign(ctx, spec)
    ctx.globalAlpha = spec.globalAlpha * alphaScale
    ctx.beginPath()
    for (const A of items) {
      const segMask = drawAll ? A.segMask : A.getPartialSegMask()
      count += A.forEachSegment(drawSegment, segMask)
    }
    ctx.stroke()
  }
  return count
}

/*
 * Functions for Drawing Dots
 * size is the length of the square and the radius of the circle
 */

const updateDrawDotFuncs = {
  default: function () {
    const ctx = dotCanvas.getContext("2d")
    const ds = _dotSettings
    const pi2 = TWO_PI

    _drawFunction.circle = (x, y) => {
      const size = ds._dotSize
      const p = ViewBox.transform(x, y)
      ctx.arc(p[0], p[1], size, 0, pi2)
      ctx.closePath()
    }

    _drawFunction.square = (x, y) => {
      const size = ds._dotSize
      const dotOffset = size / 2.0
      const p = ViewBox.transform(x, y)
      ctx.rect(p[0] - dotOffset, p[1] - dotOffset, size, size)
    }
  },

  imageDataTest: function () {
    const ds = _dotSettings
    const defaultColor = {r: 0, g:0, b:0}

    _drawFunction.square = (x, y) => {
      const { data, width, height } = dotImageData
      const D = _lastDotDrawBox
      const size = ds._dotSize
      const offset = size / 2
      const p = ViewBox.transform(x, y)

      const tx = p[0] - offset - D.x
      const ty = p[1] - offset - D.y
      const color = _drawColor || defaultColor
      const xStart = Math.round(Math.max(0, tx))
      const xEnd = Math.round(Math.min(tx + size, width))

      const yStart = Math.round(Math.max(0, ty))
      const yEnd = Math.round(Math.min(ty + size, height))
      for (let row = yStart; row < yEnd; row++) {
        const firstCol = row * width
        const colStart = 4 * (firstCol + xStart)
        const colEnd = 4 * (firstCol + xEnd)
        for (let col = colStart; col < colEnd; col += 4) {
          data[col] = color.r
          data[col + 1] = color.g
          data[col + 2] = color.b
          data[col + 3] = ds.alpha
        }
      }
    }
  },

  sprites: function () {
    const ctx = dotCanvas.getContext("2d")
    const size = _dotSettings._dotSize
    if (!_dotStyleGroups) return

    // Make sprite sheet
    const bufferCanvas = document.createElement("canvas")
    const bufCtx = bufferCanvas.getContext("2d")

    const items = ActivityCollection.items
    const colorSet = new Set(
      Array.from(items.values()).map((A) => A.colors.dot)
    )
    const colorsArray = Array.from(colorSet)
    const colorIdx = {}
    const n = colorsArray.length
    for (let i = 0; i < n; i++) {
      const color = colorsArray[i]
      colorIdx[color] = i
    }
    bufferCanvas.width = 3 * size * n
    bufferCanvas.height = 2 * size
    const loc = (idx, sel) => {
      const x = 3 * idx + sel
      const y = 0
      const w = (1 + sel) * size
      const h = w
      return { x, y, w, h }
    }

    for (let i = 0; i < n; i++) {
      bufCtx.fillStyle = colorsArray[i]

      const { x0, y0, w0, h0 } = loc(i, 0)``
      bufCtx.fillRect(x0, y0, w0, h0)

      const { x1, y1, w1 } = loc(i, 1)
      const radius = w1 / 2
      const cx = x1 + radius
      const cy = y1 + radius
      bufCtx.beginPath()
      bufCtx.ctx.arc(cx, cy, radius, 0, TWO_PI)
      ctx.closePath()
      ctx.fill()
    }

    _drawFunction.circle = (x, y, color) => {
      const idx = color ? colorIdx(color) : 0
      const r = loc(idx, 1)
    }

    _drawFunction.square = (x, y, color) => {
      const idx = color ? colorIdx(color) : 0
      const r = loc(idx, 0)
    }
  },
}

let _drawColor = {r: 0, g: 0, b: 0}
const _re = /(\d+),(\d+),(\d+)/
function extractColor(colorString) {
  const result = colorString.match(_re)
  return {r: result[1], g: result[2], b: result[3]}
}

async function drawDots(tsecs, dotStyleGroups, forceFullRedraw) {
  if (!_ready || !_dotStyleGroups) return 0

  const styleGroups = dotStyleGroups || _dotStyleGroups.values()
  const ctx = dotCanvas.getContext("2d")

  const drawAll = forceFullRedraw || FORCE_FULL_REDRAW

  const D = (_lastDotDrawBox = DrawBox.getScreenRect())

  if (drawAll) {
    DrawBox.clear(ctx, _lastDotDrawBox || DrawBox.defaultRect())
    dotImageData.data.fill(0, 0)
  }

  let count = 0
  for (const { spec, items, sprite } of styleGroups) {
    const drawDotFunc = _drawFunction[sprite]
    _drawColor = extractColor(spec.strokeStyle || spec.fillStyle)

    // Object.assign(ctx, spec)
    // ctx.globalAlpha = spec.globalAlpha * alphaScale
    // ctx.beginPath()
    items.forEach((A) => {
      const segMask = drawAll ? A.segMask : A.getPartialSegMask()
      count += A.forEachDot(tsecs, drawDotFunc, segMask)
    })
    // ctx.fill()
  }
  ctx.putImageData(dotImageData, D.x, D.y)
  return count
}

function drawBoundsBoxes() {
  const ctx = debugCanvas.getContext("2d")
  ViewBox.clear(ctx)
  ctx.lineWidth = 4
  ctx.setLineDash([6, 5])
  ctx.strokeStyle = "rgb(0,255,0,0.8)"
  DrawBox.draw(ctx)
  ctx.strokeStyle = "rgb(255,0,255,1)"
  ViewBox.draw(ctx)
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
    drawDots(_timePaused || 0, null, true)
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


// for debug display
const fpsRegister = []
let fpsSum = 0
let _roundCount, _duration
const fpsRegisterSize = 20
function updateInfoBox(dt, count) {
  fpsSum += dt
  fpsRegister.push(dt)
  if (fpsRegister.length !== fpsRegisterSize) return

  const roundCount = 10 * Math.round(count / 10)
  const duration = Math.round(fpsSum / fpsRegisterSize)
  fpsSum -= fpsRegister.shift()

  if (roundCount !== _roundCount || duration !== _duration) {
    _infoBox.innerHTML = `${duration} ms (${Math.round(
      1000 / duration
    )}fps), ${roundCount} pts`
  }
  _roundCount = roundCount
  _duration = duration
}

function _animateZoom(e) {
  const newZoom = e.zoom
  const newCenter = e.center
  const scale = _map.getZoomScale(newZoom)

  const origin = _map.getBounds().getNorthWest()
  const offset = _map._latLngToNewLayerPoint(origin, newZoom, newCenter)

  ViewBox.setCSStransform(offset, scale)
}
