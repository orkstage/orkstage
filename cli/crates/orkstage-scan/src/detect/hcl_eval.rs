//! HCL → JSON with symbolic expressions, plus a tiny evaluator for `var.*`, `local.*`,
//! literals, comparisons and a few pure functions. Enough to resolve module defaults and the
//! common `var.x == "EC2" ? a : b` patterns without implementing Terraform.
//!
//! Encoding of non-literal expressions:
//! - traversal `aws_db_instance.main.address` → `{"$ref": "aws_db_instance.main.address"}`
//! - function call → `{"$fn": "name", "args": [..]}`
//! - conditional → `{"$cond": [cond, then, else]}`
//! - operation → `{"$op": [lhs, "op", rhs]}` or `{"$op": ["op", expr]}`
//! - anything else (for expressions, splats on calls) → `{"$expr": "<kind>"}`
//!
//! Interpolated strings keep their raw `${...}` text; references are extracted by regex.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use hcl::expr::{BinaryOperator, Expression, ObjectKey, Operation, TemplateExpr, TraversalOperator, UnaryOperator};
use hcl::{Block, Body};
use regex::Regex;
use serde_json::{Map, Value, json};

pub(crate) fn body_to_json(body: &Body) -> Value {
    let mut out = Map::new();
    for attr in body.attributes() {
        out.insert(attr.key().to_string(), expr_to_json(attr.expr()));
    }
    for block in body.blocks() {
        let (key, inner) = nested_block(block);
        match out.entry(key).or_insert_with(|| Value::Array(Vec::new())) {
            Value::Array(items) => items.push(inner),
            other => *other = Value::Array(vec![inner]),
        }
    }
    Value::Object(out)
}

/// `dynamic "x" { content { .. } }` is treated as a plain `x { .. }` block.
fn nested_block(block: &Block) -> (String, Value) {
    if block.identifier() == "dynamic"
        && let Some(label) = block.labels().first()
    {
        let content = block
            .body()
            .blocks()
            .find(|b| b.identifier() == "content")
            .map(|b| body_to_json(b.body()))
            .unwrap_or_else(|| Value::Object(Map::new()));
        return (label.as_str().to_string(), content);
    }
    (block.identifier().to_string(), body_to_json(block.body()))
}

pub(crate) fn expr_to_json(e: &Expression) -> Value {
    match e {
        Expression::Null => Value::Null,
        Expression::Bool(b) => Value::Bool(*b),
        Expression::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else {
                n.as_f64().map(Value::from).unwrap_or(Value::Null)
            }
        }
        Expression::String(s) => Value::String(s.clone()),
        Expression::Array(items) => Value::Array(items.iter().map(expr_to_json).collect()),
        Expression::Object(obj) => {
            let mut m = Map::new();
            for (k, v) in obj.iter() {
                let key = match k {
                    ObjectKey::Identifier(id) => id.as_str().to_string(),
                    ObjectKey::Expression(Expression::String(s)) => s.clone(),
                    ObjectKey::Expression(other) => match expr_to_json(other) {
                        Value::String(s) => s,
                        v => v.to_string(),
                    },
                    _ => String::new(),
                };
                m.insert(key, expr_to_json(v));
            }
            Value::Object(m)
        }
        Expression::TemplateExpr(t) => match t.as_ref() {
            TemplateExpr::QuotedString(s) => template_string(s),
            TemplateExpr::Heredoc(h) => template_string(&h.template),
        },
        Expression::Variable(v) => json!({ "$ref": v.as_str() }),
        Expression::Traversal(t) => match traversal_string(&t.expr, &t.operators) {
            Some(s) => json!({ "$ref": s }),
            None => json!({ "$expr": "traversal" }),
        },
        Expression::FuncCall(f) => {
            let mut name = f.name.namespace.iter().map(|n| n.as_str()).collect::<Vec<_>>().join("::");
            if !name.is_empty() {
                name.push_str("::");
            }
            name.push_str(f.name.name.as_str());
            json!({ "$fn": name, "args": f.args.iter().map(expr_to_json).collect::<Vec<_>>() })
        }
        Expression::Parenthesis(inner) => expr_to_json(inner),
        Expression::Conditional(c) => json!({
            "$cond": [expr_to_json(&c.cond_expr), expr_to_json(&c.true_expr), expr_to_json(&c.false_expr)]
        }),
        Expression::Operation(op) => match op.as_ref() {
            Operation::Unary(u) => {
                let sym = match u.operator {
                    UnaryOperator::Neg => "-",
                    UnaryOperator::Not => "!",
                };
                json!({ "$op": [sym, expr_to_json(&u.expr)] })
            }
            Operation::Binary(b) => {
                let sym = match b.operator {
                    BinaryOperator::Eq => "==",
                    BinaryOperator::NotEq => "!=",
                    BinaryOperator::LessEq => "<=",
                    BinaryOperator::GreaterEq => ">=",
                    BinaryOperator::Less => "<",
                    BinaryOperator::Greater => ">",
                    BinaryOperator::Plus => "+",
                    BinaryOperator::Minus => "-",
                    BinaryOperator::Mul => "*",
                    BinaryOperator::Div => "/",
                    BinaryOperator::Mod => "%",
                    BinaryOperator::And => "&&",
                    BinaryOperator::Or => "||",
                };
                json!({ "$op": [expr_to_json(&b.lhs_expr), sym, expr_to_json(&b.rhs_expr)] })
            }
        },
        // Keep the collection so references inside it survive (`for k, v in var.env : ...`).
        Expression::ForExpr(f) => json!({ "$expr": "for", "in": expr_to_json(&f.collection_expr) }),
        _ => json!({ "$expr": "unknown" }),
    }
}

