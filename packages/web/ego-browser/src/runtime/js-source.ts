/**
 * Source shaping for `Runtime.evaluate`. Both `js()` and the `browser_js` tool
 * hand the browser a string, and the accepted shape differs between a script
 * whose completion value is the result, an outer `return`, and top-level
 * `await`. The inspection here is pure syntax analysis, so it stays testable
 * without launching Chrome.
 */

import { parse, type Node, type Options, type Program } from 'acorn'

/** Node types whose bodies form their own function scope. */
const FUNCTION_NODE_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
])

/** Parsing tolerances shared by every inspection: an outer `return` and `await` are shapes to detect, not errors. */
const PARSE_OPTIONS: Options = {
  ecmaVersion: 'latest',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
}

/**
 * Parse a source string.
 * @param expression - JavaScript source to parse.
 * @returns the parsed program, or null when acorn rejects the syntax.
 */
function parseProgram(expression: string): Program | null {
  try {
    return parse(expression, PARSE_OPTIONS)
  } catch {
    return null
  }
}

/**
 * Whether a walked value is an acorn node.
 * @param value - candidate AST value.
 * @returns true when the value carries a string `type`.
 */
function isNode(value: unknown): value is Node {
  if (typeof value !== 'object' || value === null) return false
  return 'type' in value && typeof value.type === 'string'
}

/**
 * Whether the source holds a node of `type` outside every nested function.
 * @param node - AST value to walk.
 * @param type - acorn node type to find.
 * @returns true when the node occurs at the source's own level.
 */
function containsAtTopLevel(node: unknown, type: string): boolean {
  if (!isNode(node)) return false
  if (node.type === type) return true
  if (FUNCTION_NODE_TYPES.has(node.type)) return false
  return Object.values(node).some(child =>
    Array.isArray(child)
      ? child.some(entry => containsAtTopLevel(entry, type))
      : containsAtTopLevel(child, type),
  )
}

/**
 * Whether the source returns outside every nested function, which
 * `Runtime.evaluate` accepts only once a function wrapper carries the `return`.
 * @param expression - JavaScript source to inspect.
 * @returns true when an outer `return` requires a wrapper.
 */
export function hasReturnStatement(expression: string): boolean {
  const program = parseProgram(expression)
  return program !== null && containsAtTopLevel(program, 'ReturnStatement')
}

/**
 * Whether the source awaits outside every nested function, where only an async
 * wrapper makes the code valid.
 * @param expression - JavaScript source to inspect.
 * @returns true when the source awaits at its own level.
 */
export function hasTopLevelAwait(expression: string): boolean {
  const program = parseProgram(expression)
  return program !== null && containsAtTopLevel(program, 'AwaitExpression')
}

/**
 * Whether the source is one expression, so a `return (...)` wrapper preserves
 * its value.
 * @param expression - JavaScript source to inspect.
 * @returns true when the whole source parses as a single expression.
 */
export function isSingleExpression(expression: string): boolean {
  // Parenthesizing forces an expression parse instead of a statement parse, so
  // `{ a: 1 }` reads as an object literal rather than a block. The trailing
  // newline keeps a final line comment from swallowing the closing paren.
  const program = parseProgram(`(${expression}\n)`)
  if (program === null) return false
  return (
    program.body.length === 1 &&
    program.body.every(statement => statement.type === 'ExpressionStatement')
  )
}

/**
 * Source the `browser_js` tool evaluates for one agent-supplied expression or
 * statement body.
 *
 * Without top-level `await` the source passes through unchanged: `js()` yields a
 * script's completion value and wraps an outer `return` itself. Top-level
 * `await` is valid only inside an async function, so those sources get an async
 * IIFE — a single expression is returned, while a statement body keeps its own
 * `return` as the value.
 * @param expression - the agent-supplied expression or statement body.
 * @returns the source string to evaluate.
 */
export function browserJsSource(expression: string): string {
  if (!hasTopLevelAwait(expression)) return expression
  return isSingleExpression(expression)
    ? `(async () => { return (${expression}\n) })()`
    : `(async () => { ${expression}\n })()`
}
