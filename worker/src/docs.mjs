// Mullo's docs: /docs and /docs/<slug>. Plain HTML, no scripts (the page CSP allows
// none): the menu is a <details> on a phone and a sidebar on a wide screen.
//
// Each page is { slug, group, title, intro, body(ctx) }. ctx = { origin, minutes, open },
// where `open` says whether MCP and API keys are switched on yet (env CONNECTIONS_OPEN).

import { esc, MARK, SOURCE_URL, STYLE_HREF } from './pages.mjs';

const GROUPS = ['Start here', 'Using Mullo', 'Plans and AI', 'Server', 'MCP', 'API', 'More'];

const code = (text) => `<pre class="docs-code"><code>${esc(text)}</code></pre>`;
const note = (html) => `<p class="docs-note">${html}</p>`;
const soon = ({ open }) => (open ? '' : note('<b>Opening soon.</b> This part is built and is being switched on. Until then, connecting will fail at the sign-in step.'));
const link = (slug, text) => `<a href="/docs${slug ? `/${slug}` : ''}">${esc(text)}</a>`;

export const DOCS = [
  // ── Start here ────────────────────────────────────────────────────────
  {
    slug: '', group: 'Start here', title: 'Welcome',
    intro: 'Mullo records your conversations, meetings and voice notes and turns each one into a transcript, a summary and a list of tasks.',
    body: () => `
<p>You record on your iPhone or Android phone, or on your Apple Watch or Wear OS watch. Mullo writes down who said what, gives the recording a short title, splits it into sections, summarises it the way you like, and picks out the things you said you'd do. Later you can search everything, ask questions about it, or let your own AI read it.</p>

<h2>Pick a path</h2>
<div class="docs-paths">
  <a class="card docs-path" href="/docs/quickstart"><h3>New to Mullo</h3><p>Your first recording in two minutes.</p></a>
  <a class="card docs-path" href="/docs/recording"><h3>Using Mullo</h3><p>Recording, transcripts, summaries, tasks, search.</p></a>
  <a class="card docs-path" href="/docs/plans"><h3>Plans and AI</h3><p>Mullo Pro, the trial, or your own AI key.</p></a>
  <a class="card docs-path" href="/docs/server"><h3>Server</h3><p>Where your notes live, and how to use your own server.</p></a>
  <a class="card docs-path" href="/docs/mcp"><h3>MCP</h3><p>Let Claude, ChatGPT or Cursor read your notes.</p></a>
  <a class="card docs-path" href="/docs/api"><h3>API</h3><p>Read your notes from scripts and automations.</p></a>
</div>

<h2>How it fits together</h2>
<ul>
  <li><b>Your phone holds everything.</b> Recordings, transcripts and tasks are saved on the phone first and work offline.</li>
  <li><b>Your account is a copy.</b> Once you sign in, Mullo keeps a copy in your account, on Mullo's server or on ${link('own-server', 'your own')}.</li>
  <li><b>The AI does the writing.</b> Audio goes to Google Gemini to be written down and summarised. It runs on Mullo Pro, a trial, or ${link('own-ai-key', 'your own key')}.</li>
  <li><b>Connections read the copy.</b> ${link('mcp', 'MCP')} and the ${link('api', 'API')} read the notes in your account, and only read them.</li>
</ul>`,
  },
  {
    slug: 'quickstart', group: 'Start here', title: 'Quickstart',
    intro: 'From a fresh install to your first summary.',
    body: ({ minutes }) => `
<ol class="docs-steps">
  <li><b>Sign in.</b> Settings, tap the profile at the top, type your email. Mullo sends a code; type it in. No password.</li>
  <li><b>Pick your languages.</b> Settings, Languages: the language you speak (or Auto) and the language the transcript is written in.</li>
  <li><b>Record.</b> On the Record screen tap Start recording. Pause and resume as you need, then stop. On a Wear OS watch, double-press the side button or tap Mullo record on your watch face, and talk after the buzz; the recording moves to your phone on its own.</li>
  <li><b>Wait a moment.</b> Mullo sends the audio to the AI in the background. You can close the screen; the recording fills in when it's done, even for a long meeting.</li>
  <li><b>Read it.</b> Open the recording: title, summary, sections with times, tasks, and the transcript.</li>
</ol>
<p>New accounts get a free trial of recording minutes. After that, Mullo Pro includes ${esc(minutes)} a month, or you can use ${link('own-ai-key', 'your own AI key')} with no limit from Mullo.</p>
<p>Next: ${link('summaries', 'choose a summary format')}, ${link('transcripts', 'teach it names')}, or ${link('mcp', 'connect your AI')}.</p>`,
  },

  // ── Using Mullo ───────────────────────────────────────────────────────
  {
    slug: 'recording', group: 'Using Mullo', title: 'Recording',
    intro: 'Phone, watch, or a typed note.',
    body: () => `
<h2>On the phone</h2>
<ul>
  <li><b>Start recording</b> on the Record screen. A level meter shows the microphone is hearing you. Pause, resume, or discard (tap twice, so it can't happen by accident).</li>
  <li><b>Summarise as</b>: choose the format for this recording before you start, or leave the default from Settings.</li>
  <li><b>Live preview</b> (Settings, Recording and transcription) shows text as you talk, made by your phone. The final transcript is written by the AI when you stop. Turn it off and the audio goes only to the AI.</li>
  <li><b>Lock the phone</b> if you like: in the iPhone and Android apps the microphone keeps going with the screen off. On Android a "Mullo is recording" notification shows while it records; tap it to come back. In a phone's browser, keep Mullo on screen while recording.</li>
  <li><b>Long meetings</b> are fine, up to about 2 hours in one recording. The phone sends the recording and collects the result later, so a weak signal or a closed app doesn't lose anything.</li>
</ul>
<h2>On a Wear OS watch</h2>
<p>One press starts, the next stops and sends. The recording moves to your phone by itself and is written down there.</p>
<ul>
  <li><b>One buzz</b> = recording now: the microphone is on, start talking. <b>Two buzzes</b> = stopped and saved. <b>One long buzz</b> = it couldn't start; open Mullo on the watch to see why.</li>
  <li><b>Double-press the side button</b> (Samsung Galaxy Watch): watch Settings, Advanced features, Customize buttons (or keys), Double press, <b>Mullo record</b>.</li>
  <li><b>A button on your watch face</b> (any Wear OS watch, including ones whose button can't open an app): press and hold the watch face, Edit (or Customize), choose a spot, then <b>Mullo record</b>. Tap it to start; it turns into a stop button while recording.</li>
  <li>The very first press after the watch has been idle for a while can take a moment longer: the watch is opening Mullo. Wait for the buzz before you talk.</li>
</ul>
<h2>On an Apple Watch</h2>
<p>Open Mullo on the watch, or add its button to your watch face (press and hold the face, Edit, choose a spot, <b>Mullo</b>), and tap to record. Tap again to stop. The note goes to the Mullo app on your iPhone and is written down there.</p>
<ul>
  <li>If the iPhone is out of reach, the watch keeps the note and sends it as soon as the two are connected again, even if Mullo is closed on the iPhone.</li>
  <li>A note stays on the watch until the iPhone has it, so nothing is lost if the watch app closes mid-send.</li>
</ul>
<p>How long a recording can be: ${link('limits', 'Limits and AI models')}.</p>
<h2>A typed note</h2>
<p>Under the record button, <b>Or type a note</b>: write it and Save note. It gets a summary and tasks like a recording.</p>
<h2>Languages</h2>
<p>Mullo understands English, Hebrew and about 110 other languages. In Settings, Languages, set the language you speak (or Auto) and, if you like, a different language to write the transcript in.</p>`,
  },
  {
    slug: 'transcripts', group: 'Using Mullo', title: 'Transcripts',
    intro: 'Who said what, and when.',
    body: () => `
<ul>
  <li><b>Speakers.</b> Lines are marked by speaker. Give each speaker a name once and it shows everywhere in that recording.</li>
  <li><b>Times.</b> Every line has its time, and you can play that part of the audio.</li>
  <li><b>Fix a line.</b> Tap a line to edit it. When you correct a name or word, Mullo offers to <b>teach</b> it, so the next transcripts spell it right.</li>
  <li><b>Names and words.</b> Settings, Names and words: a list of names and terms Mullo should always spell right, like people, places and products.</li>
  <li><b>Re-transcribe.</b> Run the AI again, for example with a different spoken language. The old transcript stays in Activity.</li>
  <li><b>Paste a transcript.</b> No audio? Paste or type it, one line per turn; "Name: text" marks the speaker.</li>
</ul>
<p>Quiet stretches are skipped, so silence doesn't turn into made-up words.</p>`,
  },
  {
    slug: 'summaries', group: 'Using Mullo', title: 'Summaries and formats',
    intro: 'The same conversation, summarised for what it was.',
    body: () => `
<h2>Built-in formats</h2>
<div class="docs-table"><table>
  <tr><th>Format</th><th>What you get</th></tr>
  <tr><td>General</td><td>Overview, key points, next steps</td></tr>
  <tr><td>Meeting</td><td>Overview, decisions, discussion, action items</td></tr>
  <tr><td>Phone call</td><td>What it was about, highlights, follow-ups</td></tr>
  <tr><td>Voice note</td><td>The note, and a to-do list</td></tr>
  <tr><td>Lecture / learning</td><td>Topic, main ideas, things to look up</td></tr>
</table></div>
<h2>Your own formats</h2>
<p>Settings, Summaries, <b>Make your own</b>: give it a name and up to 8 sections, each with a heading and, if you like, what goes under it. Choose whether it should pick out tasks. You can keep up to 10.</p>
<h2>Summarise again</h2>
<p>On any recording, choose another format and <b>Summarise again</b>. If you edited the transcript, Mullo tells you the summary was made from the old words and offers to update it.</p>
<p>Every recording also gets <b>sections</b>: chapters with a title and a start time.</p>`,
  },
  {
    slug: 'tasks', group: 'Using Mullo', title: 'Tasks',
    intro: '"Remind me to call Dana tomorrow" becomes a task with a date.',
    body: () => `
<ul>
  <li>Mullo picks out what you said you'd do, with a date when you said one.</li>
  <li>The <b>Tasks</b> screen sorts them: Overdue, Today, Coming up, No date, Done.</li>
  <li><b>One tap</b> turns a task into the thing it describes: an email draft, a message to share, or a calendar event.</li>
  <li><b>Calendar.</b> On Android, the 📅 button opens your calendar app with the event filled in. In a browser you get an event file. No date said? It's set for tomorrow.</li>
  <li>Add your own tasks to a recording, tick them off, or combine duplicates into one.</li>
</ul>`,
  },
  {
    slug: 'search-ask', group: 'Using Mullo', title: 'Search and Ask',
    intro: 'Find anything you captured, ask about it, or have it write an email from it.',
    body: () => `
<h2>Search</h2>
<p>Search looks through titles, summaries, sections, tasks and transcripts, in any language. Results show where the words matched.</p>
<h2>Ask</h2>
<p>Ask is a chat. Ask a question like "What did we decide about the Montreal delivery?" Mullo answers from your own notes and links to the recordings it used. Follow-ups carry on from there: "and when is it due?"</p>
<p>Only the best matches for your question (and the recordings the chat already used) are sent to the AI, never your whole library.</p>
<h2>Drafts</h2>
<p>Ask for something to send: "write an email to Daniel about the call", "a WhatsApp to the team saying the meeting moved". The draft comes back in the chat with Copy and Share. Change it by asking: "shorter", "more formal", "now in Hebrew". It is written from your notes only; anything they don't say comes out as a [placeholder] to fill in.</p>
<h2>Moving tasks</h2>
<p>Ask "can this wait until next week?" or "I called Dana, mark it done". Mullo suggests the change with a button showing the task and the new date, like <b>Move to Tue, Oct 20</b>. Nothing changes until you tap it; then the task moves (and your Google Calendar or Tasks with it, if connected). Undo it from Activity.</p>
<h2>Updates on a note</h2>
<p>A note works like a page in a notebook: what happened later goes underneath. Type it on the note's Summary (<b>Add an update…</b>), or tell Ask "add to this note that I told Tina, it's by the end of next week". Ask writes the line and shows <b>Add to note</b>; nothing is added until you tap it. Updates are dated, kept below the summary, found by Search and read by Ask. The summary and transcript stay as recorded. Remove an update with its ×, or undo from Activity.</p>
<p>On a recording, <b>Ask about this</b> opens the chat about that one recording: only it is sent to the AI.</p>
<p>The chat stays on this device; New chat starts over. Drafts are not saved anywhere else.</p>`,
  },
  {
    slug: 'library', group: 'Using Mullo', title: 'Library and sharing',
    intro: 'Folders, joining notes, and sending a recording somewhere.',
    body: () => `
<ul>
  <li><b>Library</b> lists everything you captured. Filter by where it came from: phone, watch or typed.</li>
  <li><b>Folders.</b> Make folders and move recordings into them.</li>
  <li><b>Join notes.</b> Recorded a thought in pieces? Tick two or more finished notes and join them: one transcript, one summary, one task list. The pieces can be brought back from Activity.</li>
  <li><b>Send it somewhere.</b> On a recording: share it as text, with or without the transcript, to WhatsApp, email, Notion, Google Docs, Keep or anything else, or copy it.</li>
  <li><b>Ask about this.</b> On a recording: opens Ask about that one recording, for questions or a draft from it (${link('search-ask', 'Search and Ask')}).</li>
</ul>`,
  },
  {
    slug: 'activity', group: 'Using Mullo', title: 'Activity and storage',
    intro: 'Nothing vanishes without a trace.',
    body: () => `
<h2>Activity</h2>
<p>Settings, Activity lists every change: added, changed, deleted. Each one can be undone, and a deleted recording can be restored from here, with its transcript and tasks.</p>
<h2>Storage</h2>
<p>Settings, Storage shows how much room Mullo uses on the phone. You can free space by removing the audio of deleted recordings, or of recordings older than 30 days, biggest first. The words stay; only the sound goes.</p>
<h2>Appearance</h2>
<p>Settings, Appearance: light, dark (true black), or match the phone.</p>`,
  },

  // ── Plans and AI ──────────────────────────────────────────────────────
  {
    slug: 'plans', group: 'Plans and AI', title: 'Plans and minutes',
    intro: 'How the AI part of Mullo is paid for.',
    body: ({ minutes }) => `
<div class="docs-table"><table>
  <tr><th>Plan</th><th>What it means</th></tr>
  <tr><td>Trial</td><td>New accounts may get free recording minutes, once. Whether a trial is offered and how many minutes it has can change; see the <a href="/terms">Terms</a>.</td></tr>
  <tr><td>Mullo Pro</td><td>The AI is included: ${esc(minutes)} of recordings a month. Get it in Mullo: Settings, Subscription; cancel any time.</td></tr>
  <tr><td>Your own key</td><td>Use your own Gemini, OpenAI or Claude key. That company bills you, Mullo counts nothing. ${link('own-ai-key', 'How')}</td></tr>
</table></div>
<ul>
  <li><b>Minutes</b> are minutes of recorded audio the AI wrote down. Summaries, questions and drafts don't use minutes.</li>
  <li>Settings shows a ring around your photo with what's left this month, and when it resets. Settings, Subscription shows your plan in full.</li>
  <li>Without any plan, recordings still get a simple summary made on the phone.</li>
  <li>To change your card, see invoices or cancel: <a href="/manage">Manage subscription</a>.</li>
</ul>`,
  },
  {
    slug: 'limits', group: 'Plans and AI', title: 'Limits and AI models',
    intro: 'How long a recording can be, what happens past that, and which AI does the work.',
    body: () => `
<h2>How long a recording can be</h2>
<p>Every Mullo app records speech at 32 kbps, so the limit is about the same everywhere. Mullo's server takes one recording up to 32 MB.</p>
<div class="docs-table"><table>
  <tr><th>Where you record</th><th>Written down in one go</th></tr>
  <tr><td>iPhone app, Android app</td><td>About 2 hours 20 minutes. The phone can be locked.</td></tr>
  <tr><td>Apple Watch, Wear OS watch</td><td>About 2 hours 20 minutes. A Wear OS watch keeps recording up to 4 hours, but past about 2 hours 20 minutes it can't be written down in one go.</td></tr>
  <tr><td>A browser</td><td>About 2 hours 20 minutes, if the browser keeps to Mullo's quality setting. On a phone, keep Mullo on screen while recording.</td></tr>
  <tr><td>With your own OpenAI key</td><td>About 1 hour 45 minutes (OpenAI takes files up to 25 MB).</td></tr>
</table></div>
<h2>Past the limit</h2>
<p>Nothing is lost. The recording is saved on your phone (up to 200 MB, about 14 hours) and, when you're signed in, copied to your account with its audio. Mullo says it's too long to write down in one go; you can still play it back. For long meetings, stop and start a new recording every 2 hours.</p>
<h2>Which AI does what</h2>
<div class="docs-table"><table>
  <tr><th>Who pays</th><th>Transcripts</th><th>Titles, summaries, tasks, Ask, drafts</th></tr>
  <tr><td>Mullo's plan (trial, Pro)</td><td>Google Gemini 3.1 Flash-Lite</td><td>The model you pick in Settings, Summaries: Gemini 3.1 Flash-Lite (default) or 3.5 Flash-Lite. A trial uses the default. More with Mullo Max (coming).</td></tr>
  <tr><td>Your own Gemini key</td><td>Gemini 3.1 Flash-Lite</td><td>Any model in the list, Max ones too</td></tr>
  <tr><td>Your own OpenAI key</td><td>gpt-4o-transcribe-diarize (speakers labelled)</td><td>GPT-6 Luna</td></tr>
  <tr><td>Your own Claude key</td><td>Your Mullo plan (Claude doesn't take audio)</td><td>Claude Opus 5.5</td></tr>
</table></div>
<ul>
  <li>Mullo's server picks the model, not the app, so a better model reaches every phone without an update. This page says what's used now.</li>
  <li>Google's paid API, which Mullo uses, isn't used to train Google's models.</li>
  <li>On any recording, ⋯ then Summarise again can use another model for that note.</li>
  <li>Languages: English, Hebrew and about 110 others. Speakers are told apart within one recording; Mullo never recognises a voice from one recording to the next.</li>
</ul>`,
  },
  {
    slug: 'own-ai-key', group: 'Plans and AI', title: 'Bring your own AI key',
    intro: 'Run Mullo on your own Gemini, OpenAI or Claude key. No plan, no minutes.',
    body: () => `
<ol class="docs-steps">
  <li>Get an API key: Gemini from Google AI Studio, OpenAI from the OpenAI dashboard, or Claude from the Claude Console.</li>
  <li>Sign in to Mullo (Settings, Account). The key pays; the sign-in says it's you, so it's needed to add the key and every time it's used.</li>
  <li>In Mullo: Settings, Developers, <b>Use your own AI key</b>. Paste it and tap Use this key. Mullo tells from the key which company it's from.</li>
  <li>Mullo checks the key with that company. From then on every transcription, summary and question uses it, watch notes too.</li>
</ol>
<h2>What each one does</h2>
<div class="docs-table"><table>
  <tr><th>Key</th><th>Transcripts</th><th>Titles, summaries, tasks, Ask</th></tr>
  <tr><td>Gemini</td><td>Yes, up to about 2 hours, with your Names and words list and translation</td><td>Yes</td></tr>
  <tr><td>OpenAI</td><td>Yes, up to 25 MB (about 1 hour 45 minutes), speakers labelled; no Names and words list, no translation</td><td>Yes</td></tr>
  <tr><td>Claude</td><td>No: Claude doesn't take audio, so transcripts use your Mullo plan</td><td>Yes</td></tr>
</table></div>
<h2>How the key is kept</h2>
<ul>
  <li>Mullo's server locks (encrypts) the key so only Mullo's server can open it, and gives the locked copy back to your phone. The server doesn't keep it.</li>
  <li>Each AI request carries the locked copy; the server opens it for that request only and never logs it.</li>
  <li>The locked copy works only through Mullo's server and only for the Mullo account that added it: a copy taken from your phone is refused under anyone else's sign-in. On a new phone, add the key again once.</li>
</ul>
<p>The company behind the key bills you directly and no Mullo minutes are counted; its own terms apply to what it's sent. OpenAI is asked not to keep the request as a stored response. To stop: Settings, Developers, <b>Stop using my key</b>.</p>`,
  },

  // ── Server ────────────────────────────────────────────────────────────
  {
    slug: 'server', group: 'Server', title: 'Your account and Mullo\'s server',
    intro: 'Where your notes live.',
    body: () => `
<ul>
  <li><b>On your phone</b>: everything, always. Mullo works offline and doesn't need an account to record.</li>
  <li><b>In your account</b>: a copy, once you sign in (Settings, tap your profile). It syncs by itself: new and changed notes, and their audio, are copied as you go.</li>
  <li><b>A new or second phone</b>: sign in with the same email. Your notes come down by themselves, and changes made on either phone follow. A recording's audio downloads when you open it. If the same note was changed on both phones at once, the phone you're on keeps its version and tells you; the other version stays in Activity.</li>
  <li>The copy is kept per person: the database itself lets an account read only its own rows.</li>
  <li>The copy is what ${link('mcp', 'MCP')} and the ${link('api', 'API')} read.</li>
</ul>
<h2>Sign-in</h2>
<p>Email and a code, Sign in with Apple, or Google; no password. Your session is kept on the phone. Being offline never signs you out.</p>
<h2>Delete your account</h2>
<p>Settings, Account, <b>Delete account</b> (below Sign out), then confirm. Your account and everything in it goes at once: notes, audio, tasks and Activity history. Connected apps and API keys stop working, and a Mullo Pro subscription bought on the website is cancelled right away, with no refund for the rest of the month. One bought in the iPhone app is billed by Apple: cancel it in your iPhone's Settings, your name, Subscriptions, or it keeps renewing. The notes on your phone stay there. It can't be undone. More in the <a href="/privacy">Privacy Policy</a>.</p>
<h2>Want it on your own server?</h2>
<p>See ${link('own-server', 'Bring your own server')}.</p>`,
  },
  {
    slug: 'own-server', group: 'Server', title: 'Bring your own server',
    intro: 'Keep the copy of your notes in your own Supabase project instead of Mullo\'s.',
    body: ({ origin }) => `
${note('Android app only, for now.')}
<h2>Set it up once</h2>
<ol class="docs-steps">
  <li>Make a project at supabase.com. The free plan is fine.</li>
  <li>Authentication, Sign In / Providers: turn Email on. Then Authentication, Emails: put <code>{{ .Token }}</code> in BOTH "Confirm signup" (your first sign-in, which makes the account) and "Magic link or OTP" (every sign-in after), so the email carries the code (6 to 10 digits, Supabase's "Email OTP length"). This is a dashboard setting; the SQL can't do it. Supabase's built-in mail sends only a few emails an hour, and only to your project's team, so send one code and wait. For everyday use, set your own mail sender in Authentication, Emails, SMTP Settings (a Gmail app password works; the username is the Gmail address). To own everything, add your own AI key too (Settings, Developers): then Mullo's server only passes your calls through.</li>
  <li>SQL editor: run each step from <a href="/setup">${esc(origin)}/setup</a>, in order.</li>
  <li>Project Settings, API Keys: copy the project URL and the <b>publishable</b> key. Never the secret key: it must never be on a phone, and Mullo refuses it.</li>
  <li>In Mullo: Settings, Developers, Your own server. Paste both. Mullo asks you to confirm, then signs you out of the old server.</li>
  <li>Sign in on your server with your email. Everything on the phone moves there by itself.</li>
</ol>
<h2>Moving your notes</h2>
<p>Your phone already has everything, so moving means copying it to the new server. When the copy is done, <b>Check the move</b> counts folders, recordings, audio files, transcripts, tasks and history on the server against the phone.</p>
<h2>Updates</h2>
<p>When Mullo needs a newer database step, Settings, Developers says so and links to the SQL to run. Mullo only ever holds the publishable key, so it never changes your database itself.</p>
<h2>Good to know</h2>
<ul>
  <li>AI on your own server: it still goes through Mullo's server, so you also sign in to your Mullo account there (Settings, Account, Mullo account). Switching keeps this device signed in to Mullo for it. Then your plan, a Mullo Pro key or ${link('own-ai-key', 'your own AI key')} works as before; your notes stay on your server.</li>
  <li>MCP and API keys work with Mullo's server.</li>
  <li><b>Back to Mullo's server</b> switches back at any time.</li>
</ul>`,
  },

  // ── MCP ───────────────────────────────────────────────────────────────
  {
    slug: 'mcp', group: 'MCP', title: 'MCP overview',
    intro: 'Ask your own AI about your meetings, in its own chat.',
    body: (ctx) => `
${soon(ctx)}
<p>Mullo is an MCP server. Connect it to Claude, ChatGPT, Cursor or any app that speaks MCP, and that app can search your recordings and read their summaries, tasks and transcripts.</p>
<p>The address:</p>
<input class="key" readonly value="${esc(ctx.origin)}/mcp" aria-label="Mullo MCP address">
<h2>Set it up in</h2>
<div class="docs-paths">
  <a class="card docs-path" href="/docs/mcp-claude"><h3>Claude</h3><p>Web, desktop and mobile.</p></a>
  <a class="card docs-path" href="/docs/mcp-chatgpt"><h3>ChatGPT</h3><p>Developer mode connector.</p></a>
  <a class="card docs-path" href="/docs/mcp-claude-code"><h3>Claude Code</h3><p>One command in the terminal.</p></a>
  <a class="card docs-path" href="/docs/mcp-cursor"><h3>Cursor and VS Code</h3><p>A line in the MCP settings.</p></a>
  <a class="card docs-path" href="/docs/mcp-other"><h3>Other apps</h3><p>Anything with HTTP MCP.</p></a>
</div>
<h2>What it can and can't do</h2>
<ul>
  <li>It can search your recordings and read titles, summaries, sections, tasks and transcripts.</li>
  <li>It can't change or delete anything, and it can't reach your audio. The database refuses it, not just the app.</li>
  <li>It sees only the notes in your account, so sign in in Mullo first.</li>
  <li>It can't use your AI minutes, your subscription or your API keys.</li>
</ul>
<h2>Signing in</h2>
<p>The first time, your AI app opens a Mullo page. Sign in with your email code, check the app's name and the address it sends you back to, then Approve. To disconnect: Mullo, Settings, Developers, Disconnect.</p>
<p>Building something? See the ${link('mcp-reference', 'MCP reference')}.</p>`,
  },
  {
    slug: 'mcp-claude', group: 'MCP', title: 'Claude',
    intro: 'claude.ai, Claude desktop and the Claude mobile app.',
    body: (ctx) => `
${soon(ctx)}
<ol class="docs-steps">
  <li>In Claude on the web or desktop: Settings, Connectors, <b>Add custom connector</b>.</li>
  <li>Name it Mullo and paste <code>${esc(ctx.origin)}/mcp</code>. Leave the advanced settings empty.</li>
  <li>Tap Connect. A Mullo page opens: sign in with your email code and Approve.</li>
  <li>In a chat, open the tools menu and make sure Mullo is on.</li>
</ol>
<p>Try: "What did I promise to do this week, according to Mullo?" or "Summarise my meetings with Dana from Mullo."</p>
<p>The connector also works in the Claude mobile app once it's added on the web.</p>`,
  },
  {
    slug: 'mcp-chatgpt', group: 'MCP', title: 'ChatGPT',
    intro: 'As a custom connector.',
    body: (ctx) => `
${soon(ctx)}
<ol class="docs-steps">
  <li>ChatGPT on the web (not the phone app): Settings, Apps and Connectors, Advanced settings (at the bottom): turn on <b>Developer mode</b>. If it isn't there, OpenAI may have moved it; look under Settings, Security.</li>
  <li>Back in Apps and Connectors, <b>Create</b>. Name it Mullo, paste <code>${esc(ctx.origin)}/mcp</code>, choose OAuth, and tick that you trust it.</li>
  <li>Mullo's page opens: sign in with the code from your email, check the return address is ChatGPT's, and Allow.</li>
  <li>In a chat: the + menu, Developer mode, then switch Mullo on. Ask, for example, "What did I decide in yesterday's meeting?"</li>
</ol>
<p>Plans: Plus and Pro can add it (Mullo only reads, which is what those plans allow). On Business, Enterprise and Edu an admin has to allow Developer mode first. If you don't see Developer mode, your plan or workspace doesn't have it yet.</p>`,
  },
  {
    slug: 'mcp-claude-code', group: 'MCP', title: 'Claude Code',
    intro: 'Your meeting notes next to your code.',
    body: (ctx) => `
${soon(ctx)}
<p>Add the server:</p>
${code(`claude mcp add --transport http mullo ${ctx.origin}/mcp`)}
<p>Then in Claude Code run <code>/mcp</code>, choose mullo and sign in. Your browser opens the Mullo approval page.</p>
<h2>With an API key instead</h2>
<p>For a machine with no browser, make an ${link('api', 'API key')} and send it as a header:</p>
${code(`claude mcp add --transport http mullo ${ctx.origin}/mcp \\\n  --header "Authorization: Bearer mullo_..."`)}`,
  },
  {
    slug: 'mcp-cursor', group: 'MCP', title: 'Cursor and VS Code',
    intro: 'A few lines of settings.',
    body: (ctx) => `
${soon(ctx)}
<h2>Cursor</h2>
<p>Cursor Settings, the MCP section, Add new MCP server, or edit <code>~/.cursor/mcp.json</code> (every project) or <code>.cursor/mcp.json</code> in one project. No key goes in the file:</p>
${code(`{
  "mcpServers": {
    "mullo": { "url": "${ctx.origin}/mcp" }
  }
}`)}
<h2>VS Code</h2>
<p>Command palette, MCP: Add Server, HTTP, or edit <code>.vscode/mcp.json</code>:</p>
${code(`{
  "servers": {
    "mullo": { "type": "http", "url": "${ctx.origin}/mcp" }
  }
}`)}
<p>Both open your browser to Mullo's sign-in page the first time (in Cursor, restart it after editing the file, then use Connect or Login beside Mullo in the MCP settings). After that the connection stays.</p>`,
  },
  {
    slug: 'mcp-other', group: 'MCP', title: 'Other apps',
    intro: 'Anything that speaks MCP over HTTP.',
    body: (ctx) => `
${soon(ctx)}
<ul>
  <li><b>Type:</b> HTTP (also called Streamable HTTP). Not SSE, not stdio.</li>
  <li><b>Address:</b> <code>${esc(ctx.origin)}/mcp</code></li>
  <li><b>Sign-in:</b> OAuth. The app finds it by itself from the address.</li>
  <li><b>No OAuth in your app?</b> Use an ${link('api', 'API key')} in the header <code>Authorization: Bearer mullo_...</code>.</li>
</ul>
<p>If an app only runs local (stdio) servers, a bridge such as <code>mcp-remote</code> can connect it:</p>
${code(`npx mcp-remote ${ctx.origin}/mcp`)}`,
  },
  {
    slug: 'mcp-reference', group: 'MCP', title: 'MCP reference',
    intro: 'For developers: transport, sign-in, tools and limits.',
    body: (ctx) => `
${soon(ctx)}
<h2>Transport</h2>
<ul>
  <li>Streamable HTTP at <code>${esc(ctx.origin)}/mcp</code>. Stateless: JSON-RPC over POST, JSON answers, no session id. GET answers 405.</li>
  <li>Protocol versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05.</li>
  <li>Tools only, all marked read-only.</li>
</ul>
<h2>Authentication</h2>
<ul>
  <li>OAuth 2.1 with PKCE and dynamic client registration. The authorization server is Mullo's account service; Mullo's own page asks the person to approve.</li>
  <li>A request without a valid token gets <code>401</code> with <code>WWW-Authenticate: Bearer resource_metadata="${esc(ctx.origin)}/.well-known/oauth-protected-resource"</code>.</li>
  <li>Protected resource metadata (RFC 9728): <code>${esc(ctx.origin)}/.well-known/oauth-protected-resource</code>.</li>
  <li>Or a personal ${link('api', 'API key')} as a bearer token.</li>
</ul>
<h2>Tools</h2>
<div class="docs-table"><table>
  <tr><th>Tool</th><th>Arguments</th><th>Returns</th></tr>
  <tr><td><code>search</code></td><td><code>query</code> (text), <code>limit</code> 1 to 25, default 10</td><td>Matching recordings with where the words matched</td></tr>
  <tr><td><code>recent_recordings</code></td><td><code>days</code> 1 to 366 (default 7), or <code>from</code> / <code>to</code> as YYYY-MM-DD; <code>limit</code> 1 to 100, default 30</td><td>Recordings, newest first, with a short overview</td></tr>
  <tr><td><code>get_recording</code></td><td><code>id</code>, <code>include_transcript</code> (default false)</td><td>Title, date, length, summary, sections, tasks, and the transcript when asked</td></tr>
  <tr><td><code>list_tasks</code></td><td><code>status</code> open, done or all (default open); <code>limit</code> 1 to 200, default 50</td><td>Tasks with due date and the recording they came from</td></tr>
</table></div>
<p>Results come as text and, for lists, as structured content too.</p>
<h2>Limits</h2>
<ul>
  <li>60 requests a minute per person, shared with the API. Over it: 429.</li>
  <li>A recording with its transcript is cut at 120,000 characters, with a note saying so.</li>
  <li>Search reads the transcripts of the newest recordings; titles, summaries and tasks of all of them.</li>
</ul>
<h2>Safety</h2>
<ul>
  <li>Reads go to the database as the person, with their own token. Row-level security applies exactly as in the app.</li>
  <li>Tokens from connected apps can't insert, change or delete anything, and can't read audio, enforced in the database.</li>
  <li>The same tokens are refused on AI, billing, admin and key routes.</li>
  <li>Mullo's server stores no OAuth tokens.</li>
</ul>`,
  },

  // ── API ───────────────────────────────────────────────────────────────
  {
    slug: 'api', group: 'API', title: 'API keys',
    intro: 'Read your notes from scripts, n8n, Zapier or Make.',
    body: (ctx) => `
${soon(ctx)}
<h2>Make a key</h2>
<ol class="docs-steps">
  <li>Sign in in Mullo: the API reads your account's copy.</li>
  <li>Mullo: Settings, Developers, API keys. Give the key a name and tap <b>New key</b>.</li>
  <li>Copy it now. It starts with <code>mullo_</code> and is shown <b>once</b>: Mullo keeps only a fingerprint of it.</li>
</ol>
<h2>Use it</h2>
<p>Send it as a bearer token in the Authorization header:</p>
${code(`curl -H "Authorization: Bearer mullo_..." \\\n  "${ctx.origin}/v1/recordings?days=7"`)}
<p>In n8n or Make, use an HTTP Request with a header named <code>Authorization</code> and the value <code>Bearer mullo_...</code>. The same key also works for ${link('mcp-other', 'MCP apps')} that take a header.</p>
<h2>Keep it safe</h2>
<ul>
  <li>Treat it like a password: it reads all your notes.</li>
  <li>It can only read. It can't change anything, reach your audio or use your minutes.</li>
  <li>Revoke it any time in Settings, Developers, API keys. It stops working at once.</li>
</ul>
<p>All endpoints: ${link('api-reference', 'API reference')}.</p>`,
  },
  {
    slug: 'api-reference', group: 'API', title: 'API reference',
    intro: 'Read-only JSON over HTTPS.',
    body: (ctx) => `
${soon(ctx)}
<p>Base address: <code>${esc(ctx.origin)}/v1</code>. Every request needs <code>Authorization: Bearer mullo_...</code>.</p>

<h2>GET /v1/recordings</h2>
<p>Recordings, newest first. Default: the last 7 days.</p>
<div class="docs-table"><table>
  <tr><th>Parameter</th><th>Meaning</th></tr>
  <tr><td><code>q</code></td><td>Search words (titles, summaries, sections, tasks, transcripts)</td></tr>
  <tr><td><code>days</code></td><td>The last N days, 1 to 366</td></tr>
  <tr><td><code>from</code>, <code>to</code></td><td>Dates, YYYY-MM-DD</td></tr>
  <tr><td><code>limit</code></td><td>Up to 100 (25 with <code>q</code>)</td></tr>
</table></div>
${code(`{
  "recordings": [
    {
      "id": "6f1c...",
      "title": "Weekly sync",
      "date": "2026-10-07",
      "duration_ms": 1680000,
      "overview": "Planning the Montreal delivery..."
    }
  ]
}`)}
<p>With <code>q</code>, each result also has <code>matched</code>: where the words were found.</p>

<h2>GET /v1/recordings/&lt;id&gt;</h2>
<p>One recording: summary, sections and tasks. Add <code>?transcript=1</code> for who said what.</p>
${code(`{
  "recording": {
    "id": "6f1c...",
    "title": "Weekly sync",
    "date": "2026-10-07",
    "recorded_at": "2026-10-07T13:02:11Z",
    "duration_ms": 1680000,
    "language": "en",
    "summary": { "blocks": [ { "heading": "Decisions", "items": ["..."] } ] },
    "sections": [ { "title": "Delivery dates", "start_ms": 0, "end_ms": 312000 } ],
    "tasks": [ { "id": "...", "label": "Call Dana", "status": "open", "due": "2026-10-08" } ],
    "transcript": [ { "speaker": "Dana", "start_ms": 4200, "text": "..." } ]
  }
}`)}

<h2>GET /v1/tasks</h2>
<p><code>status</code>: open (default), done or all. <code>limit</code>: up to 200.</p>
${code(`{
  "tasks": [
    {
      "id": "...",
      "label": "Send the quote",
      "status": "open",
      "due": "2026-10-09",
      "recording": { "id": "6f1c...", "title": "Weekly sync" }
    }
  ]
}`)}

<h2>Errors</h2>
<div class="docs-table"><table>
  <tr><th>Status</th><th>Meaning</th></tr>
  <tr><td>400</td><td>A parameter is wrong; the message says which</td></tr>
  <tr><td>401</td><td>No key, a revoked key, or a key that stopped working</td></tr>
  <tr><td>404</td><td>No such recording (or it isn't copied to the account)</td></tr>
  <tr><td>429</td><td>More than 60 requests a minute; wait a minute</td></tr>
</table></div>
<p>Errors come as <code>{"error": "..."}</code>.</p>`,
  },

  // ── More ──────────────────────────────────────────────────────────────
  {
    slug: 'connections', group: 'More', title: 'App connections',
    intro: 'The apps Mullo works with: Settings, Connections.',
    body: () => `
<p>Settings, Connections lists every app, with what you can do today: <b>Set up</b>, <b>Built in</b> (nothing to connect) or <b>Coming soon</b>. The technical setup (your own AI key, MCP, API keys, your own server) is in Settings, Developers.</p>
<h2>Claude and ChatGPT</h2>
<p>Ask them about your notes in their own chat. Set up takes you to Settings, Developers; the steps are in ${link('mcp-claude', 'Claude')} and ${link('mcp-chatgpt', 'ChatGPT')}. They can read, never change anything.</p>
<h2>Calendar</h2>
<p>A task with a date: tap 📅 and your phone's calendar app opens with the event filled in. You choose the calendar and save it. In a browser you get an event file instead.</p>
<h2>Google Calendar</h2>
<p>Connect once and your tasks go to Google by themselves, from every device you're signed in on. Settings, Connections, Google Calendar, <b>Set up</b>, then <b>Connect Google</b>. Google's page opens (in your browser, from the phone apps).</p>
<p>A task with a date becomes an all-day event on that day, in a calendar called Mullo. Done in Mullo, it shows a ✓; no date any more, or cancelled, and it's taken away.</p>
<p>Mullo sends; what you change in Google doesn't come back to Mullo. Tasks finished before you connect aren't sent. Mullo can only touch the calendar it makes. Signed in to Mullo's own server only (not your own server). <b>Disconnect</b> on the same page stops it on every device; the Mullo calendar stays in your Google account.</p>
<p><b>Google Tasks</b> (every open task in a list called Mullo) is coming soon.</p>
<h2>Notion, Google Docs, Keep and other notes apps</h2>
<p>On a recording, <b>Send it somewhere</b> shares the whole note as text: title, summary, tasks, and the transcript if you like. Pick the app from your phone's share menu.</p>
<h2>Coming soon</h2>
<p>Notion and Google Drive sync, and Gmail drafts.</p>`,
  },
  {
    slug: 'privacy', group: 'More', title: 'Privacy and security',
    intro: 'What goes where, and who can read it.',
    body: () => `
<ul>
  <li><b>Recordings stay on your phone</b> unless you sign in. Then a copy goes to your account, readable only by you.</li>
  <li><b>Where it's kept.</b> Your account's copy is stored with Supabase in Canada (Montreal). Mullo's own server keeps only your plan, minutes used, fingerprints of keys and, for website subscriptions, the email you paid with.</li>
  <li><b>The AI.</b> To be written down, audio passes through Mullo's server to Google Gemini (paid tier, not used to train models). Mullo deletes the audio once the transcript is made; the transcript waits on the server for up to 24 hours so a phone that lost signal can still collect it, then it's deleted too. Settings, Privacy & data, Mullo's server makes that shorter: 6 hours, 1 hour, or until your phone has it. "Keep recordings" there deletes a recording's audio on your device and in your account once its notes are made (or after 7 or 30 days); the words stay. Which models: ${link('limits', 'Limits and AI models')}.</li>
  <li><b>Silence.</b> A recording with no speech at all isn't sent to the AI. Otherwise the whole recording is sent.</li>
  <li><b>Your own AI key</b> (Gemini, OpenAI or Claude) is never stored by Mullo; your device keeps a locked copy only Mullo's server can open. With it, your notes go to that company under its terms.</li>
  <li><b>Connected apps and API keys</b> only read. The database refuses them any change and any audio.</li>
  <li><b>API keys</b> are kept only as a fingerprint; Mullo can't show one again.</li>
  <li><b>Activity</b> keeps every change, so a mistake can always be undone.</li>
  <li><b>Delete your account</b> any time: Settings, Account, Delete account. Everything in it goes at once. ${link('server', 'More')}</li>
</ul>
<p>The full <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms of Service</a>.</p>`,
  },
  {
    slug: 'troubleshooting', group: 'More', title: 'Troubleshooting',
    intro: 'When something doesn\'t work.',
    body: () => `
<dl class="docs-faq">
  <dt>The microphone doesn't start</dt>
  <dd>Mullo needs the microphone permission. Allow it in the phone's app settings (or the browser's site settings) and try again.</dd>
  <dt>My AI app says Mullo has nothing</dt>
  <dd>It reads the copy in your account. Sign in in Mullo and give it a moment to copy everything.</dd>
  <dt>The connector won't sign in</dt>
  <dd>Use the same email as in Mullo; the approval page only signs in existing accounts. Check the address ends with <code>/mcp</code>.</dd>
  <dt>An API key gives 401</dt>
  <dd>It was revoked, or Settings, Developers marks it as not working. Make a new one there.</dd>
  <dt>"Too many requests"</dt>
  <dd>Over 60 requests a minute for MCP and the API, or too many AI requests at once. Wait a minute.</dd>
  <dt>"Add your key again"</dt>
  <dd>Your own AI key could no longer be opened, or Google refused it. Paste it again in Settings, Developers.</dd>
  <dt>No sign-in code on my own server</dt>
  <dd>Both the "Confirm signup" and "Magic link or OTP" email templates must contain <code>{{ .Token }}</code>. See ${link('own-server', 'Bring your own server')}.</dd>
  <dt>A recording says the audio is gone</dt>
  <dd>Its audio was removed in Storage to free space. The transcript, summary and tasks stay.</dd>
</dl>`,
  },
];

