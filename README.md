# NatakaRemote — Expo Development Build

NatakaRemote is a React Native remote for Android TV/X96-style devices. It connects directly to the TV's wireless ADB daemon on TCP port 5555 and implements the ADB authentication/protocol in JavaScript.

## Why this is an Expo development build

The project uses Expo SDK 57 with `expo-dev-client`. It is **not** intended to run in the standard Expo Go app because `react-native-tcp-socket` contains native code. Expo development builds allow that native dependency while retaining the Expo development workflow.

## Project layout

- `App.js` — physical-remote UI and interaction logic.
- `adb/AdbClient.js` — TCP connection, ADB authentication and shell streams.
- `adb/adbProtocol.js` — ADB packet framing/parsing.
- `adb/adbCrypto.js` — persistent RSA keypair and ADB authentication signing.
- `app.json` — Expo app configuration, Android package, cleartext networking and dev-client plugin.
- `eas.json` — cloud development/preview APK profiles.
- `index.js` — Expo-compatible app entry point.

## Windows development

Install Node.js LTS and make sure Android platform-tools are available if you want to install locally to a phone.

```powershell
npm install
npx expo start
```

### Build locally

A local development build requires the Android SDK/Java toolchain:

```powershell
npx expo prebuild --clean
npx expo run:android --device
```

After the development build is installed, normal UI changes can use:

```powershell
npx expo start
```

### Build in the cloud (no Android Studio build required)

Install EAS CLI and sign in:

```powershell
npm install -g eas-cli
eas login
```

Then:

```powershell
eas build --platform android --profile development
```

The development profile produces an installable APK. After installing it on the Android phone, start Metro with:

```powershell
npx expo start --dev-client
```

The phone and PC should be on the same local network for the easiest development-server connection.

## Features

- **Saved TVs** — every IP you successfully connect to is remembered (up to 5, most-recent-first) and shown as chips under the connect bar. Tap a chip to fill the IP field; long-press a chip to remove it.
- **Quick-launch apps** — a scrollable "APPS" row launches Netflix, YouTube, Prime Video, Disney+, and Spotify directly via `monkey -p <package> -c android.intent.category.LAUNCHER 1`. The package names in `App.js` (`APPS` constant) target standard Android; edit them if your box runs an Android TV/Google TV build with different package names.
- **Swipe D-pad** — drag anywhere inside the D-pad circle to move focus, instead of tapping the small arrow buttons.

## ADB connection

The TV must expose wireless ADB on TCP 5555. Enter its LAN IP in the app and tap CONNECT.

On first connection, the TV may display an ADB authorization prompt. Accept it. The app stores its RSA keypair in AsyncStorage so the same device can be trusted on later connections.

## Important

This app is an ADB client, not an ADB server. Your phone connects to the TV at `TV_IP:5555`; USB debugging on the development phone is only relevant when installing/debugging the app itself.
