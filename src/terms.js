// Tokenizer shared by recall and the term-frequency builder: both must split text the same way.
// Distinctive terms only: >= 5 letters, or shorter tokens that mix letters and digits (s3, k8s, gpt5).
// Any alphabet works (Latin, Cyrillic, Greek, Devanagari, Arabic, Hebrew...). Hangul words count from 2
// syllables. Scripts written without spaces are split differently: Chinese and Japanese kanji and katakana
// into overlapping character pairs (bigrams: 王伟决定 -> 王伟 伟决 决定), because a word segmenter splits
// names apart (王伟 -> 王 | 伟); Thai, Lao, Khmer and Myanmar with Intl.Segmenter. Hiragana is grammar and
// is skipped. Stopwords cover English, Spanish, Portuguese, French, German, Italian, Russian and Korean, plus
// the commonest Chinese and Japanese pairs; extend them with `extraStopwords`. They are written as spoken
// (perché, können, сейчас) and folded with norm() like everything else. Only function words: a word that is
// a content word in another language stays out (Italian "prima" is a Spanish insurance term).

const STOP_WORDS = `
  about after again also because before being could does doing from have here into just like
  make more most other over should some such than that their them then there these they this
  those through under very what when where which while will with would your please thanks
  thing things something anything everything going doing check could might maybe really
  para pero como cuando donde porque sobre entre desde hasta hacia contra segun sino tambien
  ahora antes despues luego todavia siempre nunca mientras aunque entonces mismo misma otros otras
  este esta esto estos estas ese esa eso esos esas aquel cual cuales quien quienes cuanto cuanta
  tiene tienen tener tengo hacer hace hacen hecho haber habia hemos puede pueden podemos poder
  quiero quieres queremos necesito necesitas debe deben seria estar estamos estan estoy
  vamos sigue sigamos seguir dame dime decir dijo dijiste creo crees parece revisa revisar
  quedo queda decidimos recuerdame retomemos usamos generan propusimos problema tema cosa
  cosas todo todos toda todas algo alguno alguna nada mucho mucha muchos muy bien mejor peor
  gracias favor claro listo vale bueno buena buenos
  ainda depois entao muito muita muitos muitas outro outra estou estao tenho temos fazer preciso precisa
  podemos podes deveria agora aquilo coisa algum alguma alguns algumas obrigado obrigada certo vamos tudo
  alors aussi comme cette encore faire jamais maintenant merci moins parce pendant pourquoi pouvez pouvons
  quand quelque quelques selon toujours toutes toute votre notre nous vous leurs cela celui celle ceux
  avoir avons avez chose choses voila juste ensuite après avant depuis regarde vérifie peux
  allem allen alles andere anderen bitte damit danke darum diese dieser dieses durch einem einen einer
  eines etwas gegen haben hatte hatten heute immer jetzt kannst keine können machen meine müssen schon
  seine sollen sollte unsere warum welche werden wieder wurde würde zwischen dabei davon bereits einfach
  genau gerade vielleicht wirklich prüfe schau
  abbiamo adesso allora ancora anche avere bisogna essere fatto grazie molto molti nostro nostra nella
  nelle negli oppure perché possiamo posso proprio quale quali qualche quanto quella quello quelle questi
  questo questa sempre senza siamo sotto stato stata tutto tutti tutte vediamo voglio vorrei controlla
  сейчас потом теперь может можно нужно очень всего всегда когда потому чтобы этого такой также только
  сделать сделай давай давайте пожалуйста спасибо хорошо ладно проверь посмотри который которые которая
  между после перед через более менее вообще просто будет будем почему какой какие какая сколько здесь
  нужен нужна нужны вопрос
  그리고 그래서 하지만 그런데 그러면 지금 이제 우리 우리가 우리는 저희 저희가 정말 진짜 그냥 혹시 이거 그거 저거
  여기 거기 어떻게 무엇 뭐가 때문에 있는 없는 하는 해줘 해주세요 확인 부탁 부탁해 감사합니다 고마워 좋아 알겠어
`;

// Chinese pairs common enough to be noise in any corpus (rarity filters the rest once `quietmem tf` has run).
const CJK_STOP = new Set(`
  我们 你们 他们 她们 什么 怎么 这个 那个 这些 那些 一个 没有 可以 因为 所以 但是 如果 已经 自己 现在
  时候 知道 就是 还是 不是 这样 那样 为什 一下 一些 需要 应该 问题 我的 你的 的话 这里 那里 怎样 为了
  关于 然后 或者 而且 不过 确认 检查 一点 今天 明天
  今日 本当 大丈夫 確認 必要 場合 少し 全部 一番 今度 最近 問題 時間 自分 方法
`.split(/\s+/).filter(Boolean));

