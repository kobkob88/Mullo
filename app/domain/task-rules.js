// What counts as an action item, whichever engine (offline rules, Gemini,
// an import) proposed it. Pure.
//
// Measured on a first real Hebrew note (2026-10-04): "בסדר", "כביסה",
// "למרות שכביסה לא קונים" and "ונעליים לימילה שכבר קנינו" all became tasks -
// filler, a lone noun, an aside, and something already done.

export const EN_VERB = /^(?:call|email|e-mail|send|text|message|whatsapp|check|book|pay|ask|follow|invoice|buy|talk|get|order|schedule|review|fix|write|remind|tell|bring|pick|prepare|update|finish|submit|cancel|confirm|return|renew|print|sign|reply|meet|visit|clean|wash|take|make|find|go|draft|plan|arrange|contact|look|set|move|share|research|test|try|reach|discuss|organize|organise|clarify|collect|deliver|ship|transfer|follow-up)\b/i;
export const HE_NOT_VERB = /^(?:למרות|לפני|לגבי|לכן|לא|לפעמים|לדעתי|לי|לך|לו|לה|לנו|לכם|להם|לפי|למה|לאן|לפחות|למשל|לגמרי)(?![֐-׿])/;
export const FILLER = /^(?:בסדר|אוקיי|אוקי|טוב|כן|לא|יופי|סבבה|נכון|ok|okay|thanks|thank you|right|yes|no|sure|great|fine)[.!?,]*$/i;
const ASIDE = /^(?:although|even though|but|because|since|unless|whereas|though)\b/i;
const ALREADY = /שכבר|כבר (?:קנינו|עשינו|שילמנו|שלחנו|קניתי|עשיתי|שילמתי|שלחתי)|\balready (?:bought|done|paid|sent|booked|ordered)\b/i;
const HEBREW = /[֐-׿]/;

const clean = (s) => String(s ?? '').trim().replace(/^(?:and|then|also)\s+/i, '').replace(/^ו(?=ל)/, '');

export function startsTask(part) {
  const p = clean(part);
  if (HEBREW.test(p[0] ?? '')) return /^ל[֐-׿]{2,}/.test(p) && !HE_NOT_VERB.test(p);
  return EN_VERB.test(p);
}

// Hebrew tasks must start with an infinitive ("לקנות…", "להתקשר…") - that is
// how both engines write them. Other scripts: at least two words, or a verb.
export function isPlausibleTask(label) {
  const p = clean(label).replace(/[.!?]+$/, '');
  if (p.length < 3 || FILLER.test(p) || ASIDE.test(p) || ALREADY.test(p)) return false;
  if (HEBREW.test(p[0])) return startsTask(p);
  return p.split(/\s+/).length >= 2 || startsTask(p);
}
