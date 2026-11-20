/** What went wrong with OpenRouter, in words the person can act on (main/openrouter/client.ts OpenRouterError) */
export type CloudProblem = 'auth' | 'credits' | 'rate' | 'network' | 'model' | 'server' | 'too-large'

/** what the window is told: a problem, or speaker labels that failed (the transcript from this computer is kept) */
export type CloudNotice = CloudProblem | 'speakers'

/** Settings → Cloud AI as the window sees it: never the key itself, only its last characters */
export type OpenRouterState = {
  /** the saved key's last 4 characters; null: no key */
  keyHint: string | null
  /** false: no keychain here (Linux without a secret service), so the key is only scrambled */
  encrypted: boolean
  chat: boolean; chatModel: string
  speakers: boolean; sttModel: string
  /** advanced: the provider's own options as JSON ('' for the built-in ones) */
  sttOptions: string
}

/** speech models on OpenRouter known to tell voices apart, and the provider options that turn it on (keyed by the endpoint's tag) */
export const SPEAKER_MODELS = ['elevenlabs/scribe-v2', 'microsoft/mai-transcribe-2', 'deepgram/nova-3'] as const
