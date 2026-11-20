import { describe, expect, it } from 'vitest'
import { chunks, clipOf, fromReferences, isSilent, link, nameSpeakers, normalize, REFERENCE_GAP_MS, REFERENCE_MS, SAMPLE_RATE, stitch, withReferences, type CloudLine } from '../src/main/openrouter/diarize'

/** seeded noise, the same every run */
function noise(n: number, amp: number, seed = 1): Float32Array {
  let s = seed >>> 0
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    out[i] = ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1) * amp
  }
  return out
}
const at = (ms: number) => Math.round((ms * SAMPLE_RATE) / 1000)
/** a source handing out the audio in blocks of the size given */
async function* blocks(audio: Float32Array, size: number) {
  for (let i = 0; i < audio.length; i += size) yield audio.subarray(i, i + size)
}
const collect = async <T>(g: AsyncIterable<T>) => { const out: T[] = []; for await (const x of g) out.push(x); return out }
/** element by element: toEqual on millions of samples is slow */
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i])
const line = (startS: number, endS: number, speaker: string | null, text = 'words'): CloudLine => ({ startMs: startS * 1000, endMs: endS * 1000, text, speaker })

describe('chunks', () => {
  const o = { chunkMs: 10_000, overlapMs: 2_000, searchMs: 3_000 }
  /** 25 s of loud noise with a quiet 100 ms at 8.3 s (quieter than the 100 ms after it) */
  const audio = () => {
    const a = noise(at(25_000), 0.2)
    a.set(noise(at(100), 0.0001, 2), at(8_300))
    a.set(noise(at(100), 0.001, 3), at(8_400))
    return a
  }

  it('cuts at the quietest 100 ms in the last part of the window', async () => {
    const out = await collect(chunks(blocks(audio(), 1234), o))
    expect(out[0].startMs).toBe(0)
    // the middle of the quiet frame
    expect(out[0].samples.length).toBe(at(8_350))
  })

  it('each chunk starts the overlap before the last one ended, and together they cover everything once', async () => {
    const a = audio()
    const out = await collect(chunks(blocks(a, 1234), o))
    expect(out.length).toBeGreaterThan(2)
    for (const c of out) {
      const start = at(c.startMs)
      expect(c.samples.length).toBeLessThanOrEqual(at(o.chunkMs))
      expect(same(c.samples, a.subarray(start, start + c.samples.length))).toBe(true)
    }
    for (let i = 1; i < out.length; i++) {
      const prevEnd = at(out[i - 1].startMs) + out[i - 1].samples.length
      expect(prevEnd - at(out[i].startMs)).toBe(at(o.overlapMs))
      // each cut falls in the last 3 s of its 10 s window
      expect(out[i - 1].samples.length).toBeGreaterThan(at(7_000))
    }
    const last = out.at(-1)!
    expect(at(last.startMs) + last.samples.length).toBe(a.length)
  })

  it('cuts the same whatever the blocks: one big one, or many small', async () => {
    const a = audio()
    const shape = (cs: Array<{ startMs: number; samples: Float32Array }>) => cs.map((c) => [c.startMs, c.samples.length])
    const one = await collect(chunks(blocks(a, a.length), o))
    const small = await collect(chunks(blocks(a, 160), o))
    expect(shape(one)).toEqual(shape(small))
    expect(shape(one)).toEqual(shape(await collect(chunks(blocks(a, 16_001), o))))
  })

  it('sends chunks of their own: a source reusing its block, or a chunk written to, changes nothing', async () => {
    const a = audio()
    async function* reused() {
      const block = new Float32Array(4000)
      for (let i = 0; i < a.length; i += 4000) {
        block.fill(0)
        block.set(a.subarray(i, i + 4000))
        yield block.subarray(0, Math.min(4000, a.length - i))
      }
    }
    const out: Array<{ startMs: number; samples: Float32Array }> = []
    for await (const c of chunks(reused(), o)) { out.push({ startMs: c.startMs, samples: c.samples.slice() }); c.samples.fill(9) }
    for (const c of out) expect(same(c.samples, a.subarray(at(c.startMs), at(c.startMs) + c.samples.length))).toBe(true)
  })

  it('audio shorter than a chunk is one chunk; none is none', async () => {
    const a = noise(at(4_000), 0.1)
    const out = await collect(chunks(blocks(a, 1000), o))
    expect(out).toHaveLength(1)
    expect(out[0].startMs).toBe(0)
    expect(same(out[0].samples, a)).toBe(true)
    expect(await collect(chunks(blocks(new Float32Array(0), 10), o))).toEqual([])
  })

  it('by default: 8 min chunks overlapping by 20 s (silence cuts as late as it can)', async () => {
    async function* seconds(n: number) { for (let i = 0; i < n; i++) yield new Float32Array(SAMPLE_RATE) }
    const out = await collect(chunks(seconds(1000)))
    expect(out.map((c) => [c.startMs, c.samples.length / SAMPLE_RATE])).toEqual([[0, 479.95], [459_950, 479.95], [919_900, 80.1]])
  })
})

