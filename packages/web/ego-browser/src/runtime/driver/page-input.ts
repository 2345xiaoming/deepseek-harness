// @ts-nocheck — ported from ego-browser v2.1.0-beta.2 (strict:false); vendor exemption, not strict-checked.
import { isAbsolute } from 'node:path'

import { resolveElementObjectId } from '../element-resolver.ts'
import { type RefMap } from '../ref-map.ts'
import { COMPOSED_TREE_HELPERS } from './action-target.ts'
import { type KeyboardServices } from './keyboard.ts'

type PageInputServices = KeyboardServices

const RESOLVE_FILE_INPUT_SOURCE = `function resolveFileInputForUpload() {
  ${COMPOSED_TREE_HELPERS}
  const isFileInput = (element) =>
    String(element?.tagName || "").toUpperCase() === "INPUT" &&
    String(element.type || "").toLowerCase() === "file";
  if (isFileInput(this)) return this;
  const isFileLabel = (element) =>
    String(element?.tagName || "").toUpperCase() === "LABEL" &&
    isFileInput(element.control);
  if (isFileLabel(this)) {
    return this.control;
  }
  const label = nearestComposedAncestor(this, isFileLabel);
  if (label) return label.control;
  const descendants = composedDescendantMatches(this, isFileInput, true);
  if (descendants.length === 1) return descendants[0];
  if (descendants.length > 1) {
    throw new TypeError(
      "page.setInputFiles selected a container with multiple file inputs",
    );
  }
  throw new TypeError(
    "page.setInputFiles requires a file input, its label, or a container with a file input",
  );
}`

/**
 * Set one or more local files on an input in one explicit Page session. The
 * selector may name the file input, its label, or a container holding exactly
 * one file input; anything else is rejected with `TypeError`. Objects resolved
 * for the attempt are released even when the assignment fails.
 * @param services - Page services supplying CDP.
 * @param sessionId - the Page session holding the input.
 * @param refMap - refs held for this Page, consulted before selector matching.
 * @param selector - CSS selector, `@ref`, `loc=`, or `xpath=` expression.
 * @param path - one absolute file path or a list of them.
 * @param iframeSessions - frame id to session id map discovered for this Page.
 */
export async function setInputFilesInPage(
  services: PageInputServices,
  sessionId: string,
  refMap: RefMap,
  selector: string,
  path: string | string[],
  iframeSessions = new Map<string, string>(),
): Promise<void> {
  const files = normalizeFilePaths(path, 'page.setInputFiles')
  const resolved = await resolveElementObjectId(
    cdpAdapter(services),
    sessionId,
    refMap,
    selector,
    iframeSessions,
    { strict: true },
  )
  let inputObjectId: string | undefined
  try {
    const input = await services.cdp(
      'Runtime.callFunctionOn',
      {
        functionDeclaration: RESOLVE_FILE_INPUT_SOURCE,
        objectId: resolved.objectId,
        returnByValue: false,
        awaitPromise: false,
      },
      resolved.sessionId,
    )
    if (input?.exceptionDetails) {
      throw new TypeError(
        input.exceptionDetails.exception?.description ||
          input.exceptionDetails.text ||
          'page.setInputFiles could not resolve a file input',
      )
    }
    inputObjectId = input?.result?.objectId
    if (!inputObjectId) {
      throw new TypeError('page.setInputFiles could not resolve a file input')
    }
    await setFilesOnBackendNode(
      services,
      resolved.sessionId,
      files,
      undefined,
      inputObjectId,
    )
  } finally {
    if (inputObjectId && inputObjectId !== resolved.objectId) {
      await releaseObject(services, resolved.sessionId, inputObjectId)
    }
    await releaseObject(services, resolved.sessionId, resolved.objectId)
  }
}

/**
 * Validate local file paths without touching the operating-system chooser.
 * @param path - one absolute file path or a list of them.
 * @param methodName - public method name used in the rejection message.
 * @returns the paths as a list, unchanged.
 */
export function normalizeFilePaths(
  path: string | string[],
  methodName: string,
): string[] {
  const files = Array.isArray(path) ? path : [path]
  if (
    files.some(
      file =>
        typeof file !== 'string' || file.length === 0 || !isAbsolute(file),
    )
  ) {
    throw new TypeError(`${methodName} requires absolute file paths`)
  }
  return files
}

/**
 * Set files on a file input identified by a chooser event, addressed by backend
 * node id or remote object id.
 * @param services - Page services supplying CDP.
 * @param sessionId - the Page session holding the file input.
 * @param files - absolute paths to assign.
 * @param backendNodeId - backend node id of the file input, when known.
 * @param objectId - remote object id of the file input, when known.
 */
export async function setFilesOnBackendNode(
  services: PageInputServices,
  sessionId: string,
  files: string[],
  backendNodeId?: number,
  objectId?: string,
): Promise<void> {
  await services.cdp(
    'DOM.setFileInputFiles',
    {
      files,
      ...(backendNodeId === undefined ? {} : { backendNodeId }),
      ...(objectId === undefined ? {} : { objectId }),
    },
    sessionId,
  )
}

function cdpAdapter(services: PageInputServices) {
  return {
    sendRaw(method, params, sessionId) {
      return services.cdp(method, params, sessionId)
    },
  }
}

async function releaseObject(
  services: PageInputServices,
  sessionId: string,
  objectId: string,
): Promise<void> {
  await services
    .cdp('Runtime.releaseObject', { objectId }, sessionId)
    .catch(() => {})
}
