//! Provider sizes → OrkStage t-shirt sizes, and unit parsing. Inverse of the adapters'
//! size tables (e.g. `small` ↔ `db.t4g.small` in `packages/cloud-aws/src/stacks.ts`).

/// `db.t4g.small` → `small`, `db.r7g.2xlarge` → `xlarge`.
pub(crate) fn aws_class_size(class: &str) -> Option<&'static str> {
    let last = class.rsplit('.').next()?.to_ascii_lowercase();
    Some(match last.as_str() {
        "nano" | "micro" => "micro",
        "small" => "small",
        "medium" => "medium",
        "large" => "large",
        s if s.ends_with("xlarge") => "xlarge",
        _ => return None,
    })
}

/// Cache sizes stop at `large`.
pub(crate) fn cache_size(size: &str) -> &'static str {
    match size {
        "micro" => "micro",
        "small" => "small",
        "medium" => "medium",
        _ => "large",
    }
}

/// Azure Flexible Server SKUs: `B_Standard_B1ms`, `GP_Standard_D4s_v3`, `MO_Standard_E8ds_v4`.
pub(crate) fn azure_sku_size(sku: &str) -> Option<&'static str> {
    let tier = sku.split('_').next()?.to_ascii_uppercase();
    // The VM size is the third segment (`D4s`, `B1ms`); its first number is the vCore count.
    let vm = sku.split('_').nth(2).unwrap_or(sku);
    let vcores: u32 = vm
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap_or(2);
    Some(match (tier.as_str(), vcores) {
        ("B", 0..=1) => "micro",
        ("B", _) => "small",
        (_, 0..=2) => "medium",
        (_, 3..=4) => "large",
        _ => "xlarge",
    })
}

/// Cloud SQL tiers: `db-f1-micro`, `db-g1-small`, `db-custom-2-7680`, `db-perf-optimized-N-4`.
pub(crate) fn gcp_tier_size(tier: &str) -> Option<&'static str> {
    if tier.ends_with("micro") {
        return Some("micro");
    }
    if tier.ends_with("small") {
        return Some("small");
    }
    let cpus = tier.split('-').filter_map(|p| p.parse::<u32>().ok()).next()?;
    Some(match cpus {
        0..=1 => "small",
        2 => "medium",
        3..=4 => "large",
        _ => "xlarge",
    })
}

/// Kubernetes CPU quantity → vCPU: `500m` → 0.5, `2` → 2.
pub(crate) fn k8s_cpu(q: &str) -> Option<f64> {
    let q = q.trim();
    if let Some(m) = q.strip_suffix('m') {
        return m.parse::<f64>().ok().map(|v| v / 1000.0);
    }
    q.parse().ok()
}

/// Memory quantity → MiB: `512Mi`, `1Gi`, `1G`, `512M`, `268435456`, Compose `512m`, `1gb`.
pub(crate) fn memory_mib(q: &str) -> Option<f64> {
    let q = q.trim();
    let split = q.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(q.len());
    let (num, unit) = q.split_at(split);
    let n: f64 = num.parse().ok()?;
    let mib = 1024.0 * 1024.0;
    let bytes = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "b" => n,
        "k" | "kb" => n * 1000.0,
        "ki" | "kib" => n * 1024.0,
        "m" | "mb" if unit.starts_with('M') && unit.len() == 1 => n * 1e6,
        "m" | "mb" => n * mib, // Compose/Docker use binary units for "m"/"mb"
        "mi" | "mib" => n * mib,
        "g" if unit.starts_with('G') => n * 1e9,
        "g" | "gb" => n * 1024.0 * mib,
        "gi" | "gib" => n * 1024.0 * mib,
        "t" | "tb" => n * 1e12,
        "ti" | "tib" => n * 1024.0 * 1024.0 * mib,
        _ => return None,
    };
    Some(bytes / mib)
}

/// Clamp a vCPU value into the template range `(0, 16]`, rounded to 2 decimals.
pub(crate) fn clamp_cpu(v: f64) -> f64 {
    let v = v.clamp(0.125, 16.0);
    (v * 100.0).round() / 100.0
}

pub(crate) fn clamp_memory(v: f64) -> i64 {
    (v.round() as i64).clamp(128, 122_880)
}

/// ECS CPU units (1024 = 1 vCPU) or `"1 vCPU"`/`"0.5 vcpu"` strings.
pub(crate) fn ecs_cpu(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64().map(|u| u / 1024.0),
        serde_json::Value::String(s) => {
            let lower = s.to_ascii_lowercase();
            if let Some(rest) = lower.strip_suffix("vcpu") {
                rest.trim().parse().ok()
            } else {
                lower.trim().parse::<f64>().ok().map(|u| u / 1024.0)
            }
        }
        _ => None,
    }
}

/// ECS memory: MiB number or `"2 GB"`.
pub(crate) fn ecs_memory(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => {
            let lower = s.to_ascii_lowercase().replace(' ', "");
            if let Some(gb) = lower.strip_suffix("gb") {
                gb.parse::<f64>().ok().map(|g| g * 1024.0)
            } else {
                lower.parse().ok()
            }
        }
        _ => None,
    }
}

/// `16.4` → `16`, `POSTGRES_15` → `15`, `aurora-postgresql` versions `15.4` → `15`.
pub(crate) fn pg_major(version: &str) -> Option<String> {
    let digits: String = version.chars().skip_while(|c| !c.is_ascii_digit()).take_while(char::is_ascii_digit).collect();
    (!digits.is_empty()).then_some(digits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        assert_eq!(aws_class_size("db.t4g.small"), Some("small"));
        assert_eq!(aws_class_size("db.r7g.2xlarge"), Some("xlarge"));
        assert_eq!(aws_class_size("cache.t4g.micro"), Some("micro"));
        assert_eq!(azure_sku_size("B_Standard_B1ms"), Some("micro"));
        assert_eq!(azure_sku_size("GP_Standard_D4s_v3"), Some("large"));
        assert_eq!(azure_sku_size("GP_Standard_D2ds_v5"), Some("medium"));
        assert_eq!(gcp_tier_size("db-custom-2-7680"), Some("medium"));
        assert_eq!(k8s_cpu("250m"), Some(0.25));
        assert_eq!(memory_mib("512Mi"), Some(512.0));
        assert_eq!(memory_mib("1Gi"), Some(1024.0));
        assert_eq!(memory_mib("512m"), Some(512.0));
        assert_eq!(pg_major("POSTGRES_15"), Some("15".into()));
        assert_eq!(pg_major("16.3"), Some("16".into()));
    }
}
