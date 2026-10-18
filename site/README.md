# Codemm website

The public landing page, live at https://codemm.vercel.app. It's a static site with no server code and no dependencies, and it collects nothing: no forms, no accounts, no cookies, no analytics.

```
public/   the page, styles, scripts, fonts and images (copied to dist/ by build.mjs)
scripts/  dev.mjs, a local server with vercel.json's headers
test/     node:test suites
```

## How downloads work

- **The installers stay on GitHub Releases.** `public/main.js` reads the release list from the GitHub API in the visitor's browser, cached for 10 minutes in the tab, and links each installer straight to GitHub. Nothing is hosted on Vercel.
- **Which release:** the newest published stable release, or the newest beta until there is one. Drafts are never shown.
- **Which button:** the visitor's computer picks the main one (Apple Silicon Mac, Intel Mac, or Windows), with the others listed below it. Phones and Linux get every installer listed. A Mac whose chip the browser doesn't report gets Apple Silicon first, with Intel right below.
- **Betas:** a beta release (a GitHub prerelease) shows a Beta label and the one-time steps to open an unsigned build.
- **No published release** shows "Coming soon" with a link to the GitHub repository.
- **GitHub unreachable:** the button links to the Releases page.

The hero shows the names Claude Code, Codex and Cursor as plain text around Codemm's own art. There are no third-party logos, and the footer says Codemm isn't affiliated with or endorsed by them.

## Develop

Needs Node.js 22 or newer.

```bash
cd site && npm run build && npm run dev
```

Then open http://localhost:4317.

## Test

```bash
cd site && npm test
```

The tests cover OS detection, which release and installer are offered, the no-release case, the build, and that the site stays static and collects nothing. `.github/workflows/site.yml` runs them on pull requests that touch `site/`.

## Deploy

The Vercel project `codemm` in the owner's personal scope (gael55xs-projects) is connected to this repository, with Root Directory `site` and production branch `main`. Merging to `main` deploys; commits that don't touch `site/` are skipped (`ignoreCommand`). A new GitHub release needs no redeploy.

`vercel.json` sets the security headers: a CSP with no inline code that allows network requests only to `api.github.com`, plus HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and same-origin COOP and CORP.
