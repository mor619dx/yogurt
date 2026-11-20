import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStore, type Store } from '../src/main/store'
import { createSavedTranscriptions } from '../src/main/savedTranscription'
import { createOpenRouter } from '../src/main/openrouter/client'
import { createCloudTranscriber, diarizeOptions, heardLanguage } from '../src/main/openrouter/cloudTranscribe'

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
  /** voices as tones, each its own pitch (Hz) */
  const PITCH: Record<string, number> = { A: 220, B: 440, C: 880 }
  /** the other side of a meeting: who speaks when (s) */
  function voices(seconds: number, lines: Array<[voice: string, from: number, to: number]>): Float32Array {
    const s = new Float32Array(16000 * seconds)
    for (const [v, from, to] of lines) for (let i = Math.round(from * 16000); i < Math.round(to * 16000); i++) s[i] = Math.sin((2 * Math.PI * PITCH[v] * i) / 16000) * 0.3
    return s
  }
  /** a provider that listens: tells the tones apart by pitch, numbers them afresh in each request (the last heard first), a segment for each */
  function hear(body: Record<string, unknown>) {
    const b = Buffer.from((body.input_audio as { data: string }).data, 'base64')
    const pcm = new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length))
    const runs: Array<{ voice: string; start: number; end: number }> = []
    for (let f = 0; f + 1600 <= pcm.length; f += 1600) {
      // the pitch over the samples with sound in them (a frame can hold a voice's first or last moments)
      let loud = 0, crossings = 0
      for (let i = f + 1; i < f + 1600; i++) if (pcm[i] !== 0 && pcm[i - 1] !== 0) { loud++; if ((pcm[i - 1] < 0) !== (pcm[i] < 0)) crossings++ }
      if (loud < 800) continue
      const hz = (crossings * 16000) / loud / 2
      const voice = Object.entries(PITCH).sort((x, y) => Math.abs(x[1] - hz) - Math.abs(y[1] - hz))[0][0]
      const t = f / 16000, run = runs.at(-1)
      if (run && run.voice === voice && t - run.end < 0.35) run.end = t + 0.1
      else runs.push({ voice, start: t, end: t + 0.1 })
    }
    const order = [...new Set(runs.map((r) => r.voice))].reverse()
    return { segments: runs.map((r) => ({ start: r.start, end: r.end, text: r.voice, speaker: order.indexOf(r.voice) })) }
  }
  const once = (a: Float32Array) => (async function* () { yield a })()
  /** each voice heard, and who the app said it was */
  const whoIs = (saved: Array<{ track: string; text: string; speaker: string | null }>) => {
    const by = new Map<string, Set<string | null>>()
    for (const s of saved.filter((s) => s.track === 'them')) by.set(s.text, (by.get(s.text) ?? new Set()).add(s.speaker))
    return Object.fromEntries([...by].map(([v, set]) => [v, [...set]]))
  }

  it('follows each voice from one part to the next, also one that was quiet where the parts overlap; skips parts with nothing in them', async () => {
    const { bodies, client } = rig(Array.from({ length: 12 }, () => hear))
    const saved: Array<{ track: string; text: string; speaker: string | null }> = []
    const run = createCloudTranscriber({ client, model: () => 'deepgram/nova-3', options: () => ({ custom: { x: 1 } }), spoken: () => 'auto', previous: () => [], label: (n) => `Speaker ${n}`, chunkMs: 8000, overlapMs: 2000, searchMs: 500 })
    // A speaks again only after the overlap (11.5 s): matched by the clip of A played ahead of the second part
    const them = voices(20, [['A', 0.5, 3], ['B', 3.5, 7.5], ['C', 8.5, 10.5], ['A', 11.5, 13.5], ['B', 14.5, 16.5], ['C', 17.5, 19.5]])
    await run('m2', { me: once(new Float32Array(16000 * 20)), them: once(them) }, { save: (s) => saved.push(...s) })
    // silent mic: never sent; Auto-detect: no language; the advanced options go as they are
    expect(bodies.length).toBeGreaterThanOrEqual(3)
    expect(bodies.every((b) => b.provider)).toBe(true)
    expect(bodies.every((b) => !('language' in b))).toBe(true)
    expect(bodies[0].provider).toEqual({ options: { custom: { x: 1 } } })
    const who = whoIs(saved)
    expect(who).toEqual({ A: [expect.any(String)], B: [expect.any(String)], C: [expect.any(String)] })
    expect(new Set([who.A[0], who.B[0], who.C[0]]).size).toBe(3)
    expect(saved.map((s) => s.text)).toEqual(['A', 'B', 'C', 'A', 'B', 'C'])
    // the clips went ahead of the later parts only: the first is the part alone
    const seconds = (b: Record<string, unknown>) => (Buffer.from((b.input_audio as { data: string }).data, 'base64').length - 44) / 32000
    expect(seconds(bodies[0])).toBeLessThanOrEqual(8)
    expect(seconds(bodies[1])).toBeGreaterThan(8)
  })
  it("the mic answered in one segment for each whole part (ElevenLabs without labels): every part's words are kept, in lines", async () => {
    let k = 0
    const mic = (b: Record<string, unknown>) => {
      const seconds = (Buffer.from((b.input_audio as { data: string }).data, 'base64').length - 44) / 32000
      const words = []
      for (let t = 0.5; t + 0.5 <= seconds; t += 2.5) words.push({ word: `r${k}.`, start: t, end: t + 0.5 })
      k++
      return { segments: [{ start: 0, end: seconds, text: words.map((w) => w.word).join(' ') }], words }
    }
    const { bodies, client } = rig(Array.from({ length: 10 }, () => mic), ['elevenlabs'])
    const saved: Array<{ track: string; text: string; startMs: number; endMs: number }> = []
    const run = createCloudTranscriber({ client, model: () => 'elevenlabs/scribe-v2', options: () => undefined, spoken: () => 'he', previous: () => [], label: String, chunkMs: 30_000, overlapMs: 4000, searchMs: 1000 })
    expect(await run('m8', { me: audio(70) }, { save: (s) => saved.push(...s) })).toBe(true)
    expect(bodies.length).toBeGreaterThanOrEqual(3)
    const me = saved.filter((s) => s.track === 'me')
    // the words of every part, to the end of the meeting, in lines of 20 s at most (one for each word, where its part's
    // segment ran over 20 s)
    expect(new Set(me.flatMap((s) => s.text.split(' ')))).toEqual(new Set(bodies.map((_, i) => `r${i}.`)))
    expect(me.every((s) => s.endMs - s.startMs <= 20_000)).toBe(true)
    expect(me.filter((s) => s.text === 'r0.').length).toBeGreaterThan(5)
    expect(Math.max(...me.map((s) => s.endMs))).toBeGreaterThan(66_000)
  })
  it('a model without word timings is asked again without them, and not asked for them after', async () => {
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/endpoints')) return new Response(JSON.stringify({ data: { endpoints: [{ tag: 'mistral/zdr' }] } }))
      const body = JSON.parse(String(init?.body)); grains.push(body.timestamp_granularities)
      if (body.timestamp_granularities.includes('word')) return new Response(JSON.stringify({ error: { code: 400, message: 'HTTP 400: Word-level segments are not enabled for this model' } }), { status: 400 })
      return new Response(JSON.stringify({ segments: [{ start: 0, end: 1, text: 'ok' }] }))
    }) as typeof fetch
    const grains: string[][] = []
    const saved: unknown[] = []
    const run = createCloudTranscriber({ client: createOpenRouter({ key: () => 'k', fetchFn }), model: () => 'mistralai/voxtral-small-transcribe-3-0', options: () => undefined, spoken: () => 'en', previous: () => [], label: String })
    expect(await run('m5', { me: audio(2), them: audio(2) }, { save: (s) => saved.push(...s) })).toBe(true)
    expect(saved).toHaveLength(2)
    expect(grains.filter((g) => g.includes('word')).length).toBeLessThanOrEqual(2)
    expect(grains.at(-1)).toEqual(['segment'])
  })
  it('a part too large for the model goes again in smaller ones, and the next parts are that small from the start', async () => {
    const sizes: Array<[seconds: number, ok: boolean]> = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/endpoints')) return new Response(JSON.stringify({ data: { endpoints: [{ tag: 'deepgram' }] } }))
      const body = JSON.parse(String(init?.body))
      const seconds = (Buffer.from(body.input_audio.data, 'base64').length - 44) / 32000
      sizes.push([seconds, seconds <= 6])
      if (seconds > 6) return new Response(JSON.stringify({ error: { code: 400, message: 'The selected model does not support large audio inputs' } }), { status: 400 })
      return new Response(JSON.stringify(hear(body)))
    }) as typeof fetch
    const saved: Array<{ track: string; text: string; speaker: string | null }> = []
    const run = createCloudTranscriber({ client: createOpenRouter({ key: () => 'k', fetchFn }), model: () => 'deepgram/nova-3', options: () => undefined, spoken: () => 'en', previous: () => [], label: String, minPartMs: 2000, searchMs: 500, overlapMs: 1000 })
    const them = voices(20, [['A', 0.5, 2.5], ['B', 3.5, 5.5], ['C', 7, 9], ['A', 10.5, 12.5], ['B', 14, 16], ['C', 17.5, 19.5]])
    expect(await run('m6', { them: once(them) }, { save: (s) => saved.push(...s) })).toBe(true)
    expect(new Set(saved.map((s) => s.text))).toEqual(new Set(['A', 'B', 'C']))
    // turned down while the app learned the size (20 s, then 12 s, then 7.2 s), never once it knew
    const refused = sizes.filter(([, ok]) => !ok)
    expect(refused.length).toBeLessThanOrEqual(3)
    expect(sizes.findIndex(([, ok]) => ok)).toBeGreaterThan(sizes.map(([, ok]) => ok).lastIndexOf(false))
    const plain = (async () => new Response(JSON.stringify({ error: { code: 400, message: 'The selected model does not support large audio inputs' } }), { status: 400 })) as unknown as typeof fetch
    const never = createCloudTranscriber({ client: createOpenRouter({ key: () => 'k', fetchFn: plain }), model: () => 'x/y', options: () => ({}), spoken: () => 'en', previous: () => [], label: String, minPartMs: 2000 })
    await expect(never('m7', { them: audio(3) }, {})).rejects.toMatchObject({ kind: 'model' })
  })
  it('reads the language a provider heard however it writes it', () => {
    expect(['he', 'heb', 'iw', 'hebrew', 'HEB', 'eng', 'english', 'en-US', 'jv', 'yue', 'xx', '', 'auto'].map(heardLanguage))
      .toEqual(['hebrew', 'hebrew', 'hebrew', 'hebrew', 'hebrew', 'english', 'english', 'english', 'javanese', undefined, undefined, undefined, undefined])
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
