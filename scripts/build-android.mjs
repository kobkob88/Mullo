// Builds the Android apps (android/): the phone app = Mullo's own web files
// bundled inside a locked-down WebView, plus the watch recorder.
//
//   node scripts/build-android.mjs            → debug APKs
//   node scripts/build-android.mjs release    → Play bundles (.aab), signed with the upload key (S17)
//
// Steps: scripts/build.mjs (the same checked dist/ the web host gets) → copy
// dist/ into android/app/src/main/assets/web/ (git-ignored) → Gradle.
// config.json is NOT copied: the app writes it from the bridge address saved on
// the phone. No key or URL goes into the APK.
//
// Needs a JDK (JAVA_HOME, or one unpacked in ~/tools/jdk-*) and the Android SDK
// (android/local.properties → sdk.dir).

import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ROOT } from './lib.mjs';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });

run(process.execPath, [join(ROOT, 'scripts', 'build.mjs')]);

const web = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'web');
rmSync(web, { recursive: true, force: true });
cpSync(join(ROOT, 'dist'), web, { recursive: true, filter: (src) => !src.endsWith('config.json') });

const env = { ...process.env };
if (!env.JAVA_HOME) {
  const tools = join(homedir(), 'tools');
  const jdk = existsSync(tools) && readdirSync(tools).find((d) => d.startsWith('jdk-'));
  if (jdk) env.JAVA_HOME = join(tools, jdk);
}
const win = process.platform === 'win32';
const android = join(ROOT, 'android');

// The watch is built as RELEASE (not debuggable): measured 2026-10-14 on a Galaxy Watch, the
// debug build took 1.06 s from process start to asking for the recorder, release 0.2 s - the
// double press felt slow. Signed with the same debug key as the phone app (until Play signing,
// S17), or the Data Layer won't pair them. The phone stays debug: its WebView needs DevTools.
const debugKey = join(homedir(), '.android', 'debug.keystore');
const watchRelease = existsSync(debugKey);
const signing = watchRelease ? [
  `-Pandroid.injected.signing.store.file=${debugKey}`, '-Pandroid.injected.signing.store.password=android',
  '-Pandroid.injected.signing.key.alias=androiddebugkey', '-Pandroid.injected.signing.key.password=android',
] : [];
const gradlew = join(android, win ? 'gradlew.bat' : 'gradlew');
// Through sh: git doesn't keep gradlew's executable bit in every clone.
const gradle = (args) => (win ? run(gradlew, args, { cwd: android, env, shell: true }) : run('sh', [gradlew, ...args], { cwd: android, env }));
if (process.argv[2] === 'release') {
  if (!existsSync(join(homedir(), '.mullo', 'upload.properties'))) throw new Error('No ~/.mullo/upload.properties: Play refuses unsigned bundles (android/build.gradle.kts files say what goes in it)');
  gradle([':app:bundleRelease', ':wear:bundleRelease']);
  console.log('Bundles: android/app/build/outputs/bundle/release/app-release.aab, android/wear/build/outputs/bundle/release/wear-release.aab');
  process.exit(0);
}
gradle([':app:assembleDebug', ':wear:assembleDebug', ...(watchRelease ? [':wear:assembleRelease'] : []), ...signing]);
console.log(`APKs: android/app/build/outputs/apk/debug/app-debug.apk, ${watchRelease
  ? 'android/wear/build/outputs/apk/release/wear-release.apk (install this one on the watch)'
  : 'android/wear/build/outputs/apk/debug/wear-debug.apk (no ~/.android/debug.keystore, so no release watch build)'}`);
