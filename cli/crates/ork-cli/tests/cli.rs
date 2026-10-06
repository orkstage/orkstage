//! Offline integration tests of the `ork` binary: scan, init, exit codes, credentials.

use std::path::{Path, PathBuf};

use assert_cmd::Command;
use predicates::prelude::*;
use serde_json::Value;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../orkstage-scan/tests/fixtures").join(name)
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let target = to.join(e.file_name());
        if e.path().is_dir() {
            copy_dir(&e.path(), &target);
        } else {
            std::fs::copy(e.path(), target).unwrap();
        }
    }
}

/// A command isolated from the developer's machine (config dir, env, keychain).
fn ork(config: &Path) -> Command {
    let mut c = Command::cargo_bin("ork").unwrap();
    c.env_clear()
        .env("ORK_CONFIG_DIR", config)
        .env("ORK_CREDENTIALS_STORE", "file")
        .env("NO_COLOR", "1")
        .env("PATH", std::env::var_os("PATH").unwrap_or_default());
    c
}

#[test]
fn version_and_help() {
    let cfg = tempfile::tempdir().unwrap();
    ork(cfg.path()).arg("--version").assert().success().stdout(predicate::str::starts_with("ork "));
    ork(cfg.path()).arg("--help").assert().success().stdout(predicate::str::contains("Exit codes"));
    ork(cfg.path()).arg("no-such-command").assert().code(2);
}

#[test]
fn scan_json_is_a_scan_report() {
    let cfg = tempfile::tempdir().unwrap();
    let out = ork(cfg.path())
        .args(["scan", "--format", "json"])
        .arg(fixture("compose/app"))
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let report: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(report["version"], 1);
    let ids: Vec<&str> = report["resources"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"api") && ids.contains(&"database"), "{ids:?}");
    assert!(report["template"].as_str().unwrap().contains("apiVersion: platform/v1"));
}

#[test]
fn scan_json_is_deterministic() {
    let cfg = tempfile::tempdir().unwrap();
    let run = || {
        ork(cfg.path())
            .args(["-o", "json", "scan"])
            .arg(fixture("terraform/starter-standard"))
            .assert()
            .success()
            .get_output()
            .stdout
            .clone()
    };
    assert_eq!(run(), run());
}

#[test]
fn scan_table_lists_resources_and_unmapped() {
    let cfg = tempfile::tempdir().unwrap();
    ork(cfg.path())
        .arg("scan")
        .arg(fixture("cloudformation/starter-standard"))
        .assert()
        .success()
        .stdout(predicate::str::contains("Resources (9)"))
        .stdout(predicate::str::contains("rds-postgres"))
        .stdout(predicate::str::contains("Unmapped"))
        .stderr(predicate::str::contains("Scanned"));
}