describe('isSilent', () => {
  it('quiet and click-free is silent', () => {
    expect(isSilent(new Float32Array(16000))).toBe(true)
    expect(isSilent(new Float32Array(0))).toBe(true)
    expect(isSilent(noise(16000, 0.004))).toBe(true)
  })

  it('a voice, or one click, is not', () => {
    expect(isSilent(noise(16000, 0.05))).toBe(false)
    const click = new Float32Array(16000)
    click[8000] = 0.05
    expect(isSilent(click)).toBe(false)
    // under the peak everywhere but loud enough on average
    const hum = new Float32Array(16000).fill(0.01)
    expect(isSilent(hum)).toBe(false)
  })
})

describe('normalize', () => {
  it('takes segments with their speakers, numbers as strings, on meeting time', () => {
    expect(normalize({ segments: [{ start: 0.5, end: 2.25, text: ' Hello there. ', speaker: 0 }, { start: 2.5, end: 4, text: 'Hi!', speaker: 1 }, { start: 4, end: 5, text: '  ', speaker: 0 }, { start: 5, end: 6.0004, text: 'Again', speaker: 'SPEAKER_00' }] }, 60_000)).toEqual([
      { startMs: 60_500, endMs: 62_250, text: 'Hello there.', speaker: '0' },
      { startMs: 62_500, endMs: 64_000, text: 'Hi!', speaker: '1' },
      { startMs: 65_000, endMs: 66_000, text: 'Again', speaker: 'SPEAKER_00' },
    ])
  })

  it('segments without speakers and words without either: segments, no speaker', () => {
    expect(normalize({ segments: [{ start: 0, end: 1, text: 'One' }], words: [{ word: 'One', start: 0, end: 1 }] }, 0)).toEqual([{ startMs: 0, endMs: 1000, text: 'One', speaker: null }])
  })

  it('segments without speakers but words with them: lines from the words, a new one when the voice changes', () => {
    const words = [
      { word: 'Hello', start: 0, end: 0.4, speaker: 0 }, { word: 'there,', start: 0.5, end: 0.9, speaker: 0 }, { word: 'Bob.', start: 1, end: 1.3, speaker: 0 },
      { word: 'Hi', start: 1.5, end: 1.7, speaker: 1 }, { word: 'Ann', start: 1.8, end: 2, speaker: 1 }, { word: '!', start: 2, end: 2.05, speaker: 1 },
      { word: 'So', start: 2.2, end: 2.4, speaker: 0 },
    ]
    expect(normalize({ segments: [{ start: 0, end: 2.4, text: 'Hello there, Bob. Hi Ann! So' }], words }, 1000)).toEqual([
      { startMs: 1000, endMs: 2300, text: 'Hello there, Bob.', speaker: '0' },
      { startMs: 2500, endMs: 3050, text: 'Hi Ann!', speaker: '1' },
      { startMs: 3200, endMs: 3400, text: 'So', speaker: '0' },
    ])
  })

  it('words only: a new line after a pause over 1.5 s', () => {
    const words = [{ word: 'One', start: 0, end: 0.5, speaker: 'A' }, { word: 'two', start: 2, end: 2.5, speaker: 'A' }, { word: 'three', start: 4.1, end: 4.5, speaker: 'A' }]
    expect(normalize({ words }, 0).map((l) => l.text)).toEqual(['One two', 'three'])
  })

  it('words only: a line over 20 s ends at the next sentence end, not before', () => {
    const words: Array<{ word: string; start: number; end: number; speaker: number }> = []
    for (let t = 0; t < 30; t++) words.push({ word: t === 10 || t === 25 ? 'end.' : 'word', start: t, end: t + 0.5, speaker: 0 })
    const lines = normalize({ words }, 0)
    expect(lines).toHaveLength(2)
    expect(lines[0].text.endsWith('end.')).toBe(true)
    expect(lines[0].endMs).toBe(25_500)
    expect(lines[1].startMs).toBe(26_000)
  })

  it('words with their own spaces (whisper) are joined as they are; Chinese without spaces', () => {
    expect(normalize({ words: [{ word: ' Hello', start: 0, end: 0.5, speaker: 0 }, { word: ' world', start: 0.5, end: 1, speaker: 0 }] }, 0)[0].text).toBe('Hello world')
    expect(normalize({ words: [{ word: '你好', start: 0, end: 0.5, speaker: 0 }, { word: '世界', start: 0.5, end: 1, speaker: 0 }, { word: '。', start: 1, end: 1.1, speaker: 0 }] }, 0)[0].text).toBe('你好世界。')
  })

  it('only text: one line over the whole chunk; nothing: no lines', () => {
    expect(normalize({ text: ' Just this. ', duration: 12.5 }, 5000)).toEqual([{ startMs: 5000, endMs: 17_500, text: 'Just this.', speaker: null }])
    expect(normalize({ text: '  ' }, 0)).toEqual([])
    expect(normalize({}, 0)).toEqual([])
    expect(normalize({ segments: [], words: [], text: '' }, 0)).toEqual([])
  })
})

