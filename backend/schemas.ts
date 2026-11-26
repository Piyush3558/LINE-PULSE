import { Type, type Static } from '@sinclair/typebox';
const obj = <P extends Parameters<typeof Type.Object>[0]>(properties: P) => Type.Object(properties, { additionalProperties: false });
const txt = (maxLength = 120) => Type.String({ minLength: 1, maxLength });
const id = Type.String({ pattern: '^[1-9][0-9]{0,17}$' });
const uuid = Type.String({ pattern: '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' });
const code = Type.String({ pattern: '^[A-Za-z0-9_-]{1,40}$' });
const choice = <T extends string>(...values: T[]) => Type.Unsafe<T>({ type: 'string', enum: values });
const nullableText = (max = 500) => Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: max })]));
const signal = obj({
  signal_code: Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }),
  plc_device: txt(12),
  data_type: choice('bool', 'uint16', 'int16', 'uint32', 'int32'),
  word_order: Type.Optional(Type.Union([choice('high_word_first', 'low_word_first'), Type.Null()])),
  scale_factor: nullableText(25),
  engineering_unit: nullableText(50),
  verification_status: Type.Optional(choice('candidate', 'user_provided_unverified', 'user_provided_ladder_confirmed', 'verified')),
  evidence_reference: nullableText(),
});
const password = Type.String({ minLength: 12, maxLength: 200 });
export const schemas = {
  login: obj({ username: txt(80), password: txt(200) }),
  user: obj({ username: Type.String({ pattern: '^[a-zA-Z0-9_.-]{1,80}$' }), password, role: choice('admin', 'operator', 'viewer') }),
  userId: obj({ userId: id }),
  userEnabled: obj({ enabled: Type.Boolean() }),
  machineId: obj({ machineId: id }),
  moduleId: obj({ machineId: id, moduleId: id }),
  versionId: obj({ machineId: id, moduleId: id, versionId: id }),
  commandId: obj({ machineId: id, commandId: uuid }),
  exportKind: obj({ machineId: id, kind: choice('samples', 'events') }),
  machine: obj({ machine_code: code, machine_name: txt(), time_zone: txt(80), poll_interval_seconds: Type.Integer({ minimum: 2, maximum: 3600 }), enabled: Type.Boolean(), collector_key: Type.Optional(Type.Union([uuid, Type.Null()])) }),
  module: obj({ module_code: code, display_order: Type.Integer({ minimum: 0, maximum: 9999 }), enabled: Type.Boolean() }),
  endpoint: obj({ ip_address: txt(64), port: Type.Integer({ minimum: 1, maximum: 65535 }), unit_id: Type.Integer({ minimum: 0, maximum: 255 }) }),
  mapping: obj({ endpoint_id: id, purpose: choice('commissioning', 'production'), signals: Type.Array(signal, { minItems: 2, maxItems: 100 }) }),
  command: obj({ action: choice('check', 'start', 'stop') }),
  archiveQuery: obj({ module_id: Type.Optional(id), cursor: Type.Optional(id) }),
  history: obj({
    module_id: Type.Optional(id),
    from: Type.Optional(txt(40)),
    to: Type.Optional(txt(40)),
    cursor: Type.Optional(txt(512)),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    purpose: Type.Optional(choice('production', 'commissioning', 'all')),
  }),
};
export type Body<K extends keyof typeof schemas> = Static<(typeof schemas)[K]>;
