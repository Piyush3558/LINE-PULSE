import { useEffect, useState, type FormEvent } from 'react';
import { api, type Account, type Endpoint, type Machine, type Mapping, type MappingInput, type Module, type Read } from './api.js';

type SignalInput = MappingInput['signals'][number];
const defaultSignals: SignalInput[] = ['cycle_start', 'cycle_complete'].map(signal_code => ({ signal_code, plc_device: '', data_type: 'bool' }));
const cleanSignal = ({ signal_code, plc_device, data_type, word_order, scale_factor, engineering_unit, verification_status, evidence_reference }: SignalInput): SignalInput =>
  ({ signal_code, plc_device, data_type, word_order: word_order || null, scale_factor: scale_factor || null, engineering_unit: engineering_unit || null, verification_status, evidence_reference: evidence_reference || null });

function MachineForm({ machine, save }: { machine?: Machine; save: (data: unknown) => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await save({ machine_code: data.get('code'), machine_name: data.get('name'), time_zone: data.get('zone'),
      poll_interval_seconds: Number(data.get('seconds')), collector_key: String(data.get('key') || '').trim() || null, enabled: data.has('enabled') });
  }
  return <form onSubmit={submit} className="form-grid">
    <label>Machine code<input name="code" required readOnly={!!machine} defaultValue={machine?.machine_code} pattern="[A-Za-z0-9_\-]{1,40}" /></label>
    <label>Machine name<input name="name" required maxLength={120} defaultValue={machine?.machine_name} /></label>
    <label>Time zone<input name="zone" required defaultValue={machine?.time_zone ?? 'Asia/Kolkata'} /></label>
    <label>Poll interval in seconds<input name="seconds" type="number" required min="2" max="3600" defaultValue={machine?.poll_interval_seconds ?? 5} /></label>
    <label className="wide">Collector installation ID<input name="key" placeholder="Installation UUID" defaultValue={machine?.collector_key ?? ''} /></label>
    <label className="check"><input name="enabled" type="checkbox" defaultChecked={machine?.enabled ?? false} /> Enable collection</label>
    <button className="primary" type="submit">{machine ? 'Save machine' : 'Add machine'}</button>
  </form>;
}

