# Wear OS transfer spike

Throwaway test for `docs/specs/2026-10-05-wearos-recorder-design.md`, build-order step 1.
Two bare apps, both `app.mullo` (`io.lizai.echo` before the S16 rename; the watch↔phone link only connects apps with the same id
and signing key - build both on the same machine):

- `wear/` - Record/Stop, foreground microphone service (keeps going with the screen off),
  outbox, sends to the phone, deletes only on the phone's ok. No internet permission.
  A second entry, **Mullo record**, is for the watch's double-press button: press = start
  (one buzz) / stop and send (two buzzes).
- `phone/` - receives into app-private storage, checks size + sha256, acks, lists what arrived
  with transfer time, link and battery, and a ▶ Play button.

## Build (Windows desktop, no Android Studio needed)

```powershell
$env:JAVA_HOME="$env:USERPROFILE\tools\jdk-21.0.12.1+1"
.\gradlew.bat :phone:assembleDebug :wear:assembleDebug
```

APKs: `phone/build/outputs/apk/debug/phone-debug.apk`, `wear/build/outputs/apk/debug/wear-debug.apk`.

## Install

`adb` = `%USERPROFILE%\tools\android-sdk\platform-tools\adb.exe`. Phone, watch and PC on the same Wi‑Fi.

- **Phone:** Settings → About phone → Software information → tap Build number 7×. Developer
  options → Wireless debugging → on → "Pair device with pairing code".
  `adb pair <ip:port> <code>`, then `adb connect <ip:port>`, then `adb -s <phone> install phone-debug.apk`.
- **Watch:** Settings → About watch → Software → tap Software version 5×. Developer options →
  ADB debugging + Wireless debugging → on → Pair new device. Same `adb pair` / `connect`, then
  `adb -s <watch> install wear-debug.apk`.
- **Button:** watch Settings → Advanced features → Customize keys (or buttons) → Double press
  Home key → Mullo record.

## What to test

1. Open Mullo spike on the watch once, allow the microphone and notifications.
2. Double-press → buzz → let the screen go off → talk for **10 minutes** → double-press → two buzzes.
3. On the phone, open Mullo spike: the recording should be listed, hash ok. Play it - is the full
   10 minutes there (screen-off didn't cut it)?
4. Note: transfer seconds, "nearby" or not, battery start→end (on the phone list and the watch log).
5. Repeat once with Bluetooth off on the phone (Wi‑Fi path) - does it still arrive?
6. Kill the phone app / restart the phone mid-way - the watch keeps the file until the phone says ok.
