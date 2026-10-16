// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Browser-safe subset of the domain (no Node built-ins). The web console imports this via
 * `@orkstage/domain/core`; server code keeps using `@orkstage/domain`.
 */
export * from './providers.js';
export * from './errors.js';
export * from './instance-lifecycle.js';
export * from './deployment.js';
export * from './health.js';
export * from './limits.js';
export * from './flags.js';
