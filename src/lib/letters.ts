/**
 * Letter names for the two languages a learner can study, written by hand (no
 * AI), so they cost nothing and never change between visits.
 *
 * `hints` is how the letter's NAME sounds, in each language a learner may know:
 * Devanagari for Hindi, Telugu script for Telugu, plain English for English.
 * `speak` is the text the phone voice reads out so it says the letter's name
 * (a bare "A" is read differently by different voices).
 *
 * Hindi and Telugu spellings are approximations of the sounds and worth a
 * native speaker's review before a wide release.
 */

export type HintLang = "en" | "hi" | "te";

export type Letter = {
  letter: string;
  speak: string;
  hints: Partial<Record<HintLang, string>>;
  /** Extra help for letters that have no English sound (German umlauts). */
  notes?: Partial<Record<HintLang, string>>;
};

const row = (letter: string, speak: string, hi: string, te: string, en?: string): Letter => ({
  letter,
  speak,
  hints: { hi, te, ...(en ? { en } : {}) },
});

export const ENGLISH_LETTERS: readonly Letter[] = [
  row("A", "ay", "ए", "ఏ"),
  row("B", "bee", "बी", "బీ"),
  row("C", "see", "सी", "సీ"),
  row("D", "dee", "डी", "డీ"),
  row("E", "ee", "ई", "ఈ"),
  row("F", "eff", "एफ़", "ఎఫ్"),
  row("G", "jee", "जी", "జీ"),
  row("H", "aitch", "एच", "ఎచ్"),
  row("I", "eye", "आई", "ఐ"),
  row("J", "jay", "जे", "జే"),
  row("K", "kay", "के", "కే"),
  row("L", "ell", "एल", "ఎల్"),
  row("M", "em", "एम", "ఎమ్"),
  row("N", "en", "एन", "ఎన్"),
  row("O", "oh", "ओ", "ఓ"),
  row("P", "pee", "पी", "పీ"),
  row("Q", "cue", "क्यू", "క్యూ"),
  row("R", "ar", "आर", "ఆర్"),
  row("S", "ess", "एस", "ఎస్"),
  row("T", "tee", "टी", "టీ"),
  row("U", "you", "यू", "యూ"),
  row("V", "vee", "वी", "వీ"),
  row("W", "double you", "डबल्यू", "డబ్ల్యూ"),
  row("X", "ex", "एक्स", "ఎక్స్"),
  row("Y", "why", "वाई", "వై"),
  row("Z", "zed", "ज़ेड", "జెడ్"),
];

export const GERMAN_LETTERS: readonly Letter[] = [
  row("A", "ah", "आ", "ఆ", "AH"),
  row("B", "beh", "बे", "బే", "BAY"),
  row("C", "tseh", "त्से", "త్సే", "TSAY"),
  row("D", "deh", "दे", "డే", "DAY"),
  row("E", "eh", "ए", "ఏ", "AY"),
  row("F", "eff", "एफ़", "ఎఫ్", "EFF"),
  row("G", "geh", "गे", "గే", "GAY"),
  row("H", "hah", "हा", "హా", "HAH"),
  row("I", "ih", "ई", "ఈ", "EE"),
  row("J", "yot", "योट", "యోట్", "YOT"),
  row("K", "kah", "का", "కా", "KAH"),
  row("L", "ell", "एल", "ఎల్", "ELL"),
  row("M", "emm", "एम", "ఎమ్", "EMM"),
  row("N", "enn", "एन", "ఎన్", "ENN"),
  row("O", "oh", "ओ", "ఓ", "OH"),
  row("P", "peh", "पे", "పే", "PAY"),
  row("Q", "kuh", "कू", "కూ", "KOO"),
  row("R", "err", "एर", "ఎర్", "AIR"),
  row("S", "ess", "एस", "ఎస్", "ESS"),
  row("T", "teh", "टे", "టే", "TAY"),
  row("U", "uh", "ऊ", "ఊ", "OO"),
  row("V", "fau", "फाउ", "ఫౌ", "FOW"),
  row("W", "veh", "वे", "వే", "VAY"),
  row("X", "iks", "इक्स", "ఇక్స్", "IKS"),
  row("Y", "üpsilon", "यूप्सिलोन", "ఉప్సిలాన్", "UP-see-lon"),
  row("Z", "tset", "त्सेट", "త్సెట్", "TSET"),
  {
    letter: "Ä",
    speak: "äh",
    hints: { hi: "ऐ", te: "ఏ", en: "EH (long, as in 'bed')" },
  },
  {
    letter: "Ö",
    speak: "öh",
    hints: { hi: "ओ़", te: "ఓ", en: "ER (round your lips)" },
    notes: {
      hi: "ए बोलते हुए होंठ ओ की तरह गोल कीजिए।",
      te: "ఏ అంటూ పెదవులను ఓ లాగా గుండ్రంగా చేయండి.",
      en: "Say AY while rounding your lips as for OH.",
    },
  },
  {
    letter: "Ü",
    speak: "üh",
    hints: { hi: "यू़", te: "యూ", en: "EW (round your lips)" },
    notes: {
      hi: "ई बोलते हुए होंठ ऊ की तरह गोल कीजिए।",
      te: "ఈ అంటూ పెదవులను ఊ లాగా గుండ్రంగా చేయండి.",
      en: "Say EE while rounding your lips as for OO.",
    },
  },
  row("ß", "ess tset", "एस-त्सेट", "ఎస్-త్సెట్", "ESS-tset"),
];

export function lettersFor(target: "en" | "de"): readonly Letter[] {
  return target === "de" ? GERMAN_LETTERS : ENGLISH_LETTERS;
}
