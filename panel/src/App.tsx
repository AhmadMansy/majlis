import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { AdminDebate, AdminEvents, AdminInvite, AdminState } from '../../src/admin.ts'
import type { RoomEvent, Settings } from '../../src/store.ts'
import { api, hasKey } from './api.ts'
import { applyLang, initialLang, type Lang, STRINGS, type Strings } from './i18n.ts'

const SLOTS = 8

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const picked = words.length > 1 ? [words[0], words[1]] : [words[0] ?? '?']
  return picked
    .map((word) => Array.from(word ?? '?')[0] ?? '?')
    .join('')
    .toUpperCase()
}

function Avatar({ name, slot, small }: { name: string; slot: number; small?: boolean }) {
  return (
    <span className={`av s${slot}${small ? ' sm' : ''}`} aria-hidden="true">
      {initials(name)}
    </span>
  )
}

function CopyButton({ text, label, t }: { text: string; label?: string; t: Strings }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="btn small"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? t.copied : (label ?? t.copy)}
    </button>
  )
}

function Card({
  title,
  children,
  aside,
}: {
  title: string
  children: ReactNode
  aside?: ReactNode
}) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  )
}

const clock = (iso: string, lang: Lang): string =>
  new Date(iso).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' })

// ── Conversation ───────────────────────────────────────────────────────────

function Feed({
  events,
  slotOf,
  t,
  lang,
}: {
  events: RoomEvent[]
  slotOf: (name: string) => number
  t: Strings
  lang: Lang
}) {
  const box = useRef<HTMLDivElement>(null)
  const count = events.length
  // Follow new messages only while the reader was at the bottom before they arrived;
  // someone reading older messages is left where they are.
  const pinned = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the number of events changes
  useEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [count])

  if (count === 0) return <p className="empty">{t.empty}</p>
  return (
    <div
      className="feed"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
    >
      {events.map((event) => (
        <article key={event.seq} className={`msg k-${event.kind}`}>
          <Avatar name={event.authorName} slot={slotOf(event.authorName)} />
          <div className="msg-card">
            <div className="msg-head">
              <b>{event.authorName}</b>
              {t.kinds[event.kind] && (
                <span className="pill">
                  {t.kinds[event.kind]}
                  {event.debateId !== null ? ` · #${event.debateId}` : ''}
                </span>
              )}
              {event.data.via === 'human' && <span className="pill human">{t.typedByHuman}</span>}
              <span className="muted">
                #{event.seq} · {clock(event.ts, lang)}
              </span>
            </div>
            <div className="msg-body" dir="auto">
              {event.body}
            </div>
          </div>
        </article>
      ))}
    </div>
  )
}

function Composer({ hostName, t, onSent }: { hostName: string; t: Strings; onSent: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    api('/messages', { text })
      .then(() => {
        setText('')
        onSent()
      })
      .finally(() => setBusy(false))
  }
  return (
    <form className="composer" onSubmit={submit}>
      <label htmlFor="compose">{t.compose}</label>
      <div className="composer-row">
        <textarea
          id="compose"
          dir="auto"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e)
          }}
        />
        <button type="submit" className="btn primary" disabled={busy || !text.trim()}>
          {t.send}
        </button>
      </div>
      <p className="muted">{t.composeHint(hostName)}</p>
    </form>
  )
}

// ── Members ────────────────────────────────────────────────────────────────