#[test]
fn init_then_scan_write() {
    let cfg = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    copy_dir(&fixture("compose/app"), project.path());
    // Files under node_modules and .gitignored paths are skipped.
    std::fs::create_dir_all(project.path().join("node_modules/pg")).unwrap();
    std::fs::write(project.path().join("node_modules/pg/package.json"), r#"{"dependencies":{"kafkajs":"1"}}"#).unwrap();

    ork(cfg.path())
        .current_dir(project.path())
        .args(["init", "--yes", "--name", "shop", "--tenant", "acme", "--environment", "staging"])
        .assert()
        .success()
        .stderr(predicate::str::contains("Created"));
    let ork_dir = project.path().join(".ork");
    for f in ["config.toml", "template.yaml", "inventory.json", ".gitignore"] {
        assert!(ork_dir.join(f).is_file(), "{f} missing");
    }
    let config = std::fs::read_to_string(ork_dir.join("config.toml")).unwrap();
    assert!(config.contains("tenant = \"acme\""));
    assert!(config.contains("slug = \"shop-staging\""));
    assert!(config.contains("# primary = { target ="));
    let template = std::fs::read_to_string(ork_dir.join("template.yaml")).unwrap();
    assert!(template.contains("name: shop"));
    let inventory: Value =
        serde_json::from_str(&std::fs::read_to_string(ork_dir.join("inventory.json")).unwrap()).unwrap();
    assert!(
        !inventory["resources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["type"] == "queue" && r["sources"].to_string().contains("kafkajs")),
        "node_modules must not be scanned"
    );
    assert!(std::fs::read_to_string(ork_dir.join(".gitignore")).unwrap().contains("inventory.json"));

    // Second init refuses without --force (usage error).
    ork(cfg.path()).current_dir(project.path()).args(["init", "--yes"]).assert().code(2);

    // scan --write from a subdirectory finds the project root and keeps the template name.
    std::fs::remove_file(ork_dir.join("template.yaml")).unwrap();
    ork(cfg.path()).current_dir(project.path().join("api")).args(["scan", "--write", "-o", "json"]).assert().success();
    let template = std::fs::read_to_string(ork_dir.join("template.yaml")).unwrap();
    assert!(template.contains("name: shop"));
}

#[test]
fn exit_codes_without_platform() {
    let cfg = tempfile::tempdir().unwrap();
    let empty = tempfile::tempdir().unwrap();
    // No API URL anywhere → usage.
    ork(cfg.path()).current_dir(empty.path()).arg("whoami").assert().code(2);
    // API URL but no credentials → auth.
    ork(cfg.path())
        .current_dir(empty.path())
        .args(["whoami", "--api-url", "http://127.0.0.1:9"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("ork login"));
    // Unreachable API → failure, JSON error on stderr when -o json.
    let out = ork(cfg.path())
        .current_dir(empty.path())
        .env("ORK_TOKEN", "ork_test_00000000_abcdefghijklmnopqrstuvwxyz")
        .args(["-o", "json", "whoami", "--api-url", "http://127.0.0.1:9"])
        .assert()
        .code(1)
        .get_output()
        .stderr
        .clone();
    let err: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(err["error"]["code"], "NETWORK");
    assert_eq!(err["error"]["exitCode"], 1);
    // Missing instance / bad confirmation → usage, before any network call.
    ork(cfg.path()).current_dir(empty.path()).args(["deploy", "--api-url", "http://127.0.0.1:9"]).assert().code(2);
    ork(cfg.path()).current_dir(empty.path()).args(["destroy", "--instance", "a", "--confirm", "b"]).assert().code(2);
    ork(cfg.path()).current_dir(empty.path()).args(["template", "push"]).assert().code(2);
}

#[test]
fn login_with_token_from_stdin_and_logout() {
    let cfg = tempfile::tempdir().unwrap();
    let token = "ork_test_0123abcd_abcdefghijklmnopqrstuvwxyz012345";
    ork(cfg.path())
        .args(["login", "--api-url", "http://localhost:4000/api/v1/", "--with-token", "--no-verify"])
        .write_stdin(format!("{token}\n"))
        .assert()
        .success()
        .stderr(predicate::str::contains("credentials file"));
    let creds = std::fs::read_to_string(cfg.path().join("credentials.toml")).unwrap();
    assert!(creds.contains("http://localhost:4000") && creds.contains(token));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(cfg.path().join("credentials.toml")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    // The URL becomes the default.
    let user = std::fs::read_to_string(cfg.path().join("config.toml")).unwrap();
    assert!(user.contains("api_url = \"http://localhost:4000\""));
    ork(cfg.path()).arg("logout").assert().success().stderr(predicate::str::contains("Removed"));
    assert!(!std::fs::read_to_string(cfg.path().join("credentials.toml")).unwrap().contains(token));
    // Garbage tokens are refused.
    ork(cfg.path()).args(["login", "--with-token", "--no-verify"]).write_stdin("hunter2").assert().code(2);
}

#[test]
fn completions() {
    let cfg = tempfile::tempdir().unwrap();
    ork(cfg.path()).args(["completions", "bash"]).assert().success().stdout(predicate::str::contains("_ork"));
}
