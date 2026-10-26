// @ts-nocheck — ported from ego-browser v2.1.0 (strict:false); vendor exemption, not strict-checked.

import { hasReturnStatement } from './js-source.ts'
import { browserCdp } from './browser-runtime.ts'
import { state } from './state.ts'

let hasWarnedAboutFunctionJs = false

/**
 * Send a raw Chrome DevTools Protocol command. On the default session, Network.enable
 * and Network.disable also record the domain's state for helpers that restore it.
 * @param method - CDP method name, for example Runtime.evaluate.
 * @param params - CDP command parameters.
 * @param sessionId - optional attached target session id; the state override only applies to the default session.
 * @returns the CDP result object, or an empty object when the response carries none.
 */
export async function cdp(method, params: any = {}, sessionId = undefined): Promise<any> {
  const result = state.cdpOverride
    ? await state.cdpOverride(method, params, sessionId)
    : (await browserCdp(method, params, sessionId)).result || {}
  if (
    !sessionId &&
    (method === 'Network.enable' || method === 'Network.disable')
  ) {
    // Mirror the default session's Network domain state so helpers like
    // waitForNetworkIdle can restore it instead of tearing down a domain
    // the caller still relies on for drainEvents().
    state.networkDomainEnabled = method === 'Network.enable'
  }
  return result
}

/**
 * Evaluate JavaScript in the current page or a target tab.
 * @param expression - JavaScript source string, or a function whose body is evaluated; a function emits a
 *   one-time warning to stderr because auto-wrap captures no closure variables and passes no arguments. A
 *   top-level `return` in a string is auto-wrapped in an async IIFE.
 * @param targetId - optional target id to attach and evaluate in.
 * @returns the Runtime.evaluate return-by-value result.
 * @throws when `expression` is neither a string nor a function, or when the evaluation reports an exception.
 */
export async function js(expression, targetId = undefined): Promise<any> {
  if (typeof expression === 'function') {
    const source = expression.toString()
    if (!hasWarnedAboutFunctionJs) {
      hasWarnedAboutFunctionJs = true
      process.stderr.write(
        `[ego-browser] js() received a function and auto-wrapped it (${jsSnippet(source, 80)}).\n` +
          '  js() is a thin wrapper over CDP Runtime.evaluate; it takes a string expression,\n' +
          '  not a Puppeteer/Playwright-style callable. Auto-wrap does NOT capture closure\n' +
          '  variables and has NO args channel.\n' +
          '  Prefer:\n' +
          '    js(`<expression>`)  // pure expression or explicit IIFE\n',
      )
    }
    expression = `(${source})()`
  } else if (typeof expression !== 'string') {
    throw new TypeError(
      `js() expects a string expression or function, got ${expression === null ? 'null' : typeof expression}`,
    )
  }
  const sessionId = targetId
    ? (await cdp('Target.attachToTarget', { targetId, flatten: true }))
      .sessionId
    : undefined
  let finalExpression = expression
  if (hasReturnStatement(expression)) {
    // Newlines keep a trailing line comment from swallowing the closing
    // brace; async keeps top-level await valid inside the wrapper.
    finalExpression = `(async function(){\n${expression}\n})()`
  }
  return runtimeEvaluate(finalExpression, sessionId, true)
}

async function runtimeEvaluate(
  expression,
  sessionId = undefined,
  awaitPromise = false,
) {
  try {
    const response = await cdp(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise,
      },
      sessionId,
    )
    return runtimeValue(response, expression)
  } catch (error) {
    if (/timed out/i.test(error?.message || '')) {
      throw new Error(
        `Runtime.evaluate timed out; expression: ${jsSnippet(expression)}`,
      )
    }
    throw error
  }
}

/**
 * Unwrap a Runtime.evaluate response into its JavaScript value.
 * @param response - the CDP response carrying `result` and optional `exceptionDetails`.
 * @param expression - the evaluated source, quoted in the thrown error for diagnosis.
 * @returns the value, the decoded unserializable value, or null when the response carries neither.
 * @throws when the response reports an exception or an error subtype.
 */
export function runtimeValue(response, expression): any {
  const result = response.result || {}
  const details = response.exceptionDetails
  if (details || result.subtype === 'error') {
    const desc = jsExceptionDescription(result, details)
    const loc =
      details?.lineNumber !== undefined && details?.columnNumber !== undefined
        ? ` at line ${details.lineNumber}, column ${details.columnNumber}`
        : ''
    throw new Error(
      `JavaScript evaluation failed${loc}: ${desc}; expression: ${jsSnippet(expression)}`,
    )
  }
  if (Object.hasOwn(result, 'value')) {
    return result.value
  }
  if (Object.hasOwn(result, 'unserializableValue')) {
    return decodeUnserializableJsValue(result.unserializableValue)
  }
  return null
}

function jsExceptionDescription(result, details) {
  let desc = result.description
  const exception = details?.exception
  if (!desc && exception && typeof exception === 'object') {
    desc = exception.description
    if (desc === undefined && Object.hasOwn(exception, 'value')) {
      desc = String(exception.value)
    }
    if (desc === undefined) {
      desc = exception.className
    }
  }
  return desc || details?.text || 'JavaScript evaluation failed'
}

/**
 * Decode a CDP unserializable value into its JavaScript value: `NaN`, `Infinity`,
 * `-Infinity`, `-0`, or a BigInt literal.
 * @param value - the CDP `unserializableValue` string.
 * @returns the decoded number or bigint, or the input unchanged when it matches none of those forms.
 */
export function decodeUnserializableJsValue(value): any {
  if (value === 'NaN') {
    return Number.NaN
  }
  if (value === 'Infinity') {
    return Number.POSITIVE_INFINITY
  }
  if (value === '-Infinity') {
    return Number.NEGATIVE_INFINITY
  }
  if (value === '-0') {
    return -0
  }
  if (value.endsWith('n')) {
    return BigInt(value.slice(0, -1))
  }
  return value
}

function jsSnippet(expression, limit = 160) {
  const snippet = expression.trim().replace(/\n/g, '\\n')
  return snippet.length > limit ? `${snippet.slice(0, limit - 3)}...` : snippet
}
