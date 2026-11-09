# PocketTavern on Android

There are two ways to get PocketTavern on an Android phone. Both run the same app from
`https://setsuna1313.github.io/pockettavern/`, so updates you push to GitHub reach the phone automatically.

## 1. Install from Chrome (no APK needed)
Open the site in Chrome. Tap the **Install** banner on the home screen, or open the menu **⋮** and tap
**Add to Home screen** / **Install app**. It opens full-screen with its own icon, like any app.

## 2. Build an APK with PWABuilder
This wraps the site in a Trusted Web Activity (TWA), the format the Play Store accepts. It can also be sideloaded.

1. Go to <https://www.pwabuilder.com>, enter `https://setsuna1313.github.io/pockettavern/` and press **Start**.
2. Choose **Package for stores → Android → Generate package**. Suggested options:
   - Package ID: `io.github.setsuna1313.pockettavern`
   - App name: `PocketTavern`, launcher name: `Tavern`
   - Signing key: **Create new** (the default). Keep the downloaded `signing.keystore` and
     `signing-key-info.txt` somewhere safe: you need the same key for every future update.
3. Unzip the download. Install the `.apk` on your phone (copy it over and open it; Android will ask you to
   allow installing from that source). The `.aab` file is the one you'd upload to Google Play.

### Removing the address bar (optional)
A TWA only hides Chrome's address bar after it can verify that you own the site, using a file at
`https://setsuna1313.github.io/.well-known/assetlinks.json`. That path is at the root of the domain,
so it can't live in this repo (which is served from `/pockettavern/`). Without it, the app still works,
but a thin address bar shows at the top.

To verify:
1. Create a GitHub repo named exactly `setsuna1313.github.io` with GitHub Pages turned on.
2. Copy `assetlinks.json` from the PWABuilder zip into it as `.well-known/assetlinks.json`.
3. Add an empty file named `.nojekyll` at that repo's root (otherwise GitHub Pages hides the `.well-known` folder).
4. Reinstall the APK. The address bar should be gone.

## Things to know on Android
- **Back button**: closes an open sheet first, then goes back a screen. On the home screen it leaves the app.
- **Local models over `http://`** (KoboldCpp, Ollama on your PC): blocked, because the app is served over HTTPS.
  Use an `https://` tunnel (e.g. Cloudflare Tunnel, ngrok), as on iPhone.
- **Sync between devices**: export a sync file to Google Drive (or send it with Quick Share), then
  "Restore / sync from file" on the other device. This also works between iPhone and Android.
