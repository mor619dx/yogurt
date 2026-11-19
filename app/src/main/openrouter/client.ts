/**
 * OpenRouter, for people who bring their own key: one OpenAI-compatible API for the notes model and for speech to text.
 * Nothing here logs, and no error carries the key or what was sent: errors are shown to people and end up in logs.
 */

/** OpenRouter's speech-to-text answer (verbose_json); speakers only from providers that tell voices apart */
export type SttResponse = {
  text?: string; language?: string; duration?: number
  segments?: Array<{ start: number; end: number; text: string; speaker?: number | string }>
  words?: Array<{ word: string; start: number; end: number; speaker?: number | string }>
  usage?: { seconds?: number; cost?: number }
}

/** what went wrong, as the app tells people: a bad key, no credits, too many requests, offline, a model that can't take it, ... */
export type Problem = 'auth' | 'credits' | 'rate' | 'network' | 'model' | 'server' | 'too-large'

export class OpenRouterError extends Error {
  kind: Problem
  status?: number
  constructor(kind: Problem, message: string, status?: number) {
    super(message)
    this.name = 'OpenRouterError'
    this.kind = kind
    if (status !== undefined) this.status = status
  }
}

export const problemOf = (e: unknown): OpenRouterError['kind'] | undefined => (e instanceof OpenRouterError ? e.kind : undefined)

const BASE = 'https://openrouter.ai/api/v1'
/** OpenRouter's app attribution: who is calling, shown on the person's activity page */
const ATTRIBUTION = { 'HTTP-Referer': 'https://yogurt.so', 'X-Title': 'Yogurt' }
/** the model lists change a few times a day at most */
const CACHE_MS = 3_600_000
const MAX_MESSAGE = 300

/** by HTTP status; one nobody expects is the server's fault when 5xx, the request's otherwise */
function kindOf(status: number): Problem {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'credits'
  if (status === 408) return 'network'
  if (status === 413) return 'too-large'
  if (status === 429) return 'rate'
  if (status >= 500) return 'server'
  return 'model'
}

/** an error's code: a status (in an error body), or a name such as 'server_error' (in a chunk that ends a stream early) */
function kindOfCode(code: unknown, status?: number): Problem {
  const n = typeof code === 'number' ? code : typeof code === 'string' && /^\d{3}$/.test(code) ? Number(code) : NaN
  if (n >= 400) return kindOf(n)
  const c = typeof code === 'string' ? code.toLowerCase() : ''
  if (/auth|key|forbidden/.test(c)) return 'auth'
  if (/credit|payment|billing/.test(c)) return 'credits'
  if (/rate_limit|rate limit|too_many/.test(c)) return 'rate'
  if (/too_large|too large/.test(c)) return 'too-large'
  if (/timeout|network/.test(c)) return 'network'
  if (/invalid|not_found|model|context|bad_request/.test(c)) return 'model'
  return status && status >= 400 ? kindOf(status) : 'server'
}

/** no key in a message, however a provider worded it, and short enough to show */
function clean(message: string, key?: string): string {
  let m = key ? message.split(key).join('[key]') : message
  m = m.replace(/sk-or-[\w-]+/g, '[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]')
  return m.length > MAX_MESSAGE ? `${m.slice(0, MAX_MESSAGE - 1)}…` : m
}

type ErrorBody = { code?: unknown; message?: unknown }
const fromBody = (err: ErrorBody, fallback: string, key: string | undefined, status?: number): OpenRouterError => {
  const code = typeof err.code === 'number' ? err.code : undefined
  return new OpenRouterError(kindOfCode(err.code, status), clean(typeof err.message === 'string' && err.message.trim() ? err.message.trim() : fallback, key), code ?? status)
}

/** a failed request: only the provider's own error message is kept, never the raw body (it can echo the request) */
async function failure(res: Response, key: string | undefined): Promise<OpenRouterError> {
  let message = ''
  try {
    const j = JSON.parse(await res.text()) as { error?: ErrorBody }
    if (typeof j?.error?.message === 'string') message = j.error.message.trim()
  } catch { /* not JSON: the status says enough */ }
  return new OpenRouterError(kindOf(res.status), clean(message || `OpenRouter answered ${res.status}`, key), res.status)
}

