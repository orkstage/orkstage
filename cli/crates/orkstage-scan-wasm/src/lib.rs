//! WebAssembly bindings for the OrkStage scan engine, published as `@orkstage/scan`.
//!
//! ```js
//! const { scanFiles } = require('@orkstage/scan');
//! const report = scanFiles([{ path: 'main.tf', content: '...' }], { templateName: 'shop' });
//! ```

use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r#"
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
"#;

/// Scans files (no I/O) and returns a ScanReport v1. Throws on malformed arguments only.
#[wasm_bindgen(js_name = scanFiles, unchecked_return_type = "ScanReport")]
pub fn scan_files(
    #[wasm_bindgen(unchecked_param_type = "InputFile[]")] files: JsValue,
    #[wasm_bindgen(unchecked_param_type = "ScanOptions | undefined")] options: JsValue,
) -> Result<JsValue, JsError> {
    let files: Vec<orkstage_scan::InputFile> = serde_wasm_bindgen::from_value(files)
        .map_err(|e| JsError::new(&format!("scanFiles: files must be {{ path, content }}[]: {e}")))?;
    let opts: orkstage_scan::ScanOptions = if options.is_undefined() || options.is_null() {
        Default::default()
    } else {
        serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsError::new(&format!("scanFiles: invalid options: {e}")))?
    };
    let report = orkstage_scan::scan_files(&files, &opts);
    report.serialize(&serde_wasm_bindgen::Serializer::json_compatible()).map_err(|e| JsError::new(&e.to_string()))
}

/// Engine version, e.g. `orkstage-scan/0.1.0`.
#[wasm_bindgen(js_name = version)]
pub fn version() -> String {
    orkstage_scan::GENERATOR.to_string()
}