/// A quoted string that is exactly one interpolation (`"${var.x}"`) is that expression.
fn template_string(raw: &str) -> Value {
    let t = raw.trim();
    if let Some(inner) = t.strip_prefix("${").and_then(|s| s.strip_suffix('}'))
        && !inner.contains("${")
        && !inner.contains('}')
        && let Ok(expr) = inner.trim().parse::<Expression>()
    {
        return expr_to_json(&expr);
    }
    Value::String(raw.to_string())
}

/// JSON-syntax configs (`*.tf.json`): strings holding interpolations become expressions.
pub(crate) fn json_config_value(v: &Value) -> Value {
    match v {
        Value::String(s) if s.contains("${") => template_string(s),
        Value::Array(items) => Value::Array(items.iter().map(json_config_value).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), json_config_value(v))).collect()),
        other => other.clone(),
    }
}

fn traversal_string(base: &Expression, ops: &[TraversalOperator]) -> Option<String> {
    let mut s = match base {
        Expression::Variable(v) => v.as_str().to_string(),
        _ => return None,
    };
    for op in ops {
        match op {
            TraversalOperator::GetAttr(id) => {
                s.push('.');
                s.push_str(id.as_str());
            }
            TraversalOperator::Index(Expression::Number(n)) => {
                s.push_str(&format!("[{n}]"));
            }
            TraversalOperator::Index(Expression::String(k)) => {
                s.push_str(&format!("[\"{k}\"]"));
            }
            TraversalOperator::LegacyIndex(n) => s.push_str(&format!("[{n}]")),
            _ => s.push_str("[*]"),
        }
    }
    Some(s)
}

/// Dotted segments of a reference, without index operators.
pub(crate) fn ref_segments(r: &str) -> Vec<&str> {
    r.split('.').map(|seg| seg.split('[').next().unwrap_or(seg)).filter(|s| !s.is_empty()).collect()
}

/// Resource address designated by a reference: `aws_db_instance.main.address` →
/// `aws_db_instance.main`; `module.db.host` → `module.db`; `var.x`/`local.x` → `None`.
pub(crate) fn ref_address(r: &str) -> Option<String> {
    let segs = ref_segments(r);
    match segs.as_slice() {
        ["var" | "local" | "each" | "count" | "path" | "self" | "terraform", ..] => None,
        ["data", t, n, ..] => Some(format!("data.{t}.{n}")),
        ["module", n, ..] => Some(format!("module.{n}")),
        [t, n, ..] if t.contains('_') => Some(format!("{t}.{n}")),
        _ => None,
    }
}

static INTERP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$\{([^}]*)\}").unwrap());
static TRAV: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[A-Za-z_][A-Za-z0-9_\-]*(?:\.[A-Za-z0-9_\-*]+|\[[^\]]*\])+"#).unwrap());