export type ModelInfo = { id: string; name: string; contextLength: number }

/**
 * Calls OpenRouter with the key read at each call, so a key changed in settings counts at once.
 * Every call but the model lists needs a key; without one it fails as 'auth' before anything is sent.
 * A stopped call (its signal) throws the abort as it is, except chatStream, which keeps what was written, like the local engine.
 */
export function createOpenRouter(o: { key: () => string | undefined; fetchFn?: typeof fetch; base?: string }) {
  const fetchFn = o.fetchFn ?? fetch
  const base = (o.base ?? BASE).replace(/\/+$/, '')
  const cache = new Map<string, { at: number; value: unknown }>()

  /** the key given, else the one stored */
  const keyFor = (given: string | undefined, needed: boolean): string | undefined => {
    const key = (given ?? o.key())?.trim() || undefined
    if (!key && needed) throw new OpenRouterError('auth', 'No OpenRouter key')
    return key
  }

  const send = async (path: string, r: { key?: string; body?: unknown; signal?: AbortSignal }): Promise<Response> => {
    const headers: Record<string, string> = { ...ATTRIBUTION }
    if (r.key) headers.Authorization = `Bearer ${r.key}`
    if (r.body !== undefined) headers['Content-Type'] = 'application/json'
    let res: Response
    try {
      res = await fetchFn(`${base}${path}`, { method: r.body === undefined ? 'GET' : 'POST', headers, ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }), ...(r.signal ? { signal: r.signal } : {}) })
    } catch (e) {
      if (r.signal?.aborted) throw e
      throw new OpenRouterError('network', clean(`Could not reach OpenRouter${e instanceof Error && e.message ? ` (${e.message})` : ''}`, r.key))
    }
    if (!res.ok) throw await failure(res, r.key)
    return res
  }

  /** a JSON answer; a 200 that carries an error is still one */
  const read = async <T>(res: Response, signal: AbortSignal | undefined, key: string | undefined): Promise<T> => {
    let j: unknown
    try { j = await res.json() } catch (e) {
      if (signal?.aborted) throw e
      throw e instanceof SyntaxError ? new OpenRouterError('server', 'OpenRouter sent an answer that could not be read', res.status) : new OpenRouterError('network', 'The answer from OpenRouter was cut off', res.status)
    }
    const err = (j as { error?: unknown } | null)?.error
    if (err && typeof err === 'object') throw fromBody(err as ErrorBody, 'OpenRouter could not answer', key, res.status)
    return j as T
  }

  const cached = async <T>(id: string, load: () => Promise<T>): Promise<T> => {
    const hit = cache.get(id)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T
    const value = await load()
    cache.set(id, { at: Date.now(), value })
    return value
  }

  return {
    /** the key works (given, else the stored one): throws an OpenRouterError ('auth' for a wrong one) when it doesn't */
    async checkKey(key?: string): Promise<void> {
      const k = keyFor(key, true)
      await read(await send('/key', { key: k }), undefined, k)
    },

    /** the models people can pick, for notes (text out) or for speech to text; the key is sent when there is one */
    async models(kind: 'chat' | 'transcription', signal?: AbortSignal): Promise<ModelInfo[]> {
      return cached(`models:${kind}`, async () => {
        const key = keyFor(undefined, false)
        const j = await read<{ data?: unknown }>(await send(kind === 'chat' ? '/models' : '/models?output_modalities=transcription', { key, signal }), signal, key)
        type Raw = { id?: unknown; name?: unknown; context_length?: unknown; top_provider?: { context_length?: unknown } }
        return (Array.isArray(j.data) ? (j.data as Raw[]) : []).flatMap((m): ModelInfo[] => {
          if (!m || typeof m.id !== 'string' || !m.id) return []
          const context = typeof m.context_length === 'number' ? m.context_length : typeof m.top_provider?.context_length === 'number' ? m.top_provider.context_length : 0
          return [{ id: m.id, name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : m.id, contextLength: context }]
        })
      })
    },

    /** the providers serving a model, by tag ('deepgram'): which provider options a request can carry */
    async endpoints(id: string, signal?: AbortSignal): Promise<string[]> {
      return cached(`endpoints:${id}`, async () => {
        const key = keyFor(undefined, false)
        const path = `/models/${id.split('/').map(encodeURIComponent).join('/')}/endpoints`
        const j = await read<{ data?: { endpoints?: Array<{ tag?: unknown }> } }>(await send(path, { key, signal }), signal, key)
        const tags = (Array.isArray(j.data?.endpoints) ? j.data.endpoints : []).map((e) => e?.tag).filter((t): t is string => typeof t === 'string' && !!t)
        return [...new Set(tags)]
      })
    },

    /**
     * One streamed answer: onToken gets each piece of the text (a reasoning model's thoughts, sent apart, are left out).
     * Stopped: resolves with what was written so far. An error mid-answer throws, as does a stream that ends without [DONE].
     */
    async chatStream(body: Record<string, unknown>, onToken: (t: string) => void, signal?: AbortSignal): Promise<string> {
      const key = keyFor(undefined, true)
      let text = ''
      if (signal?.aborted) return text
      let res: Response
      try { res = await send('/chat/completions', { key, body: { ...body, stream: true }, signal }) } catch (e) {
        if (signal?.aborted) return text
        throw e
      }
      const reader = res.body?.getReader()
      if (!reader) throw new OpenRouterError('server', 'OpenRouter sent no answer', res.status)
      // a fetch whose body ignores the signal still stops here
      const stop = () => { reader.cancel().catch(() => {}) }
      signal?.addEventListener('abort', stop, { once: true })
      const decoder = new TextDecoder()
      let pending = ''
      let done = false
      /** one line of the stream; true at [DONE]. Blank lines and comments (': OPENROUTER PROCESSING', sent while it waits) are skipped. */
      const line = (raw: string): boolean => {
        const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (!l.startsWith('data:')) return false
        const data = l.slice(5).trim()
        if (data === '[DONE]') return true
        let chunk: { error?: ErrorBody; choices?: Array<{ delta?: { content?: unknown } }> }
        try { chunk = JSON.parse(data) } catch { return false }
        if (chunk?.error && typeof chunk.error === 'object') throw fromBody(chunk.error, 'OpenRouter stopped the answer', key)
        const t = chunk?.choices?.[0]?.delta?.content
        if (typeof t === 'string' && t) { text += t; onToken(t) }
        return false
      }
      try {
        while (!done && !signal?.aborted) {
          let r: ReadableStreamReadResult<Uint8Array>
          try { r = await reader.read() } catch {
            if (signal?.aborted) return text
            throw new OpenRouterError('network', 'The answer from OpenRouter was cut off')
          }
          if (r.done) { pending += decoder.decode(); if (pending && !signal?.aborted) done = line(pending); break }
          pending += decoder.decode(r.value, { stream: true })
          let nl: number
          while (!done && !signal?.aborted && (nl = pending.indexOf('\n')) >= 0) {
            const l = pending.slice(0, nl)
            pending = pending.slice(nl + 1)
            done = line(l)
          }
        }
        if (!done && !signal?.aborted) throw new OpenRouterError('network', 'The answer from OpenRouter was cut off')
        return text
      } finally {
        signal?.removeEventListener('abort', stop)
        // past [DONE], stopped or failed: let the connection go (a closed stream ignores this)
        stop()
      }
    },

    /** speech to text: body as OpenRouter's /audio/transcriptions takes it (model, input_audio, ...) */
    async transcribe(body: Record<string, unknown>, signal?: AbortSignal): Promise<SttResponse> {
      const key = keyFor(undefined, true)
      return read<SttResponse>(await send('/audio/transcriptions', { key, body, signal }), signal, key)
    },
  }
}
export type OpenRouter = ReturnType<typeof createOpenRouter>