function MappingEditor({ machine, module, endpoints }: { machine: Machine; module: Module; endpoints: Endpoint[] }) {
  const base = `/machines/${machine.machine_id}/modules/${module.module_id}/mappings`;
  const [versions, setVersions] = useState<Mapping[]>([]);
  const [version, setVersion] = useState('new');
  const [purpose, setPurpose] = useState<MappingInput['purpose']>('commissioning');
  const [endpoint, setEndpoint] = useState(endpoints[0]?.endpoint_id ?? '');
  const [signals, setSignals] = useState<SignalInput[]>(defaultSignals);
  const [reads, setReads] = useState<Read[]>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);

  function choose(item?: Mapping) {
    setVersion(item?.mapping_version_id ?? 'new');
    setPurpose(item?.purpose ?? 'commissioning');
    setEndpoint(item?.endpoint_id ?? endpoints[0]?.endpoint_id ?? '');
    setSignals(item?.signals.map(cleanSignal) ?? defaultSignals);
    setReads(item?.reads);
    setRevision(number => number + 1);
  }
  useEffect(() => {
    let live = true;
    void api<Mapping[]>(base).then(data => { if (live) { setVersions(data); choose(data[0]); } }).catch(err => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [base]);

  const selected = versions.find(item => item.mapping_version_id === version);
  const published = !!selected?.published_at;
  const changed = selected && (endpoint !== selected.endpoint_id || purpose !== selected.purpose
    || JSON.stringify(signals.map(cleanSignal)) !== JSON.stringify(selected.signals.map(cleanSignal)));
  const body = () => ({ endpoint_id: endpoint, purpose, signals: signals.map(cleanSignal) });

  function update(index: number, patch: Partial<SignalInput>) {
    setReads(undefined);
    setSignals(current => current.map((signal, i) => i === index ? { ...signal, ...patch } : signal));
  }

  async function run(action: 'preview' | 'save' | 'publish') {
    setNotice('');
    setError('');
    setBusy(true);
    try {
      if (action === 'preview') {
        setReads((await api<{ reads: Read[] }>(`${base}/preview`, 'POST', body())).reads);
      } else {
        let id = version;
        if (action === 'save') {
          const saved = await api<Mapping>(version === 'new' ? base : `${base}/${version}`, version === 'new' ? 'POST' : 'PUT', body());
          id = saved.mapping_version_id;
        } else {
          await api(`${base}/${id}/publish`, 'POST');
        }
        const data = await api<Mapping[]>(base);
        setVersions(data);
        choose(data.find(item => item.mapping_version_id === id));
        setNotice(action === 'save' ? 'Draft saved' : 'Mapping published and activated');
      }
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="panel setup-panel"><div className="section-head"><h2>{module.module_code} signal mapping</h2>
    <button onClick={() => choose()}>New draft</button></div>
    <div className="version-row"><label>Version<select value={version} onChange={event => choose(versions.find(item => item.mapping_version_id === event.target.value))}>
      <option value="new">New draft</option>{versions.map(item => <option key={item.mapping_version_id} value={item.mapping_version_id}>v{item.version_number} · {item.purpose} · {item.published_at ? 'Published' : 'Draft'}</option>)}</select></label>
      {selected && <button onClick={() => { setVersion('new'); setPurpose('production'); setReads(undefined); setSignals(selected.signals.map(cleanSignal)); setEndpoint(selected.endpoint_id); }}>Copy to production draft</button>}
    </div>
    <form key={revision} onSubmit={event => { event.preventDefault(); void run('save'); }}>
      <fieldset disabled={published || busy}>
        <div className="filters">
          <label>PLC endpoint<select required value={endpoint} onChange={event => { setEndpoint(event.target.value); setReads(undefined); }}><option value="">Select an endpoint</option>{endpoints.map(item => <option key={item.endpoint_id} value={item.endpoint_id}>{item.ip_address}:{item.port} · Unit {item.unit_id}</option>)}</select></label>
          <label>Purpose<select value={purpose} onChange={event => setPurpose(event.target.value as typeof purpose)}><option value="commissioning">Commissioning</option><option value="production">Production</option></select></label>
        </div>
        <div className="signal-list">
          {signals.map((signal, index) => <div className="signal" key={index}>
            <label>Signal code<input required value={signal.signal_code} onChange={event => update(index, { signal_code: event.target.value })} /></label>
            <label>PLC device<input required placeholder="M130 or D400" value={signal.plc_device} onChange={event => update(index, { plc_device: event.target.value })} /></label>
            <label>Data type<select value={signal.data_type} onChange={event => update(index, { data_type: event.target.value as SignalInput['data_type'] })}>
              <option value="bool">Boolean</option><option value="uint16">Unsigned 16-bit</option><option value="int16">Signed 16-bit</option><option value="uint32">Unsigned 32-bit</option><option value="int32">Signed 32-bit</option></select></label>
            {signal.data_type.endsWith('32') && <label>Word order<select value={signal.word_order ?? ''} onChange={event => update(index, { word_order: (event.target.value || null) as SignalInput['word_order'] })}>
              <option value="">Select order</option><option value="high_word_first">High word first</option><option value="low_word_first">Low word first</option></select></label>}
            {signal.data_type !== 'bool' && <><label>Scale factor<input inputMode="decimal" value={signal.scale_factor ?? ''} onChange={event => update(index, { scale_factor: event.target.value })} /></label>
              <label>Engineering unit<input value={signal.engineering_unit ?? ''} onChange={event => update(index, { engineering_unit: event.target.value })} /></label></>}
            <label>Verification<select value={signal.verification_status ?? 'candidate'} onChange={event => update(index, { verification_status: event.target.value as SignalInput['verification_status'] })}>
              <option value="candidate">Candidate</option><option value="user_provided_unverified">Unverified</option><option value="user_provided_ladder_confirmed">Ladder confirmed</option><option value="verified">Verified</option></select></label>
            <label>Evidence reference<input value={signal.evidence_reference ?? ''} onChange={event => update(index, { evidence_reference: event.target.value })} /></label>
            {!published && <button className="remove" type="button" onClick={() => { setReads(undefined); setSignals(current => current.filter((_, i) => i !== index)); }}>Remove</button>}
          </div>)}
        </div>
        {!published && <div className="actions mapping-actions"><button type="button" onClick={() => { setReads(undefined); setSignals(current => [...current, { signal_code: '', plc_device: '', data_type: 'uint16' }]); }}>Add signal</button>
          <button type="button" onClick={() => void run('preview')}>Preview requests</button><button className="primary" type="submit">Save draft</button></div>}
      </fieldset>
    </form>
    {reads && <details className="read-plan" open><summary>Read plan · {reads.length} requests</summary><div className="table-wrap"><table>
      <thead><tr><th>Function</th><th>Address</th><th>Quantity</th><th>Request bytes</th></tr></thead>
      <tbody>{reads.map(read => <tr key={`${read.function_code}-${read.address}`}><td>FC0{read.function_code}</td><td>{read.address}</td><td>{read.quantity}</td><td><code>{read.request_hex.match(/../g)?.join(' ')}</code></td></tr>)}</tbody>
    </table></div></details>}
    {selected && !published && <button className="primary publish" type="button" disabled={busy || changed || !reads} onClick={() => void run('publish')}>Publish saved version</button>}
    {notice && <p className="notice" role="status">{notice}</p>}{error && <p className="notice error" role="alert">{error}</p>}
  </section>;
}

function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState('');
  const load = () => api<Account[]>('/users').then(setAccounts).catch(err => setError(err.message));
  useEffect(() => { void load(); }, []);
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError('');
    try { await api('/users', 'POST', Object.fromEntries(new FormData(form))); form.reset(); await load(); }
    catch (err) { setError((err as Error).message); }
  }
  return <section className="panel setup-panel"><h2>User accounts</h2>
    <form className="form-grid" onSubmit={add}>
      <label>Username<input name="username" required /></label><label>Temporary password<input name="password" type="password" minLength={12} required /></label>
      <label>Role<select name="role"><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select></label>
      <button className="primary">Add user</button>
    </form>
    <ul className="record-list">{accounts.map(account => <li key={account.user_id}><span>{account.username} <small>{account.role}</small></span>
      <button onClick={() => { setError(''); void api(`/users/${account.user_id}`, 'PATCH', { enabled: !account.enabled }).then(load).catch(err => setError(err.message)); }}>{account.enabled ? 'Disable' : 'Enable'}</button></li>)}</ul>
    {error && <p className="notice error">{error}</p>}
  </section>;
}

export function Setup({ machine, refresh }: { machine?: Machine; refresh: (id?: string) => Promise<void> }) {
  const [tab, setTab] = useState<'machine' | 'accounts'>('machine');
  const [creating, setCreating] = useState(false);
  const [modules, setModules] = useState<Module[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [selected, setSelected] = useState('');
  const [editingModule, setEditingModule] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const base = `/machines/${machine?.machine_id}`;

  async function reload() {
    if (!machine) return;
    const [stations, nodes] = await Promise.all([api<Module[]>(`${base}/modules`), api<Endpoint[]>(`${base}/endpoints`)]);
    setModules(stations);
    setEndpoints(nodes);
    setSelected(id => stations.some(module => module.module_id === id) ? id : stations[0]?.module_id ?? '');
  }
  useEffect(() => { void reload().catch(err => setError(err.message)); }, [base]);

  async function change(fn: () => Promise<void>, message: string) {
    setError('');
    setNotice('');
    try { await fn(); setNotice(message); }
    catch (err) { setError((err as Error).message); }
  }
  const module = modules.find(item => item.module_id === selected);
  const isNew = creating || !machine;
  return <>
    <div className="section-head setup-heading"><h1>Setup</h1><div className="actions"><button className={tab === 'machine' ? 'primary' : ''} onClick={() => setTab('machine')}>Machines</button><button className={tab === 'accounts' ? 'primary' : ''} onClick={() => setTab('accounts')}>Users</button></div></div>
    {tab === 'accounts' ? <Accounts /> : <>
      {(error || notice) && <p className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}</p>}
      <div className="setup-grid">
        <section className="panel setup-panel"><div className="section-head"><h2>{isNew ? 'New machine' : 'Machine details'}</h2>
          {machine && <button onClick={() => setCreating(!creating)}>{creating ? 'Cancel' : 'New machine'}</button>}</div>
          <MachineForm key={isNew ? 'new' : JSON.stringify(machine)} machine={isNew ? undefined : machine} save={data => change(async () => {
            const saved = await api<Machine>(isNew ? '/machines' : base, isNew ? 'POST' : 'PUT', data);
            setCreating(false);
            await refresh(saved.machine_id);
          }, isNew ? 'Machine added' : 'Machine saved')} />
        </section>
        {!isNew && <section className="panel setup-panel"><h2>PLC endpoints</h2>
          <form className="form-grid endpoint-form" onSubmit={event => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            void change(async () => { await api(`${base}/endpoints`, 'POST', { ip_address: data.get('address'), port: Number(data.get('port')), unit_id: Number(data.get('unit')) }); form.reset(); await reload(); }, 'Endpoint added');
          }}>
            <label>IP address<input name="address" placeholder="192.168.1.71" required /></label><label>TCP port<input name="port" type="number" min="1" max="65535" defaultValue="502" required /></label>
            <label>Unit ID<input name="unit" type="number" min="0" max="255" defaultValue="1" required /></label><button>Add endpoint</button>
          </form>
          <ul className="record-list">{endpoints.map(item => <li key={item.endpoint_id}><code>{item.ip_address}:{item.port}</code><span>Unit {item.unit_id}</span></li>)}</ul>
        </section>}
      </div>
      {!isNew && machine && <>
        <section className="panel setup-panel">
          <div className="section-head"><h2>Modules</h2><button onClick={() => setEditingModule(!editingModule)}>{editingModule ? 'Add a different module' : 'Edit selected module'}</button></div>
          <div className="module-picker" aria-label="Choose a module">{modules.map(item => <button key={item.module_id} className={item.module_id === selected ? 'primary' : ''} onClick={() => setSelected(item.module_id)}>{item.module_code}</button>)}</div>
          <form key={editingModule ? JSON.stringify(module) : 'new'} className="form-grid module-form" onSubmit={event => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const edit = editingModule && module;
            void change(async () => {
              const saved = await api<Module>(`${base}/modules${edit ? '/' + module.module_id : ''}`, edit ? 'PUT' : 'POST',
                { module_code: data.get('code'), display_order: Number(data.get('order')), enabled: data.has('enabled') });
              if (!edit) form.reset();
              await reload();
              setSelected(saved.module_id);
            }, edit ? 'Module saved' : 'Module added');
          }}>
            <label>Module code<input name="code" required pattern="[A-Za-z0-9_\-]{1,40}" defaultValue={editingModule ? module?.module_code : ''} /></label>
            <label>Display order<input type="number" name="order" min="0" max="9999" required defaultValue={editingModule ? module?.display_order : (modules.length + 1) * 10} /></label>
            <label className="check"><input type="checkbox" name="enabled" defaultChecked={editingModule ? module?.enabled : false} /> Enable module</label>
            <button className="primary">{editingModule && module ? 'Save module' : 'Add module'}</button>
          </form>
        </section>
        {module && <MappingEditor key={module.module_id} machine={machine} module={module} endpoints={endpoints} />}
      </>}
    </>}
  </>;
}
