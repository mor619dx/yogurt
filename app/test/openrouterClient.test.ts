import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenRouter, OpenRouterError, problemOf } from '../src/main/openrouter/client'

const KEY = 'sk-or-v1-0123456789abcdef'
const enc = new TextEncoder()

type Call = { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown>; signal?: AbortSignal }

/** a stand-in fetch: records each request and answers with the next reply (the last one again when they run out) */
function stub(...replies: Array<(c: Call) => Response | Promise<Response>>) {
  const calls: Call[] = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const c: Call = { url: String(url), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), ...(init?.signal ? { signal: init.signal } : {}) }
    calls.push(c)
    return replies[Math.min(calls.length - 1, replies.length - 1)](c)
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
/** a server-sent event stream delivered in the pieces given (cut anywhere, mid-line included) */
const sse = (...pieces: string[]) => () => new Response(new ReadableStream<Uint8Array>({ start(c) { for (const p of pieces) c.enqueue(enc.encode(p)); c.close() } }), { headers: { 'content-type': 'text/event-stream' } })
const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
const client = (fetchFn: typeof fetch, key: string | undefined = KEY) => createOpenRouter({ key: () => key, fetchFn })

afterEach(() => { vi.useRealTimers() })

describe('requests', () => {
  it('sends the key and the app attribution on every request, to the default base', async () => {
    const { fetchFn, calls } = stub(json({ data: {} }), json({ data: [] }), json({ data: { endpoints: [] } }), sse('data: [DONE]\n\n'), json({ text: '' }))
    const c = client(fetchFn)
    await c.checkKey()
    await c.models('chat')
    await c.endpoints('openai/whisper-1')
    await c.chatStream({ model: 'm' }, () => {})
    await c.transcribe({ model: 's' })
    expect(calls.map((x) => x.url)).toEqual([
      'https://openrouter.ai/api/v1/key',
      'https://openrouter.ai/api/v1/models',
      'https://openrouter.ai/api/v1/models/openai/whisper-1/endpoints',
      'https://openrouter.ai/api/v1/chat/completions',
      'https://openrouter.ai/api/v1/audio/transcriptions',
    ])
    for (const x of calls) {
      expect(x.headers.Authorization).toBe(`Bearer ${KEY}`)
      expect(x.headers['HTTP-Referer']).toBe('https://yogurt.so')
      expect(x.headers['X-Title']).toBe('Yogurt')
    }
    expect(calls.map((x) => x.method)).toEqual(['GET', 'GET', 'GET', 'POST', 'POST'])
    expect(calls[3].headers['Content-Type']).toBe('application/json')
  })

  it('takes another base, without a trailing slash doubling up', async () => {
    const { fetchFn, calls } = stub(json({ data: {} }))
    await createOpenRouter({ key: () => KEY, fetchFn, base: 'http://localhost:9/v1/' }).checkKey()
    expect(calls[0].url).toBe('http://localhost:9/v1/key')
  })

  it('without a key, fails as auth before sending anything (model lists excepted)', async () => {
    const { fetchFn, calls } = stub(json({ data: [{ id: 'a/b', name: 'B', context_length: 1000 }] }))
    const c = createOpenRouter({ key: () => undefined, fetchFn })
    for (const e of await Promise.all([c.checkKey(), c.chatStream({}, () => {}), c.transcribe({})].map((p) => p.catch((x) => x)))) {
      expect(e).toBeInstanceOf(OpenRouterError)
      expect(e.kind).toBe('auth')
    }
    expect(calls).toHaveLength(0)
    expect(await c.models('chat')).toEqual([{ id: 'a/b', name: 'B', contextLength: 1000 }])
    expect(calls[0].headers.Authorization).toBeUndefined()
    expect(calls[0].headers['X-Title']).toBe('Yogurt')
  })

  it('reads the key at each call', async () => {
    let key: string | undefined = 'sk-or-one'
    const { fetchFn, calls } = stub(json({ data: {} }))
    const c = createOpenRouter({ key: () => key, fetchFn })
    await c.checkKey()
    key = 'sk-or-two'
    await c.checkKey()
    expect(calls.map((x) => x.headers.Authorization)).toEqual(['Bearer sk-or-one', 'Bearer sk-or-two'])
  })
})

describe('checkKey', () => {
  it('checks the key given over the stored one', async () => {
    const { fetchFn, calls } = stub(json({ data: { label: 'x' } }))
    await client(fetchFn).checkKey('sk-or-typed')
    expect(calls[0].headers.Authorization).toBe('Bearer sk-or-typed')
  })

  it('throws auth for a key OpenRouter refuses', async () => {
    const { fetchFn } = stub(json({ error: { code: 401, message: 'No auth credentials found' } }, 401))
    const e = await client(fetchFn).checkKey('sk-or-wrong').catch((x) => x)
    expect(e).toBeInstanceOf(OpenRouterError)
    expect(e.kind).toBe('auth')
    expect(e.status).toBe(401)
    expect(e.message).toBe('No auth credentials found')
  })

  it('an empty key typed in is refused, not swapped for the stored one', async () => {
    const { fetchFn, calls } = stub(json({ data: {} }))
    expect(problemOf(await client(fetchFn).checkKey('  ').catch((x) => x))).toBe('auth')
    expect(calls).toHaveLength(0)
  })
})

