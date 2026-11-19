/**
 * The language people speak in a meeting, kept on each meeting and picked in its note's footer; Settings → Language
 * holds the one new meetings start with. A language tells whisper (and Apple's speech) what it is, so nothing is guessed;
 * Auto-detect leaves whisper to hear which it is. Not the interface's language, and not the one the notes are written in.
 */

/** whisper.cpp's languages (g_lang), as its code and the name whisper-server reports; Cantonese (large-v3 only) left out */
export const SPOKEN_LANGUAGES: ReadonlyArray<readonly [code: string, whisperName: string]> = [
  ['en', 'english'], ['zh', 'chinese'], ['de', 'german'], ['es', 'spanish'], ['ru', 'russian'], ['ko', 'korean'],
  ['fr', 'french'], ['ja', 'japanese'], ['pt', 'portuguese'], ['tr', 'turkish'], ['pl', 'polish'], ['ca', 'catalan'],
  ['nl', 'dutch'], ['ar', 'arabic'], ['sv', 'swedish'], ['it', 'italian'], ['id', 'indonesian'], ['hi', 'hindi'],
  ['fi', 'finnish'], ['vi', 'vietnamese'], ['he', 'hebrew'], ['uk', 'ukrainian'], ['el', 'greek'], ['ms', 'malay'],
  ['cs', 'czech'], ['ro', 'romanian'], ['da', 'danish'], ['hu', 'hungarian'], ['ta', 'tamil'], ['no', 'norwegian'],
  ['th', 'thai'], ['ur', 'urdu'], ['hr', 'croatian'], ['bg', 'bulgarian'], ['lt', 'lithuanian'], ['la', 'latin'],
  ['mi', 'maori'], ['ml', 'malayalam'], ['cy', 'welsh'], ['sk', 'slovak'], ['te', 'telugu'], ['fa', 'persian'],
  ['lv', 'latvian'], ['bn', 'bengali'], ['sr', 'serbian'], ['az', 'azerbaijani'], ['sl', 'slovenian'], ['kn', 'kannada'],
  ['et', 'estonian'], ['mk', 'macedonian'], ['br', 'breton'], ['eu', 'basque'], ['is', 'icelandic'], ['hy', 'armenian'],
  ['ne', 'nepali'], ['mn', 'mongolian'], ['bs', 'bosnian'], ['kk', 'kazakh'], ['sq', 'albanian'], ['sw', 'swahili'],
  ['gl', 'galician'], ['mr', 'marathi'], ['pa', 'punjabi'], ['si', 'sinhala'], ['km', 'khmer'], ['sn', 'shona'],
  ['yo', 'yoruba'], ['so', 'somali'], ['af', 'afrikaans'], ['oc', 'occitan'], ['ka', 'georgian'], ['be', 'belarusian'],
  ['tg', 'tajik'], ['sd', 'sindhi'], ['gu', 'gujarati'], ['am', 'amharic'], ['yi', 'yiddish'], ['lo', 'lao'],
  ['uz', 'uzbek'], ['fo', 'faroese'], ['ht', 'haitian creole'], ['ps', 'pashto'], ['tk', 'turkmen'], ['nn', 'nynorsk'],
  ['mt', 'maltese'], ['sa', 'sanskrit'], ['lb', 'luxembourgish'], ['my', 'myanmar'], ['bo', 'tibetan'], ['tl', 'tagalog'],
  ['mg', 'malagasy'], ['as', 'assamese'], ['tt', 'tatar'], ['haw', 'hawaiian'], ['ln', 'lingala'], ['ha', 'hausa'],
  ['ba', 'bashkir'], ['jw', 'javanese'], ['su', 'sundanese'],
]
/** a language code from SPOKEN_LANGUAGES, or 'auto': whisper hears which it is */
export type Spoken = string
export const AUTO: Spoken = 'auto'
export const SPOKEN_CODES: readonly string[] = SPOKEN_LANGUAGES.map(([code]) => code)
const NAMES = new Map(SPOKEN_LANGUAGES)
const CODES = new Map(SPOKEN_LANGUAGES.map(([code, name]) => [name, code]))
export const isSpoken = (v: unknown): v is Spoken => typeof v === 'string' && (v === AUTO || NAMES.has(v))
/** what was saved, as a language: Multi-language (before languages were picked one by one) is Auto-detect; English when unknown */
export const spokenOf = (v: unknown): Spoken => (v === 'multi' ? AUTO : isSpoken(v) ? v : 'en')
/** what whisper is told for each chunk: the language, or nothing (it detects, then keeps each track's language) */
export const whisperLanguage = (s: Spoken): string | undefined => (s === AUTO ? undefined : s)
/** "he" → "hebrew", as whisper-server names it; a code it doesn't know stays as it is */
export const whisperName = (code: string): string => NAMES.get(code) ?? code
/** "hebrew" → "he"; undefined for a name whisper doesn't have */
export const codeOfWhisperName = (name: string | null | undefined): string | undefined => (name ? CODES.get(name.toLowerCase()) : undefined)
/** the ISO 639 code, for Intl and for services that don't take whisper's own ("jw" is whisper's Javanese) */
export const isoCode = (code: string): string => (code === 'jw' ? 'jv' : code)
/** how many languages whisper can hear */
export const WHISPER_LANGUAGES = SPOKEN_LANGUAGES.length
