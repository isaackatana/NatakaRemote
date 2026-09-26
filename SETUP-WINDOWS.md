# Windows setup — NatakaRemote Expo development build

## Easiest route: cloud-built Android development APK

This route avoids needing Android Studio for the build itself.

### 1. Install Node.js

Use Node.js 22.13+ for Expo SDK 57.

Verify:

```powershell
node --version
npm --version
```

### 2. Install project dependencies

From the NatakaRemote folder:

```powershell
npm install
```

If Expo reports dependency mismatches after installation, run:

```powershell
npx expo install --fix
npx expo-doctor
```

### 3. Install and log in to EAS

```powershell
npm install -g eas-cli
eas login
eas whoami
```

### 4. Initialize EAS project metadata

The first time only:

```powershell
eas build:configure
```

Keep the Android development profile from `eas.json`.

### 5. Build the development APK

```powershell
eas build --platform android --profile development
```

The development profile is configured as an internal APK and includes `expo-dev-client`.

Download/install the resulting APK on the Android phone.

### 6. Start Metro

From the project folder:

```powershell
npx expo start --dev-client
```

Keep the PC and phone on the same Wi-Fi network. The development client can connect to the Metro server from the launcher/QR code.

## Local build alternative

If the Android SDK/JDK are configured on Windows:

```powershell
npx expo prebuild --clean
npx expo run:android --device
```

After the first native build, normal JavaScript/UI work generally only requires:

```powershell
npx expo start --dev-client
```

A native rebuild is needed again when native dependencies or native app configuration changes.

## Testing the ADB remote

The development phone does **not** need USB debugging for the TV connection. USB debugging is only useful for installing/debugging the development build locally.

The app itself connects over the LAN to:

```text
TV_IP:5555
```

The TV/X96 must have wireless ADB enabled. On first connection, accept the ADB authorization prompt on the TV. The app persists its RSA keypair so the TV can recognize it on later connections.
