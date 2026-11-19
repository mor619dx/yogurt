import { ipcMain } from 'electron'
import { loadSettings, updateSettings } from '../settings'
import { openSecret, sealSecret, secretsEncrypted } from '../secrets'
import { createOpenRouter, problemOf, type OpenRouterError } from './client'
import { createRemoteLlm } from './llm'
import type { Llm } from '../notes/enhance'
import type { CloudProblem, OpenRouterState } from '../../shared/openRouter'

/** a model id as OpenRouter writes them ("anthropic/claude-sonnet-5.5", "deepgram/nova-3", "openai/gpt-5:online") */
const MODEL_ID = /^[\w.\-]+\/[\w.\-:@]+$/
/** a key as pasted: printable, no spaces, not absurdly long */
const KEY = /^[\x21-\x7e]{8,300}$/

/**
 * Settings → Cloud AI (OpenRouter): the key (sealed; never sent back to the window, only its last characters), and the
 * two switches with their models. Off by default: nothing is sent to OpenRouter until a key is saved and a switch is on.
 */
export function hookOpenRouter(d: { file: string; fetchFn?: typeof fetch; base?: string
  /** summaries and answers moved between this computer and OpenRouter (waiting jobs can start) */
  chatChanged(): void
  /** something sent to OpenRouter failed in a way the person can fix (their key, their credits) */
  problem(kind: CloudProblem): void }) {
  const key = (): string | undefined => {
    const sealed = loadSettings(d.file).openRouterKey
    if (!sealed) return undefined
    try { return openSecret(sealed) } catch (e) { console.warn('the OpenRouter key could not be opened', e); return undefined }
  }
  const client = createOpenRouter({ key, fetchFn: d.fetchFn, base: d.base })
  const s = () => loadSettings(d.file)
  const chatModel = () => s().openRouterChatModel?.trim() ?? ''
  const sttModel = () => s().openRouterSttModel?.trim() ?? ''
  const chatOn = () => { const v = s(); return !!v.openRouterChat && !!v.openRouterKey && MODEL_ID.test(v.openRouterChatModel ?? '') }
  const speakersOn = () => { const v = s(); return !!v.openRouterSpeakers && !!v.openRouterKey && MODEL_ID.test(v.openRouterSttModel ?? '') }
  /** the advanced provider options, when set and valid */
  const sttOptions = (): Record<string, unknown> | undefined => {
    const raw = s().openRouterSttOptions?.trim()
    if (!raw) return undefined
    try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined } catch { return undefined }
  }
  const told = new Map<CloudProblem, number>()
  /** one notice per kind of problem a minute: a meeting's notes make several calls */
  const tell = (e: unknown) => {
    const kind = problemOf(e)
    if (!kind) return
    const at = told.get(kind) ?? 0
    if (Date.now() - at < 60_000) return
    told.set(kind, Date.now())
    d.problem(kind)
  }
  const remote = createRemoteLlm({ client, model: chatModel })
  /** the remote model as the notes, chat and Ask use it: what fails is told once, and still fails the job */
  const llm = async (signal?: AbortSignal): Promise<Llm> => {
    const m = await remote.llm(signal).catch((e) => { tell(e); throw e })
    return { ...m, chat: (prompt, onToken, o) => m.chat(prompt, onToken, o).catch((e) => { if (!signal?.aborted) tell(e); throw e }) }
  }

  const state = (): OpenRouterState => {
    const v = s(), k = key()
    return { keyHint: k ? k.slice(-4) : null, encrypted: secretsEncrypted(), chat: !!v.openRouterChat, chatModel: v.openRouterChatModel ?? '',
      speakers: !!v.openRouterSpeakers, sttModel: v.openRouterSttModel ?? '', sttOptions: v.openRouterSttOptions ?? '' }
  }
  ipcMain.handle('openrouter:state', () => state())
  // checked with OpenRouter before it is kept: a key that doesn't work is never saved
  ipcMain.handle('openrouter:set-key', async (_e, v: unknown): Promise<{ state: OpenRouterState } | { error: CloudProblem }> => {
    if (v === '') { const was = chatOn(); updateSettings(d.file, { openRouterKey: undefined }); if (was) d.chatChanged(); return { state: state() } }
    if (typeof v !== 'string' || !KEY.test(v.trim())) return { error: 'auth' }
    try { await client.checkKey(v.trim()) } catch (e) { return { error: problemOf(e) ?? 'network' } }
    const was = chatOn()
    updateSettings(d.file, { openRouterKey: sealSecret(v.trim()) })
    if (chatOn() !== was) d.chatChanged()
    return { state: state() }
  })
  ipcMain.handle('openrouter:set', (_e, patch: unknown): { state: OpenRouterState } | { error: 'model' | 'json' } => {
    if (!patch || typeof patch !== 'object') return { error: 'json' }
    const p = patch as Record<string, unknown>
    const next: Parameters<typeof updateSettings>[1] = {}
    if (typeof p.chat === 'boolean') next.openRouterChat = p.chat || undefined
    if (typeof p.speakers === 'boolean') next.openRouterSpeakers = p.speakers || undefined
    for (const [k, to] of [['chatModel', 'openRouterChatModel'], ['sttModel', 'openRouterSttModel']] as const) {
      if (p[k] === undefined) continue
      const m = typeof p[k] === 'string' ? p[k].trim() : null
      if (m === null || (m && (m.length > 200 || !MODEL_ID.test(m)))) return { error: 'model' }
      next[to] = m || undefined
    }
    if (p.sttOptions !== undefined) {
      const raw = typeof p.sttOptions === 'string' ? p.sttOptions.trim() : null
      if (raw === null || raw.length > 4000) return { error: 'json' }
      if (raw) { try { const v = JSON.parse(raw); if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'json' } } catch { return { error: 'json' } } }
      next.openRouterSttOptions = raw || undefined
    }
    const was = chatOn()
    updateSettings(d.file, next)
    if (chatOn() !== was || (was && next.openRouterChatModel !== undefined)) d.chatChanged()
    return { state: state() }
  })
  ipcMain.handle('openrouter:models', async (_e, kind: unknown) => {
    if (kind !== 'chat' && kind !== 'transcription') return []
    try { return (await client.models(kind)).map((m) => ({ id: m.id, name: m.name })) } catch (e) { return { error: problemOf(e) ?? 'network' } }
  })

  return { client, chatOn, speakersOn, chatModel, sttModel, sttOptions, remote: { on: chatOn, llm }, tell }
}
export type OpenRouterHook = ReturnType<typeof hookOpenRouter>
export type { OpenRouterError }
