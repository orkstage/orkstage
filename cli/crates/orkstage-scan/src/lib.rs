//! # orkstage-scan
//!
//! Turns infrastructure-as-code and project files into an OrkStage **ScanReport** (v1, see
//! `docs/specs/integration-api.md`) including a generated `platform/v1` EnvironmentTemplate.
//!
//! The core API does no I/O: callers pass file contents, so the engine also runs as
//! WebAssembly inside the platform.
//!
//! ```
//! use orkstage_scan::{scan_files, InputFile, ScanOptions};
//! let files = [InputFile::new(
//!     "docker-compose.yml",
//!     "services:\n  api:\n    build: .\n    ports: ['8080:8080']\n    depends_on: [db]\n  db:\n    image: postgres:17\n",
//! )];
//! let report = scan_files(&files, &ScanOptions::default());
//! assert!(report.resources.iter().any(|r| r.id == "database"));
//! assert!(report.template.contains("type: database.postgresql"));
//! ```

#![forbid(unsafe_code)]

mod detect;
mod evidence;
mod merge;
mod model;
mod sizing;
mod template;
mod util;
mod yaml;

pub use detect::is_candidate_path;
pub use model::*;

/// `orkstage-scan/<version>`, recorded in every report.
pub const GENERATOR: &str = concat!("orkstage-scan/", env!("CARGO_PKG_VERSION"));

/// Files above this size are skipped unless `ScanOptions::max_file_bytes` says otherwise.
pub const DEFAULT_MAX_FILE_BYTES: usize = 1024 * 1024;

/// Scans the given files and returns a ScanReport. Never panics on bad input; problems are
/// reported as warnings.
pub fn scan_files(files: &[InputFile], opts: &ScanOptions) -> ScanReport {
    let max = opts.max_file_bytes.unwrap_or(DEFAULT_MAX_FILE_BYTES);
    let mut warnings = Vec::new();
    let mut normalized: Vec<InputFile> = Vec::with_capacity(files.len());
    for f in files {
        let path = f.path.replace('\\', "/").trim_start_matches("./").to_string();
        if f.content.len() > max {
            warnings.push(format!("{path}: skipped, larger than {max} bytes"));
            continue;
        }
        normalized.push(InputFile { path, content: f.content.clone() });
    }
    normalized.sort_by(|a, b| a.path.cmp(&b.path));
    normalized.dedup_by(|a, b| a.path == b.path);
    let refs: Vec<&InputFile> = normalized.iter().collect();

    let mut findings = evidence::Findings::default();
    detect::run(&refs, &mut findings);

    let detectors: Vec<DetectorCount> = SourceKind::ALL
        .iter()
        .filter_map(|k| findings.files.get(k).map(|f| DetectorCount { kind: *k, files: f.len() as u32 }))
        .collect();
    let mut unmapped = std::mem::take(&mut findings.unmapped);
    unmapped.sort_by(|a, b| {
        (&a.source.file, a.source.line, &a.source.address).cmp(&(&b.source.file, b.source.line, &b.source.address))
    });
    unmapped.dedup();
    warnings.append(&mut findings.warnings);

    let merged = merge::merge(findings);
    warnings.extend(merged.warnings.iter().cloned());

    let (name, name_ok) = match opts.template_name.as_deref().map(str::trim) {
        Some(n) if !n.is_empty() => match util::sanitize_id(n) {
            Some(s) if s.len() >= 2 => (s, true),
            _ => ("imported-app".to_string(), false),
        },
        _ => ("imported-app".to_string(), true),
    };
    if !name_ok {
        warnings.push("template name is not a valid template name; used imported-app".into());
    }
    let display = opts.display_name.clone().unwrap_or_else(|| display_name(&name));
    let version = opts.template_version.clone().unwrap_or_else(|| "0.1.0".into());
    let kinds: Vec<(SourceKind, u32)> = detectors.iter().map(|d| (d.kind, d.files)).collect();
    let rendered = template::render(
        &merged,
        &template::Meta { name: &name, display_name: &display, version: &version, kinds: &kinds },
    );
    if merged.resources.is_empty() {
        warnings.push("no deployable resources were detected; the template is incomplete".into());
    }
    for issue in &rendered.issues {
        warnings.push(format!("template: {issue}"));
    }
    let _ = &rendered.document;
    warnings.dedup();

    ScanReport {
        version: 1,
        generator: GENERATOR.to_string(),
        detectors,
        resources: merged.detected(),
        unmapped,
        connections: merged.report_connections(),
        template: rendered.yaml,
        warnings,
    }
}

fn display_name(name: &str) -> String {
    let s = name.replace('-', " ");
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}