describe('link', () => {
  // the earlier chunk, speakers already linked: A and B talk in turn through the overlap (100-120 s)
  const prev = [line(90, 100, 'A'), line(100, 105, 'A'), line(105, 112, 'B'), line(112, 118, 'A'), line(118, 120, 'B')]
  const ids = () => { let n = 0; return () => `S${++n}` }

  it('matches voices numbered the other way round in the next chunk', () => {
    // the next chunk heard B first, so B is its 0; timings off by a little
    const next = [line(100.2, 104.9, '1'), line(105.1, 112, '0'), line(112.1, 118, '1'), line(118, 121, '0'), line(122, 130, '0')]
    const map = link(prev, next, [100_000, 120_000], ids())
    expect(Object.fromEntries(map)).toEqual({ '1': 'A', '0': 'B' })
  })

  it('a voice not heard in the overlap is someone new, in order of first appearance', () => {
    const next = [line(100, 105, '0'), line(105, 112, '1'), line(125, 130, '3'), line(131, 140, '2')]
    expect(Object.fromEntries(link(prev, next, [100_000, 120_000], ids()))).toEqual({ '0': 'A', '1': 'B', '3': 'S1', '2': 'S2' })
  })

  it('under 1 s together, or under half its time in the overlap, is not a match', () => {
    const short = [line(104.2, 105.1, '0'), line(105.1, 112, '1')]
    expect(link(prev, short, [100_000, 120_000], ids()).get('0')).toBe('S1')
    // 3 s alongside A, but 10 s of its time in the overlap: someone the earlier chunk didn't hear (or heard as no one)
    const quiet = [line(100, 103, 'A'), line(112, 118, 'B')]
    const map = link(quiet, [line(100, 110, '0'), line(112, 118, '1')], [100_000, 120_000], ids())
    expect(map.get('0')).toBe('S1')
    expect(map.get('1')).toBe('B')
  })

  it('a little crosstalk with another speaker doesn\'t count against a voice\'s main match', () => {
    // 0 is mostly A, a little B; 1 is all B
    const next = [line(100, 105, '0'), line(105, 106.5, '0'), line(106.5, 112, '1'), line(112, 118, '0')]
    expect(Object.fromEntries(link(prev, next, [100_000, 120_000], ids()))).toEqual({ '0': 'A', '1': 'B' })
  })

  it('one voice the provider split in two: both halves go to the one speaker', () => {
    const next = [line(100, 104, '0'), line(104, 105, '1'), line(112, 113.5, '1'), line(105, 112, '2')]
    expect(Object.fromEntries(link(prev, next, [100_000, 120_000], ids()))).toEqual({ '0': 'A', '1': 'A', '2': 'B' })
  })

  it('lines without a speaker are left out', () => {
    expect(link(prev, [line(100, 110, null)], [100_000, 120_000], ids()).size).toBe(0)
  })
})

