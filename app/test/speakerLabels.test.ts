import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStore, type Store } from '../src/main/store'
import { createSavedTranscriptions } from '../src/main/savedTranscription'
import { createOpenRouter } from '../src/main/openrouter/client'
import { createCloudTranscriber, diarizeOptions } from '../src/main/openrouter/cloudTranscribe'

const line = (id: string, start: number, end: number, text: string, track: 'me' | 'them' = 'them', speaker: string | null = null) => ({ meetingId: id, track, startMs: start, endMs: end, text, speaker })

describe('speaker labels after a meeting (refine)', () => {
  let store: Store
  const transcribe = vi.fn(), summarize = vi.fn(), changed = vi.fn(), refineFailed = vi.fn()
  let jobs: ReturnType<typeof createSavedTranscriptions>
  const note = () => store.createMeeting({ title: 'Planning', startedAt: 100, endedAt: 200, state: 'stopped', attendees: [], eventId: null, app: null })
  beforeEach(() => {
    store = openStore(':memory:'); vi.resetAllMocks()
    jobs = createSavedTranscriptions({ store, ready: () => true, recording: () => false, tracks: async () => ({ them: (async function* () { yield new Float32Array(1600) })() }), transcribe, summarize, changed, refineFailed })
  })
  afterEach(async () => { jobs.shutdown(); await vi.waitFor(() => expect(store.meetings({ limit: 20 }).some((m) => jobs.owns(m.id))).toBe(false)); store.close() })

  it('replaces the transcript with the labelled one, then writes the summary', async () => {
    const id = note().id; store.addSegments([line(id, 0, 900, 'old words')])
    transcribe.mockImplementationOnce(async (_id, _t, o) => { o.save([line(id, 0, 900, 'new words', 'them', 'Speaker 1')]); return true })
    await jobs.start(id, true, { refine: true })
    await vi.waitFor(() => expect(store.meeting(id)?.transcriptionState).toBe('done'))
    expect(store.segments(id).map((s) => [s.text, s.speaker])).toEqual([['new words', 'Speaker 1']])
    expect(summarize).toHaveBeenCalledExactlyOnceWith(id)
    expect(refineFailed).not.toHaveBeenCalled()
  })
  it('keeps the transcript from this computer when OpenRouter fails, says so, and still writes the summary', async () => {
    const id = note().id; store.addSegments([line(id, 0, 900, 'old words')])
    const error = new Error('402')
    transcribe.mockRejectedValueOnce(error)
    await jobs.start(id, true, { refine: true })
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledExactlyOnceWith(id))
    expect(refineFailed).toHaveBeenCalledWith(id, error)
    expect(store.segments(id).map((s) => s.text)).toEqual(['old words'])
    expect(store.meeting(id)).toMatchObject({ transcriptionState: 'done' })
    expect(store.meeting(id)?.transcriptionAgain).toBeFalsy()
  })
  it('stopped by the person: the old transcript stays and the summary is written', async () => {
    const id = note().id; store.addSegments([line(id, 0, 900, 'old words')])
    transcribe.mockImplementationOnce((_id, _t, o) => new Promise((resolve) => o.signal.addEventListener('abort', () => resolve(false), { once: true })))
    await jobs.start(id, true, { refine: true })
    await vi.waitFor(() => expect(jobs.owns(id)).toBe(true))
    jobs.stop(id)
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledExactlyOnceWith(id))
    expect(store.segments(id).map((s) => s.text)).toEqual(['old words'])
  })
  it('a plain Transcribe again that fails is left to retry, as before', async () => {
    const id = note().id; store.addSegments([line(id, 0, 900, 'old words')])
    transcribe.mockRejectedValueOnce(new Error('boom'))
    await jobs.start(id, true)
    await vi.waitFor(() => expect(store.meeting(id)?.transcriptionState).toBe('error'))
    expect(summarize).not.toHaveBeenCalled(); expect(refineFailed).not.toHaveBeenCalled()
  })
})

