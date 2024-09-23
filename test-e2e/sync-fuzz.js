/**
 * @overview Randomly performs sync operations until something breaks.
 *
 * This is run as part of normal testing. You can also run it with custom
 * arguments like this:
 *
 * ```sh
 * COMAPEO_SYNC_FUZZ_TEST_COUNT=10 \
 * COMAPEO_SYNC_FUZZ_MIN_MANAGER_COUNT=2 \
 * COMAPEO_SYNC_FUZZ_MAX_MANAGER_COUNT=3 \
 * COMAPEO_SYNC_FUZZ_MIN_ACTION_COUNT=4 \
 * COMAPEO_SYNC_FUZZ_MAX_ACTION_COUNT=32 \
 * node --test test-e2e/sync-fuzz.js
 * ```
 */

import { generate } from '@mapeo/mock-data'
import { map } from 'iterpal'
import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import * as process from 'node:process'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { valueOf } from '../src/utils.js'
import {
  connectPeers,
  createManagers,
  invite,
  sample,
  setAdd,
  waitForSync,
} from './utils.js'
/** @import { MapeoProject } from '../src/mapeo-project.js' */

/**
 * @internal
 * @typedef {object} ProjectState
 * @prop {boolean} isSyncEnabled
 * @prop {Readonly<Set<string>>} observationIds
 */

/**
 * @internal
 * @typedef {ReadonlyArray<ProjectState>} State
 */

/**
 * @internal
 * @typedef {object} ActionResult
 * @prop {string} title
 * @prop {State} newExpectedState
 */

/**
 * @internal
 * @callback Action
 * @param {State} oldExpectedState
 * @returns {ActionResult | Promise<ActionResult>}
 */

test('sync fuzz tests', { concurrency: true, timeout: 2 ** 30 }, async (t) => {
  const testCount = getEnvironmentVariableInt('TEST_COUNT', 10)
  const minManagerCount = getEnvironmentVariableInt('MIN_MANAGER_COUNT', 2)
  const maxManagerCount = getEnvironmentVariableInt('MAX_MANAGER_COUNT', 3)
  const minActionCount = getEnvironmentVariableInt('MIN_ACTION_COUNT', 4)
  const maxActionCount = getEnvironmentVariableInt('MAX_ACTION_COUNT', 32)
  assert(
    minManagerCount <= maxManagerCount,
    'min manager count is greater than max. Test is not set up correctly'
  )
  assert(
    minActionCount <= maxActionCount,
    'min action count is greater than max. Test is not set up correctly'
  )

  for (let i = 1; i <= testCount; i++) {
    await t.test(
      `fuzz test #${i}`,
      { concurrency: true, timeout: 120_000 },
      async (t) => {
        const managerCount = randomInt(minManagerCount, maxManagerCount + 1)
        const actionCount = randomInt(minActionCount, maxActionCount + 1)

        const managers = await createManagers(managerCount, t)
        const [invitor, ...invitees] = managers

        const disconnect = connectPeers(managers)
        t.after(disconnect)

        const projectId = await invitor.createProject({ name: 'Mapeo' })
        await invite({ invitor, invitees, projectId })

        const projects = await Promise.all(
          managers.map((m) => m.getProject(projectId))
        )
        t.after(() =>
          Promise.all(
            projects.map(async (project) => {
              project.$sync.stop()
              await project.close()
            })
          )
        )
        await waitForSync(projects, 'initial')

        /** @type {string[]} */
        const actionTitles = []
        /** @type {State} */
        let expectedState = projects.map(() => ({
          isSyncEnabled: false,
          observationIds: new Set(),
        }))

        for (let i = 0; i < actionCount; i++) {
          const possibleActions = getPossibleNextActions(projects)
          const action = sample(possibleActions)
          assert(action, 'no next step? test is broken')

          const result = await action(expectedState)
          actionTitles.push(result.title)
          expectedState = result.newExpectedState

          await waitForStateToMatch(projects, expectedState, actionTitles)
        }
      }
    )
  }
})

/**
 * @param {string} name
 * @param {number} defaultValue
 * @returns {number}
 */
function getEnvironmentVariableInt(name, defaultValue) {
  const fullName = 'COMAPEO_SYNC_FUZZ_' + name
  const rawValue = process.env[fullName]
  if (!rawValue) return defaultValue

  const result = parseInt(rawValue, 10)
  assert(result > 0, `${fullName} must be positive`)
  assert(Number.isFinite(result), `Can't parse ${fullName}`)
  assert(Number.isSafeInteger(result), `${fullName} must be a safe integer`)

  return result
}

/**
 * @param {MapeoProject} project
 * @returns {boolean}
 */
function isSyncEnabled(project) {
  return project.$sync.getState().data.isSyncEnabled
}

/**
 * @param {MapeoProject} project
 * @param {number} index
 * @returns {Action[]}
 */
