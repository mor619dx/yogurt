import { LoadingContent } from './LoadingContent'
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Languages } from 'lucide-react'
import type { Spoken } from '../../../shared/spoken'
import { t } from '../../../shared/i18n'
import { useLanguage } from '../i18n'
import { sortedSpoken, spokenLabel } from '../spokenNames'

/** Settings → Language: the language new meetings start in; each meeting's own is picked under its note */
export function SpokenSetting() {
  const locale = useLanguage()
  const [spoken, setSpoken] = useState<Spoken>()
  useEffect(() => { void window.yogurt.settings.get().then((p) => setSpoken(p.spoken)) }, [])
  const all = useMemo(() => sortedSpoken(locale), [locale])
  const choose = (v: Spoken) => { setSpoken(v); void window.yogurt.settings.setSpoken(v) }
  return (
    <LoadingContent pending={!spoken}><div className="settings-row" data-kind="spoken">
      <span className="settings-permission-icon"><Languages size={17} strokeWidth={1.75} aria-hidden="true" /></span>
      <div className="settings-row-copy">
        <label htmlFor="settings-spoken" className="settings-label">{t('Spoken language')}</label>
        <p id="settings-spoken-description" className="settings-description">{t('Used for new meetings. You can change it for each meeting from its note.')}</p>
      </div>
      <span className="settings-select-wrap">
        <select id="settings-spoken" data-testid="settings-spoken" aria-describedby="settings-spoken-description" value={spoken ?? 'en'} disabled={!spoken} onChange={(e) => choose(e.target.value)} className="settings-select">
          {all.map((c) => <option key={c} value={c}>{spokenLabel(c, locale)}</option>)}
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div></LoadingContent>
  )
}