describe('the store', () => {
  it("stamps a new meeting with the default spoken language, and keeps each meeting's own", () => {
    const store = openStore(':memory:')
    const a = store.createMeeting({ title: 'A', startedAt: 1, endedAt: null, state: 'stopped', attendees: [], eventId: null, app: null })
    expect(a.spoken).toBeUndefined()
    store.newSpoken = () => 'he'
    const b = store.createMeeting({ title: 'B', startedAt: 2, endedAt: null, state: 'stopped', attendees: [], eventId: null, app: null })
    expect(b.spoken).toBe('he')
    store.updateMeeting(b.id, { spoken: 'es' })
    expect(store.meeting(b.id)?.spoken).toBe('es')
    store.close()
  })
  it('renames one voice on every line of it, keeping its colour', () => {
    const store = openStore(':memory:')
    const m = store.createMeeting({ title: 'A', startedAt: 1, endedAt: null, state: 'stopped', attendees: [], eventId: null, app: null })
    store.addSegments([line(m.id, 0, 1000, 'one', 'them', 'Speaker 1'), line(m.id, 1000, 2000, 'two', 'them', 'Speaker 2'), line(m.id, 2000, 3000, 'three', 'them', 'Speaker 1'), line(m.id, 3000, 4000, 'mine', 'me', 'me')])
    const before = store.speakerOrder(m.id)
    expect(store.renameSpeaker(m.id, 'Speaker 1', 'Dana')).toBe(2)
    expect(store.segments(m.id).map((s) => s.speaker)).toEqual(['Dana', 'Speaker 2', 'Dana', 'me'])
    expect(store.speakerOrder(m.id)).toEqual(before.map((s) => (s === 'Speaker 1' ? 'Dana' : s)))
    // Them (no name) named too; the mic's lines never
    store.addSegments([line(m.id, 5000, 6000, 'who', 'them', null)])
    expect(store.renameSpeaker(m.id, null, 'Alex')).toBe(1)
    expect(store.renameSpeaker(m.id, 'me', 'Alex')).toBe(0)
    store.close()
  })
})

