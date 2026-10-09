'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { Messages } from '@/i18n/messages';
import { Button } from '../ui/button';
import { Field, Input } from '../ui/input';
import { Select } from '../ui/select';
import { Textarea } from '../ui/textarea';

/*
 * Form fields generated from zod 4 schemas: number / boolean / enum / string / nested object /
 * record (JSON). Bounds and defaults are read from the schema, so the inspector always matches
 * what validation will accept.
 */

// zod 4 internals used for introspection (stable public-ish surface: `_zod.def`, minValue, options, shape).
interface ZodLike {
  _zod: { def: { type: string; innerType?: ZodLike; defaultValue?: unknown } };
  minValue?: number | null;
  maxValue?: number | null;
  isInt?: boolean;
  options?: readonly string[];
  shape?: Record<string, ZodLike>;
}

export interface Unwrapped {
  inner: ZodLike;
  kind: string;
  optional: boolean;
  defaultValue?: unknown;
}

export function unwrap(schema: unknown): Unwrapped {
  let s = schema as ZodLike;
  let optional = false;
  let defaultValue: unknown;
  for (let i = 0; i < 6; i++) {
    const t = s._zod.def.type;
    if (t === 'default' || t === 'prefault') {
      defaultValue = s._zod.def.defaultValue;
      optional = true;
    } else if (t === 'optional' || t === 'nullable') {
      optional = true;
    } else break;
    s = s._zod.def.innerType!;
  }
  return { inner: s, kind: s._zod.def.type, optional, defaultValue };
}

export function humanizeKey(key: string): string {
  const s = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/MiB|GiB/g, (m) => ` ${m}`).replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/ mib/, ' MiB').replace(/ gib/, ' GiB');
}

/** Default object for an optional nested object (uses defaults, else the minimum, else 1). */
export function defaultObject(shape: Record<string, ZodLike>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) {
    const u = unwrap(v);
    if (u.defaultValue !== undefined) out[k] = structuredClone(u.defaultValue);
    else if (u.optional) continue;
    else if (u.kind === 'number') out[k] = Math.max(1, u.inner.minValue ?? 1);
    else if (u.kind === 'boolean') out[k] = false;
    else if (u.kind === 'enum') out[k] = u.inner.options?.[0];
    else if (u.kind === 'string') out[k] = '';
  }
  return out;
}

type FieldsT = ReturnType<typeof useTranslations<'fields'>>;
type FieldKey = keyof Messages['schemaFields'];

/** Translated label for a template schema field; unknown keys are humanized. */
export function useFieldLabel() {
  const t = useTranslations('schemaFields');
  return (key: string): string => (t.has(key as FieldKey) ? t(key as FieldKey) : humanizeKey(key));
}

function rangeHint(u: Unwrapped, t: FieldsT): string | undefined {
  const parts: string[] = [];
  if (u.kind === 'number') {
    const min = u.inner.minValue;
    const max = u.inner.maxValue;
    const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < Number.MAX_SAFE_INTEGER;
    if (finite(min) && finite(max)) parts.push(t('range', { min, max }));
    else if (finite(min)) parts.push(t('atLeast', { min }));
    else if (finite(max)) parts.push(t('atMost', { max }));
  }
  if (u.defaultValue !== undefined && typeof u.defaultValue !== 'object') parts.push(t('default', { value: String(u.defaultValue) }));
  else if (u.optional && u.defaultValue === undefined) parts.push(t('optional'));
  return parts.length ? parts.join(' · ') : undefined;
}

