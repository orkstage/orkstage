//! Fast, parallel project walk: respects .gitignore, skips dependency/build directories and
//! large or binary files, and only reads files a detector can use.

use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use ignore::overrides::OverrideBuilder;
use ignore::{DirEntry, WalkBuilder, WalkState};
use orkstage_scan::InputFile;

use crate::error::{CliError, Result};

/// Directories never worth scanning.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".terraform",
    "target",
    "vendor",
    "dist",
    ".git",
    ".ork",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".turbo",
    ".gradle",
    "bower_components",
    ".tox",
    ".mypy_cache",
];

pub struct Walked {
    pub files: Vec<InputFile>,
    pub visited: usize,
    pub bytes: u64,
    pub skipped_large: Vec<String>,
    pub elapsed_ms: u128,
    /// Engine time, filled in by the caller.
    pub scan_ms: u128,
}

fn skip_dir(e: &DirEntry) -> bool {
    let name = e.file_name().to_string_lossy();
    SKIP_DIRS.contains(&name.as_ref())
        // CDK copies sources into cdk.out/asset.*; scanning them would duplicate everything.
        || name.starts_with("asset.")
}

pub fn collect(root: &Path, include: &[String], exclude: &[String], max_bytes: usize) -> Result<Walked> {
    let start = Instant::now();
    if root.is_file() {
        // A single file (e.g. `ork scan infra/docker-compose.yml`) is scanned as is.
        let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let content =
            std::fs::read_to_string(root).map_err(|e| CliError::io(format!("reading {}", root.display()), e))?;
        let len = content.len() as u64;
        return Ok(Walked {
            files: vec![InputFile::new(name, content.replace("\r\n", "\n"))],
            visited: 1,
            bytes: len,
            skipped_large: Vec::new(),
            elapsed_ms: start.elapsed().as_millis(),
            scan_ms: 0,
        });
    }
    if !root.is_dir() {
        return Err(CliError::usage(format!("{} does not exist", root.display()), None));
    }
    let mut ob = OverrideBuilder::new(root);
    for g in include {
        ob.add(g).map_err(|e| CliError::usage(format!("invalid include glob {g:?}: {e}"), None))?;
    }
    for g in exclude {
        ob.add(&format!("!{g}")).map_err(|e| CliError::usage(format!("invalid exclude glob {g:?}: {e}"), None))?;
    }
    let overrides = ob.build().map_err(|e| CliError::usage(format!("invalid scan globs: {e}"), None))?;

    let files: Mutex<Vec<InputFile>> = Mutex::new(Vec::new());
    let skipped: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let visited = std::sync::atomic::AtomicUsize::new(0);
    let bytes = std::sync::atomic::AtomicU64::new(0);

    WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .require_git(false)
        .overrides(overrides)
        .filter_entry(|e| !(e.file_type().is_some_and(|t| t.is_dir()) && skip_dir(e)))
        .build_parallel()
        .run(|| {
            Box::new(|entry| {
                let Ok(entry) = entry else { return WalkState::Continue };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                visited.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Ok(rel) = entry.path().strip_prefix(root) else { return WalkState::Continue };
                let rel = rel.to_string_lossy().replace('\\', "/");
                if !orkstage_scan::is_candidate_path(&rel) {
                    return WalkState::Continue;
                }
                let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
                if len as usize > max_bytes {
                    skipped.lock().unwrap().push(rel);
                    return WalkState::Continue;
                }
                // Binary or non-UTF-8 files are ignored.
                if let Ok(content) = std::fs::read_to_string(entry.path()) {
                    bytes.fetch_add(len, std::sync::atomic::Ordering::Relaxed);
                    files.lock().unwrap().push(InputFile::new(rel, content.replace("\r\n", "\n")));
                }
                WalkState::Continue
            })
        });

    let mut files = files.into_inner().unwrap();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let mut skipped_large = skipped.into_inner().unwrap();
    skipped_large.sort();
    Ok(Walked {
        files,
        visited: visited.into_inner(),
        bytes: bytes.into_inner(),
        skipped_large,
        elapsed_ms: start.elapsed().as_millis(),
        scan_ms: 0,
    })
}
