import { flags } from "./Model.js"
import { controlWindow } from "./MapAPI.js"
import queryBackend from "./Socket.js"
import * as ActivityCollection from "./DotLayer/ActivityCollection.js"
import { nextTask } from "./appUtil.js"

let numActivities, count

/*
 * Set up a message box that appears only when flags.importing is true
 */
const importInfoBox = controlWindow({
  position: "center",
  title: '<i class="fas fa-download"></i> Importing...',
  content: `<div class="info-message"></div>
            <div class="progress msgbox">
            <progress class="progbar"></progress>
            </div>`,
  prompt: {},
  visible: false,
})

flags.onChange("importing", (val) => {
  val ? importInfoBox.show() : importInfoBox.hide()
})

const infoMsgElements = document.querySelectorAll(".info-message"),
  progBars = document.querySelectorAll(".progbar")

/*
 * Display a progress message and percent-completion
 */
function displayProgressInfo(msg, progress) {
  if (!msg && !progress) {
    infoMsgElements.forEach((el) => (el.innerHTML = ""))
    progBars.forEach((el) => el.removeAttribute("value"))
    return
  }

  if (msg) {
    for (const el of infoMsgElements) {
      el.innerHTML = msg
    }
  }

  if (progress) {
    for (const el of progBars) {
      el.value = progress
    }
  }
}

/*
 * Send a query to the backend and populate the items object with it.
 */
export function makeQuery(query, done) {
  flags.importing = true
  numActivities = 0
  count = 0

  displayProgressInfo("Retrieving activity data...")

  queryBackend(query, onMessage, done)
}

export function abortQuery() {
  flags.importing = false
  makeQuery()
}

// when done
// Dom.prop("#renderButton", "disabled", false);
// doneRendering("Finished.");
// return;

/*
 *  this is the callback for our data importer. If there is an open
 *    connection with the data-layer (backend server), it gets called on
 *    every received message.
 *
 * @param {Object} A - A JSON object ecoding 1 message from the data layer
 */
function onMessage(A) {
  if (!("_id" in A)) {
    if ("idx" in A) {
      displayProgressInfo(`indexing...${A.idx}`)
    } else if ("count" in A) {
      numActivities += A.count
    } else if ("delete" in A) {
      const toDelete = A.delete
      if (toDelete.length) {
        // delete all ids in A.delete
        for (const id of toDelete) {
          ActivityCollection.remove(id)
        }
      }
    } else if ("done" in A) {
      console.log("received done")
      // doneRendering("Done rendering.");
    } else if ("msg" in A) {
      displayProgressInfo(A.msg)
    }

    return
  }

  if (!("type" in A)) {
    return
  }

  ActivityCollection.add(A)

  count++
  if (count % 5 === 0) {
    const prog = numActivities ? count / numActivities : null
    displayProgressInfo(`imported ${count}/${numActivities || "?"}`, prog)
  }
}
