import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
  // no keychain, as on Linux without a secret service: the key is scrambled only
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
}))
import { hookOpenRouter } from '../src/main/openrouter/ipc'
import { FAKE_KEY, fakeOpenRouterFetch } from '../src/main/openrouter/fake'
import { loadSettings } from '../src/main/settings'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); handlers.clear() })

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-openrouter-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  const chatChanged = vi.fn(), problem = vi.fn()
  const hook = hookOpenRouter({ file, fetchFn: fakeOpenRouterFetch(), chatChanged, problem })
  const call = (name: string, ...args: unknown[]) => handlers.get(name)!(null, ...args)
  return { file, hook, call, chatChanged, problem }
}

it('checks a key with OpenRouter before keeping it, keeps it sealed, and never gives it back to the window', async () => {
  const { file, call, hook } = rig()
  expect(await call('openrouter:set-key', 'sk-or-wrong-1234')).toEqual({ error: 'auth' })
  expect(loadSettings(file).openRouterKey).toBeUndefined()
  const r = await call('openrouter:set-key', ` ${FAKE_KEY} `)
  expect(r.state).toMatchObject({ keyHint: FAKE_KEY.slice(-4), encrypted: false, chat: false, speakers: false })
  expect(JSON.stringify(r)).not.toContain(FAKE_KEY)
  expect(JSON.stringify(call('openrouter:state'))).not.toContain(FAKE_KEY)
  expect(readFileSync(file, 'utf8')).not.toContain(FAKE_KEY)
  expect(loadSettings(file).openRouterKey).toMatch(/^b:/)
  // nothing goes to OpenRouter until a switch is on and has a model
  expect(hook.chatOn()).toBe(false)
  expect(hook.speakersOn()).toBe(false)
  expect((await call('openrouter:set-key', '')).state.keyHint).toBeNull()
  expect(loadSettings(file).openRouterKey).toBeUndefined()
})

it('turns summaries over to OpenRouter only with a key, the switch and a model, and says when that changes', async () => {
  const { call, hook, chatChanged } = rig()
  await call('openrouter:set-key', FAKE_KEY)
  expect(call('openrouter:set', { chat: true }).state.chat).toBe(true)
  expect(hook.chatOn()).toBe(false)
  expect(call('openrouter:set', { chatModel: 'not a model' })).toEqual({ error: 'model' })
  call('openrouter:set', { chatModel: 'anthropic/claude-sonnet-5.5' })
  expect(hook.chatOn()).toBe(true)
  expect(chatChanged).toHaveBeenCalled()
  const llm = await hook.remote.llm()
  let said = ''
  await llm.chat('What was decided?\n<question>\nWhat was decided?\n</question>', (t) => { said += t })
  expect(said).toContain('Tuesday')
  expect(llm.contextSize).toBeGreaterThan(32_000)
})

it('keeps speech settings valid: a model ID, and provider options as a JSON object', async () => {
  const { call, hook } = rig()
  await call('openrouter:set-key', FAKE_KEY)
  call('openrouter:set', { speakers: true, sttModel: 'deepgram/nova-3' })
  expect(hook.speakersOn()).toBe(true)
  for (const bad of ['{', '[1]', '"x"', 'null']) expect(call('openrouter:set', { sttOptions: bad })).toEqual({ error: 'json' })
  call('openrouter:set', { sttOptions: '{"deepgram": {"diarize": true, "smart_format": true}}' })
  expect(hook.sttOptions()).toEqual({ deepgram: { diarize: true, smart_format: true } })
  call('openrouter:set', { sttOptions: '' })
  expect(hook.sttOptions()).toBeUndefined()
  expect(await call('openrouter:models', 'transcription')).toContainEqual({ id: 'deepgram/nova-3', name: 'Deepgram: Nova 3' })
})

it('tells the window once when OpenRouter refuses, and still fails the job', async () => {
  const { call, hook, problem } = rig()
  await call('openrouter:set-key', FAKE_KEY)
  call('openrouter:set', { chat: true, chatModel: 'openai/gpt-5.5' })
  process.env.YOGURT_FAKE_OPENROUTER_FAIL = '402'
  try {
    const llm = await hook.remote.llm()
    await expect(llm.chat('hi', () => {})).rejects.toMatchObject({ kind: 'credits' })
    await expect(llm.chat('hi', () => {})).rejects.toMatchObject({ kind: 'credits' })
    expect(problem).toHaveBeenCalledExactlyOnceWith('credits')
  } finally { delete process.env.YOGURT_FAKE_OPENROUTER_FAIL }
})
