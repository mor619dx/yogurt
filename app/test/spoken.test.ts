import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SPOKEN_CODES, WHISPER_LANGUAGES, codeOfWhisperName, isSpoken, isoCode, spokenOf, whisperLanguage, whisperName } from '../src/shared/spoken'
import { loadSettings, spokenSetting, updateSettings } from '../src/main/settings'

describe('the spoken language', () => {
  it("is one of whisper's 99 languages (not Cantonese), or Auto-detect", () => {
    expect(WHISPER_LANGUAGES).toBe(99)
    expect(new Set(SPOKEN_CODES).size).toBe(99)
    expect(SPOKEN_CODES).not.toContain('yue')
    for (const c of ['en', 'he', 'es', 'ja', 'haw', 'jw', 'auto']) expect(isSpoken(c)).toBe(true)
    for (const c of ['multi', 'klingon', '', 'EN', 'he-IL', null, 1]) expect(isSpoken(c)).toBe(false)
  })
  it('is English unless another language (or Auto-detect) was picked; Multi-language from before is Auto-detect', () => {
    expect(spokenOf(undefined)).toBe('en')
    expect(spokenOf('en')).toBe('en')
    expect(spokenOf('he')).toBe('he')
    expect(spokenOf('auto')).toBe('auto')
    expect(spokenOf('multi')).toBe('auto')
    expect(spokenOf('klingon')).toBe('en')
    expect(spokenSetting({})).toBe('en')
    expect(spokenSetting({ spoken: 'multi' })).toBe('auto')
    expect(spokenSetting({ spoken: 'he' })).toBe('he')
  })
  it('English is the default, so only another language is written down', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'yogurt-spoken-')), 'settings.json')
    updateSettings(file, { spoken: 'he' })
    expect(loadSettings(file).spoken).toBe('he')
    updateSettings(file, { spoken: undefined })
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('spoken')
  })
  it('whisper is told the language picked, and left to detect for Auto-detect', () => {
    expect(whisperLanguage('en')).toBe('en')
    expect(whisperLanguage('he')).toBe('he')
    expect(whisperLanguage('auto')).toBeUndefined()
  })
  it("names languages as whisper-server does, both ways, and gives Intl's code for whisper's own", () => {
    expect(whisperName('he')).toBe('hebrew')
    expect(whisperName('ht')).toBe('haitian creole')
    expect(codeOfWhisperName('hebrew')).toBe('he')
    expect(codeOfWhisperName('Spanish')).toBe('es')
    expect(codeOfWhisperName('klingon')).toBeUndefined()
    expect(isoCode('jw')).toBe('jv')
    expect(isoCode('he')).toBe('he')
  })
})
