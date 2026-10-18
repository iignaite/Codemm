# Codemm website

The public landing page. Visitors read about Codemm, enter their email, and get the installer links. The source is always public on GitHub; only the installer links sit behind the email.

```
public/       the pages, styles, scripts, fonts and images (copied to dist/ by build.mjs)
api/          Vercel Functions: form, subscribe, downloads, unsubscribe
lib/          server code: email validation, signed tokens, the database, the endpoints
migrations/   the database schema, applied in name order
scripts/      dev.mjs (local server), migrate.mjs, unsubscribe-link.mjs
test/         node:test suites
```

## How the gate works

1. The page asks `GET /api/form` for a signed form token. It also says whether a release is out, so the form reads "Get Codemm" or "Notify me".
2. `POST /api/subscribe` with the email, the form token and a hidden honeypot field. The server refuses:
   - a filled honeypot;
   - a form token that is forged, younger than 3 seconds or older than 2 hours;
   - more than 5 submits per IP in 10 minutes, or 3 per email in an hour;
   - a request from another origin, a body that isn't JSON, or one over 2 KB;
   - an invalid email (ASCII, at most 254 characters, a normal domain).
3. It requires the Terms box (`terms: true`) and stores the email, whether they ticked the optional release-emails box (`consent`), the Terms version they accepted (`terms_version`, matching `TERMS_VERSION` in `lib/app.js` and `public/terms.html`) and a timestamp, and returns a signed download token, valid for 10 minutes. It never returns an unsubscribe token: submitting an email doesn't prove you own it, so removal links go only to the inbox.
4. The browser goes to `/downloads#d=…`. The fragment never reaches a server or a Referer header, and the page removes it from the address bar. `GET /api/downloads` with the download token returns the newest published release (stable first, otherwise the newest beta), reduced to its `.dmg` and `.exe` links on GitHub. The page picks the installer for the visitor's computer.
5. `/unsubscribe#u=…` deletes the email after a click. `scripts/unsubscribe-link.mjs` makes one link per subscriber, for the owner's release emails.

**What's stored.** The `subscribers` table holds `email`, `consent` (release emails, opt-in), `terms_version`, `created_at` and an id. Nothing else is stored: no IP, name or user agent. Rate limits are keyed by an HMAC of the IP or email, never the value itself, and are deleted after a day. When someone unsubscribes, their row is deleted and an HMAC of the email goes into `suppressions`, so nobody can put it back on the list through the form. Emails are never logged; errors log only an error code.

**No inbox confirmation yet.** Anyone can submit any address, so the list may hold emails whose owners never asked. Double opt-in (a confirmation email before `consent = 1`) needs an email provider, which is the owner's choice.

**Security headers** (`vercel.json`): a CSP with `script-src 'self'` and no inline code, `connect-src 'self'` (the browser talks only to this site; the server calls GitHub), `frame-ancestors 'none'`, HSTS, `nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and same-origin COOP and CORP. API responses are `no-store`.

**Bot protection** is the honeypot, the time check and the rate limits. For stronger protection, two options, each needing the owner's OK because it adds a third party:

- **Vercel BotID**: invisible, no third-party script on the page, and checked in the function. Its deep analysis needs a paid plan.
- **Cloudflare Turnstile**: free, with a widget script from `challenges.cloudflare.com`, so the CSP would need that origin.

## Terms of Use

`public/terms.html` is a plain-language draft, not legal advice; have a lawyer review it. The form is clickwrap: an unticked, required "I agree to the Terms" box beside a link to the Terms, and the server refuses a submit without it and records the version accepted. To change the Terms, edit the page, bump its version and date together with `TERMS_VERSION`, and commit; git keeps every earlier version. Before the first release the form is only a notify list, so the release-emails box is hidden and the submit counts as asking for release emails.

## Develop

Needs Node.js 22 or newer. No Vercel or Turso account is needed.

```bash
cd site && npm ci
```

```bash
cp .env.example .env
```

Set `SITE_SECRET` in `.env` to the output of `openssl rand -base64 48`, then:

```bash
npm run migrate
```

```bash
npm run build && npm run dev
```

Open http://localhost:4317. Data goes to `data/dev.db` (gitignored). To preview a release before one is published, set `DEV_RELEASES_FILE` to a JSON file shaped like GitHub's release list.

## Test

```bash
cd site && npm test
```

The suites cover email validation, injection attempts, the honeypot, the time check, rate limits (per IP and per email), token expiry, tampering and purpose, the download and unsubscribe flows, that emails never reach the console, what the database stores, OS detection, which release and installer are offered, and the build. `.github/workflows/site.yml` runs them on pull requests that touch `site/`.

## Deploy (the owner, once)

Codemm is a personal project. **Use your personal accounts for every step, never a work team, org or database.** Nothing here has been created or deployed yet.

1. **Choose a domain** for the site.
2. **Create the database** in your **personal Turso** account (sign in at turso.tech with your personal GitHub or email, and pick your personal organization). Create a database, for example `codemm-site`, then create a database token. With the Turso CLI, signed in to that personal account:

   ```bash
   turso db create codemm-site
   ```

   ```bash
   turso db show codemm-site --url
   ```

   ```bash
   turso db tokens create codemm-site
   ```

3. **Apply the schema.** Every Vercel build runs `scripts/migrate.mjs` first, so a deploy applies new migrations by itself. To apply them by hand from your computer: Put the URL and token in `site/.env.turso` (gitignored), as `TURSO_DATABASE_URL=libsql://…` and `TURSO_AUTH_TOKEN=…`, then:

   ```bash
   cd site && node --env-file=.env.turso scripts/migrate.mjs
   ```

4. **Match the region.** `vercel.json` runs the functions in Tokyo (`hnd1`), next to the Turso database in AWS ap-northeast-1. If your database is elsewhere, change `regions` to the nearest Vercel region.
5. **Create the Vercel project** in your **personal Vercel** scope (in the scope switcher at the top left, pick your personal account, not a team). Import `iignaite/Codemm` and set **Root Directory** to `site`. `vercel.json` sets the rest: `npm ci`, migrations then `node build.mjs`, `dist/`, the functions in `api/`, and the Tokyo region.
6. **Add three environment variables** under Project Settings, Environment Variables, for **Production** only: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `SITE_SECRET` (a new `openssl rand -base64 48`, not your development one). Preview deployments then answer "not configured" rather than writing to the production database; give Preview its own Turso database if you want previews to work.
7. **Deploy**, then add your domain under Project Settings, Domains.
8. **Check it**: submit your own email and download. Then export the unsubscribe links (below) and use yours.

If you'd rather use the Turso integration in the Vercel Marketplace, install it from your personal Vercel scope and connect it to your personal Turso organization. Then check that the variables it adds are named `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.

**Later.** Commits that don't touch `site/` don't redeploy (`ignoreCommand`). A new GitHub release needs no redeploy. To email subscribers, `node --env-file=.env.turso scripts/unsubscribe-link.mjs https://your-domain subscribers.tsv` writes each email and its unsubscribe link to a new file only you can read, and prints just the count. It needs `SITE_SECRET` in `.env.turso` too. Delete the file after sending, and never commit it.

**Where `SITE_SECRET` lives.** Vercel can't show a Production value again, so keep a copy. The live site's is in the owner's macOS Keychain: `security find-generic-password -s codemm-site -a SITE_SECRET -w` prints it, for example to run `scripts/unsubscribe-link.mjs`.

**Rotating `SITE_SECRET`** invalidates every unsubscribe link already sent and every suppression, so rotate it only if it leaks.