/// Every reference inside a value (symbolic refs and `${...}` interpolations).
pub(crate) fn collect_refs(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            if let Some(Value::String(r)) = m.get("$ref") {
                out.push(r.clone());
            }
            for (k, child) in m {
                if k != "$ref" {
                    collect_refs(child, out);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|i| collect_refs(i, out)),
        Value::String(s) if s.contains("${") => {
            for cap in INTERP.captures_iter(s) {
                for m in TRAV.find_iter(&cap[1]) {
                    out.push(m.as_str().to_string());
                }
            }
        }
        _ => {}
    }
}

/// Evaluation scope of one module instance.
pub(crate) struct Scope<'a> {
    pub vars: &'a BTreeMap<String, Value>,
    pub locals: &'a BTreeMap<String, Value>,
}

const MAX_DEPTH: u8 = 12;

impl Scope<'_> {
    pub fn resolve(&self, v: &Value) -> Value {
        self.eval(v, 0)
    }

    fn eval(&self, v: &Value, depth: u8) -> Value {
        if depth > MAX_DEPTH {
            return v.clone();
        }
        match v {
            Value::Object(m) => {
                if let Some(Value::String(r)) = m.get("$ref") {
                    return self.lookup(r, depth).unwrap_or_else(|| v.clone());
                }
                if let Some(Value::String(name)) = m.get("$fn") {
                    let args: Vec<Value> = m
                        .get("args")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().map(|x| self.eval(x, depth + 1)).collect())
                        .unwrap_or_default();
                    return call(name, args);
                }
                if let Some(Value::Array(parts)) = m.get("$cond")
                    && parts.len() == 3
                {
                    let cond = self.eval(&parts[0], depth + 1);
                    let then = self.eval(&parts[1], depth + 1);
                    let other = self.eval(&parts[2], depth + 1);
                    return match cond {
                        Value::Bool(true) => then,
                        Value::Bool(false) => other,
                        _ if then == other => then,
                        c => json!({ "$cond": [c, then, other] }),
                    };
                }
                if let Some(Value::Array(parts)) = m.get("$op") {
                    let parts: Vec<Value> = parts.iter().map(|p| self.eval(p, depth + 1)).collect();
                    return operate(parts);
                }
                Value::Object(m.iter().map(|(k, x)| (k.clone(), self.eval(x, depth + 1))).collect())
            }
            Value::Array(items) => Value::Array(items.iter().map(|x| self.eval(x, depth + 1)).collect()),
            Value::String(s) if s.contains("${") => Value::String(self.interpolate(s, depth)),
            other => other.clone(),
        }
    }

    fn lookup(&self, r: &str, depth: u8) -> Option<Value> {
        let segs = ref_segments(r);
        let (base, rest) = match segs.as_slice() {
            ["var", name, rest @ ..] => (self.vars.get(*name)?, rest),
            ["local", name, rest @ ..] => (self.locals.get(*name)?, rest),
            _ => return None,
        };
        let mut value = self.eval(base, depth + 1);
        for seg in rest {
            value = value.get(*seg)?.clone();
        }
        // A reference that still resolves to an unknown is no better than the original.
        Some(value)
    }

    fn interpolate(&self, s: &str, depth: u8) -> String {
        INTERP
            .replace_all(s, |cap: &regex::Captures<'_>| {
                let inner = cap[1].trim();
                let resolved = inner.parse::<Expression>().ok().map(|e| self.eval(&expr_to_json(&e), depth + 1));
                match resolved {
                    Some(Value::String(v)) if !v.contains("${") => v,
                    Some(Value::Number(n)) => n.to_string(),
                    Some(Value::Bool(b)) => b.to_string(),
                    _ => cap[0].to_string(),
                }
            })
            .into_owned()
    }
}

fn is_symbolic(v: &Value) -> bool {
    v.as_object().is_some_and(|m| m.keys().any(|k| matches!(k.as_str(), "$ref" | "$fn" | "$cond" | "$op" | "$expr")))
}

