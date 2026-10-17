# Signing the desktop installers

Builds are unsigned until the owner adds the secrets below. Nothing about signing lives in the repository:
- `packaging.cjs` reads it from the environment;
- `.github/workflows/desktop-release.yml` fills the environment from repository secrets. PR builds in `desktop.yml` never sign.

With no secrets, every value is empty and the build stays unsigned. macOS builds are then signed ad hoc, which Gatekeeper needs before it will offer Open Anyway on Apple silicon.

Prices are rough, as of late 2026. Check the vendor before buying.

## macOS: Developer ID and notarization

**Cost:** the Apple Developer Program, about US$99 a year.

1. Enroll at developer.apple.com/programs. An organization needs a D-U-N-S number.
2. Create the certificate:
   1. On a Mac, open Xcode, then Settings, then Accounts, then Manage Certificates.
   2. Click + and choose **Developer ID Application**.
   3. In Keychain Access, export the certificate with its private key as a `.p12` file, with a strong password.
3. Add two repository secrets (Settings, then Secrets and variables, then Actions):
   - `MAC_CERTS`: the output of `base64 -i DeveloperID.p12`.
   - `MAC_CERTS_PASSWORD`: the `.p12` password.
4. For notarization, create an app-specific password at account.apple.com, then add three more secrets:
   - `APPLE_ID`: your Apple ID email.
   - `APPLE_APP_SPECIFIC_PASSWORD`: the app-specific password.
   - `APPLE_TEAM_ID`: the 10-character Team ID from the developer account.

electron-builder signs when `CSC_LINK` is set and notarizes when the `APPLE_*` values are set.

An App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) also works, and Apple recommends it. It needs a workflow step that writes the `.p8` file before `npm run dist`, because `APPLE_API_KEY` is a file path.

## Windows: a code-signing service

Choose one.

**Azure Trusted Signing (recommended).** About US$10 a month on the Basic tier.
1. Create a Trusted Signing account and pass identity validation. Eligibility depends on the country and on whether you are an organization or an individual.
2. Create a public-trust certificate profile.
3. Create an app registration with a client secret. Give it the "Trusted Signing Certificate Profile Signer" role on the account.
4. Add these secrets:
   - `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`: from the app registration.
   - `AZURE_SIGNING_ENDPOINT`: the account's region endpoint, for example `https://eus.codesigning.azure.net/`.
   - `AZURE_SIGNING_ACCOUNT`: the account name.
   - `AZURE_SIGNING_PROFILE`: the certificate profile name.
   - `AZURE_SIGNING_PUBLISHER`: exactly the subject CN on the certificate.

`packaging.cjs` turns on `azureSignOptions` only when all four `AZURE_SIGNING_*` values are present.

**An EV or OV certificate.** About US$250 to US$700 a year. Since 2023, private keys must live on hardware or in a cloud HSM, so CI signing usually adds a cloud HSM service. EV no longer skips SmartScreen's reputation check. Signing this way needs a custom `win.signtoolOptions` or `sign` hook in `packaging.cjs` for the HSM, so Azure is the simpler route.

Unsigned or newly signed Windows builds may still show SmartScreen until the publisher builds reputation.

## Auto-update

Off until builds are signed: `publish` is `null` in `packaging.cjs`. The plan is electron-updater with GitHub Releases as the provider. Turning it on means:
- adding a `publish` entry;
- calling `autoUpdater.checkForUpdatesAndNotify()` in the main process;
- having the release workflow upload the installers and `latest*.yml`.

Publishing needs the owner's go-ahead.

## Checking a signed build

- **macOS:** `codesign --verify --deep --strict --verbose=2 Codemm.app`, then `spctl -a -vv Codemm.app`. Notarized builds say "source=Notarized Developer ID".
- **Windows:** the installer's Properties, then Digital Signatures, or `Get-AuthenticodeSignature .\Codemm-*.exe`.
