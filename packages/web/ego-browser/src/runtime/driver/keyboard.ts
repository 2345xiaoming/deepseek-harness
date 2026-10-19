// @ts-nocheck — ported from ego-browser v2.1.0-beta.2 (strict:false); vendor exemption, not strict-checked.
import { cdp } from '../cdp-eval.ts'
import { browserCdp } from '../browser-runtime.ts'
import { state } from '../state.ts'
import { withHandle, resolveAndCall } from './element-ops.ts'
import { waitForElement } from './waits.ts'

type FillInputOptions = {
  clearFirst?: boolean
  timeout?: number
}

/** CDP and timing facilities one keyboard operation needs from its Page session. */
export type KeyboardServices = {
  cdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<any>
  sleep(ms: number): Promise<void>
  platform?: string
}

const KEYS = {
  Enter: { vk: 13, key: 'Enter', code: 'Enter', text: '\r' },
  Tab: { vk: 9, key: 'Tab', code: 'Tab', text: '\t' },
  Backspace: { vk: 8, key: 'Backspace', code: 'Backspace', text: '' },
  Escape: { vk: 27, key: 'Escape', code: 'Escape', text: '' },
  Delete: { vk: 46, key: 'Delete', code: 'Delete', text: '' },
  ' ': { vk: 32, key: ' ', code: 'Space', text: ' ' },
  ArrowLeft: { vk: 37, key: 'ArrowLeft', code: 'ArrowLeft', text: '' },
  ArrowUp: { vk: 38, key: 'ArrowUp', code: 'ArrowUp', text: '' },
  ArrowRight: { vk: 39, key: 'ArrowRight', code: 'ArrowRight', text: '' },
  ArrowDown: { vk: 40, key: 'ArrowDown', code: 'ArrowDown', text: '' },
  Home: { vk: 36, key: 'Home', code: 'Home', text: '' },
  End: { vk: 35, key: 'End', code: 'End', text: '' },
  PageUp: { vk: 33, key: 'PageUp', code: 'PageUp', text: '' },
  PageDown: { vk: 34, key: 'PageDown', code: 'PageDown', text: '' },
}

const PRINTABLE_CODE_RE = /^[A-Za-z0-9]$/
const ALT_MODIFIER = 1
const CTRL_MODIFIER = 2
const META_MODIFIER = 4
const SHIFT_MODIFIER = 8
const NON_TEXT_MODIFIERS = ALT_MODIFIER | CTRL_MODIFIER | META_MODIFIER
const INPUT_EVENT_DELAY_MS = 25
const INPUT_DISPATCH_TIMEOUT_MS = 1000
const MODIFIER_KEYS = [
  {
    bit: ALT_MODIFIER,
    key: 'Alt',
    code: 'AltLeft',
    windowsVirtualKeyCode: 18,
    location: 1,
  },
  {
    bit: CTRL_MODIFIER,
    key: 'Control',
    code: 'ControlLeft',
    windowsVirtualKeyCode: 17,
    location: 1,
  },
  {
    bit: META_MODIFIER,
    key: 'Meta',
    code: 'MetaLeft',
    windowsVirtualKeyCode: 91,
    location: 1,
  },
  {
    bit: SHIFT_MODIFIER,
    key: 'Shift',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 16,
    location: 1,
  },
] as const
const NATIVE_ONLY_EDITING_COMMANDS = new Set([
  'copy',
  'cut',
  'paste',
  'redo',
  'undo',
])

