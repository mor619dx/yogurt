import type { SttResponse } from './client'

/**
 * Speaker-labelled transcription in the cloud, as pure steps. A speaker model needs minutes of audio to tell voices apart,
 * so a recording goes out in long chunks; each chunk numbers its voices afresh, so chunks overlap, and the voices heard in
 * an overlap are matched to the ones before. Then the speakers get the names the call app showed, where it showed them.
 */

export const SAMPLE_RATE = 16000
/** 100 ms */
const FRAME = SAMPLE_RATE / 10
const toSamples = (ms: number) => Math.round((ms * SAMPLE_RATE) / 1000)
const toMs = (samples: number) => Math.round((samples * 1000) / SAMPLE_RATE)

/** start of the quietest 100 ms frame in the window's last search samples (the latest of equals: chunks stay long), cut in its middle */
function quietCut(buf: Float32Array, size: number, search: number): number {
  let best = size - FRAME
  let bestSum = Infinity
  for (let f = size - search; f + FRAME <= size; f += FRAME) {
    let sum = 0
    for (let i = f; i < f + FRAME; i++) sum += buf[i] * buf[i]
    if (sum <= bestSum) { bestSum = sum; best = f }
  }
  return best + FRAME / 2
}

/**
 * Cuts 16 kHz audio into chunks of about chunkMs, each cut at the quietest 100 ms in its last searchMs (a pause, so no
 * word is split), each starting overlapMs before the last one's cut. The rest goes out at the end. Only one chunk is held
 * at a time, copied in, so a source may reuse its blocks; each chunk is a copy of its own.
 */
export async function* chunks(source: AsyncIterable<Float32Array>, o: { chunkMs?: number; overlapMs?: number; searchMs?: number } = {}): AsyncGenerator<{ startMs: number; samples: Float32Array }> {
  const size = Math.max(2 * FRAME, toSamples(o.chunkMs ?? 480_000))
  const search = Math.max(FRAME, Math.min(size, Math.floor(toSamples(o.searchMs ?? 30_000) / FRAME) * FRAME))
  const overlap = Math.max(0, toSamples(o.overlapMs ?? 20_000))
  const buf = new Float32Array(size)
  let fill = 0
  /** samples before buf[0], and how many at its start the last chunk already sent */
  let at = 0
  let sent = 0
  for await (const block of source) {
    let i = 0
    while (i < block.length) {
      const n = Math.min(block.length - i, size - fill)
      buf.set(block.subarray(i, i + n), fill)
      fill += n
      i += n
      if (fill < size) continue
      const cut = quietCut(buf, size, search)
      // a chunk must move on: never keep more than half of it
      const keep = Math.min(overlap, Math.floor(cut / 2))
      const chunk = { startMs: toMs(at), samples: buf.slice(0, cut) }
      buf.copyWithin(0, cut - keep, size)
      fill = size - (cut - keep)
      at += cut - keep
      sent = keep
      yield chunk
    }
  }
  if (fill > sent) yield { startMs: toMs(at), samples: buf.slice(0, fill) }
}

/** nothing worth sending: no voice, no click */
export function isSilent(samples: Float32Array): boolean {
  if (!samples.length) return true
  let sum = 0
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]
    sum += v * v
    const a = Math.abs(v)
    if (a > peak) peak = a
  }
  return Math.sqrt(sum / samples.length) < 0.003 && peak < 0.02
}

/** a line on meeting time; speaker: the provider's key for the voice (numbered per chunk until linked), null when none */
export type CloudLine = { startMs: number; endMs: number; text: string; speaker: string | null }

const speakerOf = (s: number | string | null | undefined): string | null => (s === undefined || s === null || s === '' ? null : String(s))
const seconds = (s: unknown): number => (typeof s === 'number' && Number.isFinite(s) ? s : 0)

/** a new line after this much quiet between words */
const WORD_GAP_MS = 1500
/** a line this long ends at the next sentence end */
const LONG_LINE_MS = 20_000
const SENTENCE_END = /[.!?。！？…]["'”’)\]]*$/
/** scripts written without spaces between words */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const NO_SPACE_BEFORE = /^[,.!?;:%)\]}…、。，！？：；]/

