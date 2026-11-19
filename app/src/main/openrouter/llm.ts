import type { Llm } from '../notes/enhance'
import { OpenRouterError, type OpenRouter } from './client'

const MIN_CONTEXT = 8192
const MAX_CONTEXT = 131_072
/** a model OpenRouter doesn't list (or a list that didn't load): a size most models take */
const UNKNOWN_CONTEXT = 32_768
/** routing suffixes OpenRouter takes on any model id but doesn't list */
const ROUTING = /:(nitro|floor|online|exacto)$/

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/**
 * Tokens in a text, roughly: there is no remote tokenizer to ask. About 4 characters a token, and a token a character in
 * Chinese, Japanese and Korean, where 4 to a token would undercount by far and overfill the context.
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return Math.ceil((Array.from(text).length - cjk) / 4 + cjk)
}

/** an earlier prompt and answer, as the conversation they were */
const before = (pairs: string[] = []) => pairs.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content }))

const OPEN = '<think>'
const CLOSE = '</think>'
/**
 * Passes an answer on without a leading <think>…</think>: some providers write a reasoning model's thoughts into the text.
 * The start is held back only while it could still turn out to be "<think>"; the thoughts are never passed on, nor the
 * space after them. Thoughts that never close were all there was (the tokens ran out): nothing is passed on.
 */
function withoutThinking(onToken: (t: string) => void) {
  let state: 'start' | 'think' | 'gap' | 'pass' = 'start'
  let held = ''
  let out = ''
  const emit = (t: string) => { if (t) { out += t; onToken(t) } }
  return {
    feed(t: string): void {
      if (state === 'pass') return emit(t)
      held += t
      if (state === 'start') {
        const lead = held.trimStart()
        if (OPEN.startsWith(lead)) return
        if (!lead.startsWith(OPEN)) { state = 'pass'; const h = held; held = ''; return emit(h) }
        state = 'think'
      }
      if (state === 'think') {
        const end = held.indexOf(CLOSE)
        if (end < 0) return
        held = held.slice(end + CLOSE.length)
        state = 'gap'
      }
      const rest = held.trimStart()
      held = ''
      if (rest) { state = 'pass'; emit(rest) }
    },
    /** the answer as passed on; a start that never turned out to be thoughts goes out now */
    end(): string {
      if (state === 'start') emit(held)
      held = ''
      return out
    },
  }
}

/**
 * The notes model on OpenRouter, as the notes need it (the Llm the local engine also gives). Nothing is loaded: llm()
 * only reads the chosen model's context from the model list, kept for an hour. The context is 90% of what OpenRouter
 * lists (its count is the provider's tokenizer, ours a guess), kept between 8k and 128k: notes split a long meeting into
 * parts anyway, and a huge prompt costs the person money for little gain.
 */
export function createRemoteLlm(o: { client: OpenRouter; model: () => string }) {
  const contextOf = async (model: string, signal?: AbortSignal): Promise<number> => {
    let list: Awaited<ReturnType<OpenRouter['models']>>
    try { list = await o.client.models('chat', signal) } catch (e) {
      if (signal?.aborted) throw e
      return UNKNOWN_CONTEXT
    }
    const m = list.find((x) => x.id === model) ?? list.find((x) => x.id === model.replace(ROUTING, ''))
    if (!m?.contextLength) return UNKNOWN_CONTEXT
    return Math.min(MAX_CONTEXT, Math.max(MIN_CONTEXT, Math.floor(0.9 * m.contextLength)))
  }

  return {
    /** the chosen model; a stopped job's signal stops what it is writing (the answer so far is kept) */
    async llm(signal?: AbortSignal): Promise<Llm> {
      const model = o.model()?.trim()
      if (!model) throw new OpenRouterError('model', 'No OpenRouter model chosen')
      const contextSize = await contextOf(model, signal)
      return {
        contextSize,
        count: async (texts) => texts.map(estimateTokens),
        chat: async (prompt, onToken, opts) => {
          const body = {
            model,
            messages: [...before(opts?.before), { role: 'user', content: prompt }],
            ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
            ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
          }
          const answer = withoutThinking(onToken)
          await o.client.chatStream(body, answer.feed, signal)
          return answer.end()
        },
      }
    },
  }
}