describe('models', () => {
  const list = { data: [{ id: 'openai/gpt-x', name: 'GPT X', context_length: 128000, pricing: {} }, { id: 'meta/llama', context_length: 8192 }, { name: 'no id' }, { id: 'other/m', name: 'M', top_provider: { context_length: 4096 } }] }

  it('lists chat models as id, name and context', async () => {
    const { fetchFn } = stub(json(list))
    expect(await client(fetchFn).models('chat')).toEqual([
      { id: 'openai/gpt-x', name: 'GPT X', contextLength: 128000 },
      { id: 'meta/llama', name: 'meta/llama', contextLength: 8192 },
      { id: 'other/m', name: 'M', contextLength: 4096 },
    ])
  })

  it('asks for speech-to-text models by output modality', async () => {
    const { fetchFn, calls } = stub(json({ data: [{ id: 'openai/whisper-1', name: 'Whisper', context_length: 0 }] }))
    expect(await client(fetchFn).models('transcription')).toEqual([{ id: 'openai/whisper-1', name: 'Whisper', contextLength: 0 }])
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/models?output_modalities=transcription')
  })

  it('keeps each list for an hour, apart from the other kind', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { fetchFn, calls } = stub(json(list))
    const c = client(fetchFn)
    await c.models('chat')
    await c.models('chat')
    expect(calls).toHaveLength(1)
    await c.models('transcription')
    expect(calls).toHaveLength(2)
    vi.setSystemTime(new Date('2026-01-01T00:59:00Z'))
    await c.models('chat')
    expect(calls).toHaveLength(2)
    vi.setSystemTime(new Date('2026-01-01T01:00:01Z'))
    await c.models('chat')
    expect(calls).toHaveLength(3)
  })

  it('does not keep a failure', async () => {
    const { fetchFn, calls } = stub(json({ error: { message: 'down' } }, 503), json(list))
    const c = client(fetchFn)
    expect(problemOf(await c.models('chat').catch((x) => x))).toBe('server')
    expect(await c.models('chat')).toHaveLength(3)
    expect(calls).toHaveLength(2)
  })

  it('passes the signal on, and a stop throws the abort itself', async () => {
    const ac = new AbortController()
    const { fetchFn, calls } = stub((c) => new Promise((_, reject) => c.signal!.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')))))
    const p = client(fetchFn).models('chat', ac.signal)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    ac.abort()
    const e = await p.catch((x) => x)
    expect(e).not.toBeInstanceOf(OpenRouterError)
    expect(e.name).toBe('AbortError')
  })
})

describe('endpoints', () => {
  it('lists the provider tags once each, kept for an hour', async () => {
    const { fetchFn, calls } = stub(json({ data: { id: 'x', endpoints: [{ tag: 'deepgram', name: 'Deepgram' }, { tag: 'openai' }, { tag: 'deepgram' }, { name: 'untagged' }] } }))
    const c = client(fetchFn)
    expect(await c.endpoints('openai/whisper-1')).toEqual(['deepgram', 'openai'])
    expect(await c.endpoints('openai/whisper-1')).toEqual(['deepgram', 'openai'])
    expect(calls).toHaveLength(1)
  })

  it('escapes each part of the id', async () => {
    const { fetchFn, calls } = stub(json({ data: { endpoints: [] } }))
    expect(await client(fetchFn).endpoints('a b/c:free')).toEqual([])
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/models/a%20b/c%3Afree/endpoints')
  })
})

describe('chatStream', () => {
  it('streams the content, whatever the pieces cut, skipping comments, reasoning and what comes after [DONE]', async () => {
    const text = [
      ': OPENROUTER PROCESSING\n\n',
      delta('Hel'),
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'thinking hard', content: '' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: null, reasoning: 'more' } }] })}\r\n\r\n`,
      ': OPENROUTER PROCESSING\n\n',
      delta('lo, wörld 你好'),
      delta('!'),
      'data: [DONE]\n\n',
      delta('after the end'),
    ].join('')
    // cut in three at many places: mid-line, mid-JSON, inside multi-byte characters
    const bytes = enc.encode(text)
    for (const [i, j] of [[1, 2], [7, 40], [30, 31], [bytes.length - 20, bytes.length - 5], [100, 180]]) {
      const { fetchFn } = stub(() => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, i)); c.enqueue(bytes.slice(i, j)); c.enqueue(bytes.slice(j)); c.close() } })))
      const tokens: string[] = []
      expect(await client(fetchFn).chatStream({ model: 'm' }, (t) => tokens.push(t))).toBe('Hello, wörld 你好!')
      expect(tokens.join('')).toBe('Hello, wörld 你好!')
      expect(tokens).not.toContain('')
    }
  })

  it('sends the body with stream on', async () => {
    const { fetchFn, calls } = stub(sse(delta('ok'), 'data: [DONE]\n'))
    await client(fetchFn).chatStream({ model: 'a/b', messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 9 }, () => {})
    expect(calls[0].body).toEqual({ model: 'a/b', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 9 })
  })

  it('reads a last line with no newline after it', async () => {
    const { fetchFn } = stub(sse(delta('a'), 'data: [DONE]'))
    expect(await client(fetchFn).chatStream({}, () => {})).toBe('a')
  })

  it('a stream that ends without [DONE] was cut off', async () => {
    const { fetchFn } = stub(sse(delta('half an ans')))
    const e = await client(fetchFn).chatStream({}, () => {}).catch((x) => x)
    expect(e).toBeInstanceOf(OpenRouterError)
    expect(e.kind).toBe('network')
  })

  it('an error mid-answer throws, by its code', async () => {
    for (const [code, kind] of [[429, 'rate'], [502, 'server'], ['server_error', 'server'], [402, 'credits'], ['context_length_exceeded', 'model']] as const) {
      const tokens: string[] = []
      const { fetchFn } = stub(sse(delta('Some'), `data: ${JSON.stringify({ error: { code, message: 'Provider disconnected' }, choices: [{ delta: { content: '' }, finish_reason: 'error' }] })}\n\n`, 'data: [DONE]\n\n'))
      const e = await client(fetchFn).chatStream({}, (t) => tokens.push(t)).catch((x) => x)
      expect(e).toBeInstanceOf(OpenRouterError)
      expect(e.kind).toBe(kind)
      expect(e.message).toBe('Provider disconnected')
      expect(tokens).toEqual(['Some'])
    }
  })

  it('stopped while streaming: resolves with what was written', async () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>
    const { fetchFn } = stub(() => new Response(new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })))
    const ac = new AbortController()
    const tokens: string[] = []
    const p = client(fetchFn).chatStream({}, (t) => tokens.push(t), ac.signal)
    await vi.waitFor(() => expect(ctrl).toBeDefined())
    ctrl.enqueue(enc.encode(delta('Hel') + delta('lo')))
    await vi.waitFor(() => expect(tokens).toEqual(['Hel', 'lo']))
    ac.abort()
    expect(await p).toBe('Hello')
    expect(tokens).toEqual(['Hel', 'lo'])
  })

  it('stopped where the body errors with the abort (as fetch does): still resolves', async () => {
    const ac = new AbortController()
    let ctrl!: ReadableStreamDefaultController<Uint8Array>
    const { fetchFn } = stub((c) => {
      const body = new ReadableStream<Uint8Array>({ start(x) { ctrl = x } })
      c.signal!.addEventListener('abort', () => ctrl.error(new DOMException('stopped', 'AbortError')))
      return new Response(body)
    })
    const p = client(fetchFn).chatStream({}, () => {}, ac.signal)
    await vi.waitFor(() => expect(ctrl).toBeDefined())
    ctrl.enqueue(enc.encode(delta('So far')))
    await new Promise((r) => setTimeout(r, 10))
    ac.abort()
    expect(await p).toBe('So far')
  })

  it('stopped before an answer: resolves empty; already stopped: sends nothing', async () => {
    const ac = new AbortController()
    const { fetchFn, calls } = stub((c) => new Promise((_, reject) => c.signal!.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')))))
    const p = client(fetchFn).chatStream({}, () => {}, ac.signal)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    ac.abort()
    expect(await p).toBe('')
    expect(await client(fetchFn).chatStream({}, () => {}, ac.signal)).toBe('')
    expect(calls).toHaveLength(1)
  })

  it('a connection lost mid-answer is a network problem', async () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>
    const { fetchFn } = stub(() => new Response(new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })))
    const p = client(fetchFn).chatStream({}, () => {})
    await vi.waitFor(() => expect(ctrl).toBeDefined())
    ctrl.enqueue(enc.encode(delta('a')))
    ctrl.error(new TypeError('terminated'))
    expect(problemOf(await p.catch((x) => x))).toBe('network')
  })
})

describe('transcribe', () => {
  it('posts the JSON body and returns the answer', async () => {
    const answer = { text: 'hi there', language: 'en', duration: 2.5, segments: [{ start: 0, end: 2.5, text: 'hi there', speaker: 0 }], usage: { seconds: 2.5, cost: 0.001 } }
    const { fetchFn, calls } = stub(json(answer))
    const body = { model: 'openai/whisper-1', input_audio: { data: 'UklGRg==', format: 'wav' }, response_format: 'verbose_json', timestamp_granularities: ['segment', 'word'] }
    expect(await client(fetchFn).transcribe(body)).toEqual(answer)
    expect(calls[0].body).toEqual(body)
    expect(calls[0].headers['Content-Type']).toBe('application/json')
  })

  it('a 200 that carries an error throws it', async () => {
    const { fetchFn } = stub(json({ error: { code: 413, message: 'Audio too long' } }))
    const e = await client(fetchFn).transcribe({}).catch((x) => x)
    expect(e.kind).toBe('too-large')
    expect(e.message).toBe('Audio too long')
  })

  it('an answer that is not JSON is the server\'s fault', async () => {
    const { fetchFn } = stub(() => new Response('<html>oops</html>', { status: 200 }))
    expect(problemOf(await client(fetchFn).transcribe({}).catch((x) => x))).toBe('server')
  })
})

describe('errors', () => {
  it.each([
    [401, 'auth'], [403, 'auth'], [402, 'credits'], [429, 'rate'], [400, 'model'], [404, 'model'], [422, 'model'],
    [413, 'too-large'], [500, 'server'], [502, 'server'], [503, 'server'],
  ] as const)('%i is %s', async (status, kind) => {
    const { fetchFn } = stub(json({ error: { code: status, message: `Problem ${status}` } }, status))
    for (const call of [(c: ReturnType<typeof client>) => c.transcribe({}), (c: ReturnType<typeof client>) => c.chatStream({}, () => {})]) {
      const e = await call(client(fetchFn)).catch((x) => x)
      expect(e).toBeInstanceOf(OpenRouterError)
      expect(e.kind).toBe(kind)
      expect(e.status).toBe(status)
      expect(e.message).toBe(`Problem ${status}`)
      expect(problemOf(e)).toBe(kind)
    }
  })

  it('a body that is not JSON: the status says it, and the body is never repeated', async () => {
    const { fetchFn } = stub(() => new Response('bad request: {"messages":"SECRET PROMPT"}', { status: 400 }))
    const e = await client(fetchFn).chatStream({ messages: 'SECRET PROMPT' }, () => {}).catch((x) => x)
    expect(e.kind).toBe('model')
    expect(e.message).toBe('OpenRouter answered 400')
  })

  it('a long message is cut to 300 characters', async () => {
    const { fetchFn } = stub(json({ error: { code: 400, message: 'x'.repeat(1000) } }, 400))
    const e = await client(fetchFn).transcribe({}).catch((x) => x)
    expect(e.message.length).toBe(300)
  })

  it('no network is network', async () => {
    const { fetchFn } = stub(() => Promise.reject(new TypeError('fetch failed')))
    const c = client(fetchFn)
    for (const e of await Promise.all([c.checkKey(), c.models('chat'), c.endpoints('a/b'), c.chatStream({}, () => {}), c.transcribe({})].map((p) => p.catch((x) => x)))) {
      expect(e).toBeInstanceOf(OpenRouterError)
      expect(e.kind).toBe('network')
      expect(e.status).toBeUndefined()
    }
  })

  it('never says the key, however it came back', async () => {
    const { fetchFn } = stub(
      json({ error: { code: 401, message: `Key ${KEY} is not valid` } }, 401),
      () => Promise.reject(new TypeError(`fetch failed for Bearer ${KEY}`)),
      sse(`data: ${JSON.stringify({ error: { code: 'server_error', message: `upstream saw ${KEY}` } })}\n\n`),
      json({ error: { code: 403, message: 'sk-or-v1-someotherkey was disabled' } }, 403),
    )
    const c = client(fetchFn)
    const errors = [await c.checkKey().catch((x) => x), await c.transcribe({}).catch((x) => x), await c.chatStream({}, () => {}).catch((x) => x), await c.checkKey('sk-or-v1-someotherkey').catch((x) => x)]
    for (const e of errors) {
      expect(e).toBeInstanceOf(OpenRouterError)
      expect(e.message).not.toContain(KEY)
      expect(e.message).not.toContain('sk-or-')
      expect(String(e.stack)).not.toContain(KEY)
    }
    expect(errors[0].message).toBe('Key [key] is not valid')
  })

  it('problemOf: only for OpenRouter errors', () => {
    expect(problemOf(new OpenRouterError('credits', 'no credits', 402))).toBe('credits')
    expect(problemOf(new Error('x'))).toBeUndefined()
    expect(problemOf('x')).toBeUndefined()
    expect(problemOf(undefined)).toBeUndefined()
  })
})
