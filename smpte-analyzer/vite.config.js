import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function gitInfo() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const count = execSync('git rev-list --count HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return { sha, count };
  } catch {
    return { sha: 'dev', count: '0' };
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
const { sha, count } = gitInfo();

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_COMMIT__: JSON.stringify(sha),
    __GIT_COMMIT_COUNT__: JSON.stringify(count),
  },
  test: {
    // On-demand harnesses under test/manual/ decode whole WAV fixtures and
    // (re)generate test files — slow and side-effecting, so they're excluded
    // from the default `npm test`. Run them with `npm run test:manual`.
    exclude: [...configDefaults.exclude, 'test/manual/**'],
  },
})
