import Foundation

/// What the web app sees of the iPhone app, injected before Mullo's own scripts run.
/// - `MulloWatch`: the watch inbox (app/capture/watch-inbox.js). list() and audio(id) are
///   promises (WKWebView only talks to native asynchronously), done(id) is fire-and-forget.
/// - `MulloNative`: recordingStarted/recordingStopped (app/core/native.js), so the screen
///   stays on while recording, and task reminders (Reminders.swift). The web code reads
///   reminderTaps() synchronously, so native keeps a copy in `__mulloReminderTaps` (handed
///   over by MulloWebView after each load and each tap). Nothing else is defined, so the web
///   app treats this as a browser everywhere else (`inAndroidApp()` stays false).
enum Bridge {
    static let script = """
    (() => {
      const post = (name, msg) => window.webkit.messageHandlers[name].postMessage(msg);
      const bytes = (b64) => {
        if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
        const s = atob(b64);
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
        return out;
      };
      window.MulloWatch = {
        list: () => post('mulloWatch', { op: 'list' }),
        done: (id) => { post('mulloWatch', { op: 'done', id: String(id) }); },
        audio: async (id) => {
          const b64 = await post('mulloWatch', { op: 'audio', id: String(id) });
          return b64 ? new Response(new Blob([bytes(b64)], { type: 'audio/mp4' })) : new Response(null, { status: 404 });
        },
      };
      // Recording with the phone locked (NativeRecorder.swift, app/capture/recorder.js).
      window.MulloRecorder = {
        start: () => post('mulloRecorder', { op: 'start' }),
        poll: () => post('mulloRecorder', { op: 'poll' }),
        pause: () => post('mulloRecorder', { op: 'pause' }),
        resume: () => post('mulloRecorder', { op: 'resume' }),
        stop: async () => {
          const r = await post('mulloRecorder', { op: 'stop' });
          return { blob: new Blob([bytes(r?.audio || '')], { type: r?.mime || 'audio/mp4' }), durationMs: r?.duration_ms || 0 };
        },
      };
      // Sign-in (SignIn.swift, S22b). MulloGoogle has Android's shape: signIn() answers with a
      // `mullo-google` event (app/core/native.js googleAnswer). MulloApple.signIn() is a promise.
      window.MulloGoogle = {
        available: () => true,
        signIn: (nonceHash) => {
          post('mulloSignIn', { op: 'google', nonce: String(nonceHash) })
            .catch(() => JSON.stringify({ error: 'Google sign-in didn\\'t work.' }))
            .then((json) => window.dispatchEvent(new CustomEvent('mullo-google', { detail: json })));
        },
      };
      window.MulloApple = {
        signIn: (nonceHash) => post('mulloSignIn', { op: 'apple', nonce: String(nonceHash) }),
        code: () => post('mulloSignIn', { op: 'apple-code' }),
      };
      // Mullo Pro through the App Store (Store.swift, S22c). Each is a promise of a JSON string.
      window.MulloStore = {
        product: () => post('mulloStore', { op: 'product' }),
        buy: (userId) => post('mulloStore', { op: 'buy', userId: String(userId) }),
        current: () => post('mulloStore', { op: 'current' }),
        restore: () => post('mulloStore', { op: 'restore' }),
        manage: () => { post('mulloStore', { op: 'manage' }); },
      };
      window.MulloNative = {
        recordingStarted: () => { post('mulloNative', { op: 'recording', on: true }); return 'ok'; },
        recordingStopped: () => { post('mulloNative', { op: 'recording', on: false }); },
        setReminders: (json) => { post('mulloNative', { op: 'reminders', json: String(json) }); },
        reminderTaps: () => JSON.stringify(window.__mulloReminderTaps || []),
        reminderTapsDone: (json) => {
          const done = new Set(JSON.parse(json));
          window.__mulloReminderTaps = (window.__mulloReminderTaps || []).filter((t) => !done.has(t.key));
          post('mulloNative', { op: 'tapsDone', json: String(json) });
        },
      };
    })();
    """
}