function getPossibleNextActionsForProject(project, index) {
  /** @type {Action[]} */
  const result = []

  // Add observation

  result.push(async (expectedState) => {
    const observation = await project.observation.create(
      valueOf(generate('observation')[0])
    )

    const myProject = expectedState[index]
    return {
      title: `Project ${index} added observation ${observation.docId}`,
      newExpectedState: expectedState.map((otherProject) => {
        const shouldAddThisObservationToList =
          myProject === otherProject ||
          (myProject.isSyncEnabled && otherProject.isSyncEnabled)
        return {
          ...otherProject,
          observationIds: shouldAddThisObservationToList
            ? setAdd(otherProject.observationIds, observation.docId)
            : otherProject.observationIds,
        }
      }),
    }
  })

  // Start or stop sync

  if (isSyncEnabled(project)) {
    result.push(async (expectedState) => {
      project.$sync.stop()
      await delay(10)

      const myProject = expectedState[index]
      return {
        title: `Project ${index} stopped sync`,
        newExpectedState: expectedState.map((otherProject) => {
          if (otherProject === myProject) {
            return { ...otherProject, isSyncEnabled: false }
          } else {
            return otherProject
          }
        }),
      }
    })
  } else {
    result.push(async (expectedState) => {
      project.$sync.start()
      await delay(10)

      const myProject = expectedState[index]
      return {
        title: `Project ${index} started sync`,
        newExpectedState: expectedState.map((otherProject) => {
          let { observationIds } = myProject
          if (myProject === otherProject) {
            for (const p of expectedState) {
              if (p.isSyncEnabled) {
                observationIds = setAdd(observationIds, ...p.observationIds)
              }
            }
            return { ...myProject, isSyncEnabled: true, observationIds }
          } else if (otherProject.isSyncEnabled) {
            return {
              ...otherProject,
              observationIds: setAdd(
                otherProject.observationIds,
                ...observationIds
              ),
            }
          } else {
            return otherProject
          }
        }),
      }
    })
  }

  return result
}

/**
 * @param {ReadonlyArray<MapeoProject>} projects
 * @returns {Action[]}
 */
function getPossibleNextActions(projects) {
  return projects.flatMap(getPossibleNextActionsForProject)
}

/**
 * @param {MapeoProject[]} projects
 * @param {State} expectedState
 * @returns {Promise<boolean>}
 */
async function doesStateMatch(projects, expectedState) {
  const results = await Promise.all(
    projects.map(async (project, index) => {
      const expectedProjectState = expectedState[index]
      assert(expectedProjectState, 'test not set up correctly')

      const actualSyncEnabled = isSyncEnabled(project)
      const expectedSyncEnabled = expectedProjectState.isSyncEnabled
      if (expectedSyncEnabled !== actualSyncEnabled) return false

      const observations = await project.observation.getMany()
      const actualObservationIds = new Set(map(observations, (o) => o.docId))
      const expectedObservationIds = expectedProjectState.observationIds
      return isDeepStrictEqual(expectedObservationIds, actualObservationIds)
    })
  )
  return results.every(Boolean)
}

/**
 * @param {MapeoProject[]} projects
 * @param {State} expectedState
 * @param {ReadonlyArray<string>} actionTitles
 * @returns {Promise<void>}
 */
function waitForStateToMatch(projects, expectedState, actionTitles) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      const actualState = await Promise.all(
        projects.map(async (project) => {
          const observations = await project.observation.getMany()
          const observationIds = new Set(map(observations, (o) => o.docId))
          return {
            isSyncEnabled: isSyncEnabled(project),
            observationIds,
          }
        })
      )

      const lines = [
        'Expected states to be strictly equal after the following steps, but timed out:',
        '',
        ...actionTitles,
        '',
        'Expected the following:',
        ...expectedState.flatMap(assertionLinesForProject),
        '',
        'Actually got the following:',
        ...actualState.flatMap(assertionLinesForProject),
        '',
      ]
      reject(new Error(lines.join('\n')))
    }, 5000)

    const removeListeners = () => {
      for (const project of projects) {
        project.$sync.off('sync-state', onState)
      }
    }

    const onState = async () => {
      if (await doesStateMatch(projects, expectedState)) {
        removeListeners()
        clearTimeout(timeout)
        resolve()
      }
    }

    for (const project of projects) {
      project.$sync.on('sync-state', onState)
    }

    onState().catch(reject)
  })
}

/**
 * @param {ProjectState} projectState
 * @param {number} index
 * @returns {string[]}
 */
function assertionLinesForProject({ isSyncEnabled, observationIds }, index) {
  return [
    `Project ${index} (sync ${isSyncEnabled ? 'started' : 'stopped'}): ${
      observationIds.size
    } observation${observationIds.size === 1 ? '' : 's'}`,
    ...Array.from(observationIds)
      .sort()
      .map((observationId) => `  ${observationId}`),
  ]
}
