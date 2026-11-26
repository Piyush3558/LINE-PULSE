import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, displayTime, type Account, type Command, type History, type Machine, type ModuleStatus, type Status } from './api.js';
import { Setup } from './setup.js';
import './style.css';

function Pulse({ size = 28 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M3 16h6l4-9 6 18 4-9h6" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function SignIn({ onSignIn }: { onSignIn: (user: Account) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try { onSignIn(await api<Account>('/login', 'POST', Object.fromEntries(data))); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="signin"><form className="panel login" onSubmit={submit}>
    <div className="brand-mark"><Pulse /></div><h1>Line Pulse</h1>
    <p className="muted">Sign in to view your machines.</p>
    <label>Username<input name="username" autoComplete="username" required /></label>
    <label>Password<input name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required /></label>
    <label className="check"><input type="checkbox" checked={showPassword} onChange={event => setShowPassword(event.target.checked)} /> Show password</label>
    {error && <p className="notice error" role="alert">{error}</p>}
    <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
  </form></main>;
}

function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}><i />{children}</span>;
}

function ModuleCard({ item, zone, collecting }: { item: ModuleStatus; zone: string; collecting: boolean }) {
  const state = !item.enabled ? 'Disabled' : !item.active_mapping_version_id ? 'Unconfigured' : !item.record ? 'Awaiting data'
    : item.record.purpose === 'archived' ? 'Archived' : item.stale || !collecting ? 'Stale' : 'Live';
  const row = item.record;
  const lastError = item.error && (!row || Date.parse(item.error.observed_at) >= Date.parse(row.observed_at)) ? item.error : null;
  const interrupted = lastError && /^(PLC closed the connection|PLC read interrupted)\b/.test(lastError.message);
  const errorMessage = interrupted
    ? collecting && state !== 'Live' && 'Waiting for a fresh PLC reading'
    : lastError?.message;
  return <article className="panel station">
    <div className="station-head"><h3>{item.module_code}</h3><Badge tone={state === 'Live' ? 'good' : state === 'Stale' ? 'warn' : ''}>{state}</Badge></div>
    <div className="metrics">
      <div><span>OK total</span><strong>{row?.ok_total ?? '—'}</strong></div>
      <div><span>NG total</span><strong>{row?.ng_total ?? '—'}</strong></div>
      <div><span>Cycle time</span><strong>{row?.cycle_time_seconds != null ? `${row.cycle_time_seconds} s` : row?.cycle_time_raw != null ? `${row.cycle_time_raw} raw` : '—'}</strong></div>
    </div>
    <div className="station-foot">
      {row ? <><span>{displayTime(row.observed_at, zone)}</span><span className="tag">{row.purpose}</span></> : <span>No readings stored</span>}
    </div>
    {row && <div className="bits"><span>Start <b>{row.cycle_start == null ? '—' : row.cycle_start ? 'ON' : 'OFF'}</b></span><span>Complete <b>{row.cycle_complete == null ? '—' : row.cycle_complete ? 'ON' : 'OFF'}</b></span></div>}
    {errorMessage && <p className="small error-text">{errorMessage}</p>}
  </article>;
}

