//! Small helpers over `serde_json::Value` and paths shared by every detector.

use serde_json::{Map, Value};

pub(crate) fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object().and_then(|m| m.get(key))
}

/// Case-insensitive key lookup (CloudFormation/ARM property casing varies in the wild).
pub(crate) fn get_ci<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    let m = v.as_object()?;
    m.get(key).or_else(|| m.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v))
}

pub(crate) fn path<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(v, |acc, k| get(acc, k))
}

pub(crate) fn str_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// A literal number, or a string holding one (`"512"`, `"0.5"`).
pub(crate) fn num_of(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

pub(crate) fn int_of(v: Option<&Value>) -> Option<i64> {
    num_of(v).filter(|f| f.fract() == 0.0).map(|f| f as i64)
}

pub(crate) fn bool_of(v: Option<&Value>) -> Option<bool> {
    match v? {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" => Some(true),
            "false" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// Nested blocks: HCL blocks are arrays of objects; JSON configs may use a single object.
pub(crate) fn blocks<'a>(v: &'a Value, key: &str) -> Vec<&'a Map<String, Value>> {
    match get(v, key) {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).collect(),
        Some(Value::Object(m)) => vec![m],
        _ => Vec::new(),
    }
}

pub(crate) fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

pub(crate) fn file_name(path: &str) -> &str {
    path.rsplit_once('/').map(|(_, f)| f).unwrap_or(path)
}

/// Last path component of a directory (`""` for the project root).
pub(crate) fn dir_name(dir: &str) -> &str {
    file_name(dir)
}

/// Joins a directory and a relative path, normalising `.` and `..`.
pub(crate) fn join(dir: &str, rel: &str) -> String {
    let mut parts: Vec<&str> =
        if rel.starts_with('/') { Vec::new() } else { dir.split('/').filter(|p| !p.is_empty()).collect() };
    for p in rel.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// Turns any name into a valid template id (`^[a-z][a-zA-Z0-9-]{0,39}$`), or `None`.
pub(crate) fn sanitize_id(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut last_dash = true;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            // camelCase is allowed by the schema, but lower-kebab reads better and is stable.
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let start = trimmed.find(|c: char| c.is_ascii_lowercase())?;
    let mut id: String = trimmed[start..].chars().take(40).collect();
    while id.ends_with('-') {
        id.pop();
    }
    (!id.is_empty()).then_some(id)
}

/// Normalised name used to match the same component across sources
/// (`orders-api-service` in Kubernetes, `orders_api` in Compose → `orders-api`).
pub(crate) fn norm_name(raw: &str) -> String {
    let id = sanitize_id(raw).unwrap_or_default();
    let mut s = id.as_str();
    for suffix in ["-service", "-svc", "-deployment", "-deploy", "-task", "-container"] {
        if let Some(stripped) = s.strip_suffix(suffix)
            && !stripped.is_empty()
        {
            s = stripped;
            break;
        }
    }
    s.to_string()
}

/// Labels Terraform authors use for "the only one" (`aws_db_instance.this`).
pub(crate) fn is_generic_label(label: &str) -> bool {
    matches!(label, "this" | "main" | "default" | "primary" | "app" | "service" | "example" | "resource" | "it")
}

pub(crate) fn line_of(content: &str, needle: &str) -> Option<u32> {
    let idx = content.find(needle)?;
    Some(content[..idx].bytes().filter(|b| *b == b'\n').count() as u32 + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert_eq!(sanitize_id("Orders_API").as_deref(), Some("orders-api"));
        assert_eq!(sanitize_id("1-db").as_deref(), Some("db"));
        assert_eq!(sanitize_id("123"), None);
        assert_eq!(norm_name("orders-api-service"), "orders-api");
        assert_eq!(join("a/b", "../c/./d"), "a/c/d");
        assert_eq!(join("", "."), "");
    }
}
