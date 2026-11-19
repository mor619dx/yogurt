import { describe, expect, it, vi } from 'vitest'
import { createOpenRouter, OpenRouterError, type OpenRouter } from '../src/main/openrouter/client'
import { createRemoteLlm, estimateTokens } from '../src/main/openrouter/llm'

type Body = { model: string; messages: Array<{ role: string; content: string }>; max_tokens?: number; temperature?: number }

/** a stand-in client: a model list, and an answer streamed in the pieces given */
function fake(o: { models?: Array<{ id: string; name?: string; contextLength: number }> | Error; pieces?: string[] } = {}) {
  const asked: Array<{ body: Body; signal?: AbortSignal }> = []
  const client = {
    models: vi.fn(async () => { if (o.models instanceof Error) throw o.models; return (o.models ?? []).map((m) => ({ name: m.id, ...m })) }),
    chatStream: vi.fn(async (body: Record<string, unknown>, onToken: (t: string) => void, signal?: AbortSignal) => {
      asked.push({ body: body as Body, ...(signal ? { signal } : {}) })
      let text = ''
      for (const p of o.pieces ?? []) { text += p; onToken(p) }
      return text
    }),
  } as unknown as OpenRouter
  return { client, asked }
}

const contextFor = async (contextLength: number | undefined, model = 'a/m') => {
  const { client } = fake({ models: contextLength === undefined ? [] : [{ id: 'a/m', contextLength }] })
  return (await createRemoteLlm({ client, model: () => model }).llm()).contextSize
}

describe('contextSize', () => {
  it('is 90% of the listed context, kept between 8k and 128k', async () => {
    expect(await contextFor(100_000)).toBe(90_000)
    expect(await contextFor(32_768)).toBe(29_491)
    expect(await contextFor(200_000)).toBe(131_072)
    expect(await contextFor(1_000_000)).toBe(131_072)
    expect(await contextFor(8_000)).toBe(8192)
    expect(await contextFor(4_096)).toBe(8192)
  })

  it('is 32k for a model the list lacks, or one listed without a context', async () => {
    expect(await contextFor(undefined)).toBe(32_768)
    expect(await contextFor(0)).toBe(32_768)
    expect(await contextFor(100_000, 'other/model')).toBe(32_768)
  })

  it('finds a model asked for with a routing suffix', async () => {
    expect(await contextFor(100_000, 'a/m:nitro')).toBe(90_000)
  })

  it('is 32k when the list cannot be read, but a stop still stops', async () => {
    const { client } = fake({ models: new OpenRouterError('network', 'offline') })
    expect((await createRemoteLlm({ client, model: () => 'a/m' }).llm()).contextSize).toBe(32_768)
    const ac = new AbortController()
    ac.abort()
    const stopped = { ...client, models: async () => { throw new DOMException('stopped', 'AbortError') } } as unknown as OpenRouter
    await expect(createRemoteLlm({ client: stopped, model: () => 'a/m' }).llm(ac.signal)).rejects.toThrow('stopped')
  })

  it('no model chosen is a model problem', async () => {
    const { client } = fake()
    const e = await createRemoteLlm({ client, model: () => ' ' }).llm().catch((x) => x)
    expect(e).toBeInstanceOf(OpenRouterError)
    expect(e.kind).toBe('model')
  })

  it('has no readAhead (nothing is held remotely)', async () => {
    const { client } = fake()
    expect('readAhead' in (await createRemoteLlm({ client, model: () => 'a/m' }).llm())).toBe(false)
  })
})

describe('count', () => {
  it('guesses 4 characters a token, and a token a character in Chinese, Japanese and Korean', async () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('こんにちは')).toBe(5)
    expect(estimateTokens('カタカナ')).toBe(4)
    expect(estimateTokens('안녕하세요')).toBe(5)
    // 6 others (hello and a space) and 2 Han
    expect(estimateTokens('hello 世界')).toBe(4)
    // an emoji is one character, not two code units
    expect(estimateTokens('😀😀😀😀')).toBe(1)
    const { client } = fake()
    const llm = await createRemoteLlm({ client, model: () => 'a/m' }).llm()
    expect(await llm.count(['abcdefgh', '你好世界', ''])).toEqual([2, 4, 0])
  })
})