fn call(name: &str, args: Vec<Value>) -> Value {
    let first = args.first().cloned().unwrap_or(Value::Null);
    let all_known = args.iter().all(|a| !is_symbolic(a));
    match name {
        "jsonencode" | "tostring" | "tonumber" | "tolist" | "toset" | "tomap" | "nonsensitive" | "sensitive"
        | "trimspace" => match (name, &first) {
            ("tostring", Value::Number(n)) => Value::String(n.to_string()),
            ("tonumber", Value::String(s)) => {
                s.parse::<f64>().ok().and_then(|f| serde_json::Number::from_f64(f).map(Value::Number)).unwrap_or(first)
            }
            _ => first,
        },
        "jsondecode" => match &first {
            Value::String(s) => serde_json::from_str(s).unwrap_or(first),
            _ => first,
        },
        "coalesce" | "try" => args
            .into_iter()
            .find(|a| !a.is_null() && !is_symbolic(a) && a != &Value::String(String::new()))
            .unwrap_or(json!({ "$fn": name })),
        "lookup" if args.len() >= 2 => match (&args[0], &args[1]) {
            (Value::Object(m), Value::String(k)) => {
                m.get(k).cloned().or_else(|| args.get(2).cloned()).unwrap_or(Value::Null)
            }
            _ => json!({ "$fn": name, "args": args }),
        },
        "max" | "min" | "floor" | "ceil" if all_known => {
            let nums: Vec<f64> = args.iter().filter_map(Value::as_f64).collect();
            if nums.len() != args.len() || nums.is_empty() {
                return json!({ "$fn": name, "args": args });
            }
            let r = match name {
                "max" => nums.iter().cloned().fold(f64::MIN, f64::max),
                "min" => nums.iter().cloned().fold(f64::MAX, f64::min),
                "floor" => nums[0].floor(),
                _ => nums[0].ceil(),
            };
            number(r)
        }
        _ => json!({ "$fn": name, "args": args }),
    }
}

fn number(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9.0e15 {
        Value::from(f as i64)
    } else {
        serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
    }
}

fn operate(parts: Vec<Value>) -> Value {
    if parts.iter().any(is_symbolic) {
        return json!({ "$op": parts });
    }
    match parts.as_slice() {
        [Value::String(op), Value::Bool(b)] if op == "!" => Value::Bool(!b),
        [Value::String(op), x] if op == "-" => {
            x.as_f64().map(|f| number(-f)).unwrap_or_else(|| json!({ "$op": parts }))
        }
        [l, Value::String(op), r] => match op.as_str() {
            "==" => Value::Bool(l == r),
            "!=" => Value::Bool(l != r),
            "&&" | "||" => match (l, r) {
                (Value::Bool(a), Value::Bool(b)) => Value::Bool(if op == "&&" { *a && *b } else { *a || *b }),
                _ => json!({ "$op": parts }),
            },
            _ => match (l.as_f64(), r.as_f64()) {
                (Some(a), Some(b)) => match op.as_str() {
                    "+" => number(a + b),
                    "-" => number(a - b),
                    "*" => number(a * b),
                    "/" if b != 0.0 => number(a / b),
                    "<" => Value::Bool(a < b),
                    ">" => Value::Bool(a > b),
                    "<=" => Value::Bool(a <= b),
                    ">=" => Value::Bool(a >= b),
                    _ => json!({ "$op": parts }),
                },
                _ => json!({ "$op": parts }),
            },
        },
        _ => json!({ "$op": parts }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(src: &str) -> Value {
        body_to_json(&hcl::parse(src).unwrap())
    }

    #[test]
    fn converts_and_resolves() {
        let body = parse(
            r#"
            a = var.capacity == "EC2" ? "ec2" : var.capacity
            b = "${aws_db_instance.main.address}:5432"
            c = jsonencode([{ image = var.image, port = local.port }])
            d = max(256, floor(var.cpu * 1024))
            dynamic "load_balancer" {
              for_each = [1]
              content { target_group_arn = aws_lb_target_group.api.arn }
            }
            "#,
        );
        let vars: BTreeMap<String, Value> = [
            ("capacity".to_string(), json!("FARGATE")),
            ("image".to_string(), json!("nginx")),
            ("cpu".to_string(), json!(0.5)),
        ]
        .into();
        let locals: BTreeMap<String, Value> = [("port".to_string(), json!(8080))].into();
        let scope = Scope { vars: &vars, locals: &locals };
        let r = scope.resolve(&body);
        assert_eq!(r["a"], json!("FARGATE"));
        assert_eq!(r["c"], json!([{ "image": "nginx", "port": 8080 }]));
        assert_eq!(r["d"], json!(512));
        let mut refs = Vec::new();
        collect_refs(&r, &mut refs);
        assert!(refs.contains(&"aws_db_instance.main.address".to_string()));
        assert!(refs.contains(&"aws_lb_target_group.api.arn".to_string()));
        assert_eq!(ref_address("aws_db_instance.main[0].address").as_deref(), Some("aws_db_instance.main"));
    }
}
