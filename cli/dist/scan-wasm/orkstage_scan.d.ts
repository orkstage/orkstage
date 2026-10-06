/* tslint:disable */
/* eslint-disable */

export type SourceKind = 'terraform' | 'cloudformation' | 'sam' | 'cdk' | 'serverless' | 'pulumi'
| 'kubernetes' | 'helm' | 'compose' | 'dockerfile' | 'package' | 'bicep' | 'arm';
export interface SourceRef { kind: SourceKind; file: string; line?: number; address: string }
export interface DetectedResource {
    id: string;
    type: 'network' | 'compute.container-service' | 'container-registry' | 'database.postgresql'
    | 'cache.redis' | 'queue' | 'object-storage' | 'ingress' | 'dns';
    provider: 'aws' | 'azure' | 'gcp' | 'oci' | null;
    implementation?: string;
    properties: Record<string, unknown>;
    sources: SourceRef[];
    confidence: 'high' | 'medium' | 'low';
}
export interface ScanReport {
    version: 1;
    generator: string;
    detectors: { kind: SourceKind; files: number }[];
    resources: DetectedResource[];
    unmapped: { source: SourceRef; type: string; reason: string }[];
    connections: { from: string; to: string; protocol: string; port?: number; evidence: string }[];
    template: string;
    warnings: string[];
}
export interface InputFile { path: string; content: string }
export interface ScanOptions {
    /** metadata.name of the generated template (default "imported-app"). */
    templateName?: string;
    displayName?: string;
    /** metadata.version (default "0.1.0"). */
    templateVersion?: string;
    /** Files above this size are skipped with a warning (default 1 MiB). */
    maxFileBytes?: number;
}



/**
 * Scans files (no I/O) and returns a ScanReport v1. Throws on malformed arguments only.
 */
export function scanFiles(files: InputFile[], options: ScanOptions | undefined): ScanReport;

/**
 * Engine version, e.g. `orkstage-scan/0.1.0`.
 */
export function version(): string;