describe('chat', () => {
  it('asks the chosen model, with the earlier turns before the prompt', async () => {
    const { client, asked } = fake({ pieces: ['Fine'] })
    const llm = await createRemoteLlm({ client, model: () => 'a/m' }).llm()
    expect(await llm.chat('And now?', () => {}, { before: ['First question', 'First answer'], maxTokens: 700, temperature: 0.2, summary: true })).toBe('Fine')
    expect(asked[0].body).toEqual({
      model: 'a/m',
      messages: [{ role: 'user', content: 'First question' }, { role: 'assistant', content: 'First answer' }, { role: 'user', content: 'And now?' }],
      max_tokens: 700,
      temperature: 0.2,
    })
  })

  it('leaves out max_tokens and temperature when not given (temperature 0 is given)', async () => {
    const { client, asked } = fake({ pieces: ['x'] })
    const llm = await createRemoteLlm({ client, model: () => 'a/m' }).llm()
    await llm.chat('Hi', () => {})
    expect(asked[0].body).toEqual({ model: 'a/m', messages: [{ role: 'user', content: 'Hi' }] })
    await llm.chat('Hi', () => {}, { temperature: 0 })
    expect(asked[1].body.temperature).toBe(0)
  })

  it('the model is read when llm() is, and the signal given to llm() stops each chat', async () => {
    let model = 'a/one'
    const { client, asked } = fake({ pieces: ['x'] })
    const remote = createRemoteLlm({ client, model: () => model })
    const ac = new AbortController()
    const llm = await remote.llm(ac.signal)
    model = 'a/two'
    await llm.chat('Hi', () => {})
    expect(asked[0].body.model).toBe('a/one')
    expect(asked[0].signal).toBe(ac.signal)
    await (await remote.llm()).chat('Hi', () => {})
    expect(asked[1].body.model).toBe('a/two')
  })
})

describe('thinking', () => {
  const run = async (pieces: string[]) => {
    const { client } = fake({ pieces })
    const tokens: string[] = []
    const answer = await (await createRemoteLlm({ client, model: () => 'a/m' }).llm()).chat('Hi', (t) => tokens.push(t))
    return { answer, shown: tokens.join(''), tokens }
  }

  it('drops a leading think block, however it is cut, and the space after it', async () => {
    for (const pieces of [
      ['<think>', 'Let me see', '</think>', '\n\n', 'Hello', ' there'],
      ['<th', 'ink>Let me', ' see</th', 'ink>\n\nHel', 'lo there'],
      ['  \n<think>\nhm\n</think>Hello there'],
      ['<', 't', 'h', 'i', 'n', 'k', '>', 'x', '<', '/think>', ' ', '\n', 'Hello there'],
    ]) {
      const r = await run(pieces)
      expect(r.answer).toBe('Hello there')
      expect(r.shown).toBe('Hello there')
      expect(r.shown).not.toContain('see')
    }
  })

  it('passes an answer without thoughts on at once, as it comes', async () => {
    const r = await run(['Hello', ' there', ' <think>not thoughts</think>'])
    expect(r.tokens).toEqual(['Hello', ' there', ' <think>not thoughts</think>'])
    expect(r.answer).toBe('Hello there <think>not thoughts</think>')
  })

  it('holds back only a start that could still be <think>', async () => {
    const r = await run(['<', 'b>Bold</b>'])
    expect(r.tokens).toEqual(['<b>Bold</b>'])
    expect((await run(['<thi'])).answer).toBe('<thi')
    expect((await run(['  '])).answer).toBe('  ')
  })

  it('thoughts that never close leave no answer', async () => {
    const r = await run(['<think>', 'still thinking when the tokens ran out'])
    expect(r.answer).toBe('')
    expect(r.tokens).toEqual([])
  })

  it('through the real client: thoughts streamed as content are stripped', async () => {
    const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
    const body = [': OPENROUTER PROCESSING\n\n', delta('<think>'), delta('plan'), delta('</think>\n'), delta('Notes'), 'data: [DONE]\n\n'].join('')
    const fetchFn = (async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close() } }))) as unknown as typeof fetch
    const client = createOpenRouter({ key: () => 'sk-or-x', fetchFn })
    client.models = async () => [{ id: 'a/m', name: 'M', contextLength: 64_000 }]
    const tokens: string[] = []
    const llm = await createRemoteLlm({ client, model: () => 'a/m' }).llm()
    expect(llm.contextSize).toBe(57_600)
    expect(await llm.chat('Hi', (t) => tokens.push(t))).toBe('Notes')
    expect(tokens).toEqual(['Notes'])
  })

  it('stopped: keeps the answer so far', async () => {
    const ac = new AbortController()
    const client = {
      models: async () => [],
      chatStream: async (_b: unknown, onToken: (t: string) => void, signal?: AbortSignal) => {
        onToken('<think>x</think>Part')
        ac.abort()
        if (signal?.aborted) return '<think>x</think>Part'
        onToken(' more')
        return ''
      },
    } as unknown as OpenRouter
    const llm = await createRemoteLlm({ client, model: () => 'a/m' }).llm(ac.signal)
    expect(await llm.chat('Hi', () => {})).toBe('Part')
  })
})