const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
// Letters that are not "base letter + accent", so stripping accents does not fold them.
const FOLD = { 'ß': 'ss', 'ł': 'l', 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ı': 'i' };
// Lowercase, fold accents (NFD, drop U+0300–U+036F, recompose so kana and Hangul stay whole) and FOLD.
export const norm = s => String(s).toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC')
  .replace(/[ßłøæœđðþı]/g, c => FOLD[c]);
const STOP = new Set(STOP_WORDS.split(/\s+/).filter(Boolean).map(norm));

// A run of letters, marks (Thai and Devanagari vowels are marks) and digits; '_', '.' and '-' inside it.
const RUN = /[\p{L}\p{N}][\p{L}\p{M}\p{N}_.\-]*[\p{L}\p{M}\p{N}]/gu;
export const NOSPACE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;
const HAN = /[\p{sc=Han}]{2,}/gu, KATAKANA = /[\p{sc=Katakana}ー]{2,}/gu;
const SEGMENTED = /[\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}][\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}\p{M}]*/gu;
const NOSPACE_ALL = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}ー]+/gu;
const ASCII = /^[\x00-\x7f]*$/;
const cps = s => { if (ASCII.test(s)) return s.length; let n = 0; for (const _ of s) n++; return n; };
let segmenter;

/** Minimum length for a word of an alphabet: Hangul packs a syllable in one character. */
const minLen = w => (!ASCII.test(w) && /\p{sc=Hangul}/u.test(w) ? 2 : 5);

/**
 * Every candidate word of `text` with its raw form (lowercased, accents kept: what Postgres indexes) and its
 * key (norm(): what term frequencies and matching use). kind 'run': a space-delimited word, with its hyphen,
 * dot and underscore parts in `parts`; kind 'cjk': a bigram or segmented word from a script without spaces.
 */
export function* words(text) {
  for (const [run] of String(text).normalize('NFC').toLowerCase().matchAll(RUN)) {
    if (ASCII.test(run)) { yield { kind: 'run', raw: run, key: run }; continue; }        // most words: nothing to fold
    if (!NOSPACE.test(run)) { yield { kind: 'run', raw: run, key: norm(run) }; continue; }
    for (const re of [HAN, KATAKANA]) for (const [seq] of run.matchAll(re)) {
      const c = Array.from(seq);
      for (let i = 0; i + 1 < c.length; i++) yield { kind: 'cjk', raw: c[i] + c[i + 1], key: c[i] + c[i + 1] };
    }
    for (const [seq] of run.matchAll(SEGMENTED)) {
      segmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
      for (const s of segmenter.segment(seq)) if (s.isWordLike && cps(s.segment) >= 2) yield { kind: 'cjk', raw: s.segment, key: norm(s.segment) };
    }
    // Latin, digits or another alphabet glued to them ("gpt5を使った"): the usual rules.
    for (const [rest] of run.replace(NOSPACE_ALL, ' ').matchAll(RUN)) yield { kind: 'run', raw: rest, key: norm(rest) };
  }
}

/**
 * Bigrams and segmented words of scripts without spaces, for the chunks.dense column: Postgres' text search
 * sees a whole Chinese or Thai sentence as one word, so these get their own index. null when there are none.
 */
export function denseKeys(text) {
  if (!NOSPACE.test(text)) return null;
  const out = new Set();
  for (const w of words(text)) if (w.kind === 'cjk') out.add(w.key);
  return out.size ? [...out] : null;
}

/** Is a space-delimited word distinctive enough to be a term? */
export const isTermWord = (w, stop = STOP) => {
  const n = cps(w);
  return (n >= minLen(w) || (n >= 3 && /[\p{N}]/u.test(w) && /[\p{L}]/u.test(w))) && !stop.has(w);
};

export function terms(text, extraStopwords = null) {
  const stop = extraStopwords ? new Set([...STOP, ...extraStopwords]) : STOP;
  const out = new Set();
  for (const { kind, key } of words(text)) {
    if (kind === 'cjk') { if (!CJK_STOP.has(key) && !stop.has(key)) out.add(key); continue; }
    if (isTermWord(key, stop)) out.add(key);
    // "billing-service" also counts as "billing" and "service"
    if (key.includes('-')) for (const p of key.split('-')) if (cps(p) >= minLen(p) && !stop.has(p)) out.add(p);
  }
  return out;
}

// Tokens used for the entity gate (keeps hyphenated names whole).
export const tokens = text => norm(text).match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:-[\p{L}\p{M}\p{N}]+)*/gu) || [];
