//! Dockerfiles: `EXPOSE`, the final base image and `HEALTHCHECK` are hints for the service
//! built from the same directory.

use crate::evidence::{DockerHint, Findings, src};
use crate::model::SourceKind;
use crate::util;

pub(crate) fn detect(file: &str, content: &str, out: &mut Findings) {
    out.count(SourceKind::Dockerfile, file);
    let mut port = None;
    let mut base = None;
    let mut health = None;
    let mut port_line = None;
    // Join continuation lines first.
    let joined = content.replace("\\\r\n", " ").replace("\\\n", " ");
    for (i, raw) in joined.lines().enumerate() {
        let line = raw.trim();
        let (instr, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
        match instr.to_ascii_uppercase().as_str() {
            "FROM" => {
                let image = rest.split_whitespace().find(|t| !t.starts_with("--")).unwrap_or("").to_string();
                base = Some(image);
                // A new stage resets what the final image exposes.
                port = None;
            }
            "EXPOSE" => {
                if port.is_none() {
                    port = rest.split_whitespace().filter_map(|p| p.split('/').next()?.parse::<u16>().ok()).next();
                    port_line = Some(i as u32 + 1);
                }
            }
            "HEALTHCHECK" => health = super::compose::http_path(rest),
            _ => {}
        }
    }
    let base = base.filter(|b| !b.is_empty() && !b.contains('$'));
    out.docker.push(DockerHint {
        dir: util::dir_of(file).to_string(),
        port,
        base_image: base,
        healthcheck_path: health,
        source: src(SourceKind::Dockerfile, file, port_line.or(Some(1)), "Dockerfile"),
    });
}
