// Privacy Policy and Terms of Service, served at /privacy and /terms (the App Store and
// Play listings link here, and so does the app's Settings). Plain words, and only what the
// code really does: change a sentence here when the behaviour it describes changes.
// Adapted from the budget app's pages (same company, same kind of setup: Supabase,
// Cloudflare Workers, Gemini, Stripe).

import { page } from './pages.mjs';

// The version people accept (acceptance.mjs): bump it with any change to either page, and say
// in LEGAL_CHANGES, in one plain sentence, what changed. The app shows that sentence when it
// asks people who accepted an earlier version to accept again.
export const LEGAL_UPDATED = 'October 18, 2026, problem reports';
export const LEGAL_CHANGES = 'Privacy: you can now report a problem from Settings; the policy says what a report holds (never your notes) and that it is deleted 90 days after we close it.';
const CONTACT = 'hello@lizai.io';
const mail = `<a href="mailto:${CONTACT}">${CONTACT}</a>`;
const meta = `<p>LizAI Studios · Last updated: ${LEGAL_UPDATED} · ${mail}</p>`;

export function privacyPage() {
  return page('Privacy Policy · Mullo', `
<h1>Privacy Policy</h1>
${meta}
<p>Mullo records what you say and turns it into a transcript, a summary and tasks. That is personal, so this page says plainly what goes where, who can read it, and what you can do about it. Mullo is made by LizAI Studios ("we"). By using Mullo you agree to what is described here.</p>

<h2>The short version</h2>
<ul>
  <li>Your recordings live on your phone. They go to your account only if you sign in, and only you can read them there.</li>
  <li>To be written down, audio passes through Mullo's server to Google Gemini. Mullo's server deletes the audio once the transcript is made, and the transcript within 24 hours, sooner if you choose.</li>
  <li>You can have Mullo delete a recording's audio everywhere once its notes are made, keeping only the words.</li>
  <li>We don't sell your data, show ads, or use trackers.</li>
  <li>You can delete your notes, and your whole account, at any time.</li>
</ul>

<h2>1. What stays on your device</h2>
<p>Recordings, transcripts, summaries, tasks, folders and settings are kept on the device you use Mullo on. Your profile photo stays on that device only. A recording made on your watch goes from the watch to your phone directly. If you never sign in, nothing leaves your device: using the AI needs a sign-in (section 3).</p>

<h2>2. Your account</h2>
<p><strong>Signing in.</strong> You sign in with your email address and a one-time code, or with your Google or Apple account. We use the address to identify your account and to send you sign-in codes. No password is kept. With Google or Apple, they tell our sign-in provider (Supabase) who you are: your email address, and the name and picture on that account if it has them; Google and Apple don't see your notes. If you choose Apple's Hide My Email, we only ever see the private address Apple makes for you, and our emails reach you through it.</p>
<p><strong>Your copy in the account.</strong> Once you sign in, Mullo copies your notes to your account so they reach your other devices: recordings and their audio, transcripts, summaries, tasks, folders, and the history of changes (Activity, so a mistake can be undone). They are stored with Supabase. The database lets each account read only its own rows, and audio sits in a private storage space, a folder per account, never public.</p>
<p><strong>Your own server.</strong> If you choose to keep your notes on your own Supabase project, they are copied there instead, and that project's owner is responsible for them. The AI still goes through Mullo's server, so for the AI you also sign in to a Mullo account; your notes are not copied to it.</p>

<h2>3. The AI</h2>
<p><strong>A sign-in, whoever pays.</strong> Anything that goes through Mullo's server needs you signed in to your Mullo account: on a Mullo plan, with a Mullo Pro key, and with your own AI key. The sign-in tells us it's you and that you accepted these pages; a key alone is not enough.</p>
<p><strong>Transcribing.</strong> The audio of a recording is sent through Mullo's server (Cloudflare Workers) to Google Gemini, on Google's paid API, which Google does not use to train its models. Before sending, your device checks whether there is any speech: a recording with none is not sent at all (in a browser, only recordings up to 3 minutes are checked). Otherwise the whole recording is sent, and lines written inside long silent stretches are dropped. Mullo's server keeps the audio only until the transcript is written, then deletes it. The finished transcript waits on the server so a phone that lost signal can still collect it, then it is deleted too: for 24 hours, or less if you choose in Settings, Privacy & data, Mullo's server (1 hour, 6 hours, or until your phone has it: deleted as soon as your phone saves it, and after an hour at most if your phone can't say so).</p>
<p><strong>Speakers.</strong> Within one recording, the AI marks who is talking (Speaker 1, Speaker 2), and you can put a name on each. Mullo doesn't make voiceprints and doesn't recognise anyone's voice from one recording to the next.</p>
<p><strong>Sensitive things you say.</strong> What you record can include health, money, family or other sensitive details about you or other people. Mullo uses them only to make what you ask for. It doesn't look for such details, doesn't build a profile of you, and we don't read your notes unless you ask us to help with them or the law requires it.</p>
<p><strong>Summaries, tasks, questions and drafts.</strong> To make a summary, or to answer you in Ask (a question, or a draft such as an email, message or document you ask for), the transcript text goes the same way to Gemini. For Ask that is the notes your device picks for the question (or the one recording you chose with "Ask about this") and the last few messages of the chat. Mullo's server does not keep any of it. The Ask chat and its drafts are kept only on your device.</p>
<p><strong>Drafts on your tasks.</strong> When a note gives you an email or message to send, Mullo writes a draft for it once the summary is ready, the same way as a draft you ask for in Ask: that one note goes to Gemini. The draft is kept with the task, so it is stored and synced like your tasks. Mullo never sends anything: you send it yourself from your mail or messaging app. You can turn this off in Settings, Tasks, "Draft emails and messages for me".</p>
<p><strong>Your own AI key.</strong> If you add your own Gemini, OpenAI or Claude key, your audio or notes go to that company under its own terms, and it bills you directly. Mullo's server locks the key so only Mullo's server can use it, and only for the Mullo account that added it; your device keeps the locked copy and Mullo's server does not store it.</p>

<h2>4. What Mullo's server keeps</h2>
<p>Apart from the short waits in section 3 (the audio until it is transcribed, the transcript for up to 24 hours, or less if you choose), Mullo's server doesn't store your recordings or transcripts. It keeps only what it needs to run your plan:</p>
<ul>
  <li>Your plan (Pro, trial, or one we gave you), and how much AI you used each month (minutes of audio and a technical count).</li>
  <li>For a trial: a fingerprint (a one-way hash) of your email address, so each mailbox gets one trial. The address itself is not kept there.</li>
  <li>For Mullo Pro on the website: the Stripe customer and subscription ids, the email address you gave at checkout (for support), and a fingerprint of your Pro key. The key itself is never stored. Bought in the iPhone app: Apple's id for the subscription, its status and renewal date. Either way, which Mullo account the subscription belongs to.</li>
  <li>If you use your own AI key added before October 17, 2026: a fingerprint of its locked copy and the Mullo account it belongs to, never the key.</li>
  <li>For API keys you create: a fingerprint of each key, and a locked grant that lets the key read your notes. A key can be revoked at any time.</li>
  <li>If you connect Google Calendar or Google Tasks: a locked grant from Google, the ids of the calendar and list Mullo made there, and which Google task belongs to which Mullo task (ids only, never the task's words).</li>
  <li>Which version of this policy and the Terms of Service you accepted, and when.</li>
  <li>Problem reports you send from Settings, Report a problem: what you wrote, your email address, a screenshot if you added one, and details the app adds (Mullo's version, your device and browser, the screen you were on, your plan, your language, recent error messages, and a note's id if the report is about one). Never the words of your notes, their transcripts or audio. Only Mullo's team reads them. A report is kept until we close it and deleted 90 days after that, and with your account.</li>
</ul>

<h2>5. Connected apps and API keys</h2>
<p>You can let other AI apps (for example Claude or ChatGPT) or your own scripts read your notes. Only you can connect them, they can only read (the database itself refuses them any change, and they can't use Mullo's AI or billing), and you can disconnect them in Settings, Developers. What a connected app does with what it reads is governed by that app's terms.</p>
<p><strong>Google Calendar and Google Tasks.</strong> If you connect them (Settings, Connections), your tasks go through Mullo's server to your Google account: a task's words, its context, the title of the recording it came from and its date. Tasks with a date become events in a calendar called Mullo; open tasks go to a list called Mullo in Google Tasks. For Calendar, Mullo asks Google only for calendars Mullo itself creates, so it can't see your other calendars. Google Tasks access covers all your task lists; Mullo reads only their names, to find its own list, and changes nothing else. Mullo's server passes the tasks on and doesn't keep their words. Disconnecting, or deleting your account, takes back Mullo's access at Google; what's already in your Google account stays there until you delete it, under Google's terms.</p>
<p>Mullo's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Mullo uses that information only to keep your tasks in the Mullo calendar and list; it never uses it for ads, never sells it, never lets anyone read it, and never uses it to train AI models.</p>

<h2>6. Payments</h2>
<p>Mullo Pro is paid through Stripe. We never see or store your card number.</p>

<h2>7. Services we use</h2>
<ul>
  <li><strong>Supabase</strong>: sign-in, the database and private storage for your account's copy</li>
  <li><strong>Cloudflare</strong>: Mullo's server, the website and the web app</li>
  <li><strong>Google Gemini</strong>: transcripts, summaries, tasks, answers and drafts</li>
  <li><strong>Stripe</strong>: Mullo Pro payments</li>
  <li><strong>Apple</strong>: Mullo Pro bought in the iPhone app (Apple tells us the purchase, its status and renewal date, never your card)</li>
  <li><strong>An email provider</strong>: delivering your sign-in codes</li>
  <li><strong>OpenAI or Anthropic</strong>: only if you add your own key from them</li>
  <li><strong>Google Calendar and Google Tasks</strong>: only if you connect them</li>
</ul>
<p><strong>Where your data is.</strong> Your account's copy (recordings, audio, transcripts, notes) is stored with Supabase in Canada (Montreal). To make a transcript, summary or answer, audio and text pass through Mullo's server on Cloudflare's network, usually at the location nearest you, to Google Gemini, which may process them in the United States or elsewhere; nothing is kept longer than section 3 says. Mullo's server keeps its plan records (section 4) in Cloudflare's eastern North America region, which may be in the United States. Stripe and our email provider may also store data in the United States.</p>
<p><strong>If you live outside Canada</strong>, or in Quebec, this means your data leaves your country or province. Canada is recognised by the European Union and the United Kingdom as protecting personal data adequately. Each company above works for us under written data processing terms, which for the United States include the standard contractual protections those laws ask for.</p>

<h2>8. Logs, ads and tracking</h2>
<p>Like any website, Mullo's server keeps short-lived technical logs (time, the address requested, the network address it came from), for up to 7 days, to keep the service secure and fix problems. To stop floods, it also counts how many requests each network address sends in a minute; that count lives only in memory and is gone within minutes. Nothing personal is put in those addresses. Mullo has no ads, no advertising trackers and no analytics scripts.</p>

<h2>9. Sharing</h2>
<p>We do not sell, rent or share your personal data or your notes with advertisers, data brokers or anyone else for commercial purposes. We may disclose data only when the law requires it, or to protect the safety and rights of our users.</p>

<h2>10. Your choices and rights</h2>
<ul>
  <li><strong>Delete a note</strong> in Mullo at any time; the change is copied to your account. Activity keeps earlier versions so a mistake can be undone; to erase everything for good, delete your account.</li>
  <li><strong>Free up space:</strong> Settings, Storage removes audio from that device and keeps the text; the copy in your account keeps its audio.</li>
  <li><strong>Keep recordings:</strong> in Settings, Privacy & data, choose to delete a recording's audio once its notes are made, or 7 or 30 days after you recorded it. The audio is then deleted from that device and from your account, with no copy kept for restoring (the audio of recordings you deleted goes too); the transcript, summary and tasks stay. Deleted audio can't be played or transcribed again. Your other devices keep audio they already downloaded until you make the same choice there.</li>
  <li><strong>Mullo's server:</strong> in Settings, Privacy & data, choose how long a finished transcript waits on Mullo's server for your phone to collect it (section 3).</li>
  <li><strong>Delete your account</strong> in Mullo: Settings, Account, Delete account. The account and everything in it, including its Activity history and stored audio, is deleted at once, connected apps and API keys stop working, and a Mullo Pro subscription bought on the website is cancelled. One bought in the iPhone app is billed by Apple and keeps renewing until you cancel it in your iPhone's Settings, your name, Subscriptions. If you signed in with Apple, deleting from the iPhone app also ends Mullo's link to your Apple ID (Apple asks you to confirm once). Notes still on your devices stay there until you remove the app or delete them. Afterwards we keep only the one-way fingerprint of your email address used for trials (so a new account with it doesn't get a second trial) and the payment records Stripe and the law require, without your email. Can't open the app? Email ${mail} from the address you sign in with and we'll do it within 30 days.</li>
  <li><strong>Access, correct, or take a copy:</strong> ask us what we hold about you, have it corrected, or get a copy of your notes in a common format (text files and the audio) to take elsewhere. Write to ${mail}; we answer within 30 days.</li>
  <li><strong>Withdraw or object:</strong> disconnect a connected app, Google Calendar or Tasks, or your own AI key in Settings at any time. You can also object to how we use your data, or ask us to limit it, by writing to us.</li>
</ul>
<p>These rights are yours wherever you live; section 13 names the regulator you can complain to.</p>

<h2>11. Children</h2>
<p>Mullo is not meant for children under 13, and we do not knowingly collect information from them.</p>

<h2>12. Changes to this policy</h2>
<p>We may update this policy as Mullo changes. When this policy or the Terms change, the app shows you what changed and asks you to accept them again; until you do, Mullo's AI features wait, and the notes on your device stay yours to use. The date at the top always shows the latest version.</p>

<h2>13. Why we may use your data, and where to complain</h2>
<p>Some privacy laws (for example in the European Union, the United Kingdom and Israel) ask us to say on what grounds we use your data. No law requires you to give it to us; without an email address you can still use Mullo on your device, without the AI.</p>
<ul>
  <li><strong>To give you the service you asked for:</strong> your account, copying notes to your devices, the AI on your recordings and notes, sign-in codes, Mullo Pro.</li>
  <li><strong>Our legitimate interest in keeping Mullo safe:</strong> the technical logs, counting requests to stop floods, and the trial fingerprint that stops repeat trials.</li>
  <li><strong>The law:</strong> payment records we must keep for tax.</li>
  <li><strong>Your consent:</strong> connected apps, API keys, Google Calendar and Google Tasks, and your own AI key. Disconnecting them withdraws it.</li>
</ul>
<p>Mullo makes no decisions about you that have legal or similar effects; the AI only writes notes for you to read. If you think we got something wrong, write to us first. You can also complain to the privacy regulator where you live: in Canada the Office of the Privacy Commissioner (priv.gc.ca), in Quebec the Commission d'accès à l'information (cai.gouv.qc.ca), in Israel the Privacy Protection Authority, in the United Kingdom the ICO (ico.org.uk), and in the European Union the data protection authority of your country.</p>

<h2>14. If something goes wrong</h2>
<p>If a security problem puts your personal information at real risk of significant harm, we tell you and the regulator that applies as soon as we can, with what happened and what you can do. We keep a record of every such incident, however small.</p>

<h2>15. Contact, and who is responsible</h2>
<p>LizAI Studios, a business registered in Ontario, Canada, is responsible for your personal information. The person in charge of protecting it (our privacy officer) is the owner of LizAI Studios. Questions, requests and complaints: ${mail}.</p>`);
}