describe('stitch', () => {
  it('takes the overlap\'s first half from the earlier chunk, the rest from the next', () => {
    const prev = [line(90, 99, 'A', 'p1'), line(100, 104, 'A', 'p2'), line(109.9, 112, 'B', 'p3'), line(110, 115, 'B', 'p4')]
    const next = [line(100.1, 104, 'A', 'n1'), line(109, 110.5, 'B', 'n2'), line(110, 115, 'B', 'n3'), line(121, 125, 'C', 'n4')]
    expect(stitch(prev, next, [100_000, 120_000]).map((l) => l.text)).toEqual(['p1', 'p2', 'p3', 'n3', 'n4'])
  })
})

describe('nameSpeakers', () => {
  const label = (n: number) => `Speaker ${n}`

  it('a name covering more than half of a speaker\'s time is theirs; the rest are numbered by first appearance', () => {
    const lines = [line(0, 10, '2'), line(10, 20, '0'), line(20, 30, '1'), line(30, 40, '0'), line(40, 45, null)]
    const old = [{ startMs: 10_000, endMs: 20_000, speaker: 'Ann' }, { startMs: 30_000, endMs: 36_000, speaker: 'Ann' }, { startMs: 20_000, endMs: 24_000, speaker: 'Bob' }, { startMs: 40_000, endMs: 45_000, speaker: null }]
    expect(nameSpeakers(lines, old, label).map((l) => l.speaker)).toEqual(['Speaker 1', 'Ann', 'Speaker 2', 'Ann', null])
  })

  it('exactly half is not enough', () => {
    expect(nameSpeakers([line(0, 10, '0')], [{ startMs: 0, endMs: 5000, speaker: 'Ann' }], label)[0].speaker).toBe('Speaker 1')
    expect(nameSpeakers([line(0, 10, '0')], [{ startMs: 0, endMs: 5001, speaker: 'Ann' }], label)[0].speaker).toBe('Ann')
  })

  it('a name goes to one speaker only: the one it covers most', () => {
    // the call app showed Ann over both voices
    const lines = [line(0, 10, 'a'), line(10, 14, 'b')]
    const old = [{ startMs: 0, endMs: 14_000, speaker: 'Ann' }]
    expect(nameSpeakers(lines, old, label).map((l) => l.speaker)).toEqual(['Ann', 'Speaker 1'])
  })

  it('names that aren\'t people are skipped', () => {
    const lines = [line(0, 10, '0'), line(10, 20, '1')]
    const old = [{ startMs: 0, endMs: 10_000, speaker: 'Them' }, { startMs: 10_000, endMs: 20_000, speaker: 'Ann' }]
    expect(nameSpeakers(lines, old, label, (n) => n === 'Them').map((l) => l.speaker)).toEqual(['Speaker 1', 'Ann'])
  })

  it('keeps everything but the speaker', () => {
    const out = nameSpeakers([line(5, 6, '0', 'Hi.')], [], label)
    expect(out).toEqual([{ startMs: 5000, endMs: 6000, text: 'Hi.', speaker: 'Speaker 1' }])
  })
})


