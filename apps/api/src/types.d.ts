import type { AppAbility, Principal } from '@orkstage/authorization';

export interface RequestPrincipal extends Principal {
  email: string;
  name: string;
  sessionId: string;
  ability: AppAbility;
  /** Set when the caller authenticated with an API key instead of a session. */
  apiKey?: { id: string; name: string; prefix: string; scopes: string[]; organizationId: string };
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: RequestPrincipal;
    correlationId: string;
  }
}
