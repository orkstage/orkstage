//! Tables for humans, JSON for machines. JSON goes to stdout, pretty-printed and stable.

use comfy_table::presets::UTF8_BORDERS_ONLY;
use comfy_table::{Cell, Color, ContentArrangement, Table};
use serde::Serialize;

use crate::config::Ctx;

/// Writes a line to stdout. A closed pipe (`ork scan | head`) ends the process quietly
/// instead of panicking.
pub fn emit(line: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    if let Err(e) = writeln!(out, "{line}")
        && e.kind() == std::io::ErrorKind::BrokenPipe
    {
        std::process::exit(0);
    }
}

/// `println!` that tolerates closed pipes.
#[macro_export]
macro_rules! outln {
    ($($arg:tt)*) => { $crate::output::emit(&format!($($arg)*)) };
}

pub fn print_json<T: Serialize>(value: &T) {
    match serde_json::to_string_pretty(value) {
        Ok(s) => emit(&s),
        Err(e) => eprintln!("error: cannot serialize output: {e}"),
    }
}

pub fn table(ctx: &Ctx, headers: &[&str]) -> Table {
    let mut t = Table::new();
    t.load_style(UTF8_BORDERS_ONLY)
        .set_content_arrangement(ContentArrangement::Dynamic)
        .set_header(headers.iter().map(Cell::new));
    if !ctx.color {
        t.force_no_tty();
    }
    t
}

/// A status word colored by meaning.
pub fn status_cell(ctx: &Ctx, s: &str) -> Cell {
    let c = Cell::new(s);
    if !ctx.color {
        return c;
    }
    let up = s.to_ascii_uppercase();
    if up.contains("FAIL") || up.contains("UNHEALTHY") || up == "LOW" || up.contains("ERROR") {
        c.fg(Color::Red)
    } else if up.contains("READY") || up.contains("SUCCEEDED") || up == "HEALTHY" || up == "HIGH" || up == "ACTIVE" {
        c.fg(Color::Green)
    } else if up.contains("DEGRADED") || up.contains("AWAITING") || up == "MEDIUM" || up.contains("WARN") {
        c.fg(Color::Yellow)
    } else {
        c
    }
}

pub fn heading(ctx: &Ctx, text: &str) -> String {
    if ctx.color { format!("\x1b[1m{text}\x1b[0m") } else { text.to_string() }
}

pub fn dim(ctx: &Ctx, text: &str) -> String {
    if ctx.color { format!("\x1b[2m{text}\x1b[0m") } else { text.to_string() }
}

/// Human messages go to stderr so stdout stays clean for piping.
pub fn note(ctx: &Ctx, msg: &str) {
    if !ctx.json() {
        eprintln!("{msg}");
    }
}
