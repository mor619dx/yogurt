import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
/** the one key the fake OpenRouter takes (main/openrouter/fake.ts) */
const KEY = 'sk-or-test-0000'

async function launch(env: Record<string, string> = {}, userData = mkdtempSync(join(tmpdir(), 'yogurt-openrouter-'))) {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const sent = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __fake__: { prompts(): { openrouter: Array<{ path: string; model?: string; language?: string; provider?: unknown; speakers?: boolean }> } } }).__fake__.prompts().openrouter)

/** Settings → Cloud AI: the key, then what is turned on */
async function cloud(page: Page, o: { chat?: string; speakers?: string }) {
  await page.getByTestId('settings-open').click()
  const section = page.getByTestId('openrouter')
  await section.scrollIntoViewIfNeeded()
  await page.getByTestId('openrouter-key').fill('sk-or-not-a-real-key')
  await page.getByTestId('openrouter-key-save').click()
  await expect(page.getByTestId('openrouter-key-error')).toContainText("That key didn't work")
  await page.getByTestId('openrouter-key').fill(KEY)
  await page.getByTestId('openrouter-key-save').click()
  await expect(page.getByTestId('openrouter-key-hint')).toHaveText('Key ending in 0000')
  if (o.chat) {
    await page.getByTestId('openrouter-chat-toggle').click()
    await expect(page.getByTestId('openrouter-chat-toggle')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('openrouter-chat-model').fill(o.chat)
    await page.getByTestId('openrouter-chat-model').press('Enter')
  }
  if (o.speakers) {
    await page.getByTestId('openrouter-speakers-toggle').click()
    await expect(page.getByTestId('openrouter-speakers-toggle')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('openrouter-stt-model').fill(o.speakers)
    await page.getByTestId('openrouter-stt-model').press('Enter')
  }
  await expect.poll(() => page.evaluate(() => window.yogurt.openRouter.state())).toMatchObject({ chat: !!o.chat, chatModel: o.chat ?? '', speakers: !!o.speakers, sttModel: o.speakers ?? '' })
}

/** the transcript in view (it may already be: the toggle would close it) */
async function showTranscript(page: Page) {
  const list = page.getByTestId('transcript')
  if (!await list.isVisible()) await page.getByTestId('note-transcript-toggle').click()
  await expect(list).toBeVisible()
}

/** a meeting recorded through to the end of the fixtures, then stopped */
async function record(page: Page) {
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  await showTranscript(page)
  await expect(page.getByTestId('transcript-bubble').filter({ hasText: 'She will send a draft' })).toBeVisible({ timeout: 40_000 })
  await page.getByTestId('note-stop').click()
}

// @everywhere: OpenRouter is faked (main/openrouter/fake.ts), so these run on the Windows and Linux CI too
test('@everywhere Cloud AI: the key is checked and kept sealed; summaries come from OpenRouter; the other side gets speaker labels, which can be renamed', async () => {
  test.setTimeout(150_000)
  const { app, page, userData } = await launch()
  try {
    await cloud(page, { chat: 'anthropic/claude-sonnet-5.5', speakers: 'deepgram/nova-3' })
    const file = readFileSync(join(userData, 'settings.json'), 'utf8')
    expect(file).not.toContain(KEY)
    expect(JSON.stringify(await page.evaluate(() => window.yogurt.openRouter.state()))).not.toContain(KEY)

    await page.getByTestId('nav-home').click()
    await record(page)
    // the audio went to the speech model: the mic plain, the other side with speaker labels turned on its provider's way
    await expect.poll(async () => (await sent(app)).filter((r) => r.path === '/audio/transcriptions').length, { timeout: 30_000 }).toBe(2)
    const stt = (await sent(app)).filter((r) => r.path === '/audio/transcriptions')
    expect(stt.every((r) => r.model === 'deepgram/nova-3' && r.language === 'en')).toBe(true)
    expect(stt.find((r) => r.speakers)?.provider).toEqual({ options: { deepgram: { diarize: true } } })
    // the transcript is replaced: the voices the call app named keep their names, one it never named is "Speaker 1"
    const who = page.getByTestId('transcript-who')
    await expect(page.getByTestId('transcript-bubble').filter({ hasText: 'Can everyone hear me?' })).toHaveCount(1, { timeout: 30_000 })
    await expect(who.filter({ hasText: /^Speaker 1$/ })).toHaveCount(1)
    for (const name of ['Ann Lee', 'Bo Park']) await expect(who.filter({ hasText: name })).toHaveCount(1)
    // then the summary, written by the OpenRouter model
    await expect.poll(async () => (await sent(app)).some((r) => r.path === '/chat/completions' && r.model === 'anthropic/claude-sonnet-5.5'), { timeout: 30_000 }).toBe(true)
    await expect(page.getByTestId('note-state')).not.toHaveAttribute('data-state', 'recording')

    // a voice named by hand, on every line of it (the transcript open again: the summary took its place)
    await expect.poll(async () => (await sent(app)).filter((r) => r.path === '/chat/completions').length, { timeout: 30_000 }).toBeGreaterThan(1)
    await showTranscript(page)
    await who.filter({ hasText: 'Speaker 1' }).first().click()
    const input = page.getByTestId('speaker-rename-input')
    await expect(input).toBeFocused()
    await input.fill('Dana Levi')
    await input.press('Enter')
    await expect(who.filter({ hasText: 'Dana Levi' })).toHaveCount(1)
    await expect(who.filter({ hasText: 'Speaker 1' })).toHaveCount(0)
    // Escape keeps the old name
    await who.filter({ hasText: 'Bo Park' }).first().click()
    await page.getByTestId('speaker-rename-input').fill('Nobody')
    await page.getByTestId('speaker-rename-input').press('Escape')
    await expect(who.filter({ hasText: 'Bo Park' })).toHaveCount(1)
    await expect(who.filter({ hasText: 'Nobody' })).toHaveCount(0)
  } finally { await app.close() }
})

test('@everywhere Cloud AI: when OpenRouter refuses, the transcript from this computer is kept, the person is told, and the summary is still written', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launch({ YOGURT_FAKE_OPENROUTER_FAIL: '402' })
  try {
    await cloud(page, { speakers: 'deepgram/nova-3' })
    await page.getByTestId('nav-home').click()
    await record(page)
    await expect(page.getByTestId('openrouter-problem').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Couldn't label speakers. The transcript from this computer is kept.")).toBeVisible()
    await expect(page.getByText('Your OpenRouter account is out of credits.')).toBeVisible()
    await expect(page.getByTestId('transcript-bubble').filter({ hasText: 'She will send a draft' })).toHaveCount(1)
    await expect(page.getByTestId('transcript-who').filter({ hasText: /^Speaker \d$/ })).toHaveCount(0)
    // the summary from this computer's model
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __fake__: { prompts(): { notes: string[] } } }).__fake__.prompts().notes.length), { timeout: 30_000 }).toBeGreaterThan(0)
  } finally { await app.close() }
})
