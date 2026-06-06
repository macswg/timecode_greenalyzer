# smpte-analyzer

Vite + React app — the browser-side SMPTE LTC analyzer UI.

See the root [README.md](../README.md) for setup instructions, architecture overview, and SMPTE technical reference.

**No install needed to just use it:** [https://macswg.github.io/timecode_greenalyzer/](https://macswg.github.io/timecode_greenalyzer/)

To run from source:

```bash
npm install
npm run dev   # http://localhost:5173
```

### Build / deploy

This is a fully static, client-side app. `npm run build` emits a `dist/` folder
deployable to any static host. Pushing to `main` auto-publishes to GitHub Pages
via [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

`vite.config.js` sets `base: '/timecode_greenalyzer/'` for production builds so
assets resolve under the GitHub Pages project subpath (dev stays at `/`). If you
deploy under a different repo name or path, update `base` to match — otherwise
assets (including the `ltc-worklet.js` AudioWorklet, loaded at runtime via
`import.meta.env.BASE_URL`) 404 and live capture silently fails.
