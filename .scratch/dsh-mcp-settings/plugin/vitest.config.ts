import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../../vitest.shared.ts'

// Tests import the checkout's packages through the tsconfig.base.json paths facade
// (source plane), so every bare import resolves to one src copy and built lib/
// never loads a second module-singleton. The shared decorator pre-transform is
// required because the tools/settings sources use standard TS decorators.
export default defineConfig({
  plugins: [
    tsconfigPaths({ projects: [fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url))] }),
    standardDecoratorPlugin(),
  ],
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
