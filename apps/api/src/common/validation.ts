// SPDX-License-Identifier: AGPL-3.0-only
import { applyDecorators, Body, Query, type PipeTransform } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';

class ZodPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}
  transform(value: unknown) {
    return this.schema.parse(value ?? {});
  }
}

/** Validates the body with a shared contract schema and publishes it to OpenAPI. */
export function ZodBody(schema: ZodType): ParameterDecorator {
  return Body(new ZodPipe(schema));
}

export function ZodQuery(schema: ZodType): ParameterDecorator {
  return Query(new ZodPipe(schema));
}

/** OpenAPI documentation for a zod request body. */
export function ApiZodBody(schema: ZodType) {
  return applyDecorators(ApiBody({ schema: z.toJSONSchema(schema, { io: 'input' }) as never }));
}