describe('the cloud transcriber', () => {
  /** an OpenRouter that hears scripted lines per request: the mic plain, the other side with voices */
  function rig(replies: Array<(body: Record<string, unknown>) => unknown>, tags = ['deepgram']) {
    const bodies: Array<Record<string, unknown>> = []
    let next = 0
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/endpoints')) return new Response(JSON.stringify({ data: { endpoints: tags.map((tag) => ({ tag })) } }))
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      return new Response(JSON.stringify((replies[next++] ?? (() => ({ segments: [] })))(body)))
    }) as typeof fetch
    const client = createOpenRouter({ key: () => 'sk-or-v1-test', fetchFn })
    return { bodies, client }
  }
  const audio = (seconds: number, loud = 0.2) => (async function* () {
    const s = new Float32Array(16000 * seconds)
    for (let i = 0; i < s.length; i++) s[i] = Math.sin(i / 7) * loud
    yield s
  })()

  it("labels the other side's voices, keeps names the call app showed, hides the mic's echo, and tells the language", async () => {
    const { bodies, client } = rig([
      (b) => b.provider
        ? { language: 'he', segments: [{ start: 0, end: 2, text: 'שלום לכולם', speaker: 0 }, { start: 2.5, end: 4, text: 'מה שלומך היום חבר', speaker: 1 }, { start: 5, end: 7, text: 'טוב תודה רבה', speaker: 0 }] }
        : { language: 'he', segments: [{ start: 2.6, end: 4, text: 'מה שלומך היום חבר' }, { start: 8, end: 9, text: 'אני כאן' }] },
      (b) => b.provider
        ? { language: 'he', segments: [{ start: 0, end: 2, text: 'שלום לכולם', speaker: 0 }, { start: 2.5, end: 4, text: 'מה שלומך היום חבר', speaker: 1 }, { start: 5, end: 7, text: 'טוב תודה רבה', speaker: 0 }] }
        : { language: 'he', segments: [{ start: 2.6, end: 4, text: 'מה שלומך היום חבר' }, { start: 8, end: 9, text: 'אני כאן' }] },
    ])
    const saved: unknown[] = []
    const old = [{ track: 'them' as const, startMs: 0, endMs: 2000, speaker: 'Dana', hidden: false }, { track: 'them' as const, startMs: 5000, endMs: 7000, speaker: 'Dana', hidden: false },
      { track: 'me' as const, startMs: 2600, endMs: 4000, speaker: 'me', hidden: true }]
    const languages: string[] = []
    const run = createCloudTranscriber({ client, model: () => 'deepgram/nova-3', options: () => undefined, spoken: () => 'he', previous: () => old,
      label: (n) => `Speaker ${n}`, onLanguage: (_id, name) => languages.push(name) })
    expect(await run('m1', { me: audio(10), them: audio(10) }, { save: (s) => saved.push(...s) })).toBe(true)
    const segs = saved as Array<{ track: string; text: string; speaker: string; hidden?: boolean; startMs: number }>
    expect(segs.filter((s) => s.track === 'them').map((s) => s.speaker)).toEqual(['Dana', 'Speaker 1', 'Dana'])
    expect(segs.filter((s) => s.track === 'me').map((s) => [s.text, !!s.hidden])).toEqual([['מה שלומך היום חבר', true], ['אני כאן', false]])
    expect(segs.map((s) => s.startMs)).toEqual([...segs.map((s) => s.startMs)].sort((a, b) => a - b))
    // the language picked goes as its code; only the other side asks for voices, the way its provider turns them on
    expect(bodies.every((b) => b.language === 'he' && b.response_format === 'verbose_json')).toBe(true)
    expect(bodies.filter((b) => b.provider).map((b) => b.provider)).toEqual([{ options: { deepgram: { diarize: true } } }])
    expect(languages).toEqual(['hebrew'])
  })
  it('follows the same voice from one part to the next, and skips parts with nothing in them', async () => {
    const { bodies, client } = rig([
      // part 1: 0-8 s; part 2 starts 2 s before its cut and numbers the voices the other way round
      () => ({ segments: [{ start: 0, end: 3, text: 'first voice talks', speaker: 0 }, { start: 3.2, end: 7.6, text: 'second voice answers here', speaker: 1 }] }),
      () => ({ segments: [{ start: 0, end: 2, text: 'second voice answers here', speaker: 'B' }, { start: 3, end: 5, text: 'first voice again', speaker: 'A' }] }),
    ])
    const saved: Array<{ text: string; speaker: string | null }> = []
    const run = createCloudTranscriber({ client, model: () => 'deepgram/nova-3', options: () => ({ custom: { x: 1 } }), spoken: () => 'auto', previous: () => [], label: (n) => `Speaker ${n}`, chunkMs: 8000, overlapMs: 2000, searchMs: 500 })
    const them = (async function* () { const s = new Float32Array(16000 * 14); for (let i = 0; i < s.length; i++) s[i] = Math.sin(i / 5) * 0.3; yield s })()
    const me = (async function* () { yield new Float32Array(16000 * 14) })()
    await run('m2', { me, them }, { save: (s) => saved.push(...s) })
    // silent mic: never sent; Auto-detect: no language; the advanced options go as they are
    expect(bodies.length).toBeGreaterThanOrEqual(2)
    expect(bodies.every((b) => b.provider)).toBe(true)
    expect(bodies.every((b) => !('language' in b))).toBe(true)
    expect(bodies[0].provider).toEqual({ options: { custom: { x: 1 } } })
    const byText = Object.fromEntries(saved.map((s) => [s.text, s.speaker]))
    expect(byText['first voice again']).toBe(byText['first voice talks'])
    expect(byText['second voice answers here']).not.toBe(byText['first voice talks'])
  })
  it('asks again when OpenRouter is busy, and gives up at once on a key it refuses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 })
    try {
      let calls = 0
      const fetchFn = (async (url: string) => {
        if (String(url).endsWith('/endpoints')) return new Response(JSON.stringify({ data: { endpoints: [] } }))
        calls++
        return calls === 1 ? new Response(JSON.stringify({ error: { code: 429, message: 'slow down' } }), { status: 429 }) : new Response(JSON.stringify({ segments: [{ start: 0, end: 1, text: 'ok' }] }))
      }) as typeof fetch
      const run = createCloudTranscriber({ client: createOpenRouter({ key: () => 'k', fetchFn }), model: () => 'x/y', options: () => undefined, spoken: () => 'en', previous: () => [], label: String })
      const saved: unknown[] = []
      const done = run('m3', { them: audio(2) }, { save: (s) => saved.push(...s) })
      await vi.advanceTimersByTimeAsync(3000)
      expect(await done).toBe(true)
      expect(calls).toBe(2); expect(saved).toHaveLength(1)
      const refused = (async () => new Response(JSON.stringify({ error: { code: 401, message: 'no' } }), { status: 401 })) as unknown as typeof fetch
      const bad = createCloudTranscriber({ client: createOpenRouter({ key: () => 'k', fetchFn: refused }), model: () => 'x/y', options: () => ({}), spoken: () => 'en', previous: () => [], label: String })
      await expect(bad('m4', { them: audio(2) }, {})).rejects.toMatchObject({ kind: 'auth' })
    } finally { vi.useRealTimers() }
  })
  it("turns on each provider's own speaker labels by its endpoint's tag", () => {
    expect(diarizeOptions(['deepgram'])).toEqual({ deepgram: { diarize: true } })
    expect(diarizeOptions(['mistral/zdr'])).toEqual({ 'mistral/zdr': { diarize: true } })
    expect(diarizeOptions(['assemblyai'])).toEqual({ assemblyai: { speaker_labels: true } })
    expect(diarizeOptions(['azure'])).toEqual({ azure: { diarization: { enabled: true } } })
    expect(diarizeOptions(['openai', 'groq'])).toBeUndefined()
  })
})
