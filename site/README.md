# Codemm website

The public download page: a static site in `public/` with no dependencies.

- **Downloads come from GitHub Releases**, never from this site. `public/main.js` reads the release list from the GitHub API in the visitor's browser (cached for 10 minutes) and links each installer straight to GitHub. It offers the newest published stable release, or the newest beta until there is one. Drafts are never shown.
- **The visitor's computer picks the main button**: Apple Silicon or Intel Mac, or Windows. Phones and Linux get every installer listed. A Mac whose chip the browser doesn't report gets Apple Silicon first, with Intel right below.
- **A beta release** (a GitHub prerelease) shows a Beta label and the one-time steps to open an unsigned build.
- **No published release** shows "Coming soon". If GitHub can't be reached, the button links to the Releases page.
- **App screenshots** in `public/img/app-*.webp` come from the desktop app's demo mode (`CODEMM_MOCK`), at 1440×860.

## Develop

```bash
node site/build.mjs
```

```bash
python3 -m http.server 4317 --directory site/dist
```

Then open http://localhost:4317. `build.mjs` copies `public/` to `dist/` and fills in the site's absolute URL for the canonical and Open Graph tags (set `SITE_URL`, or Vercel's production domain is used).

## Test

```bash
node --test 'site/test/*.test.js'
```

The tests cover OS detection, which release is offered, which installer is the main button, the no-release case, and the build.

## Deploy on Vercel

The owner does this once, signed in to their own Vercel account:

1. **Import** github.com/iignaite/Codemm as a new Vercel project.
2. **Set the Root Directory to `site`.** Everything else comes from `site/vercel.json`: no install step, `node build.mjs` as the build, and `dist` as the output.
3. **Deploy**, then add the domain under Project Settings, Domains.

After that, every push to `main` that changes `site/` redeploys it (`ignoreCommand` skips the rest). A new GitHub release needs no redeploy: the page reads releases live.

`vercel.json` also sets a strict Content Security Policy (the page talks only to `api.github.com`), long caching for fonts, and security headers. Vercel's preview toolbar is blocked by that policy on preview deployments, which is expected.