function HistoryPanel({ machine, modules }: { machine: Machine; modules: ModuleStatus[] }) {
  const [kind, setKind] = useState<'samples' | 'events' | 'archive'>('samples');
  const [module, setModule] = useState('');
  const [purpose, setPurpose] = useState('all');
  const [range, setRange] = useState('24');
  const [history, setHistory] = useState<History>();
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const base = `/machines/${machine.machine_id}`;
  function filters() {
    const now = Date.now();
    const params = kind === 'archive' ? new URLSearchParams() : new URLSearchParams({
      from: new Date(now - Number(range) * 3600000).toISOString(), to: new Date(now).toISOString(), purpose,
    });
    if (module) params.set('module_id', module);
    return params;
  }
  async function load(cursor?: string) {
    const params = cursor ? new URLSearchParams(query) : filters();
    if (!cursor) setQuery(params.toString());
    else params.set('cursor', cursor);
    try {
      const data = await api<History>(`${base}/${kind}?${params}`);
      setHistory(previous => cursor && previous ? { ...data, rows: [...previous.rows, ...data.rows] } : data);
      setError('');
    } catch (err) { setError((err as Error).message); }
  }
  useEffect(() => { let active = true; setHistory(undefined); setError('');
    const params = filters();
    setQuery(params.toString());
    void api<History>(`${base}/${kind}?${params}`).then(data => { if (active) setHistory(data); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [base, kind, module, purpose, range]);
  return <section className="panel history"><div className="section-head"><h2>Reading history</h2>{kind !== 'archive' && <a className="button" href={`/api/v1${base}/exports/${kind}?${query}`}>Download CSV</a>}</div>
    <div className="filters">
      <label>Data<select aria-label="Data" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="samples">Samples</option><option value="events">Events</option><option value="archive">Archived samples</option></select></label>
      <label>Module<select value={module} onChange={event => setModule(event.target.value)}><option value="">All modules</option>{modules.map(item => <option value={item.module_id} key={item.module_id}>{item.module_code}</option>)}</select></label>
      {kind !== 'archive' && <><label>Mapping<select value={purpose} onChange={event => setPurpose(event.target.value)}><option value="all">All mappings</option><option value="production">Production</option><option value="commissioning">Commissioning</option></select></label>
      <label>Period<select value={range} onChange={event => setRange(event.target.value)}><option value="1">Last hour</option><option value="24">Last 24 hours</option><option value="168">Last 7 days</option></select></label></>}
      <button type="button" onClick={() => void load()}>Refresh history</button>
    </div>
    {error ? <p className="notice error">{error}</p> : history?.rows.length ? <div className="table-wrap"><table><thead><tr><th>Observed at</th><th>Module</th><th>{kind === 'archive' ? 'Archive source' : 'Mapping'}</th>{kind !== 'events' ? <><th>OK</th><th>NG</th><th>Cycle time</th></> : <><th>Event</th><th>Counter delta</th></>}</tr></thead>
      <tbody>{history.rows.map((row, index) => <tr key={`${row.archive_id ?? row.poll_id}-${index}`}><td>{displayTime(row.observed_at!, machine.time_zone)}</td><td>{row.module_code}</td><td>{row.source_name ?? row.purpose}</td>{kind !== 'events' ? <><td>{row.ok_total ?? '—'}</td><td>{row.ng_total ?? '—'}</td><td>{row.cycle_time_seconds ? `${row.cycle_time_seconds} s` : row.cycle_time_raw ? `${row.cycle_time_raw} raw` : '—'}</td></> : <><td>{row.event_type?.replaceAll('_', ' ')}</td><td>{row.counter_delta ?? '—'}</td></>}</tr>)}</tbody></table></div>
      : <p className="empty">{history ? 'No readings for this period.' : 'Loading history…'}</p>}
    {history?.next_cursor && <button onClick={() => void load(history.next_cursor!)}>Load more</button>}
  </section>;
}

function Dashboard({ machine, user }: { machine: Machine; user: Account }) {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [active, setActive] = useState('');
  const [notice, setNotice] = useState('');
  const base = `/machines/${machine.machine_id}`;
  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      try { const data = await api<Status>(`${base}/status`); if (mounted) { setStatus(data); setError(''); } }
      catch (err) { if (mounted) setError((err as Error).message); }
      if (mounted) timer = setTimeout(update, 5000);
    };
    void update();
    return () => { mounted = false; clearTimeout(timer); };
  }, [base]);

  async function command(action: string) {
    setActive(action);
    setNotice('');
    try {
      const command = await api<Command>(`${base}/collector-commands`, 'POST', { action });
      for (let attempt = 0; attempt < 32; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const result = await api<Command>(`${base}/collector-commands/${command.command_id}`);
        if (!['pending', 'running'].includes(result.status)) {
          setNotice(result.result?.message ?? `Command ${result.status}`);
          setStatus(await api<Status>(`${base}/status`));
          return;
        }
      }
      setNotice('The collector did not confirm the command.');
    } catch (err) { setNotice((err as Error).message); }
    finally { setActive(''); }
  }

  const collector = status?.collector;
  const collectorState = !collector ? 'Waiting for collector' : collector.stale ? 'Collector offline' : collector.status === 'running' ? 'Collecting' : collector.status === 'blocked' ? 'Collector blocked' : 'Collector stopped';
  const modules = status?.modules ?? [];
  return <>
    <section className="machine-hero"><div><div className="machine-code">{machine.machine_code}</div><h1>{machine.machine_name}</h1><p>{modules.length} {modules.length === 1 ? 'module' : 'modules'} <span>·</span> {machine.time_zone}</p></div>
      <div className="hero-status"><Badge tone={collectorState === 'Collecting' ? 'good' : collectorState === 'Collector blocked' ? 'warn' : ''}>{collectorState}</Badge>{collector ? <span>{collector.pending_polls} queued polls</span> : null}</div></section>
    {user.role !== 'viewer' && <section className="panel controls"><div><h2>PLC collection</h2><span className="muted">{machine.enabled ? `Poll target every ${machine.poll_interval_seconds} seconds` : 'Machine disabled. Enable it in Setup to start polling.'}</span></div>
      <div className="actions"><button onClick={() => void command('check')} disabled={!!active || !machine.collector_key}>Check connection</button><button onClick={() => void command('start')} className="primary" disabled={!!active || !machine.enabled || !machine.collector_key || collectorState === 'Collecting'}>Start collection</button><button onClick={() => void command('stop')} disabled={!!active || collectorState !== 'Collecting'}>Stop</button></div>
      {(active || notice) && <p className="notice" role="status">{active ? 'Waiting for collector…' : notice}</p>}
    </section>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <section className="station-section"><div className="section-head"><h2>Modules</h2><span className="muted">{collectorState === 'Collecting' ? modules.filter(module => module.enabled && module.record && !module.stale).length : 0} live</span></div>
      <div className="station-grid">{modules.map(module => <ModuleCard key={module.module_id} item={module} zone={machine.time_zone} collecting={collectorState === 'Collecting'} />)}</div>
      {!modules.length && <p className="empty panel">{status ? 'Add a module in Setup.' : 'Loading modules…'}</p>}
    </section>
    <HistoryPanel machine={machine} modules={modules} />
  </>;
}

function App() {
  const [user, setUser] = useState<Account | null | undefined>();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selected, select] = useState('');
  const [view, setView] = useState('dashboard');
  const [error, setError] = useState('');
  const [dbOnline, setDbOnline] = useState<boolean>();
  useEffect(() => { void api<Account>('/session').then(setUser).catch(() => setUser(null)); }, []);
  async function refresh(selectId?: string) {
    const list = await api<Machine[]>('/machines');
    setMachines(list);
    select(previous => selectId ?? (list.some(machine => machine.machine_id === previous) ? previous : list[0]?.machine_id ?? ''));
  }
  useEffect(() => {
    if (!user) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const checkDatabase = async () => {
      const ok = await api<{ database: string }>('/health').then(result => result.database === 'postgresql', () => false);
      if (active) { setDbOnline(ok); timer = setTimeout(checkDatabase, 10000); }
    };
    void checkDatabase();
    void refresh().catch(err => {
      if (err instanceof ApiError && err.status === 401) setUser(null);
      else setError(err.message);
    });
    return () => { active = false; clearTimeout(timer); };
  }, [user]);
  const machine = machines.find(item => item.machine_id === selected);
  if (user === undefined) return <main className="signin"><span>Loading Line Pulse…</span></main>;
  if (!user) return <SignIn onSignIn={user => { setUser(user); setView('dashboard'); setError(''); }} />;
  return <div className="shell">
    <header className="topbar"><div className="top-inner"><div className="brand"><div className="brand-mark"><Pulse size={20} /></div>Line Pulse</div>
      <nav aria-label="Primary navigation"><button className={view === 'dashboard' ? 'nav-active' : ''} onClick={() => setView('dashboard')}>Overview</button>{user.role === 'admin' && <button className={view === 'setup' ? 'nav-active' : ''} onClick={() => setView('setup')}>Setup</button>}</nav>
      <div className="account"><span>{user.username}</span><button onClick={() => void api('/logout', 'POST').then(() => setUser(null)).catch(err => setError(err.message))}>Sign out</button></div></div></header>
    <main className="content">
      <div className="toolbar"><label>Machine <select value={selected} onChange={event => select(event.target.value)}>{!machines.length && <option value="">No machines</option>}{machines.map(item => <option key={item.machine_id} value={item.machine_id}>{item.machine_name}</option>)}</select></label>
        {dbOnline !== undefined && <Badge tone={dbOnline ? 'good' : 'warn'}>{dbOnline ? 'PostgreSQL connected' : 'Database unavailable'}</Badge>}</div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {view === 'setup' && user.role === 'admin' ? <Setup key={selected} machine={machine} refresh={refresh} />
        : machine ? <Dashboard key={machine.machine_id} machine={machine} user={user} />
          : <p className="panel empty">No machine selected.</p>}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
