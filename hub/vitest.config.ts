import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // The pool's bundled workerd is older than the deployed compatibility date.
      miniflare: { compatibilityDate: '2026-08-15', bindings: { SETUP_TOKEN: 'test-setup-token-0123456789' } },
    }),
  ],
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
