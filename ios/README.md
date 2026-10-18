# Mullo for iPhone + Apple Watch (roadmap S22, stage 1)

Same shape as Android + Wear OS:

- **`Mullo/`** - the iPhone app. Shows the live web app (`https://mullo.lizai.io/app/`) in a
  WKWebView, so sign-in, AI and sync are exactly Mullo in Safari. It opens with no signal once it
  has been opened online (an App-Bound Domain, so Mullo's service worker keeps the build). Adds: the microphone asked
  once, the screen kept on while recording, outside links in Safari, downloads to the share
  sheet, and the **watch inbox** (`WatchInbox.swift`) the web app drains like Android's
  (`MulloWatch` in `Bridge.swift`, `app/capture/watch-inbox.js`).
- **`MulloWatch/`** - the watch recorder. One button: record, stop, the note goes to the iPhone
  (WatchConnectivity file transfer, queued until the iPhone takes it). When Mullo is opened on
  the iPhone, the note is saved, transcribed and summarised like any recording.
- **`MulloComplication/`** - "Mullo record" on the watch face (WidgetKit, embedded in the watch
  app). A tap opens the watch app with `mullo://record`, which starts recording, or stops and
  sends when it's already recording (like the Galaxy Watch's complication). It always shows the
  mic; showing "Stop" while recording would need an App Group.

Built only on a Mac. Written on Windows without a compiler (2026-10-09): **the first build may
need small fixes** - fix them in a Mac session and commit.

## One-time setup on the Mac

1. **Xcode** from the Mac App Store (large: check free disk space first). Open it once, accept,
   and let it install the iOS + watchOS platforms (Xcode → Settings → Components).
2. **XcodeGen**: `brew install xcodegen` (makes the Xcode project from `project.yml`).
3. Xcode → Settings → Accounts → **+** → your Apple ID. A free account gives a "Personal Team":
   apps install for **7 days** (re-run from Xcode to renew), up to 3 apps per device. TestFlight
   and the App Store need the Apple Developer Program ($99/year, gate G13).

## Build

```sh
git pull origin main
cd ios
xcodegen            # makes Mullo.xcodeproj + the Info.plists (not committed)
open Mullo.xcodeproj
```

In Xcode, for **both** targets (Mullo, MulloWatch): Signing & Capabilities → Team = your
Personal Team. Never commit the team id. If Xcode says the bundle id `app.mullo` is taken,
change `app.mullo` everywhere in `project.yml` (both bundle ids + `WKCompanionAppBundleIdentifier`)
to e.g. `app.mullo.test`, run `xcodegen` again.

**No devices yet?** Pick the Mullo scheme and an iPhone simulator that has a paired Apple Watch
simulator (Xcode → Window → Devices and Simulators). The simulators use the Mac's microphone.

## Install on the iPhone + Apple Watch

1. Plug the iPhone into the Mac, unlock it, tap **Trust**.
2. iPhone: Settings → Privacy & Security → **Developer Mode** → on (it restarts). The switch
   shows up once Xcode has seen the phone.
3. Watch (paired with that iPhone, unlocked, on the wrist, same Wi-Fi as the Mac): Settings →
   Privacy & Security → **Developer Mode** → on. Xcode → Window → Devices and Simulators should
   list both; the first "preparing the watch" can take a long while.
4. In Xcode: scheme **Mullo**, destination the iPhone → **Run**. The first time, the iPhone says
   the developer isn't trusted: Settings → General → VPN & Device Management → your Apple ID →
   Trust, then run again.
5. The watch app comes with it. If it doesn't appear on the watch: the iPhone's Watch app →
   Mullo → Show App on Apple Watch, or in Xcode pick scheme **MulloWatch** + the watch → Run.

## What to test

Signing in pulls that account's notes. On someone else's phone, sign in with their own email
(a new account gets the trial minutes) unless they should see yours.

1. **iPhone:** open Mullo, sign in with the email code. Record about a minute: the meter moves,
   the screen stays on. Stop: transcript + summary arrive. Play it back.
2. **Watch:** open Mullo, tap the red button, talk, tap the square. It buzzes; "waiting for
   iPhone" goes away when the iPhone has it. Open Mullo on the iPhone: "1 recording from your
   watch", then the transcript.
3. **Watch with the iPhone app closed:** record on the watch, open Mullo on the iPhone later;
   the note is still taken in.
4. **Wrist down:** start on the watch, lower the wrist for 30 s while talking, raise, stop.
   Check the transcript covers the wrist-down part (background audio is on; unproven).
5. **Watch face:** long-press the watch face, Edit, pick a complication spot, choose **Mullo**
   (Record). Back on the face, tap it: Mullo opens and starts recording (one buzz). Tap the
   complication again (or the square in the app) to stop and send.
6. **Calendar:** in a recording's Actions, add a task to the calendar (the share sheet opens
   with the .ics).

Seeing the web app's console: Mac Safari → Settings → Advanced → "Show features for web
developers", then Develop → the iPhone → Mullo.

## Known limits of stage 1

- Opening Mullo needs the internet (the app is loaded live, like the browser version).
- iPhone recordings stop when the phone locks or you switch apps (same as Safari; the note so
  far is saved). Locked-phone recording needs a native recorder: a later stage.
- Watch notes are transcribed when Mullo opens on the iPhone, not while it's closed.
- No App Store build yet: that needs the Developer Program, the app shipped inside (not loaded
  live: App Store review 4.2), privacy labels and a listing.