/** words into lines: a new one when the voice changes, after a pause, or at a sentence end once a line runs long */
function regroup(words: NonNullable<SttResponse['words']>, ms: (s: number) => number): CloudLine[] {
  // whisper-style words carry their own leading space; others are bare and get one between them
  const spaced = words.some((w) => typeof w.word === 'string' && /^\s/.test(w.word))
  const lines: CloudLine[] = []
  let cur: CloudLine | undefined
  for (const w of words) {
    if (typeof w.word !== 'string' || !w.word.trim()) continue
    const text = spaced ? w.word : w.word.trim()
    const speaker = speakerOf(w.speaker)
    const startMs = ms(w.start)
    const endMs = Math.max(startMs, ms(w.end))
    const fresh = !cur || cur.speaker !== speaker || startMs - cur.endMs > WORD_GAP_MS || (cur.endMs - cur.startMs > LONG_LINE_MS && SENTENCE_END.test(cur.text))
    if (fresh || !cur) {
      cur = { startMs, endMs, text, speaker }
      lines.push(cur)
      continue
    }
    const glue = spaced || NO_SPACE_BEFORE.test(text) || (UNSPACED.test(cur.text.slice(-1)) && UNSPACED.test(text[0])) ? '' : ' '
    cur.text += glue + text
    cur.endMs = Math.max(cur.endMs, endMs)
  }
  return lines
}

/**
 * A provider's answer for a chunk as lines on meeting time (offsetMs: where the chunk starts). Segments when they say
 * who spoke, or nobody does; words when only they carry speakers; the bare text over the whole chunk when that is all.
 */
export function normalize(resp: SttResponse, offsetMs: number): CloudLine[] {
  const ms = (s: number) => offsetMs + Math.round(seconds(s) * 1000)
  const segments = Array.isArray(resp.segments) ? resp.segments : []
  const words = Array.isArray(resp.words) ? resp.words : []
  const segmentSpeakers = segments.some((s) => speakerOf(s.speaker) !== null)
  const wordSpeakers = words.some((w) => speakerOf(w.speaker) !== null)
  let lines: CloudLine[]
  if (segments.length && (segmentSpeakers || !wordSpeakers)) {
    lines = segments.map((s) => ({ startMs: ms(s.start), endMs: Math.max(ms(s.start), ms(s.end)), text: typeof s.text === 'string' ? s.text : '', speaker: speakerOf(s.speaker) }))
  } else if (words.length) lines = regroup(words, ms)
  else if (typeof resp.text === 'string' && resp.text.trim()) lines = [{ startMs: offsetMs, endMs: ms(seconds(resp.duration)), text: resp.text, speaker: null }]
  else return []
  return lines.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text)
}

/** the same voice in both chunks must share at least this much of the overlap */
const MIN_LINK_MS = 1000
/** ...and that much of the time it spoke in the overlap */
const MIN_LINK_SHARE = 0.5

/**
 * Which speaker before each voice of the next chunk is, from the overlap both chunks heard: the one it spoke at the same
 * time as most (at least 1 s, and at least half its time in the overlap), else a new speaker. Greedy from the strongest
 * match, two voices never get the same speaker unless the provider split one voice in two (both match only that one).
 * prev: lines with speakers already linked; next: the chunk's own speaker keys.
 */
