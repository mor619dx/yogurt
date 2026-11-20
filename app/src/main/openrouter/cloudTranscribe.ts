import { AUDIO_SPEAKER } from '../../shared/audioUpload'
import { AUTO, codeOfWhisperName, isoCode, isSpoken, whisperName, type Spoken } from '../../shared/spoken'
import { previousSpeaker } from '../../shared/transcriptReplacement'
import type { Track } from '../capture'
import type { RecordedOptions } from '../asr'
import { echoConfidence } from '../asr/echo'
import { wavBytes } from '../asr/transcribe'
import type { Segment } from '../store'
import { OpenRouterError, problemOf, type OpenRouter } from './client'
import { chunks, clipOf, fromReferences, isSilent, link, MAX_REFERENCES, nameSpeakers, normalize, REFERENCE_GAP_MS, REFERENCE_MS, SAMPLE_RATE, stitch, withReferences, type CloudLine, type Reference } from './diarize'

/** what turns on speaker labels at each provider, keyed by the start of its endpoint tag (OpenRouter passes them through as they are) */
const DIARIZE: Record<string, Record<string, unknown>> = {
  deepgram: { diarize: true }, elevenlabs: { diarize: true }, mistral: { diarize: true },
  assemblyai: { speaker_labels: true }, azure: { diarization: { enabled: true } },
}
/** the provider options that turn on speaker labels for this model's endpoint, by its tag ("mistral/zdr" → mistral's) */
export function diarizeOptions(tags: string[]): Record<string, unknown> | undefined {
  for (const tag of tags) {
    const known = DIARIZE[tag.split('/')[0]]
    if (known) return { [tag]: known }
  }
  return undefined
}

/** waits before asking again after OpenRouter was busy or out of reach */
const RETRY_MS = [2000, 6000, 15000]
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})


/** the language a provider heard, as whisper names it: "he", "heb", "iw" and "hebrew" alike */
export function heardLanguage(v: string): string | undefined {
  const s = v.trim().toLowerCase()
  if (!s) return undefined
  if (codeOfWhisperName(s)) return s
  let code: string
  try { code = Intl.getCanonicalLocales(s)[0].toLowerCase().split('-')[0] } catch { return undefined }
  if (code === 'jv') code = 'jw'
  return code !== AUTO && isSpoken(code) ? whisperName(code) : undefined
}

/** a model that turned a part down for its size gets shorter ones, but none shorter than this */
const MIN_PART_MS = 30_000
/** how much shorter, from the audio it turned down */
const SHRINK = 0.6
const tooLarge = (e: unknown) => e instanceof OpenRouterError && (e.kind === 'too-large' || /large audio|too large|too long|file size/i.test(e.message))
/** a model without word timings (Mistral's): "Word-level segments are not enabled for this model" */
const noWords = (e: unknown) => e instanceof OpenRouterError && e.kind === 'model' && /\bword/i.test(e.message)
const msOf = (samples: Float32Array) => Math.round((samples.length * 1000) / SAMPLE_RATE)

type Old = Pick<Segment, 'track' | 'startMs' | 'endMs' | 'speaker' | 'hidden'>

/**
 * After a meeting: its saved audio transcribed again by an OpenRouter speech model, the other side's voices told apart.
 * Each track goes in parts (a provider has 60 s for each request, and takes 25 MB at most), with an overlap, so voices are
 * followed from one part to the next. The mic is the person ("You"); on the other side each voice keeps the name the call
 * app showed for it (callNames) where its lines carried one, else "Speaker 1", "Speaker 2"… The same shape as
 * transcribeRecorded: the new lines go to options.save (a draft that replaces the transcript once it is all in).
 */
