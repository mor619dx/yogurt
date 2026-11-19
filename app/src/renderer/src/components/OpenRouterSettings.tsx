import { useEffect, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { SPEAKER_MODELS, type CloudNotice, type CloudProblem, type OpenRouterState } from '../../../shared/openRouter'
import { LoadingContent } from './LoadingContent'

/** What went wrong with OpenRouter, said so the person knows what to do */
export const cloudProblemText = (kind: CloudNotice): string => ({
  speakers: t("Couldn't label speakers. The transcript from this computer is kept."),
  auth: t("OpenRouter didn't accept your key. Check it in Settings."),
  credits: t('Your OpenRouter account is out of credits.'),
  rate: t('OpenRouter is busy right now. Try again in a moment.'),
  network: t("Yogurt couldn't reach OpenRouter. Check your internet connection."),
  model: t("OpenRouter couldn't use that model. Pick another in Settings."),
  server: t('OpenRouter had a problem. Try again in a moment.'),
  'too-large': t('That was too much for OpenRouter to take at once.'),
}[kind])

type Models = Array<{ id: string; name: string }>

/**
 * Settings → Cloud AI (OpenRouter): a key, then two switches, each with its model. Off by default; what each switch
 * sends away is said beside it, always.
 */
export function OpenRouterSettings() {
  const [s, setS] = useState<OpenRouterState>()
  const [key, setKey] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyError, setKeyError] = useState<CloudProblem>()
  const [chatModels, setChatModels] = useState<Models>()
  const [sttModels, setSttModels] = useState<Models>()
  const [listFailed, setListFailed] = useState(false)
  const [chatModel, setChatModel] = useState('')
  const [sttModel, setSttModel] = useState('')
  const [options, setOptions] = useState('')
  const [bad, setBad] = useState<'chat' | 'stt' | 'json'>()
  useEffect(() => { void window.yogurt.openRouter.state().then((v) => { setS(v); setChatModel(v.chatModel); setSttModel(v.sttModel); setOptions(v.sttOptions) }) }, [])
  useEffect(() => {
    if (!s?.keyHint) return
    const load = (kind: 'chat' | 'transcription', to: (m: Models) => void) => void window.yogurt.openRouter.models(kind).then((r) => { if (Array.isArray(r)) to(r); else setListFailed(true) }).catch(() => setListFailed(true))
    load('chat', setChatModels)
    // the ones known to tell voices apart first
    load('transcription', (m) => setSttModels([...m].sort((a, b) => Number(!SPEAKER_MODELS.includes(a.id as never)) - Number(!SPEAKER_MODELS.includes(b.id as never)))))
  }, [s?.keyHint])

  const saveKey = async (v: string) => {
    setKeyBusy(true); setKeyError(undefined)
    try {
      const r = await window.yogurt.openRouter.setKey(v)
      if ('error' in r) setKeyError(r.error); else { setS(r.state); setKey('') }
    } catch { setKeyError('network') } finally { setKeyBusy(false) }
  }
  const set = async (patch: Parameters<typeof window.yogurt.openRouter.set>[0], which?: 'chat' | 'stt' | 'json') => {
    const r = await window.yogurt.openRouter.set(patch)
    if ('error' in r) { setBad(which ?? (r.error === 'json' ? 'json' : 'chat')); return }
    setBad(undefined); setS(r.state)
  }
  const field = 'settings-name-field w-full max-w-none'
  const example = 'anthropic/claude-sonnet-5.5'
  return (
    <>
      <h2 className="settings-section-heading">{t('Cloud AI (OpenRouter)')}</h2>
      <LoadingContent pending={!s} testId="openrouter-loading"><div data-testid="openrouter" className="settings-group">
        <div className="settings-row">
          <span className="settings-permission-icon"><KeyRound size={17} strokeWidth={1.75} aria-hidden="true" /></span>
          <div className="settings-row-copy">
            <label htmlFor="openrouter-key" className="settings-label">{t('OpenRouter API key')}</label>
            <p className="settings-description">{s?.keyHint
              ? <span data-testid="openrouter-key-hint">{t('Key ending in {hint}', { hint: s.keyHint })}</span>
              : t('Paste a key from openrouter.ai/keys. Yogurt checks it with OpenRouter before saving it on this computer.')}</p>
            {s && !s.encrypted && s.keyHint && <p className="settings-description">{t('Your key is stored without encryption on this computer.')}</p>}
            {keyError && <p data-testid="openrouter-key-error" role="alert" className="settings-description text-danger">{keyError === 'auth' ? t("That key didn't work. Check it and try again.") : cloudProblemText(keyError)}</p>}
            {!s?.keyHint && <div className="mt-3 flex min-w-0 items-center gap-2">
              <input id="openrouter-key" data-testid="openrouter-key" type="password" dir="ltr" value={key} autoComplete="off" spellCheck={false} placeholder="sk-or-…"
                onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && key.trim()) void saveKey(key) }} className={field} />
              <button data-testid="openrouter-key-save" disabled={!key.trim() || keyBusy} onClick={() => void saveKey(key)} className="workspace-button primary shrink-0">{keyBusy ? t('Checking…') : t('Save key')}</button>
            </div>}
          </div>
          {s?.keyHint && <button data-testid="openrouter-key-remove" disabled={keyBusy} onClick={() => void saveKey('')} className="workspace-button shrink-0">{t('Remove key')}</button>}
        </div>

        {s?.keyHint && <>
          <div className="settings-row">
            <div className="settings-row-copy">
              <p className="settings-label">{t('Use OpenRouter for summaries, titles and answers')}</p>
              <p className="settings-description">{t("Your transcripts, notes and questions are sent to OpenRouter and the model's provider instead of staying on this computer.")}</p>
            </div>
            <button data-testid="openrouter-chat-toggle" role="switch" aria-checked={s.chat} aria-label={t('Use OpenRouter for summaries, titles and answers')}
              onClick={() => void set({ chat: !s.chat })} className="settings-toggle"><span className="settings-toggle-knob" /></button>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <label htmlFor="openrouter-chat-model" className="settings-label">{t('Summaries and answers model')}</label>
              <input id="openrouter-chat-model" data-testid="openrouter-chat-model" list="openrouter-chat-models" dir="ltr" value={chatModel} spellCheck={false} placeholder={example}
                onChange={(e) => setChatModel(e.target.value)} onBlur={() => { if (chatModel.trim() !== s.chatModel) void set({ chatModel }, 'chat') }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} className={`${field} mt-2`} />
              <datalist id="openrouter-chat-models">{chatModels?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
              {bad === 'chat' && <p role="alert" className="settings-description text-danger">{t("That isn't a model ID, like {example}.", { example })}</p>}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <p className="settings-label">{t('Label speakers after each meeting')}</p>
              <p className="settings-description">{t("When a meeting ends, its audio is sent to OpenRouter and the speech model's provider to tell voices apart. If that fails, the transcript from this computer is kept.")}</p>
            </div>
            <button data-testid="openrouter-speakers-toggle" role="switch" aria-checked={s.speakers} aria-label={t('Label speakers after each meeting')}
              onClick={() => void set({ speakers: !s.speakers })} className="settings-toggle"><span className="settings-toggle-knob" /></button>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <label htmlFor="openrouter-stt-model" className="settings-label">{t('Speech model')}</label>
              <input id="openrouter-stt-model" data-testid="openrouter-stt-model" list="openrouter-stt-models" dir="ltr" value={sttModel} spellCheck={false} placeholder={SPEAKER_MODELS[0]}
                onChange={(e) => setSttModel(e.target.value)} onBlur={() => { if (sttModel.trim() !== s.sttModel) void set({ sttModel }, 'stt') }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} className={`${field} mt-2`} />
              <datalist id="openrouter-stt-models">{sttModels?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
              {bad === 'stt' && <p role="alert" className="settings-description text-danger">{t("That isn't a model ID, like {example}.", { example: SPEAKER_MODELS[0] })}</p>}
              {listFailed && <p className="settings-description">{t("Couldn't load the model list. You can still type a model ID.")}</p>}
              <details className="mt-2">
                <summary className="settings-description cursor-default">{t('Provider options (advanced)')}</summary>
                <textarea data-testid="openrouter-stt-options" dir="ltr" rows={3} value={options} spellCheck={false} placeholder='{"deepgram": {"diarize": true}}'
                  onChange={(e) => setOptions(e.target.value)} onBlur={() => { if (options.trim() !== s.sttOptions) void set({ sttOptions: options }, 'json') }}
                  className={`${field} mt-2 font-mono text-[12px]`} />
                <p className="settings-description">{t("Sent as the provider's own options. Leave empty to use the built-in ones.")}</p>
                {bad === 'json' && <p role="alert" className="settings-description text-danger">{t("That isn't valid JSON.")}</p>}
              </details>
            </div>
          </div>
        </>}
      </div></LoadingContent>
    </>
  )
}
