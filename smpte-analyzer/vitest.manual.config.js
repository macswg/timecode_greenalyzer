import { defineConfig } from 'vitest/config'

// On-demand harnesses (test/manual/): decode the testing_timecode WAV fixtures
// through the real decoder and, for generators, (re)write fixtures into
// testing_timecode/. These are slow and side-effecting, so they are excluded
// from the default `npm test` (see test.exclude in vite.config.js) and run
// explicitly via `npm run test:manual`.
export default defineConfig({
  test: {
    include: ['test/manual/**/*.test.js'],
    testTimeout: 60000,
  },
})