const BY_SLUG = new Map(DOCS.map((d) => [d.slug, d]));
export const docFor = (slug) => BY_SLUG.get(slug) ?? null;

function nav(current) {
  return GROUPS.map((g) => `
<p class="docs-nav__group">${esc(g)}</p>
<ul>${DOCS.filter((d) => d.group === g).map((d) => `
  <li><a href="/docs${d.slug ? `/${d.slug}` : ''}"${d.slug === current ? ' aria-current="page"' : ''}>${esc(d.title)}</a></li>`).join('')}
</ul>`).join('');
}

export function docsPage(slug, ctx) {
  const doc = docFor(slug);
  if (!doc) return null;
  const i = DOCS.indexOf(doc);
  const prev = DOCS[i - 1];
  const next = DOCS[i + 1];
  const href = (d) => `/docs${d.slug ? `/${d.slug}` : ''}`;
  const menu = nav(slug);
  const title = doc.slug ? `${doc.title} · Mullo Docs` : 'Mullo Docs';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(doc.intro)}">
<link rel="stylesheet" href="${STYLE_HREF}">
</head><body>
<header class="docs-top"><a class="brand" href="/docs">${MARK}Mullo <span class="docs-top__tag">Docs</span></a><span class="docs-top__links"><a class="docs-top__home" href="/">mullo.app</a><a class="btn btn--ghost btn--small" href="/app/">Open Mullo</a></span></header>
<div class="docs">
<details class="docs-menu"><summary>Menu · ${esc(doc.group)}</summary><nav aria-label="Docs">${menu}</nav></details>
<aside class="docs-side"><nav aria-label="Docs">${menu}</nav></aside>
<article class="docs-main">
<p class="docs-crumb">${esc(doc.group)}</p>
<h1>${esc(doc.slug ? doc.title : 'Mullo Docs')}</h1>
<p class="lead">${esc(doc.intro)}</p>
${doc.body(ctx)}
<nav class="docs-pager" aria-label="Previous and next">
  ${prev ? `<a class="card" href="${href(prev)}"><small>Previous</small>${esc(prev.title)}</a>` : '<span></span>'}
  ${next ? `<a class="card docs-pager__next" href="${href(next)}"><small>Next</small>${esc(next.title)}</a>` : '<span></span>'}
</nav>
<footer><a href="/">Mullo</a> · <a href="/docs">Docs</a> · <a href="/manage">Manage subscription</a> · <a href="${SOURCE_URL}">Source code</a></footer>
</article>
</div>
</body></html>`;
}
