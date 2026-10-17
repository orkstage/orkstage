// SPDX-License-Identifier: AGPL-3.0-only
import { sha256 } from '@orkstage/domain';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { SESSION_COOKIE } from './auth.js';

/**
 * Rate limit buckets per caller. Signed in traffic is counted per session or API key (a hash of
 * the token): it cannot be spoofed with headers, and a made up token is rejected by AuthGuard
 * anyway. Sign in and public routes count per client address, as resolved through TRUST_PROXY_HOPS.
 */
@Injectable()
export class ClientThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    // Sign in and public routes never check the token, so a made up one must not buy a new bucket.
    const byAddress = typeof req.url === 'string' && (req.url.includes('/auth/') || req.url.includes('/public/'));
    if (!byAddress) {
      const auth = req.headers?.authorization;
      if (typeof auth === 'string' && auth.startsWith('Bearer ')) return `key:${sha256(auth.slice(7)).slice(0, 32)}`;
      const session = req.cookies?.[SESSION_COOKIE];
      if (typeof session === 'string' && session) return `session:${sha256(session).slice(0, 32)}`;
    }
    return `ip:${String(req.ip)}`;
  }
}
