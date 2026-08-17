import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/*/*/tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/lib/**'],
    // Bootstrap: the repo starts with zero plugin packages; passWithNoTests
    // keeps the presubmit green until the first scaffolded suite lands.
    passWithNoTests: true,
  },
})