export function link(prev: CloudLine[], next: CloudLine[], overlap: [number, number], nextGlobal: () => string): Map<string, string> {
  const [a, b] = overlap
  const before = prev.filter((p) => p.speaker !== null && p.endMs > a && p.startMs < b)
  /** each voice of the next chunk, by first appearance: its time in the overlap and the time it shares with each speaker before */
  const voices = new Map<string, { inside: number; shared: Map<string, number> }>()
  for (const l of [...next].sort((x, y) => x.startMs - y.startMs)) {
    if (l.speaker === null) continue
    let v = voices.get(l.speaker)
    if (!v) voices.set(l.speaker, (v = { inside: 0, shared: new Map() }))
    const s = Math.max(l.startMs, a)
    const e = Math.min(l.endMs, b)
    if (e <= s) continue
    v.inside += e - s
    for (const p of before) {
      const ms = Math.min(e, p.endMs) - Math.max(s, p.startMs)
      if (ms > 0) v.shared.set(p.speaker!, (v.shared.get(p.speaker!) ?? 0) + ms)
    }
  }
  const matches: Array<{ local: string; global: string; ms: number }> = []
  for (const [local, v] of voices) {
    for (const [global, ms] of v.shared) if (ms >= MIN_LINK_MS && ms >= MIN_LINK_SHARE * v.inside) matches.push({ local, global, ms })
  }
  matches.sort((x, y) => y.ms - x.ms)
  const map = new Map<string, string>()
  const used = new Set<string>()
  for (const m of matches) {
    if (map.has(m.local) || used.has(m.global)) continue
    map.set(m.local, m.global)
    used.add(m.global)
  }
  // a voice whose only matches were taken: the provider heard one person as two
  for (const m of matches) if (!map.has(m.local)) map.set(m.local, m.global)
  for (const local of voices.keys()) if (!map.has(local)) map.set(local, nextGlobal())
  return map
}

/** two chunks' lines as one: the overlap's first half from the earlier chunk, the rest from the next */
export function stitch(prev: CloudLine[], next: CloudLine[], overlap: [number, number]): CloudLine[] {
  const mid = (overlap[0] + overlap[1]) / 2
  return [...prev.filter((l) => l.startMs < mid), ...next.filter((l) => l.startMs >= mid)]
}

/** a speaker takes a name the call app showed for more than half of the time it spoke */
const NAME_SHARE = 0.5

/**
 * Names for the speakers: the call app's name (old: the lines as first transcribed, with the names it showed) when it
 * covers more than half of a speaker's time, else label(n), numbering the unnamed speakers by first appearance. A name
 * goes to one speaker only, the one it covers most. skip: names that aren't people ('Them', a room).
 */
export function nameSpeakers(lines: CloudLine[], old: Array<{ startMs: number; endMs: number; speaker: string | null }>, label: (n: number) => string, skip?: (name: string) => boolean): CloudLine[] {
  const named = old.filter((x): x is { startMs: number; endMs: number; speaker: string } => x.speaker !== null && !!x.speaker.trim() && x.endMs > x.startMs && !skip?.(x.speaker))
  /** each speaker, by first appearance: its time and the time each name covers */
  const speakers = new Map<string, { total: number; cover: Map<string, number> }>()
  for (const l of [...lines].sort((x, y) => x.startMs - y.startMs)) {
    if (l.speaker === null) continue
    let s = speakers.get(l.speaker)
    if (!s) speakers.set(l.speaker, (s = { total: 0, cover: new Map() }))
    if (l.endMs <= l.startMs) continue
    s.total += l.endMs - l.startMs
    for (const x of named) {
      const ms = Math.min(l.endMs, x.endMs) - Math.max(l.startMs, x.startMs)
      if (ms > 0) s.cover.set(x.speaker, (s.cover.get(x.speaker) ?? 0) + ms)
    }
  }
  const picks: Array<{ speaker: string; name: string; ms: number }> = []
  for (const [speaker, s] of speakers) {
    let best: { name: string; ms: number } | undefined
    for (const [name, ms] of s.cover) if (ms > NAME_SHARE * s.total && (!best || ms > best.ms)) best = { name, ms }
    if (best) picks.push({ speaker, ...best })
  }
  picks.sort((x, y) => y.ms - x.ms)
  const names = new Map<string, string>()
  const taken = new Set<string>()
  for (const p of picks) {
    if (taken.has(p.name)) continue
    names.set(p.speaker, p.name)
    taken.add(p.name)
  }
  let n = 0
  for (const speaker of speakers.keys()) if (!names.has(speaker)) names.set(speaker, label(++n))
  return lines.map((l) => (l.speaker === null ? l : { ...l, speaker: names.get(l.speaker) ?? l.speaker }))
}
