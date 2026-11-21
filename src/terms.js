// Tokenizer shared by recall and the term-frequency builder: both must split text the same way.
// Distinctive terms only: >= 5 letters, or shorter tokens that mix letters and digits (s3, k8s, gpt5).
// Stopwords cover English and Spanish; extend them with `extraStopwords`.

const STOP = new Set(`
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
`.split(/\s+/).filter(Boolean));

const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
export const norm = s => String(s).toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');

export function terms(text, extraStopwords = null) {
  const stop = extraStopwords ? new Set([...STOP, ...extraStopwords]) : STOP;
  const out = new Set();
  for (const w of norm(text).match(/[a-z0-9][a-z0-9_.\-]*[a-z0-9]/g) || []) {
    if ((w.length >= 5 || (w.length >= 3 && /\d/.test(w) && /[a-z]/.test(w))) && !stop.has(w)) out.add(w);
    // "billing-service" also counts as "billing" and "service"
    if (w.includes('-')) for (const p of w.split('-')) if (p.length >= 5 && !stop.has(p)) out.add(p);
  }
  return out;
}

// Tokens used for the entity gate (keeps hyphenated names whole).
export const tokens = text => norm(text).match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [];