const defaultKeyboardServices: KeyboardServices = {
  async cdp(method, params = {}, sessionId, timeoutMs) {
    // Keep the legacy cdp() override path for calls without a custom timeout.
    // Timed input dispatches use browserCdp() so a stalled native request can
    // still fall back to the synthetic event probe.
    if (timeoutMs === undefined) {
      return cdp(method, params, sessionId)
    }
    const response = await browserCdp(method, params, sessionId, timeoutMs)
    return response?.result || {}
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  get platform() {
    return state.platform
  },
}

/**
 * Resolve a key name or single printable character to its key description.
 * @param key - Key name such as `Enter`, or a one-character string.
 * @returns The virtual key code, DOM `code`, and text to insert for that key.
 */
export function keyDefinition(key: string): { vk: number; key: string; code: string; text: string } {
  const special = KEYS[key]
  if (special) {
    return special
  }
  if (key.length !== 1) {
    return { vk: 0, key, code: key, text: '' }
  }
  const vk = key.toUpperCase().codePointAt(0)
  const code = PRINTABLE_CODE_RE.test(key)
    ? `${/[0-9]/.test(key) ? 'Digit' : 'Key'}${key.toUpperCase()}`
    : key
  return { vk, key, code, text: key }
}

function editingCommandsForKey(key, modifiers, platform: string) {
  const code = keyDefinition(key).code
  if (modifiers === 0 && key === 'Backspace') {
    return ['deleteBackward']
  }
  if (modifiers === 0 && key === 'Delete') {
    return ['deleteForward']
  }

  // Chromium does not infer macOS editing commands merely from the Meta bit.
  // These command names match Chromium's editor command registry and the
  // corresponding Playwright mappings.
  if (platform === 'darwin') {
    if (modifiers === META_MODIFIER) {
      const command = {
        KeyA: 'selectAll',
        KeyC: 'copy',
        KeyV: 'paste',
        KeyX: 'cut',
        KeyZ: 'undo',
      }[code]
      return command ? [command] : undefined
    }
    if (modifiers === (SHIFT_MODIFIER | META_MODIFIER) && code === 'KeyZ') {
      return ['redo']
    }
    return undefined
  }

  // Preserve select-all for the legacy numeric modifier API off macOS.
  if (modifiers === CTRL_MODIFIER && code === 'KeyA') {
    return ['selectAll']
  }
  return undefined
}

/**
 * Dispatch a key press through CDP.
 * @param key - Key name such as Enter, Tab, ArrowLeft, or a single printable character.
 * @param modifiers - CDP modifier bitfield: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
 * @returns Resolves after the key press is dispatched.
 */
export async function pressKey(key: string, modifiers = 0): Promise<void> {
  return pressKeyInPage(defaultKeyboardServices, undefined, key, modifiers)
}

/**
 * Dispatch one key press through an explicit Page session.
 * @param services - CDP and timing facilities for the Page session.
 * @param sessionId - Target Page session, or undefined for the current page.
 * @param key - Key name or single printable character to press.
 * @param modifiers - CDP modifier bitfield: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
 * @returns Resolves after the key down/up sequence completes.
 */
export async function pressKeyInPage(
  services: KeyboardServices,
  sessionId: string | undefined,
  key: string,
  modifiers = 0,
): Promise<void> {
  const { vk, code, text } = keyDefinition(key)
  const platform = services.platform ?? state.platform
  const commands = editingCommandsForKey(key, modifiers, platform)
  const emittedText = modifiers & NON_TEXT_MODIFIERS ? '' : text
  const base = {
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
  }
  const probeId = await installKeyProbe(
    services,
    sessionId,
    key,
    expectedEditingEvent(commands),
  )
  let dispatchError: unknown = null
  let activeModifiers = 0
  const pressedModifiers = MODIFIER_KEYS.filter(modifier =>
    Boolean(modifiers & modifier.bit),
  )
  let finalKeyDownAttempted = false
  try {
    for (const modifier of pressedModifiers) {
      activeModifiers |= modifier.bit
      await dispatchKeyEvent(services, sessionId, {
        type: 'rawKeyDown',
        key: modifier.key,
        code: modifier.code,
        modifiers: activeModifiers,
        windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
        location: modifier.location,
      })
    }

    finalKeyDownAttempted = true
    await dispatchKeyEvent(services, sessionId, {
      type: emittedText ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(emittedText
        ? { text: emittedText, unmodifiedText: emittedText }
        : {}),
      ...(commands ? { commands } : {}),
    })
    await inputEventDelay(services)
    await dispatchKeyEvent(services, sessionId, { type: 'keyUp', ...base })
    finalKeyDownAttempted = false
  } catch (error) {
    if (!isKeyDispatchTimeout(error)) throw error
    dispatchError = error
  } finally {
    // A timed-out send may still have reached Chromium. Release everything we
    // attempted to press so the page cannot inherit a stuck modifier state.
    if (finalKeyDownAttempted) {
      try {
        await dispatchKeyEvent(services, sessionId, { type: 'keyUp', ...base })
      } catch (error) {
        dispatchError ||= error
      }
    }
    for (const modifier of [...pressedModifiers].reverse()) {
      activeModifiers &= ~modifier.bit
      try {
        await dispatchKeyEvent(services, sessionId, {
          type: 'keyUp',
          key: modifier.key,
          code: modifier.code,
          modifiers: activeModifiers,
          windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
          location: modifier.location,
        })
      } catch (error) {
        dispatchError ||= error
      }
    }
  }
  const requiresNativeEditing = Boolean(
    commands?.some(command => NATIVE_ONLY_EDITING_COMMANDS.has(command)),
  )
  const completed = await finishKeyProbe(services, sessionId, probeId, {
    key,
    code,
    text: emittedText,
    commands,
    modifiers,
    allowSyntheticFallback: !requiresNativeEditing,
  })
  if (requiresNativeEditing && probeId && !completed) {
    if (dispatchError) throw dispatchError
    throw new Error(
      `page.keyboard.press could not deliver native editing shortcut ${formatShortcut(key, modifiers)}`,
    )
  }
  if (dispatchError && !completed) throw dispatchError
}

function expectedEditingEvent(commands?: string[]) {
  if (commands?.includes('paste')) return 'paste'
  if (commands?.includes('copy')) return 'copy'
  if (commands?.includes('cut')) return 'cut'
  return 'keydown'
}

function formatShortcut(key: string, modifiers: number) {
  const names = MODIFIER_KEYS.filter(
    modifier => modifiers & modifier.bit,
  ).map(modifier => modifier.key)
  return [...names, key].join('+')
}

/**
 * Insert text at the focused input using CDP Input.insertText.
 * @param text - Text to insert.
 * @returns Resolves after the text is inserted.
 */
export async function typeText(text: string): Promise<void> {
  await typeTextInPage(defaultKeyboardServices, undefined, text)
}

/**
 * Insert text through an explicit Page session.
 * @param services - CDP and timing facilities for the Page session.
 * @param sessionId - Target Page session, or undefined for the current page.
 * @param text - Text to insert; a non-string value throws a TypeError.
 * @returns Resolves after the text is inserted.
 */
export async function typeTextInPage(
  services: KeyboardServices,
  sessionId: string | undefined,
  text: string,
): Promise<void> {
  if (typeof text !== 'string') {
    throw new TypeError('page.keyboard.type text must be a string')
  }
  await services.cdp('Input.insertText', { text }, sessionId)
}

/**
 * Focus an input, optionally clear it, type text, and fire input/change events.
 * @param selector - CSS selector / @ref / loc= / xpath= for the input-like element.
 * @param text - Text to write.
 * @param options - `clearFirst` defaults to true; a positive `timeout` waits for the element first.
 * @returns Resolves after the value and its input/change events are dispatched.
 * @throws When a positive `options.timeout` elapses before the element appears.
 */
export async function fillInput(
  selector: string,
  text: string,
  options: FillInputOptions = {},
): Promise<void> {
  const clearFirst = options.clearFirst ?? true
  const timeout = options.timeout ?? 0
  if (timeout > 0 && !(await waitForElement(selector, { timeout }))) {
    throw new Error(
      `fillInput: element not found: ${JSON.stringify(selector)}`,
    )
  }
  await withHandle(selector, async ({ objectId, sessionId }) => {
    const focusSource = clearFirst
      ? "function(){this.focus(); if(typeof this.select==='function') this.select();}"
      : 'function(){this.focus();}'
    await cdp(
      'Runtime.callFunctionOn',
      {
        functionDeclaration: focusSource,
        objectId,
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    )
    if (clearFirst) {
      await cdp(
        'Runtime.callFunctionOn',
        {
          functionDeclaration:
            "function(){this.value=''; this.dispatchEvent(new Event('input',{bubbles:true}));}",
          objectId,
          returnByValue: true,
          awaitPromise: false,
        },
        sessionId,
      )
    }
    await cdp('Input.insertText', { text }, sessionId)
    await cdp(
      'Runtime.callFunctionOn',
      {
        functionDeclaration:
          "function(){this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));}",
        objectId,
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    )
  })
}

/**
 * Focus an element and dispatch a DOM KeyboardEvent in page JavaScript.
 * The dispatched event has `isTrusted=false`, so pages that require trusted input ignore it; use `pressKey` for a real CDP key event.
 * @param selector - CSS selector / @ref / loc= / xpath= for the target element.
 * @param key - Event key; defaults to `Enter`.
 * @param event - Event type; defaults to `keypress`.
 * @returns Resolves after the event is dispatched.
 */
export async function dispatchKey(selector: string, key = 'Enter', event = 'keypress'): Promise<void> {
  const { vk, code } = keyDefinition(key)
  await resolveAndCall(
    selector,
    'function(keyCode, key, code, event){this.focus(); this.dispatchEvent(new KeyboardEvent(event,{key,code,keyCode,which:keyCode,bubbles:true}));}',
    [vk, key, code, event],
  )
}

function inputEventDelay(services: KeyboardServices) {
  return services.sleep(INPUT_EVENT_DELAY_MS)
}

async function dispatchKeyEvent(
  services: KeyboardServices,
  sessionId: string | undefined,
  params: Record<string, unknown>,
) {
  await services.cdp(
    'Input.dispatchKeyEvent',
    params,
    sessionId,
    INPUT_DISPATCH_TIMEOUT_MS,
  )
}

async function installKeyProbe(
  services: KeyboardServices,
  sessionId: string | undefined,
  key: string,
  eventType = 'keydown',
) {
  if (!canProbeInputFallback()) return null
  const id = `key_${Date.now()}_${Math.random().toString(16).slice(2)}`
  try {
    const result = await services.cdp(
      'Runtime.evaluate',
      {
        expression: `(() => {
      window.__egoBrowserInputProbes ||= {};
      const probe = { seen: false, eventType: ${JSON.stringify(eventType)} };
      probe.handler = (event) => {
        if (
          event.isTrusted &&
          (probe.eventType !== "keydown" || event.key === ${JSON.stringify(key)})
        ) probe.seen = true;
      };
      document.addEventListener(probe.eventType, probe.handler, true);
      window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
      return true;
    })()`,
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    )
    return result.result?.value ? id : null
  } catch {
    return null
  }
}

async function finishKeyProbe(
  services: KeyboardServices,
  sessionId: string | undefined,
  id: string | null,
  definition: {
    key: string
    code: string
    text: string
    commands?: string[]
    modifiers: number
    allowSyntheticFallback: boolean
  },
) {
  if (!id) return false
  await inputEventDelay(services)
  try {
    const result = await services.cdp(
      'Runtime.evaluate',
      {
        expression: `(() => {
      const probes = window.__egoBrowserInputProbes || {};
      const probe = probes[${JSON.stringify(id)}];
      if (!probe) return { seen: false, fallback: false };
      document.removeEventListener(probe.eventType, probe.handler, true);
      delete probes[${JSON.stringify(id)}];
      if (probe.seen) return { seen: true, fallback: false };

      if (!${JSON.stringify(definition.allowSyntheticFallback)}) {
        return { seen: false, fallback: false };
      }

      const target = document.activeElement || document.body;
      const key = ${JSON.stringify(definition.key)};
      const code = ${JSON.stringify(definition.code)};
      const text = ${JSON.stringify(definition.text)};
      const commands = ${JSON.stringify(definition.commands || [])};
      const modifiers = ${JSON.stringify(definition.modifiers)};
      const keyboardInit = {
        key,
        code,
        altKey: Boolean(modifiers & ${ALT_MODIFIER}),
        ctrlKey: Boolean(modifiers & ${CTRL_MODIFIER}),
        metaKey: Boolean(modifiers & ${META_MODIFIER}),
        shiftKey: Boolean(modifiers & ${SHIFT_MODIFIER}),
        bubbles: true,
        cancelable: true,
        keyCode: ${JSON.stringify(keyDefinition(definition.key).vk)},
        which: ${JSON.stringify(keyDefinition(definition.key).vk)},
      };
      target.dispatchEvent(new KeyboardEvent("keydown", keyboardInit));

      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;
      if (isEditable) {
        if (commands.includes("selectAll") && typeof target.select === "function") {
          target.select();
        } else if (commands.includes("deleteBackward")) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const from = start === end ? Math.max(0, start - 1) : start;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "deleteContentBackward",
          }));
          target.value = before.slice(0, from) + before.slice(end);
          target.setSelectionRange(from, from);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentBackward",
          }));
        } else if (commands.includes("deleteForward")) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const to = start === end ? Math.min(target.value.length, end + 1) : end;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "deleteContentForward",
          }));
          target.value = before.slice(0, start) + before.slice(to);
          target.setSelectionRange(start, start);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentForward",
          }));
        } else if (text) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            data: text,
            inputType: "insertText",
          }));
          target.value = before.slice(0, start) + text + before.slice(end);
          const next = start + text.length;
          target.setSelectionRange(next, next);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            data: text,
            inputType: "insertText",
          }));
        }
      }

      target.dispatchEvent(new KeyboardEvent("keyup", keyboardInit));
      return { seen: false, fallback: true };
    })()`,
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    )
    const value = result.result?.value
    return Boolean(value?.seen || value?.fallback)
  } catch {
    return false
  }
}

function canProbeInputFallback() {
  return Boolean((globalThis as any).ego?.sendCDPMessage)
}

function isKeyDispatchTimeout(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /CDP request timed out: Input\.dispatchKeyEvent/.test(message)
}