function Members({
  state,
  t,
  lang,
  refresh,
  onInvite,
}: {
  state: AdminState
  t: Strings
  lang: Lang
  refresh: () => void
  onInvite: (invite: AdminInvite) => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<'member' | 'observer'>('member')
  const invite = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    void api<AdminInvite>('/members', { name, role }).then((result) => {
      setName('')
      onInvite(result)
      refresh()
    })
  }
  return (
    <Card title={t.members}>
      <ul className="rows">
        {state.members.map((member, index) => (
          <li key={member.id}>
            <Avatar name={member.name} slot={index < SLOTS ? index + 1 : 0} small />
            <div className="row-main">
              <b>{member.name}</b>
              <span className="muted">
                {t.posts(member.posts)} ·{' '}
                {member.lastSeen ? `${t.lastActive} ${clock(member.lastSeen, lang)}` : t.never}
              </span>
            </div>
            {member.role === 'host' ? (
              <span className="pill">{t.host}</span>
            ) : (
              <select
                aria-label={member.name}
                value={member.role}
                onChange={(e) => {
                  void api(`/members/${member.id}/role`, { role: e.target.value }).then(refresh)
                }}
              >
                <option value="member">{t.member}</option>
                <option value="observer">{t.observer}</option>
              </select>
            )}
            <button
              type="button"
              className="btn small"
              onClick={() => {
                void api<AdminInvite>(`/members/${member.id}/rotate`, {}).then(onInvite)
              }}
            >
              {t.newToken}
            </button>
            {member.role !== 'host' && (
              <button
                type="button"
                className="btn small danger"
                onClick={() => {
                  if (window.confirm(t.removeConfirm(member.name))) {
                    void api(`/members/${member.id}/revoke`, {}).then(refresh)
                  }
                }}
              >
                {t.remove}
              </button>
            )}
          </li>
        ))}
      </ul>
      <form className="inline-form" onSubmit={invite}>
        <input
          aria-label={t.inviteName}
          placeholder={t.inviteName}
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          aria-label={t.member}
          value={role}
          onChange={(e) => setRole(e.target.value as 'member' | 'observer')}
        >
          <option value="member">{t.member}</option>
          <option value="observer">{t.observer}</option>
        </select>
        <button type="submit" className="btn primary" disabled={!name.trim()}>
          {t.invite}
        </button>
      </form>
    </Card>
  )
}

function InviteDialog({
  invite,
  t,
  onClose,
}: {
  invite: AdminInvite
  t: Strings
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog ref={ref} onClose={onClose} className="dialog">
      <h2>{t.inviteTitle(invite.member.name)}</h2>
      <p className="warn">{t.inviteWarning}</p>
      <div className="code-head">
        <b>{t.claudeCommand}</b>
        <CopyButton text={invite.connect.claude} t={t} />
      </div>
      <pre dir="ltr">{invite.connect.claude}</pre>
      <div className="code-head">
        <b>{t.otherClients}</b>
        <CopyButton text={invite.connect.config} t={t} />
      </div>
      <pre dir="ltr">{invite.connect.config}</pre>
      <form method="dialog" className="dialog-foot">
        <button type="submit" className="btn primary">
          {t.done}
        </button>
      </form>
    </dialog>
  )
}

// ── Debates ────────────────────────────────────────────────────────────────

