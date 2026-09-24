/**
 * All UI text lives here. English is the source of truth: `Messages` is
 * derived from it, so any language that misses a key fails to compile.
 *
 * To add a language: add an entry to LANGUAGES, add a dictionary below, and
 * register it in DICTIONARIES. It then appears in the language picker.
 */

const en = {
  "brand.name": "SpeakUp",
  "brand.by": "by AdaptiveSkills",
  "brand.tagline": "Learn and speak what matters most.",

  "common.continue": "Continue",
  "common.back": "Back",
  "common.loading": "Loading…",

  "lang.title": "Choose your language",
  "lang.subtitle": "Everything after this appears in your language.",
  "lang.groupLabel": "Languages",

  "auth.tabSignUp": "Sign up",
  "auth.tabLogIn": "Log in",
  "auth.tabsLabel": "Sign up or log in",
  "auth.name": "Name",
  "auth.namePlaceholder": "Your name",
  "auth.email": "Email",
  "auth.emailPlaceholder": "name@example.com",
  "auth.password": "Password",
  "auth.passwordCreate": "Create a password",
  "auth.passwordEnter": "Enter your password",
  "auth.passwordHint": "At least 8 characters.",
  "auth.showPassword": "Show password",
  "auth.hidePassword": "Hide password",
  "auth.gender": "Gender",
  "auth.genderHint": "This helps us use the right words in your language.",
  "auth.genderFemale": "Female",
  "auth.genderMale": "Male",
  "auth.genderUnspecified": "Prefer not to say",
  "auth.createAccount": "Create account",
  "auth.creatingAccount": "Creating your account…",
  "auth.logIn": "Log in",
  "auth.loggingIn": "Logging you in…",
  "auth.or": "OR",
  "auth.google": "Continue with Google",
  "auth.comingSoon": "Coming soon",
  "auth.takesOneMinute": "Takes 1 minute.",
  "auth.retrySave": "Try again",

  "err.nameRequired": "Please enter your name.",
  "err.emailInvalid": "Please enter a valid email address.",
  "err.passwordShort": "Your password needs at least 8 characters.",
  "err.passwordRequired": "Please enter your password.",
  "err.genderRequired": "Please choose one option.",
  "err.invalidCredentials": "Wrong email or password. Please try again.",
  "err.emailTaken":
    "An account with this email already exists. Try logging in instead.",
  "err.generic": "Something went wrong. Please try again.",
  "err.saveProfile":
    "Your account is ready, but we could not save your settings. Please try again.",

  "intro.skip": "Skip",
  "intro.next": "Next",
  "intro.start": "Get started",
  "intro.carouselLabel": "Introduction",
  "intro.cardOf": "Card {n} of {total}",
  "intro.goToCard": "Go to card {n}",
  "intro.1.title": "Tell us what you need to speak for.",
  "intro.1.body": "Your goals help us build a personal plan.",
  "intro.1.chipWork": "Work",
  "intro.1.chipDaily": "Daily life",
  "intro.1.chipTravel": "Travel",
  "intro.2.title": "Speak a little. We find your level.",
  "intro.2.body": "A short speaking check shows what you can already say.",
  "intro.3.title": "Learn only what matters.",
  "intro.3.body": "Short daily lessons built around your goal and your time.",
  "intro.3.day": "Day {n}",

  "goal.greeting": "Hi, {name}",
  "goal.placeholderTitle": "What do you need to speak for?",
  "goal.placeholderBody": "This step is coming next.",
  "goal.logOut": "Log out",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

const hi: Messages = {
  "brand.name": "SpeakUp",
  "brand.by": "by AdaptiveSkills",
  "brand.tagline": "जो सच में ज़रूरी है, वही सीखें और बोलें।",

  "common.continue": "जारी रखें",
  "common.back": "वापस",
  "common.loading": "लोड हो रहा है…",

  "lang.title": "अपनी भाषा चुनें",
  "lang.subtitle": "इसके बाद सब कुछ आपकी भाषा में दिखेगा।",
  "lang.groupLabel": "भाषाएँ",

  "auth.tabSignUp": "साइन अप",
  "auth.tabLogIn": "लॉग इन",
  "auth.tabsLabel": "साइन अप या लॉग इन",
  "auth.name": "नाम",
  "auth.namePlaceholder": "आपका नाम",
  "auth.email": "ईमेल",
  "auth.emailPlaceholder": "name@example.com",
  "auth.password": "पासवर्ड",
  "auth.passwordCreate": "पासवर्ड बनाएँ",
  "auth.passwordEnter": "अपना पासवर्ड डालें",
  "auth.passwordHint": "कम से कम 8 अक्षर।",
  "auth.showPassword": "पासवर्ड दिखाएँ",
  "auth.hidePassword": "पासवर्ड छिपाएँ",
  "auth.gender": "लिंग",
  "auth.genderHint": "इससे हम आपकी भाषा में सही शब्द इस्तेमाल कर पाते हैं।",
  "auth.genderFemale": "महिला",
  "auth.genderMale": "पुरुष",
  "auth.genderUnspecified": "बताना नहीं चाहते",
  "auth.createAccount": "खाता बनाएँ",
  "auth.creatingAccount": "आपका खाता बन रहा है…",
  "auth.logIn": "लॉग इन करें",
  "auth.loggingIn": "लॉग इन हो रहा है…",
  "auth.or": "या",
  "auth.google": "Google से जारी रखें",
  "auth.comingSoon": "जल्द आ रहा है",
  "auth.takesOneMinute": "सिर्फ़ 1 मिनट लगता है।",
  "auth.retrySave": "फिर से कोशिश करें",

  "err.nameRequired": "कृपया अपना नाम लिखें।",
  "err.emailInvalid": "कृपया सही ईमेल पता लिखें।",
  "err.passwordShort": "आपके पासवर्ड में कम से कम 8 अक्षर होने चाहिए।",
  "err.passwordRequired": "कृपया अपना पासवर्ड लिखें।",
  "err.genderRequired": "कृपया एक विकल्प चुनें।",
  "err.invalidCredentials": "ईमेल या पासवर्ड ग़लत है। कृपया फिर से कोशिश करें।",
  "err.emailTaken":
    "इस ईमेल से खाता पहले से बना हुआ है। कृपया लॉग इन करें।",
  "err.generic": "कुछ गड़बड़ हो गई। कृपया फिर से कोशिश करें।",
  "err.saveProfile":
    "आपका खाता बन गया है, लेकिन आपकी सेटिंग सेव नहीं हो पाईं। कृपया फिर से कोशिश करें।",

  "intro.skip": "छोड़ें",
  "intro.next": "आगे",
  "intro.start": "शुरू करें",
  "intro.carouselLabel": "परिचय",
  "intro.cardOf": "कार्ड {n} / {total}",
  "intro.goToCard": "कार्ड {n} पर जाएँ",
  "intro.1.title": "बताइए, आपको बोलना किसलिए है।",
  "intro.1.body": "आपके लक्ष्य से हम आपके लिए एक निजी योजना बनाते हैं।",
  "intro.1.chipWork": "काम",
  "intro.1.chipDaily": "रोज़मर्रा की ज़िंदगी",
  "intro.1.chipTravel": "यात्रा",
  "intro.2.title": "थोड़ा बोलिए। हम आपका स्तर पता करेंगे।",
  "intro.2.body":
    "एक छोटी बोलने की जाँच से पता चलता है कि आप अभी क्या बोल सकते हैं।",
  "intro.3.title": "सिर्फ़ वही सीखें जो ज़रूरी है।",
  "intro.3.body":
    "आपके लक्ष्य और आपके समय के हिसाब से छोटे रोज़ के पाठ।",
  "intro.3.day": "दिन {n}",

  "goal.greeting": "नमस्ते, {name}",
  "goal.placeholderTitle": "आपको बोलना किसलिए है?",
  "goal.placeholderBody": "यह कदम अगला बनेगा।",
  "goal.logOut": "लॉग आउट",
};

export const LANGUAGES = [
  { code: "en", nativeName: "English" },
  { code: "hi", nativeName: "हिंदी" },
] as const;

export type LangCode = (typeof LANGUAGES)[number]["code"];

export const DEFAULT_LANG: LangCode = "en";

export const DICTIONARIES: Record<LangCode, Messages> = { en, hi };

export function isSupportedLang(code: string | null | undefined): code is LangCode {
  return LANGUAGES.some((l) => l.code === code);
}