export function termsPage() {
  return page('Terms of Service · Mullo', `
<h1>Terms of Service</h1>
${meta}
<p>These Terms govern your use of Mullo, its apps for phone, watch and computer, its website and its server, all provided by LizAI Studios ("we"). By creating an account or using Mullo, you agree to them. Our <a href="/privacy">Privacy Policy</a> explains how your data is handled.</p>

<h2>1. Who can use Mullo</h2>
<p>You must be at least 13 years old. If you are under the age of majority where you live, a parent or guardian must agree to these Terms for you. To buy Mullo Pro you must be able to enter a binding agreement.</p>

<h2>2. Recording other people is your responsibility</h2>
<p>Recording laws are different in every country, province and state. Some places let you record a conversation you take part in (Canada, for example); others need the consent of everyone in it (some US states, for example). Phone calls, workplaces, and conversations you are not part of can have extra rules. Before you record, find out which rules apply where you record, and follow them: tell people, or get their consent, whenever those rules require it.</p>
<p>Mullo is a tool. It can't know where you are, who is speaking, or who agreed to be recorded, and it doesn't check. Nothing in Mullo, on our website or from us is legal advice. You alone are responsible for the recordings you make with Mullo and for how you use and share them.</p>
<p>Do not use Mullo to record anyone where that is against the law. If someone makes a claim against LizAI Studios because of a recording you made against the law or against someone's rights, you agree to cover (indemnify) LizAI Studios for that claim and its reasonable costs, to the extent the law allows.</p>

<h2>3. Your account</h2>
<p>Mullo's AI features need a Mullo account, also when your own AI key or a Mullo Pro key pays for them, and also when your notes are kept on your own server.</p>
<p>Keep access to your email account and your devices secure: whoever can sign in as you can read your notes. Treat Mullo Pro keys and API keys like passwords. Tell us at <a href="mailto:${CONTACT}">${CONTACT}</a> if you think someone else has access.</p>

<h2>4. Your content</h2>
<p>Your recordings, transcripts and notes belong to you. You give us permission to store, copy and process them only as needed to provide Mullo to you (for example, to transcribe them or copy them to your other devices). We claim no other rights over them.</p>

<h2>5. The AI can be wrong</h2>
<p>Transcripts, summaries, tasks, dates, answers and drafts are made by AI and can contain mistakes: misheard words, wrong names, missed or invented details. Check anything important against the recording before you rely on it. Mullo does not give medical, legal, financial or other professional advice. Don't rely on Mullo for anything where a mistake or a missing recording could put someone's health or safety at risk, and never in an emergency.</p>

<h2>6. Plans, trials and billing</h2>
<p><strong>Bring your own AI.</strong> You can use Mullo with your own Gemini, OpenAI or Claude key. That company bills you directly under its own terms.</p>
<p><strong>Mullo Pro</strong> is a monthly subscription that includes a monthly amount of recording minutes, shown when you subscribe. On our website it is billed through Stripe; in the iPhone app it is billed by Apple to your Apple ID, under Apple's terms. It renews each month until you cancel. You can cancel at any time (an App Store subscription in your iPhone's Settings, your name, Subscriptions); it stays active until the end of the period you paid for. Deleting your account is different: it ends a website subscription at once, with no refund for the rest of the period. It can't end an App Store subscription: cancel that with Apple, and ask Apple for any refund.</p>
<p>We may change the price with notice before your next renewal.</p>
<p><strong>Free trial minutes.</strong> New accounts may get a number of free minutes to try Mullo, once per person and per email address. Mullo is new and we are still learning what works, so whether a trial is offered, how many minutes it includes, and when it is available may change at any time, and trials may be paused or ended. Trial minutes have no cash value and can't be transferred.</p>
<p><strong>How minutes are counted.</strong> Minutes are measured by Mullo's server from the audio the AI processes, not by the app. Plans also have hidden safety limits so a leaked key or unusual use can't run up costs; normal use stays well inside them.</p>

<h2>7. Refunds</h2>
<p>If you think you were charged in error, write to <a href="mailto:${CONTACT}">${CONTACT}</a> within 14 days of the charge. If the law where you live gives you a right to cancel a purchase within a set time (for example 14 days in the European Union, the United Kingdom or Israel), you have that right too: write to us and we refund as that law says. Bought in the iPhone app? Apple handles those payments, so ask Apple for the refund (reportaproblem.apple.com); we can't refund an App Store charge ourselves.</p>

<h2>8. Acceptable use</h2>
<p>Do not use Mullo to break the law or someone else's rights (including recording laws, section 2), try to get into other people's accounts or data, interfere with or overload Mullo's server, get around plan limits, or resell access to Mullo's AI.</p>
<p>If someone makes a claim against LizAI Studios because you broke these Terms or the law while using Mullo, you agree to cover (indemnify) LizAI Studios for that claim and its reasonable costs, to the extent the law allows. This doesn't apply to a claim caused by our own breach of these Terms.</p>

<h2>9. Other services you connect</h2>
<p>Your own AI key, your own server, connected apps and calendars are provided by other companies under their own terms. We are not responsible for what they do with data you send them.</p>

<h2>10. Changes and availability</h2>
<p>Mullo is in active development. Features may change, be added or be removed, and the service may sometimes be unavailable. Keep your own copy of anything you can't afford to lose; Mullo's export and share options help with that. We may suspend or close an account that breaks these Terms.</p>

<h2>11. Intellectual property</h2>
<p>Mullo's software is open source under the GNU Affero General Public License v3; that licence, not these Terms, governs the code itself. The Mullo name and logo, and the service we run (our server and our AI plans), belong to LizAI Studios.</p>

<h2>12. Disclaimer</h2>
<p>Mullo is provided "as is" and "as available", without warranties of any kind, to the extent the law allows.</p>

<h2>13. Limitation of liability</h2>
<p><strong>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, LIZAI STUDIOS AND ITS FOUNDERS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL OR CONSEQUENTIAL DAMAGES ARISING FROM YOUR USE OF MULLO, INCLUDING LOST RECORDINGS OR DATA, OR DECISIONS MADE ON AI OUTPUT. OUR TOTAL LIABILITY IS LIMITED TO THE GREATER OF WHAT YOU PAID US IN THE 12 MONTHS BEFORE THE CLAIM AND CA$100.</strong></p>

<h2>14. Ending</h2>
<p>You can stop using Mullo and delete your account at any time, in the app: Settings, Account, Delete account. That deletes the account and everything in it at once and cancels a Mullo Pro subscription bought on our website right away, with no refund for the rest of the month. A subscription bought in the iPhone app is billed by Apple and keeps renewing until you cancel it with Apple (iPhone Settings, your name, Subscriptions), so cancel it there too (see the <a href="/privacy">Privacy Policy</a>, section 10).</p>

<h2>15. Governing law</h2>
<p>These Terms are governed by the laws of the Province of Ontario, Canada. If you use Mullo as a consumer, you also keep the protection of the consumer and privacy laws where you live that can't be set aside by agreement (in Quebec, for example), and you may bring a claim in the courts there. Where a law doesn't allow a part of these Terms, such as a limit in section 13, that part applies only as far as the law allows.</p>

<h2>16. Changes to these Terms</h2>
<p>We may update these Terms. When they change, the app shows you what changed and asks you to accept them again before you keep using Mullo's AI features. If you don't accept them, you can stop using Mullo and delete your account (section 14).</p>

<h2>17. Contact</h2>
<p>Questions? Write to <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>`);
}