export function createCloudTranscriber(d: {
  client: OpenRouter
  model: () => string
  /** advanced: the provider options to send in place of the built-in ones */
  options: () => Record<string, unknown> | undefined
  spoken: (id: string) => Spoken
  /** the transcript there was before (the one from this computer, with names from the call) */
  previous: (id: string) => Old[]
  /** "Speaker 1", in the interface's language */
  label: (n: number) => string
  /** whisper heard the language: kept with the meeting for its notes */
  onLanguage?: (id: string, whisperName: string) => void
  /** for tests: shorter parts */
  chunkMs?: number; overlapMs?: number; searchMs?: number; minPartMs?: number
}) {
  const send = async (body: Record<string, unknown>, signal?: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      try { return await d.client.transcribe(body, signal) } catch (e) {
        const kind = problemOf(e)
        // the key, the credits, the model or the size won't change by asking again
        if (signal?.aborted || attempt >= RETRY_MS.length || !(kind === 'rate' || kind === 'server' || kind === 'network')) throw e
        await sleep(RETRY_MS[attempt], signal)
      }
    }
  }

  return async (id: string, tracks: Partial<Record<Track, AsyncIterable<Float32Array>>>, options: RecordedOptions = {}): Promise<boolean> => {
    const { signal } = options
    const model = d.model()
    if (!model) throw new OpenRouterError('model', 'No speech model picked')
    const spoken = d.spoken(id)
    // a two-letter code goes as it is; whisper's own codes for languages without one ("haw") are left for the model to hear
    const language = spoken !== AUTO && /^[a-z]{2}$/.test(isoCode(spoken)) ? isoCode(spoken) : undefined
    const provider = d.options() ?? diarizeOptions(await d.client.endpoints(model).catch(() => []))
    const languages = new Map<string, number>()
    const at: Partial<Record<Track, number>> = {}
    /** what the model turned down once is not asked again: word timings, and audio this long (ms) */
    let words = true
    let maxMs = Infinity
    const minPartMs = d.minPartMs ?? MIN_PART_MS

    const ask = async (audio: Float32Array, voices: boolean) => {
      for (;;) {
        const timings = words
        try {
          return await send({
            model, input_audio: { data: wavBytes(audio).toString('base64'), format: 'wav' },
            response_format: 'verbose_json', timestamp_granularities: timings ? ['segment', 'word'] : ['segment'],
            ...(language ? { language } : {}),
            ...(voices && provider ? { provider: { options: provider } } : {}),
          }, signal)
        } catch (e) {
          // both tracks ask at once: each one that asked for words asks again without them
          if (timings && noWords(e)) { words = false; continue }
          throw e
        }
      }
    }

    /** a part in pieces of at most ms, each starting a little before the last one's end (as chunks do) */
    const split = async (part: { startMs: number; samples: Float32Array }, ms: number) => {
      const out: Array<{ startMs: number; samples: Float32Array }> = []
      const one = (async function* () { yield part.samples })()
      for await (const piece of chunks(one, { chunkMs: ms, overlapMs: Math.min(d.overlapMs ?? 20_000, ms / 4), searchMs: Math.min(d.searchMs ?? 30_000, ms / 4) })) {
        out.push({ startMs: part.startMs + piece.startMs, samples: piece.samples })
      }
      return out
    }

    const read = async (track: Track, audio: AsyncIterable<Float32Array>): Promise<CloudLine[]> => {
      let all: CloudLine[] = []
      let last: { startMs: number; endMs: number } | undefined
      /** the voices heard in the part before (their numbers for the whole meeting) */
      let before = new Set<string>()
      let next = 0
      const global = () => String(next++)
      /** each voice of the other side so far: how long it spoke, and a clip of it to play ahead of the next parts */
      const voices = new Map<string, { ms: number; clip?: Float32Array }>()
      /** the clips to play ahead of a part, the voices heard most first: a third of what the model takes at most */
      const references = (): Reference[] => {
        if (track !== 'them') return []
        const out: Reference[] = []
        let ms = 0
        for (const [speaker, v] of [...voices].filter(([, v]) => v.clip).sort((a, b) => b[1].ms - a[1].ms).slice(0, MAX_REFERENCES)) {
          ms += msOf(v.clip!) + REFERENCE_GAP_MS
          if (ms > maxMs / 3) break
          out.push({ speaker, samples: v.clip! })
        }
        return out
      }
      /** how much audio the last request carried */
      let sentMs = 0

      const take = async (part: { startMs: number; samples: Float32Array }) => {
        const endMs = part.startMs + msOf(part.samples)
        if (isSilent(part.samples)) { last = { startMs: part.startMs, endMs }; return }
        const sent = withReferences(part.samples, references())
        sentMs = msOf(sent.audio)
        const resp = await ask(sent.audio, track === 'them')
        if (signal?.aborted) return
        if (resp.language) {
          const name = heardLanguage(resp.language)
          if (name) languages.set(name, (languages.get(name) ?? 0) + (resp.text?.length ?? 1))
        }
        // on the audio sent: the clips first, then the part
        const heard = normalize(resp, 0)
        const middle = (l: CloudLine) => (l.startMs + l.endMs) / 2
        const known = fromReferences(heard.filter((l) => middle(l) < sent.prefixMs), sent.windows)
        let lines = heard.filter((l) => middle(l) >= sent.prefixMs).map((l) => ({
          ...l, startMs: Math.max(l.startMs, sent.prefixMs) - sent.prefixMs + part.startMs, endMs: l.endMs - sent.prefixMs + part.startMs }))
        const overlap: [number, number] | undefined = last && last.endMs > part.startMs ? [part.startMs, last.endMs] : undefined
        // the same voice keeps its number from one part to the next
        if (track === 'them') {
          // by the overlap both parts heard, else by the clips played before this one
          const map = new Map<string, string>()
          if (overlap) for (const [local, g] of link(all, lines.filter((l) => l.startMs < overlap[1]), overlap, () => '')) if (g) map.set(local, g)
          for (const [local, g] of known) if (!map.has(local)) map.set(local, g)
          // a voice matched by neither: when one voice of the part before is still unmatched and one here is new, they
          // are the same person (most calls have one or two people on the other side)
          const fresh = [...new Set(lines.flatMap((l) => (l.speaker != null && !map.has(l.speaker) ? [l.speaker] : [])))]
          const left = [...before].filter((g) => ![...map.values()].includes(g))
          if (fresh.length === 1 && left.length === 1) map.set(fresh[0], left[0])
          lines = lines.map((l) => {
            if (l.speaker == null) return l
            if (!map.has(l.speaker)) map.set(l.speaker, global())
            return { ...l, speaker: map.get(l.speaker)! }
          })
          for (const l of lines) {
            if (l.speaker == null) continue
            const v = voices.get(l.speaker) ?? { ms: 0 }
            v.ms += l.endMs - l.startMs
            if (!v.clip || msOf(v.clip) < REFERENCE_MS) {
              const clip = clipOf(l, lines, part.samples, part.startMs)
              if (clip && (!v.clip || clip.length > v.clip.length)) v.clip = clip
            }
            voices.set(l.speaker, v)
          }
        }
        all = overlap ? stitch(all, lines, overlap) : [...all, ...lines]
        if (track === 'them') before = new Set(lines.flatMap((l) => (l.speaker == null ? [] : [l.speaker])))
        last = { startMs: part.startMs, endMs }
      }

      for await (const chunk of chunks(audio, { chunkMs: d.chunkMs, overlapMs: d.overlapMs, searchMs: d.searchMs })) {
        if (signal?.aborted) return all
        at[track] = chunk.startMs + msOf(chunk.samples)
        options.progress?.(Math.min(...Object.values(at)))
        const queue = [chunk]
        while (queue.length) {
          const part = queue.shift()!
          // the clips go too: the part gets what is left
          const room = Math.max(minPartMs, maxMs - msOf(withReferences(new Float32Array(0), references()).audio))
          if (msOf(part.samples) > room) { queue.unshift(...await split(part, room)); continue }
          try { await take(part) } catch (e) {
            if (signal?.aborted) return all
            if (!tooLarge(e) || msOf(part.samples) <= minPartMs) throw e
            maxMs = Math.min(maxMs, Math.floor(sentMs * SHRINK))
            queue.unshift(part)
            continue
          }
          if (signal?.aborted) return all
        }
      }
      return all
    }

    const [me, them] = await Promise.all([
      tracks.me ? read('me', tracks.me) : Promise.resolve([]),
      tracks.them ? read('them', tracks.them) : Promise.resolve([]),
    ])
    if (signal?.aborted) return false

    const old = d.previous(id)
    const oldThem = old.filter((l) => l.track === 'them' && !l.hidden)
    const named = nameSpeakers(them, oldThem, d.label, (n) => n === AUDIO_SPEAKER)
    const themSegs: Omit<Segment, 'id'>[] = named.map((l) => ({ meetingId: id, track: 'them', startMs: l.startMs, endMs: l.endMs, text: l.text,
      // no voice told apart (a model without labels): the name the call app showed then, as before
      speaker: l.speaker ?? previousSpeaker(oldThem as never, 'them', l.startMs, l.endMs) }))
    // the mic heard the other side through the speakers before (lines were hidden as echo): the same here
    const echo = old.some((l) => l.track === 'me' && l.hidden)
    const meSegs: Omit<Segment, 'id'>[] = me.map((l) => {
      const confidence = echo ? echoConfidence(l, themSegs, { echo: true }) : false
      return { meetingId: id, track: 'me', startMs: l.startMs, endMs: l.endMs, text: l.text, speaker: 'me', ...(confidence ? { hidden: true, ...(confidence === 'high' ? { echoConfident: true } : {}) } : {}) }
    })
    const segs = [...meSegs, ...themSegs].sort((a, b) => a.startMs - b.startMs)
    if (segs.length) options.save?.(segs)
    let best: string | undefined, most = 0
    for (const [name, n] of languages) if (n > most) { best = name; most = n }
    if (best) d.onLanguage?.(id, best)
    return true
  }
}
export type CloudTranscriber = ReturnType<typeof createCloudTranscriber>
