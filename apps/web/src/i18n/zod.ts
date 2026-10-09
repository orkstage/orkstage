'use client';

import { toNestErrors, validateFieldsNatively } from '@hookform/resolvers';
import { useMemo } from 'react';
import type { FieldError, FieldValues, Resolver } from 'react-hook-form';
import { useTranslations } from 'use-intl';
import type { z } from 'zod';

type Issue = z.core.$ZodIssue;
type ValidationT = ReturnType<typeof useTranslations<'validation'>>;

/** Slug-like patterns from @co/contracts (instances, tenants, template names). */
const SLUG_PATTERN = /^\^\[a-z\]\[a-z0-9-\]\{1,(\d+)\}\$$/;
const SECRET_REF_SOURCE = '^(env|aws-sm):\\/\\/\\S+$';

/**
 * Localized text for a zod issue. Shared request schemas carry English messages for the API;
 * the console derives its own wording from the issue itself, so every form speaks the active
 * language. Refinements written in the console (code "custom") already carry translated text.
 */
export function describeIssue(issue: Issue, t: ValidationT): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined || issue.input === null || issue.input === '' ? t('required') : t('invalidType');
    case 'too_small': {
      const minimum = Number(issue.minimum);
      if (issue.origin === 'string') return minimum <= 1 ? t('required') : t('tooShort', { minimum });
      if (issue.origin === 'array' || issue.origin === 'set') return t('tooFewItems', { minimum });
      return t('numberTooSmall', { minimum });
    }
    case 'too_big': {
      const maximum = Number(issue.maximum);
      if (issue.origin === 'string') return t('tooLong', { maximum });
      if (issue.origin === 'array' || issue.origin === 'set') return t('tooManyItems', { maximum });
      return t('numberTooBig', { maximum });
    }
    case 'invalid_format': {
      if (issue.format === 'email') return t('email');
      if (issue.format === 'uuid' || issue.format === 'guid') return t('choose');
      if (issue.format === 'url') return t('url');
      if (issue.format === 'regex' && issue.pattern) {
        // zod reports the pattern as `/source/flags`.
        const source = issue.pattern.replace(/^\/(.*)\/[a-z]*$/, '$1');
        const slug = SLUG_PATTERN.exec(source);
        if (slug) return t('slug', { maximum: Number(slug[1]) + 1 });
        if (source === SECRET_REF_SOURCE) return t('secretRef');
      }
      return t('format');
    }
    case 'invalid_value':
      return t('choose');
    case 'not_multiple_of':
      return t('multipleOf', { divisor: issue.divisor });
    case 'custom':
      return issue.message || t('invalid');
    default:
      return t('invalid');
  }
}

/**
 * react-hook-form resolver for a zod schema with localized messages. Drop-in for
 * `zodResolver(schema)`: `resolver: useZodResolver(schema)`.
 */
export function useZodResolver<S extends z.ZodType<FieldValues, FieldValues>>(schema: S): Resolver<z.input<S>, unknown, z.output<S>> {
  const t = useTranslations('validation');
  return useMemo<Resolver<z.input<S>, unknown, z.output<S>>>(
    () => async (values, _context, options) => {
      const result = await schema.safeParseAsync(values, { reportInput: true });
      if (result.success) {
        if (options.shouldUseNativeValidation) validateFieldsNatively({}, options);
        return { values: result.data, errors: {} };
      }
      const errors: Record<string, FieldError> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.map(String).join('.');
        if (!errors[path]) errors[path] = { type: issue.code, message: describeIssue(issue, t) };
      }
      return { values: {}, errors: toNestErrors(errors, options) };
    },
    [schema, t],
  );
}
