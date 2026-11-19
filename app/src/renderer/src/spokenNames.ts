import { AUTO, SPOKEN_CODES, isoCode, whisperName, type Spoken } from '../../shared/spoken'
import { t } from '../../shared/i18n'

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const names = new Map<string, Intl.DisplayNames | null>()
/** one Intl.DisplayNames per locale (null where the system has none for it) */
function displayNames(locale: string): Intl.DisplayNames | null {
  if (!names.has(locale)) { try { names.set(locale, new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' })) } catch { names.set(locale, null) } }
  return names.get(locale)!
}

/** A spoken language's name in the interface's language ("Hebrew", "עברית"); Auto-detect for 'auto'. inSentence: as the
 * language writes it mid-sentence ("espagnol" in French), not capitalised for a list */
export function spokenLabel(code: Spoken, locale: string, inSentence = false): string {
  if (code === AUTO) return t('Auto-detect')
  const name = displayNames(locale)?.of(isoCode(code))
  return name ? (inSentence ? name : cap(name)) : cap(whisperName(code))
}
/** the language's own name for itself ("עברית" for Hebrew), shown beside it where it differs */
export function nativeLabel(code: Spoken): string {
  if (code === AUTO) return ''
  return cap(displayNames(isoCode(code))?.of(isoCode(code)) ?? '')
}

/** Every language whisper hears, by name in the interface's language; Auto-detect last */
export function sortedSpoken(locale: string): Spoken[] {
  const collator = new Intl.Collator(locale)
  return [...[...SPOKEN_CODES].sort((a, b) => collator.compare(spokenLabel(a, locale), spokenLabel(b, locale))), AUTO]
}

/** Whether a language matches what was typed: its name here, its own name, its English name or its code */
export function spokenMatches(code: Spoken, query: string, locale: string): boolean {
  const q = query.trim().toLocaleLowerCase(locale)
  if (!q) return true
  return [spokenLabel(code, locale), nativeLabel(code), code === AUTO ? 'auto' : whisperName(code), code].some((s) => s.toLocaleLowerCase(locale).includes(q))
}
