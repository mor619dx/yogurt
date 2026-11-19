import { FakeEngine } from '../notes/fake'
import { fakePrompts } from '../fake'
import { SAYS } from '../asr/fake'

/** the one key the fake OpenRouter takes */
export const FAKE_KEY = 'sk-or-test-0000'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const failure = (status: number) => json(status, { error: { code: status, message: status === 401 ? 'No auth credentials found' : status === 402 ? 'Insufficient credits' : 'Rate limited' } })

/**
 * Fake mode: OpenRouter without the network. The key FAKE_KEY works; chat answers come from the fake notes engine; the
 * speech model hears the e2e fixtures' script, the other side's two lines as two voices, and a third voice the call app
 * never named ("Can everyone hear me?"). YOGURT_FAKE_OPENROUTER_FAIL=401,
 * 402 or 429 makes every chat and speech request fail that way. What was asked is in fakePrompts.openrouter.
 */
export function fakeOpenRouterFetch(): typeof fetch {
  const engine = new FakeEngine()
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const path = url.pathname.replace(/^\/api\/v1/, '')
    const auth = new Headers(init?.headers).get('authorization')
    const fail = Number(process.env.YOGURT_FAKE_OPENROUTER_FAIL) || 0
    if (path === '/key') return auth === `Bearer ${FAKE_KEY}` ? json(200, { data: { label: 'fake' } }) : failure(401)
    if (path === '/models') return json(200, { data: url.searchParams.get('output_modalities') === 'transcription'
      ? [{ id: 'deepgram/nova-3', name: 'Deepgram: Nova 3', context_length: 0 }, { id: 'openai/whisper-1', name: 'OpenAI: Whisper', context_length: 0 }]
      : [{ id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', context_length: 200_000 }, { id: 'openai/gpt-5.5', name: 'OpenAI: GPT-5.5', context_length: 400_000 }] })
    const ep = path.match(/^\/models\/(.+)\/endpoints$/)
    if (ep) return json(200, { data: { id: ep[1], endpoints: [{ tag: ep[1].startsWith('deepgram/') ? 'deepgram' : 'openai' }] } })
    if (auth !== `Bearer ${FAKE_KEY}`) return failure(401)
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (path === '/chat/completions') {
      fakePrompts.openrouter.push({ path, model: body.model })
      if (fail) return failure(fail)
      const messages = body.messages as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
      const enc = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode(': OPENROUTER PROCESSING\n\n'))
          await engine.chat({ messages }, (t) => c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)), init?.signal ?? undefined).catch(() => {})
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (path === '/audio/transcriptions') {
      const speakers = !!body.provider
      // the fixtures are short: one part per track, the mic's request without provider options
      const track = speakers ? 'them' : 'me'
      fakePrompts.openrouter.push({ path, model: body.model, language: body.language, provider: body.provider, speakers })
      if (fail) return failure(fail)
      const segments = [...SAYS[track].map((s, i) => ({ start: s.at / 1000, end: s.end / 1000, text: s.text, ...(speakers ? { speaker: i % 2 } : {}) })),
        ...(speakers ? [{ start: 15.2, end: 16.4, text: 'Can everyone hear me?', speaker: 2 }] : [])]
      return json(200, { language: body.language ?? 'en', duration: 15, text: segments.map((s) => s.text).join(' '), segments, usage: { seconds: 15, cost: 0.001 } })
    }
    return json(404, { error: { code: 404, message: 'Not found' } })
  }) as typeof fetch
}
