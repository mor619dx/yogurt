import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(userData = mkdtempSync(join(tmpdir(), 'yogurt-spoken-'))) {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const languages = async (app: ElectronApplication) => (await fake<{ languages: string[] }>(app, 'prompts')).languages
const saved = (userData: string) => { try { return JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).spoken } catch { return undefined } }

test("@everywhere each meeting's own spoken language: picked under the note while it records, told to whisper, never changing the default", async () => {
  const { app, page, userData } = await launch()
  try {
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('spoken-name')).toHaveText('English')
    // whisper is told English, nothing is detected
    await expect.poll(async () => (await languages(app)).length, { timeout: 30_000 }).toBeGreaterThan(0)
    expect(new Set(await languages(app))).toEqual(new Set(['en']))

    await page.getByTestId('spoken-chip').click()
    const menu = page.getByTestId('spoken-menu')
    await expect(menu).toBeVisible()
    // the search has focus; every language whisper hears is there, Auto-detect last
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)).toBe('spoken-search')
    await expect(menu.getByRole('menuitemradio')).toHaveCount(100)
    await expect(menu.getByRole('menuitemradio').last()).toHaveText(/Auto-detect/)
    await expect(page.getByTestId('spoken-option-en')).toHaveAttribute('aria-checked', 'true')
    // found by its name here, its own name, or its code
    await page.getByTestId('spoken-search').fill('עברית')
    await expect(menu.getByRole('menuitemradio')).toHaveCount(1)
    await page.getByTestId('spoken-search').fill('hebr')
    await expect(page.getByTestId('spoken-option-he')).toContainText('Hebrew')
    await page.getByTestId('spoken-search').fill('zzzz')
    await expect(page.getByTestId('spoken-none')).toBeVisible()
    await page.getByTestId('spoken-search').fill('hebrew')
    const told = (await languages(app)).length
    await page.getByTestId('spoken-search').press('Enter')
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId('spoken-name')).toHaveText('Hebrew')
    await expect.poll(async () => (await languages(app)).slice(told), { timeout: 30_000 }).toContain('he')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    // this meeting only: new meetings still start in English
    expect(saved(userData)).toBeUndefined()

    // Escape closes
    await page.getByTestId('spoken-chip').click()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // the finished note keeps its language, and offers to transcribe it again in another
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('spoken-name')).toHaveText('Hebrew')
    await page.getByTestId('spoken-chip').click()
    await page.getByTestId('spoken-search').fill('spanish')
    await page.getByTestId('spoken-option-es').click()
    await expect(page.getByTestId('spoken-name')).toHaveText('Spanish')
    const again = page.getByTestId('spoken-again')
    await expect(again).toContainText('Transcribe again in Spanish?')
    const before = (await languages(app)).length
    await page.getByTestId('spoken-again-run').click()
    await expect(again).toHaveCount(0)
    await expect.poll(async () => (await languages(app)).slice(before), { timeout: 30_000 }).toContain('es')
  } finally { await app.close() }
})

test('@everywhere Settings: the language new meetings start in; Auto-detect lets whisper hear it; Multi-language from before is Auto-detect', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-spoken-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ spoken: 'multi' }))
  let { app, page } = await launch(userData)
  try {
    await page.getByTestId('settings-open').click()
    const select = page.getByTestId('settings-spoken')
    await expect(select).toHaveValue('auto')
    await expect(select.locator('option')).toHaveCount(100)
    await select.selectOption('he')
    await expect.poll(() => saved(userData)).toBe('he')
    await select.selectOption('en')
    // English is the default, so it is not written down
    await expect.poll(() => saved(userData)).toBeUndefined()
    await select.selectOption('auto')
    await expect.poll(() => saved(userData)).toBe('auto')
  } finally { await app.close() }

  ;({ app, page } = await launch(userData))
  try {
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByTestId('spoken-name')).toHaveText('Auto-detect')
    await expect.poll(async () => (await languages(app)).length, { timeout: 30_000 }).toBeGreaterThan(0)
    expect(new Set(await languages(app))).toEqual(new Set(['auto']))
  } finally { await app.close() }
})
