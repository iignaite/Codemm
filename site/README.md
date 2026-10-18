# Codemm website

The public landing page, live at https://codemm.vercel.app. It's a static site with no server code and no dependencies, and it collects no personal data: no forms, no accounts, no cookies. The only measurement is Vercel Web Analytics, which counts page views in aggregate without cookies.

```
public/   the page, styles, scripts, fonts and images (copied to dist/ by build.mjs)
scripts/  dev.mjs, a local server with vercel.json's headers
test/     node:test suites
```

## How downloads work

- **The installers stay on GitHub Releases.** `public/main.js` reads the release list from the GitHub API in the visitor's browser, cached for 10 minutes in the tab, and links each installer straight to GitHub. Nothing is hosted on Vercel.
- **Which release:** the newest published stable release, or the newest beta until there is one. Drafts are never shown.
- **Which button:** the visitor's computer picks the main one (Apple Silicon Mac, Intel Mac, or Windows), with the others listed below it. Phones and Linux get every installer listed. A Mac whose chip the browser doesn't report (Safari and Firefox never do) gets Apple Silicon and Intel as two equal buttons, with a line on how to tell them apart.
- **Betas:** a beta release (a GitHub prerelease) shows a Beta label and the one-time steps to open an unsigned build.
- **No published release** shows "Coming soon" with a link to the GitHub repository.
- **GitHub unreachable:** the button links to the Releases page.

## Numbers

- **Downloads:** every download button links straight to the release asset's own GitHub URL (`browser_download_url`), with no redirect of ours, so GitHub counts each one. To see the counts:

  ```bash
  gh api repos/iignaite/Codemm/releases --jq '.[].assets[] | {name, download_count}'
  ```

- **Page views:** Vercel Web Analytics, in the Vercel project `codemm`, under **Analytics**. It's cookieless and aggregate. Speed Insights is off.

The hero shows Emm walking while the Claude Code, Codex and Cursor logos walk in; Emm catches each with its tongue and takes its color. The logos are there by the owner's choice; the footer says they're trademarks of their owners and that Codemm isn't affiliated with or endorsed by them. With reduced motion nothing moves: the logos stand still, and clicking one changes Emm's color.

## Third-party

- **Agent logos:** `public/img/agents/claude.svg`, `codex.svg` and `cursor.svg` come from LobeHub's [lobe-icons](https://github.com/lobehub/lobe-icons) (npm `@lobehub/icons-static-svg` 1.95.1), under the MIT License, © 2023 LobeHub. The notice is in `public/img/agents/LICENSE-lobe-icons.txt` and ships with the site. The marks are trademarks of Anthropic, OpenAI and Anysphere; the owner chose to show them, and the footer says Codemm isn't affiliated with or endorsed by them.
- **Fonts:** Schibsted Grotesk, Atkinson Hyperlegible Next and JetBrains Mono, under the SIL Open Font License 1.1. Each license is in `public/fonts/OFL-*.txt`.

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

The tests cover OS detection, the Mac chip choice, the copy (it says only what Codemm checks), that the hero starts no animation with reduced motion, which release and installer are offered, that every button is the asset's own GitHub URL, the no-release case, the build, and that the site stays static, with no forms and no tracking beyond Web Analytics. `.github/workflows/site.yml` runs them on pull requests that touch `site/`.

## Deploy

Deploys are manual. The Vercel project `codemm`, in the owner's personal scope (gael55xs-projects), isn't connected to GitHub. Every connected push, even to an unrelated branch, used up the free plan's 100 deployments a day.

After a site change is merged, deploy `main` from this folder with the Vercel CLI, signed in to the owner's personal account:

```bash
git switch main && git pull && cd site && npm run deploy
```

The first time on a computer, link the folder to the project:

```bash
cd site && vercel link --project codemm --scope gael55xs-projects
```

`npm run deploy` runs the tests first. A new GitHub release needs no redeploy: the page reads releases in the browser.

`vercel.json` sets the security headers: a CSP with no inline code that allows network requests only to this site (the analytics beacon) and `api.github.com`, plus HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and same-origin COOP and CORP.
