import {
  fetchServerAction,
  handleServerActionResult,
  type FetchServerActionResult,
} from './server-action-reducer'
import {
  dropDynamicDataFromNavigationSeed,
  getNextURLForServerAction,
  markTaskAsReady,
  pingRouterQueue,
  updateTaskFreshness,
  type ServerActionRouterTask,
} from './router-task'
import { FreshnessPolicy } from '../ppr-navigations'
import type { NavigationSeed } from '../../segment-cache/navigation'

export type ServerActionCall<T> = {
  actionId: string
  actionArgs: any[]
  shouldDropData: boolean

  fulfill: (value: T) => void
  reject: (error: unknown) => void
}

let lastAction: ServerActionRouterTask | null = null
let firstAction: ServerActionRouterTask | null = null
let isActionIsInProgress = false

export function scheduleServerActionRequest(
  task: ServerActionRouterTask
): void {
  if (lastAction === null) {
    lastAction = firstAction = task
  } else {
    lastAction.nextAction = task
    lastAction = task
  }
  pingServerActionQueue()
}

function pingServerActionQueue() {
  // Only work on the next action in the queue if there is no other action
  // in progress.
  // TODO: Allow multiple Server Actions to run in parallel, except when invoked
  // by the same useActionState. This will be gated behind an opt-in flag at
  // first, since in some scenarios it could be considered a breaking change.
  if (isActionIsInProgress || firstAction === null) {
    return
  }

  // Remove the first action from the queue.
  const action = firstAction
  firstAction = action.nextAction
  if (firstAction === null) {
    lastAction = null
  }

  // Call the action.
  startServerActionCall(action)
}

function startServerActionCall(task: ServerActionRouterTask) {
  const call = task.data
  const actionId = call.actionId
  const actionArgs = call.actionArgs

  const urlOfPageToInvokeActionOn = task.url
  const nextUrl = getNextURLForServerAction(task)
  const baseTree = task.baseState.tree

  isActionIsInProgress = true
  fetchServerAction(
    urlOfPageToInvokeActionOn,
    nextUrl,
    baseTree,
    actionId,
    actionArgs
  ).then(
    (result: FetchServerActionResult) => {
      isActionIsInProgress = false
      handleServerActionResult(
        task,
        urlOfPageToInvokeActionOn,
        baseTree,
        result
      )
      pingRouterQueue()
      pingServerActionQueue()
    },
    (error: unknown) => {
      isActionIsInProgress = false
      markServerActionTaskAsReady(
        task,
        urlOfPageToInvokeActionOn,
        null,
        'reload',
        FreshnessPolicy.Restore
      )
      call.reject(error)
      pingRouterQueue()
      pingServerActionQueue()
    }
  )
}

export function markServerActionTaskAsReady(
  task: ServerActionRouterTask,
  url: URL,
  seed: NavigationSeed | null,
  navigateType: NavigationType,
  freshness: FreshnessPolicy
) {
  const call = task.data
  const finishedTask = markTaskAsReady(
    task,
    url,
    // Check if there was a newer navigation since the action was invoked. If
    // so, we should drop the data from the server action.
    seed !== null && call.shouldDropData
      ? dropDynamicDataFromNavigationSeed(seed)
      : seed
  )
  finishedTask.navigationType = navigateType
  updateTaskFreshness(finishedTask, freshness)
}