describe('clips of the voices heard before', () => {
  const L = (startMs: number, endMs: number, speaker: string | null, text = 'x'): CloudLine => ({ startMs, endMs, text, speaker })
  it('go ahead of the chunk, each followed by a pause; the chunk comes after them all', () => {
    const part = new Float32Array(at(3000)).fill(0.5)
    const { audio, windows, prefixMs } = withReferences(part, [{ speaker: '0', samples: new Float32Array(at(2000)).fill(0.1) }, { speaker: '3', samples: new Float32Array(at(1000)).fill(0.2) }])
    expect(windows).toEqual([{ speaker: '0', startMs: 0, endMs: 2000 }, { speaker: '3', startMs: 2000 + REFERENCE_GAP_MS, endMs: 3000 + REFERENCE_GAP_MS }])
    expect(prefixMs).toBe(3000 + 2 * REFERENCE_GAP_MS)
    expect(audio.length).toBe(at(prefixMs) + part.length)
    expect(audio[at(2000) + 10]).toBe(0)
    expect(audio[at(prefixMs)]).toBe(0.5)
    expect(withReferences(part, [])).toEqual({ audio: part, windows: [], prefixMs: 0 })
  })
  it("say which voice before each of the provider's voices is: the clip it spoke over most", () => {
    const windows = [{ speaker: '0', startMs: 0, endMs: 2000 }, { speaker: '3', startMs: 3600, endMs: 4600 }]
    // the provider numbers them its own way; its "b" spilled a little into the first clip; "c" said nothing in them
    const map = fromReferences([L(0, 2000, 'a'), L(1800, 1900, 'b'), L(3600, 4600, 'b'), L(4700, 4800, 'c'), L(0, 2000, null)], windows)
    expect(Object.fromEntries(map)).toEqual({ a: '0', b: '3' })
    // one voice split in two by the provider: both halves are that speaker
    expect(Object.fromEntries(fromReferences([L(0, 1000, 'a'), L(1000, 2000, 'z')], windows))).toEqual({ a: '0', z: '0' })
    // under half a second is not enough
    expect(fromReferences([L(1700, 2100, 'a')], windows).size).toBe(0)
  })
  it("a clip is the middle of a line said alone, long enough, at most REFERENCE_MS", () => {
    const samples = new Float32Array(at(20_000)).map((_, i) => i / at(20_000))
    const lines = [L(10_000, 12_000, '1'), L(12_500, 22_000, '2'), L(13_000, 13_400, '3'), L(14_000, 26_000, '4'), L(16_000, 17_000, '5')]
    // on meeting time: the chunk starts at 10 s
    const clip = clipOf(lines[0], lines, samples, 10_000)!
    expect(clip.length).toBe(at(1700))
    expect(clip[0]).toBeCloseTo(at(150) / at(20_000), 5)
    expect(clipOf(lines[1], lines, samples, 10_000)).toBeUndefined() // someone spoke over it
    expect(clipOf(lines[2], lines, samples, 10_000)).toBeUndefined() // too short
    expect(clipOf(L(10_000, 25_000, '6'), [L(10_000, 25_000, '6')], samples, 10_000)!.length).toBe(at(REFERENCE_MS))
    expect(clipOf(L(28_000, 31_000, '7'), [], samples, 10_000)).toBeUndefined() // past the chunk
    expect(clipOf(L(10_000, 12_000, null), [], samples, 10_000)).toBeUndefined()
  })
})
