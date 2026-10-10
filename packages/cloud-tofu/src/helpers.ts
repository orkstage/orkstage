import { ProviderError, redact, safeMessage } from '@orkstage/cloud-core';
import type { CloudProvider, FailureClass } from '@orkstage/domain';
import { TofuError } from '@orkstage/iac';

/** Maps runner failures to the failure classes that drive retries and incidents. */
export function toProviderError(provider: CloudProvider, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const code = provider.toUpperCase();
  if (err instanceof TofuError) {
    const text = `${err.message} ${err.diagnostics.join(' ')}`;
    const failureClass: FailureClass =
      err.kind === 'timeout' ? 'TIMEOUT'
      : err.kind === 'cancelled' ? 'UNKNOWN'
      : /Throttl|Rate exceeded|TooManyRequests|429|SlowDown|rate limit/i.test(text) ? 'PROVIDER_RATE_LIMIT'
      : /AccessDenied|Forbidden|403|Unauthorized|401|not authorized|AuthorizationFailed|PERMISSION_DENIED|NotAuthorized/i.test(text) ? 'AUTHORIZATION_ERROR'
      : /Quota|LimitExceeded|limit exceeded|insufficient capacity|OutOfCapacity/i.test(text) ? 'QUOTA_EXCEEDED'
      : /AlreadyExists|already exists|Conflict|409|state lock|Error acquiring the state lock/i.test(text) ? 'RESOURCE_CONFLICT'
      : /timeout|connection reset|EOF|dial tcp|no such host|ECONNRESET/i.test(text) ? 'NETWORK_ERROR'
      : 'DEPLOYMENT_ERROR';
    return new ProviderError(err.kind === 'cancelled' ? 'CANCELLED' : `${code}_TOFU_FAILED`, redact(err.message, 1500), failureClass, provider, {
      diagnostics: err.diagnostics.slice(0, 5).map((d) => redact(d, 500)),
    });
  }
  return new ProviderError(`${code}_UNEXPECTED`, safeMessage(err), 'UNKNOWN', provider);
}

/** A plan needs production approval when it deletes or replaces something that matters. */
export function isDestructivePlan(actions: { address: string; action: string }[], routineReplacements?: RegExp): boolean {
  return actions.some((a) => a.action === 'delete' || (a.action === 'replace' && !(routineReplacements?.test(a.address) ?? false)));
}
