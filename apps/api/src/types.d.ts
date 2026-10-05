import type { AppAbility, Principal } from '@co/authorization';

export interface RequestPrincipal extends Principal {
  email: string;
  name: string;
  sessionId: string;
  ability: AppAbility;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: RequestPrincipal;
    correlationId: string;
  }
}