export function SchemaField({
  id,
  name,
  schema,
  value,
  onChange,
  readOnly,
}: {
  id: string;
  name: string;
  schema: unknown;
  value: unknown;
  onChange: (value: unknown) => void;
  readOnly?: boolean;
}) {
  const t = useTranslations('fields');
  const tc = useTranslations('common');
  const fieldLabel = useFieldLabel();
  const u = unwrap(schema);
  const label = fieldLabel(name);
  const hint = rangeHint(u, t);

  if (u.kind === 'boolean') {
    const checked = typeof value === 'boolean' ? value : u.defaultValue === true;
    return (
      <label htmlFor={id} className="flex items-center justify-between gap-2 py-0.5 text-sm">
        <span className="text-xs font-medium text-fg-muted">{label}</span>
        <input id={id} type="checkbox" checked={checked} disabled={readOnly} onChange={(e) => onChange(e.target.checked)} />
      </label>
    );
  }

  if (u.kind === 'number') {
    return (
      <Field label={label} htmlFor={id} hint={hint}>
        <NumberInput id={id} value={typeof value === 'number' ? value : undefined} placeholder={u.defaultValue !== undefined ? String(u.defaultValue) : ''} min={u.inner.minValue} max={u.inner.maxValue} step={u.inner.isInt ? 1 : 'any'} readOnly={readOnly} onChange={(n) => onChange(n === undefined && !u.optional ? Number.NaN : n)} />
      </Field>
    );
  }

  if (u.kind === 'enum') {
    const options = u.inner.options ?? [];
    return (
      <Field label={label} htmlFor={id} hint={hint}>
        <Select id={id} value={typeof value === 'string' ? value : String(u.defaultValue ?? '')} disabled={readOnly} onChange={(e) => onChange(e.target.value)}>
          {u.optional && u.defaultValue === undefined ? <option value="">{tc('empty')}</option> : null}
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  if (u.kind === 'object' && u.inner.shape) {
    const obj = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
    return (
      <fieldset className="rounded-md border border-border p-2.5">
        <legend className="px-1 text-xs font-medium text-fg-muted">{label}</legend>
        {obj || !u.optional || u.defaultValue !== undefined ? (
          <div className="space-y-2">
            {Object.entries(u.inner.shape).map(([k, s]) => (
              <SchemaField
                key={k}
                id={`${id}-${k}`}
                name={k}
                schema={s}
                value={obj?.[k]}
                readOnly={readOnly}
                onChange={(v) => {
                  const base = obj ?? (u.defaultValue && typeof u.defaultValue === 'object' ? structuredClone(u.defaultValue as Record<string, unknown>) : {});
                  const next = { ...base };
                  if (v === undefined) delete next[k];
                  else next[k] = v;
                  onChange(next);
                }}
              />
            ))}
            {u.optional && u.defaultValue === undefined && !readOnly ? (
              <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
                {t('remove', { name: label })}
              </Button>
            ) : null}
          </div>
        ) : (
          <Button size="sm" disabled={readOnly} onClick={() => onChange(defaultObject(u.inner.shape!))}>
            {t('add', { name: label })}
          </Button>
        )}
      </fieldset>
    );
  }

  if (u.kind === 'record') return <JsonField id={id} label={label} value={value} onChange={onChange} readOnly={readOnly} />;

  // string (and anything else representable as text)
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <TextInput id={id} value={typeof value === 'string' ? value : ''} placeholder={typeof u.defaultValue === 'string' ? u.defaultValue : ''} readOnly={readOnly} onChange={(s) => onChange(s === '' && u.optional ? undefined : s)} />
    </Field>
  );
}

/** Number input that tolerates intermediate text ("", "0.") and commits numbers. */
export function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  readOnly,
}: {
  id: string;
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  min?: number | null;
  max?: number | null;
  step?: number | 'any';
  placeholder?: string;
  readOnly?: boolean;
}) {
  const [text, setText] = useState(value === undefined || Number.isNaN(value) ? '' : String(value));
  useEffect(() => {
    setText((prev) => (Number(prev) === value ? prev : value === undefined || Number.isNaN(value) ? '' : String(value)));
  }, [value]);
  const finite = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e15 ? n : undefined);
  return (
    <Input
      id={id}
      type="number"
      inputMode="decimal"
      value={text}
      min={finite(min)}
      max={finite(max)}
      step={step}
      placeholder={placeholder}
      readOnly={readOnly}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value === '') onChange(undefined);
        else if (!Number.isNaN(Number(e.target.value))) onChange(Number(e.target.value));
      }}
    />
  );
}

export function TextInput({ id, value, onChange, placeholder, readOnly, className }: { id: string; value: string; onChange: (s: string) => void; placeholder?: string; readOnly?: boolean; className?: string }) {
  return <Input id={id} value={value} placeholder={placeholder} readOnly={readOnly} className={className} onChange={(e) => onChange(e.target.value)} />;
}

function JsonField({ id, label, value, onChange, readOnly }: { id: string; label: string; value: unknown; onChange: (v: unknown) => void; readOnly?: boolean }) {
  const t = useTranslations('fields');
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(value === undefined ? '' : JSON.stringify(value, null, 2));
  }, [value]);
  return (
    <Field label={label} htmlFor={id} hint={t('jsonHint')} error={error}>
      <Textarea
        id={id}
        value={text}
        readOnly={readOnly}
        spellCheck={false}
        className="min-h-16 font-mono text-xs"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!text.trim()) {
            setError(null);
            onChange(undefined);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
            setError(null);
            onChange(parsed);
          } catch {
            setError(t('jsonError'));
          }
        }}
      />
    </Field>
  );
}
