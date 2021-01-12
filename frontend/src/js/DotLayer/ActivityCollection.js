/*
 *  ActivityCollection is a some methods for managing a collection of Activity objects.
 *  Since this might running inside a worker, we cannot assume access to anything
 *  on the main thread.
 */

import * as ColorPalette from "./ColorPalette.js"
import * as ViewBox from "./ViewBox.js"
import { Activity } from "./Activity.js"
import { options } from "./Defaults.js"
import BitSet from "../BitSet.js"
import { state } from "../Model.js"
import { Point } from "../myLeaflet.js"
import { queueTask, nextTask } from "../appUtil.js"
import { PixelGraphics } from "./PixelGraphics"

export const items = new Map()
export const pxg = new PixelGraphics()
let itemsArray

state.items = items

export function add(specs) {
  const A = new Activity(specs)
  A._selected = A.selected

  Object.defineProperty(A, "selected", {
    get() {
      return this._selected
    },

    set(value) {
      this._selected = value
      updateSelect(this.idx, value)
    },
  })

  items.set(A.id, A)
}

export function remove(id) {
  items.delete(+id)
}

/**
 * This should be called after adding or removing Activities.
 */
export function reset() {
  setDotColors()

  itemsArray = [...items.values()]

  for (let i = 0; i < itemsArray.length; i++) {
    itemsArray[i].idx = i
  }
  resetSegMasks()
  inView.current.resize(itemsArray.length)
  inView.last.resize(itemsArray.length)
}

/*
 * assign a dot-color to each item of _items
 */
function setDotColors() {
  const colorPalette = ColorPalette.makePalette(items.size)
  let i = 0
  for (const A of items.values()) {
    A.colors.dot = colorPalette[i++]
  }
}

/*
 * We group items in our collection by path color, dot color, and whether
 * they are selected in order to optimze rendering paths and dots.  That way we can
 * do all drawing in chunks of one linestyle at a time.
 */

/*
 * inView is the set indicating which activities are currently in view. It is actually
 * a set of indices of Activities in itemsArray.
 */
const inView = {
  current: new BitSet(), // Current means since the last update
  last: new BitSet(),
}

/**
 * Update StyleGroups for our collection of activities
 * @return {[type]} [description]
 */
export async function updateContext(viewportPxBounds, zoom) {
  // the semicolon is necessary
  // see https://stackoverflow.com/questions/42562806/destructuring-assignment-and-variable-swapping
  ;[inView.current, inView.last] = [inView.last, inView.current]

  inView.current.clear()

  let queuedTasks

  // update which items are in the current view
  for (let i = 0, len = itemsArray.length; i < len; i++) {
    const A = itemsArray[i]

    if (viewportPxBounds.overlaps(A.pxBounds) ){
      inView.current.add(i)

      // Making an idxSet is slow so we create new tasks for that
      if (!A.idxSet[zoom]) {
        queueTask(() => A.makeIdxSet(zoom))
        queuedTasks = true
      }
    }
  }

  // if we queued and makeIdxSet tasks, let's wait for them to finish
  if (queuedTasks) await nextTask()

  // Make segMasks (this is usually very fast)
  inView.current.forEach((i) => {
    const A = itemsArray[i]
    if (!A.idxSet[zoom]) {
      throw `idxSet[${zoom}] didn't get made`
    }

    if (!A.updateSegMask(viewportPxBounds, zoom)) {
      inView.current.remove(i)
    }
  })
}

/**
 * Update the partitions with a changed selection value for A = itemsArray[i]
 *
 * @param  {number} i -- then index of the activity
 */
function updateSelect(idx, value) {
  return
}

/**
 * Returns an array of activities given a selection region
 * in screen-ccordinates
 * @param  {Bounds} selectPxBounds leaflet Bounds Object
 */
export function* inPxBounds(pxBounds) {
  // un-transform screen coordinates given by the selection
  // plugin to absolute values that we can compare ours to.
  ViewBox.unTransform(pxBounds.min)
  ViewBox.unTransform(pxBounds.max)

  for (const idx of inView.current) {
    const A = itemsArray[idx]
    const points = A.getPointAccessor(A.segMask.zoom)

    for (const i of A.segMask) {
      const px = points(i)
      const point = new Point(px[0], px[1])
      if (pxBounds.contains(point)) {
        yield A
        break
      }
    }
  }
}

/*
 * Clear all segMasks and force rebuilding them
 */
export function resetSegMasks() {
  for (const A of itemsArray) {
    A.resetSegMask()
  }
}

// // Debug info box
// let _infoBox
// const InfoViewer = Control.extend({
//   onAdd: function () {
//     _infoBox = DomUtil.create("div")
//     _infoBox.style.width = "200px"
//     _infoBox.style.padding = "5px"
//     _infoBox.style.background = "rgba(100,200,50,0.6)"
//     _infoBox.style.textAlign = "left"
//     _infoBox.innerHTML = "Activites infoBox"
//     return _infoBox
//   },
// })

/*
 * Methods for drawing to imageData objects
 */
const drawSegFunc = (x0, y0, x1, y1) => pxg.drawSegment(x0, y0, x1, y1)
export function drawPaths(imageData, drawDiff) {
  if (pxg.imageData !== imageData) pxg.imageData = imageData

  let count = 0
  inView.current.forEach((i) => {
    const A = itemsArray[i]
    pxg.setColor(A.colors.path)

    pxg.setLineWidth(
      A.selected ? options.selected.pathWidth : options.normal.pathWidth
    )

    count += A.forEachSegment(drawSegFunc, drawDiff)
  })
  return count
}

export function drawDots(imageData, dotSize, T, timeScale, tsecs, drawDiff) {
  if (pxg.imageData !== imageData) pxg.imageData = imageData

  let count = 0
  const circle = (x, y) => pxg.drawCircle(x, y, dotSize)
  const square = (x, y) => pxg.drawSquare(x, y, dotSize)
  inView.current.forEach((i) => {
    const A = itemsArray[i]
    pxg.setColor(A.colors.dot)
    const drawFunc = A.selected ? circle : square
    count += A.forEachDot(drawFunc, tsecs, T, timeScale, drawDiff)
  })
  return count
}