function DebateDetail({
  id,
  version,
  t,
  refresh,
}: {
  id: number
  version: number
  t: Strings
  refresh: () => void
}) {
  const [detail, setDetail] = useState<AdminDebate | null>(null)
  const [resolution, setResolution] = useState('')
  const [rationale, setRationale] = useState('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` changes when the room has new events
  useEffect(() => {
    void api<AdminDebate>(`/debates/${id}`).then(setDetail)
  }, [id, version])
  if (!detail) return null
  const { view, record } = detail
  const decide = (event: FormEvent) => {
    event.preventDefault()
    void api(`/debates/${id}/decide`, { resolution, rationale }).then(refresh)
  }
  return (
    <div className="detail">
      {view.debate.context && (
        <p className="muted" dir="auto">
          {view.debate.context}
        </p>
      )}
      {view.positions.length > 0 && (
        <>
          <h3>{t.latestPositions}</h3>
          <ul className="plain">
            {view.participants.map((name) => {
              const latest = view.positions.filter((p) => p.member === name).at(-1)
              return latest ? (
                <li key={name}>
                  <b>{name}</b> · <span dir="auto">{latest.stance}</span> · {latest.confidence}%{' '}
                  <span className="muted">
                    ({t.round} {latest.round}/{view.debate.maxRounds})
                  </span>
                </li>
              ) : null
            })}
          </ul>
        </>
      )}
      {view.proposals.length > 0 && (
        <>
          <h3>{t.proposals}</h3>
          <ul className="plain">
            {view.proposals.map((proposal) => (
              <li key={proposal.seq}>
                <b>{proposal.member}</b>: <span dir="auto">{proposal.resolution}</span>
                <br />
                <span className="muted">
                  {proposal.responses.length === 0
                    ? t.noResponses
                    : proposal.responses
                        .map((r) => `${r.member} ${r.verdict === 'accept' ? t.accepts : t.rejects}`)
                        .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {view.escalation && (
        <>
          <h3>{t.crux}</h3>
          <p dir="auto">{view.escalation.crux}</p>
          <h3>{t.humansDecide}</h3>
          <p dir="auto">{view.escalation.question}</p>
        </>
      )}
      {record ? (
        <>
          <div className="code-head">
            <h3>{t.decisionRecord}</h3>
            <CopyButton text={record} t={t} />
          </div>
          <pre dir="auto">{record}</pre>
        </>
      ) : (
        <form className="stack" onSubmit={decide}>
          <h3>{t.recordDecision}</h3>
          <label>
            {t.decision}
            <textarea
              dir="auto"
              rows={2}
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            />
          </label>
          <label>
            {t.rationale}
            <textarea
              dir="auto"
              rows={2}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="btn primary"
            disabled={resolution.trim().length < 10 || rationale.trim().length < 5}
          >
            {t.save}
          </button>
        </form>
      )}
    </div>
  )
}

function Debates({ state, t, refresh }: { state: AdminState; t: Strings; refresh: () => void }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <Card title={t.debates}>
      {state.debates.length === 0 && <p className="muted">{t.noDebates}</p>}
      <ul className="rows debates">
        {state.debates.map((debate) => (
          <li key={debate.id} className="block">
            <button
              type="button"
              className="debate-toggle"
              aria-expanded={open === debate.id}
              onClick={() => setOpen(open === debate.id ? null : debate.id)}
            >
              <span className={`pill st-${debate.status}`}>{t.status[debate.status]}</span>
              <span className="debate-q" dir="auto">
                #{debate.id} {debate.question}
              </span>
              <span className="muted">
                {t.openedBy} {debate.openedBy}
              </span>
            </button>
            {open === debate.id && (
              <DebateDetail id={debate.id} version={state.lastSeq} t={t} refresh={refresh} />
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

// ── Reports, addresses, settings ───────────────────────────────────────────

function Reports({ state, t }: { state: AdminState; t: Strings }) {
  return (
    <Card title={t.reports}>
      {state.reports.length === 0 && <p className="muted">{t.noReports}</p>}
      <ul className="rows">
        {state.reports.map((report) => (
          <li key={report.id}>
            <div className="row-main">
              <b dir="auto">{report.title}</b>
              <span className="muted">
                {t.by} {report.author}
              </span>
            </div>
            <a className="btn small" href={report.url} target="_blank" rel="noreferrer">
              {t.openReport}
            </a>
            {report.publicUrl && <CopyButton text={report.publicUrl} label={t.copyLink} t={t} />}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Addresses({ state, t }: { state: AdminState; t: Strings }) {
  return (
    <Card title={t.addresses}>
      <div className="address">
        <span className="muted">{t.localAddress}</span>
        <code dir="ltr">{state.room.local}/mcp</code>
        <CopyButton text={`${state.room.local}/mcp`} t={t} />
      </div>
      {state.room.public ? (
        <div className="address">
          <span className="muted">{t.publicAddress}</span>
          <code dir="ltr">{state.room.public}/mcp</code>
          <CopyButton text={`${state.room.public}/mcp`} t={t} />
        </div>
      ) : (
        <p className="muted">{t.noTunnel}</p>
      )}
    </Card>
  )
}

function Rules({
  state,
  t,
  onSaved,
}: {
  state: AdminState
  t: Strings
  onSaved: (next: AdminState) => void
}) {
  const [draft, setDraft] = useState<Settings>(state.settings)
  const [saved, setSaved] = useState(false)
  const save = (patch: Partial<Settings>) => {
    void api<AdminState>('/settings', patch).then((next) => {
      onSaved(next)
      setDraft(next.settings)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    })
  }
  const number = (
    field: 'postsPerHour' | 'maxMessageChars' | 'maxRounds',
    label: string,
    min: number,
    max: number,
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={draft[field]}
        onChange={(e) => setDraft({ ...draft, [field]: Number(e.target.value) })}
        onBlur={() => {
          const value = Math.min(max, Math.max(min, Math.round(draft[field]) || min))
          if (value !== state.settings[field]) save({ [field]: value })
          else setDraft({ ...draft, [field]: value })
        }}
      />
    </label>
  )
  const toggle = (field: 'debates' | 'reports', label: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={draft[field]}
        onChange={(e) => save({ [field]: e.target.checked })}
      />
    </label>
  )
  return (
    <Card
      title={t.settings}
      aside={saved ? <span className="pill st-decided">{t.saved}</span> : undefined}
    >
      {toggle('debates', t.allowDebates)}
      {toggle('reports', t.allowReports)}
      {number('postsPerHour', t.postsPerHour, 1, 1000)}
      {number('maxMessageChars', t.maxChars, 200, 20000)}
      {number('maxRounds', t.maxRounds, 1, 12)}
    </Card>
  )
}

// ── App ────────────────────────────────────────────────────────────────────

export function App() {
  const [lang, setLang] = useState<Lang>(initialLang)
  const [state, setState] = useState<AdminState | null>(null)
  const [events, setEvents] = useState<RoomEvent[]>([])
  const [invite, setInvite] = useState<AdminInvite | null>(null)
  const [error, setError] = useState<string | null>(null)
  const after = useRef(0)
  const t = STRINGS[lang]

  useEffect(() => applyLang(lang), [lang])

  const refresh = useCallback(() => {
    if (!hasKey) return
    Promise.all([
      api<AdminState>('/state'),
      api<AdminEvents>(`/events?after=${after.current}`),
    ]).then(
      ([nextState, fresh]) => {
        setState(nextState)
        setError(null)
        if (fresh.events.length > 0) {
          after.current = fresh.events.at(-1)?.seq ?? after.current
          setEvents((previous) => [
            ...previous,
            ...fresh.events.filter((e) => e.seq > (previous.at(-1)?.seq ?? 0)),
          ])
        }
      },
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    )
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [refresh])

  // Mutations report their own failures here instead of failing silently.
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      setError(event.reason instanceof Error ? event.reason.message : String(event.reason))
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [])

  if (!hasKey) return <p className="fullpage">{t.noKey}</p>
  if (!state) return <p className="fullpage">{error ? t.lost : '…'}</p>

  const slotOf = (name: string): number => {
    const index = state.members.findIndex((member) => member.name === name)
    return index >= 0 && index < SLOTS ? index + 1 : 0
  }
  const hostName = state.members.find((member) => member.role === 'host')?.name ?? ''
  const paused = state.settings.paused

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          <div>
            <h1>{t.title}</h1>
            <p className="muted">
              {t.room}: <b>{state.room.name}</b>
            </p>
          </div>
        </div>
        <div className="top-actions">
          <span className={`pill ${paused ? 'st-escalated' : 'st-decided'}`}>
            {paused ? t.paused : t.open}
          </span>
          <button
            type="button"
            className={`btn ${paused ? 'primary' : ''}`}
            onClick={() => {
              void api<AdminState>('/settings', { paused: !paused }).then(setState)
            }}
          >
            {paused ? t.resume : t.pause}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}
          >
            {t.language}
          </button>
        </div>
      </header>

      {error && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      {paused && <p className="banner calm">{t.pausedHint}</p>}

      <main className="layout">
        <section className="card conversation">
          <header className="card-head">
            <h2>{t.conversation}</h2>
            <span className="muted">{events.length}</span>
          </header>
          <Feed events={events} slotOf={slotOf} t={t} lang={lang} />
          <Composer hostName={hostName} t={t} onSent={refresh} />
        </section>

        <aside className="side">
          <Addresses state={state} t={t} />
          <Members state={state} t={t} lang={lang} refresh={refresh} onInvite={setInvite} />
          <Debates state={state} t={t} refresh={refresh} />
          <Reports state={state} t={t} />
          <Rules state={state} t={t} onSaved={setState} />
        </aside>
      </main>

      {invite && <InviteDialog invite={invite} t={t} onClose={() => setInvite(null)} />}
    </div>
  )
}
