import { usePopoverPresence } from '../motion'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Languages, Search } from 'lucide-react'
import type { Spoken } from '../../../shared/spoken'
import { t } from '../../../shared/i18n'
import { useLanguage } from '../i18n'
import { nativeLabel, sortedSpoken, spokenLabel, spokenMatches } from '../spokenNames'

/**
 * The meeting's spoken language under the note's bar, as a menu with a search: whisper is told this language, so nothing
 * is guessed (Auto-detect, last, leaves whisper to hear it). Choosing counts for the recording going on from its next
 * words; on a finished meeting with its audio, it offers to transcribe it again in that language.
 */
export function SpokenMenu({ meetingId, spoken, onAgain }: { meetingId: string; spoken: Spoken; onAgain?: () => void }) {
  const locale = useLanguage()
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState<Spoken>(spoken)
  const [again, setAgain] = useState<Spoken>()
  const presence = usePopoverPresence(open)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => setShown(spoken), [spoken])
  useEffect(() => { setAgain(undefined) }, [meetingId])

  const all = useMemo(() => sortedSpoken(locale), [locale])
  const list = useMemo(() => all.filter((c) => spokenMatches(c, query, locale)), [all, query, locale])

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  useEffect(() => {
    if (!open) { setQuery(''); return }
    search.current?.focus()
    // the checked language in view
    root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open])

  const choose = (v: Spoken) => {
    setOpen(false); button.current?.focus()
    setShown(v)
    void window.yogurt.meetings.setSpoken(meetingId, v).then((r) => { if (r.ok && r.offerAgain && onAgain) setAgain(v) }).catch(() => {})
  }
  const rows = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])
  const onKey = (e: KeyboardEvent) => {
    const items = rows()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[at < 0 ? 0 : (at + 1) % items.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (at <= 0) search.current?.focus(); else items[at - 1]?.focus() }
    else if (e.key === 'Home' && at >= 0) { e.preventDefault(); items[0]?.focus() }
    else if (e.key === 'End' && at >= 0) { e.preventDefault(); items.at(-1)?.focus() }
    else if (e.key === 'Enter' && document.activeElement === search.current && list.length) { e.preventDefault(); choose(list[0]) }
    else if (e.key === 'Tab') setOpen(false)
  }

  const row = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-start text-sm hover:bg-[var(--line)] focus-visible:bg-[var(--line)] focus-visible:outline-none'
  const name = spokenLabel(shown, locale)
  return (
    <div ref={root} className="relative flex min-w-0 items-center">
      <button ref={button} data-testid="spoken-chip" aria-haspopup="menu" aria-expanded={!!open} title={t('Spoken language')}
        onClick={(e) => setOpen((o) => o ? false : e.detail > 0 ? 'pointer' : 'keyboard')}
        className="bar-btn flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:text-ink aria-expanded:text-ink">
        <Languages size={11} aria-hidden="true" className="shrink-0" />
        <span data-testid="spoken-name" className="truncate">{name}</span>
        <ChevronDown size={11} aria-hidden="true" className="shrink-0" />
      </button>
      {presence.value && (
        <div data-testid="spoken-menu" {...presence.props} data-anchor="bottom-start" role="menu" aria-label={t('Spoken language')} onKeyDown={onKey}
          className="menu-entry absolute bottom-full start-0 z-30 mb-2 flex max-h-[min(420px,60vh)] w-64 flex-col rounded-xl border border-line bg-float p-1.5 text-ink shadow-[var(--shadow)]">
          <label className="mb-1 flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-sm">
            <Search size={13} aria-hidden="true" className="shrink-0 text-muted" />
            <input ref={search} data-testid="spoken-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search languages')} aria-label={t('Search languages')}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted" />
          </label>
          <div className="min-h-0 overflow-y-auto">
            {list.map((c) => {
              const own = nativeLabel(c), label = spokenLabel(c, locale)
              return (
                <button key={c} role="menuitemradio" aria-checked={shown === c} data-testid={`spoken-option-${c}`} onClick={() => choose(c)} className={row}>
                  <span className="truncate">{label}</span>
                  {own && own !== label && <span className="truncate text-xs text-muted" lang={c}>{own}</span>}
                  <Check size={15} aria-hidden="true" className={`ms-auto shrink-0 ${shown === c ? '' : 'invisible'}`} />
                </button>
              )
            })}
            {!list.length && <p data-testid="spoken-none" className="px-3 py-2 text-sm text-muted">{t('No languages found')}</p>}
          </div>
        </div>
      )}
      {again && !open && (
        <div data-testid="spoken-again" role="dialog" aria-label={t('Spoken language')}
          className="absolute bottom-full start-0 z-30 mb-2 flex w-72 flex-col gap-2 rounded-xl border border-line bg-float p-3 text-[13px] text-ink shadow-[var(--shadow)]">
          <p>{t('Transcribe again in {language}?', { language: spokenLabel(again, locale, true) })}</p>
          <div className="flex justify-end gap-2">
            <button data-testid="spoken-again-later" className="workspace-button" onClick={() => setAgain(undefined)}>{t('Not now')}</button>
            <button data-testid="spoken-again-run" className="workspace-button primary" onClick={() => { setAgain(undefined); onAgain?.() }}>{t('Transcribe again')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
