// @ts-nocheck — ported from ego-browser v2.1.0 (strict:false); vendor exemption, not strict-checked.
import { js } from './cdp-eval.ts'

/**
 * Fetch text from Node with a browser-like User-Agent.
 *
 * @param url - URL to fetch.
 * @param options - request overrides: headers, timeout in seconds (default 20), method, and body.
 * @returns the response body text; a non-2xx status throws.
 */
export async function serverFetch(url, options: any = {}): Promise<string> {
  const { timeout = 20.0, headers = {}, ...fetchOptions } = options
  const response = await fetch(url, {
    ...fetchOptions,
    headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
    signal: AbortSignal.timeout(timeout * 1000),
  })
  if (!response.ok) {
    throw new Error(
      `${fetchOptions.method || 'GET'} ${url} failed: HTTP ${response.status}`,
    )
  }
  return response.text()
}

/**
 * Fetch text in the current browser page context.
 *
 * @param url - URL to fetch; relative URLs resolve against the current page.
 * @param options - request overrides: headers, timeout in seconds (default 20), method, and body.
 * @returns the response body text; a non-2xx status throws.
 */
export async function browserFetch(url, options: any = {}): Promise<any> {
  const { timeout = 20.0, ...fetchOptions } = options
  const payload = JSON.stringify({ url, options: fetchOptions, timeout })
  return js(`(async () => {
    const { url, options, timeout } = ${payload};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        throw new Error(\`\${options.method || "GET"} \${url} failed: HTTP \${response.status}\`);
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  })()`)
}
