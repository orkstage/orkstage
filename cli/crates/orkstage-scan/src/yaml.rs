//! YAML → JSON loader on top of `yaml-rust2`'s event parser.
//!
//! Why not the stock loader: it drops local tags, and CloudFormation short-form intrinsics
//! (`!Ref`, `!GetAtt`, `!Sub`, ...) must be kept to resolve references. This loader turns them
//! into their long form (`{"Ref": ..}`, `{"Fn::GetAtt": [..]}`), supports anchors, aliases and
//! `<<` merge keys (common in Compose files), multi-document streams, and records the line of
//! each mapping key near the top of the document so findings can point at a line.

use std::collections::HashMap;

use serde_json::{Map, Number, Value};
use yaml_rust2::Yaml;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// Keys deeper than this are not given line numbers.
const LINE_DEPTH: usize = 3;

#[derive(Debug, Clone)]
pub(crate) struct YamlDoc {
    pub value: Value,
    /// `a/b/c` key path → 1-based line of that key.
    pub lines: HashMap<String, u32>,
}

impl YamlDoc {
    pub fn line(&self, path: &[&str]) -> Option<u32> {
        self.lines.get(&path.join("/")).copied()
    }
}

/// Parses every document of a YAML stream. Empty documents are skipped.
pub(crate) fn load_all(src: &str) -> Result<Vec<YamlDoc>, String> {
    let mut recv = Receiver::default();
    let mut parser = Parser::new_from_str(src);
    parser.load(&mut recv, true).map_err(|e| e.to_string())?;
    if let Some(err) = recv.error {
        return Err(err);
    }
    Ok(recv.docs)
}

enum Frame {
    Seq {
        items: Vec<Value>,
        anchor: usize,
        tag: Option<Tag>,
        path: Vec<String>,
    },
    Map {
        entries: Map<String, Value>,
        merges: Vec<Value>,
        key: Option<String>,
        anchor: usize,
        tag: Option<Tag>,
        path: Vec<String>,
    },
}

#[derive(Default)]
struct Receiver {
    docs: Vec<YamlDoc>,
    stack: Vec<Frame>,
    anchors: HashMap<usize, Value>,
    lines: HashMap<String, u32>,
    root: Option<Value>,
    error: Option<String>,
}

impl Receiver {
    fn child_path(&self) -> Vec<String> {
        match self.stack.last() {
            None => Vec::new(),
            Some(Frame::Seq { items, path, .. }) => {
                let mut p = path.clone();
                p.push(items.len().to_string());
                p
            }
            Some(Frame::Map { key, path, .. }) => {
                let mut p = path.clone();
                p.push(key.clone().unwrap_or_default());
                p
            }
        }
    }

    fn insert(&mut self, value: Value, mark: Marker) {
        match self.stack.last_mut() {
            None => self.root = Some(value),
            Some(Frame::Seq { items, .. }) => items.push(value),
            Some(Frame::Map { entries, merges, key, path, .. }) => match key.take() {
                None => {
                    let k = scalar_key(&value);
                    if path.len() < LINE_DEPTH && k != "<<" {
                        let mut p = path.clone();
                        p.push(k.clone());
                        self.lines.entry(p.join("/")).or_insert(u32::try_from(mark.line()).unwrap_or(u32::MAX));
                    }
                    *key = Some(k);
                }
                Some(k) if k == "<<" => match value {
                    Value::Array(list) => merges.extend(list),
                    other => merges.push(other),
                },
                Some(k) => {
                    entries.insert(k, value);
                }
            },
        }
    }
}

impl MarkedEventReceiver for Receiver {
    fn on_event(&mut self, ev: Event, mark: Marker) {
        match ev {
            Event::DocumentStart => {
                self.root = None;
                self.lines.clear();
            }
            Event::DocumentEnd => {
                if let Some(value) = self.root.take()
                    && !value.is_null()
                {
                    self.docs.push(YamlDoc { value, lines: std::mem::take(&mut self.lines) });
                }
                self.lines.clear();
            }
            Event::Alias(id) => {
                let value = self.anchors.get(&id).cloned().unwrap_or(Value::Null);
                self.insert(value, mark);
            }
            Event::Scalar(text, style, anchor, tag) => {
                let value = scalar(text, style, tag.as_ref());
                let value = match tag {
                    Some(t) => apply_tag(&t, value),
                    None => value,
                };
                if anchor > 0 {
                    self.anchors.insert(anchor, value.clone());
                }
                self.insert(value, mark);
            }
            Event::SequenceStart(anchor, tag) => {
                let path = self.child_path();
                self.stack.push(Frame::Seq { items: Vec::new(), anchor, tag, path });
            }
            Event::MappingStart(anchor, tag) => {
                let path = self.child_path();
                self.stack.push(Frame::Map { entries: Map::new(), merges: Vec::new(), key: None, anchor, tag, path });
            }
            Event::SequenceEnd | Event::MappingEnd => {
                let Some(frame) = self.stack.pop() else {
                    self.error = Some("unbalanced YAML structure".into());
                    return;
                };
                let (value, anchor, tag) = match frame {
                    Frame::Seq { items, anchor, tag, .. } => (Value::Array(items), anchor, tag),
                    Frame::Map { mut entries, merges, anchor, tag, .. } => {
                        for merged in merges {
                            if let Value::Object(m) = merged {
                                for (k, v) in m {
                                    entries.entry(k).or_insert(v);
                                }
                            }
                        }
                        (Value::Object(entries), anchor, tag)
                    }
                };
                let value = match tag {
                    Some(t) => apply_tag(&t, value),
                    None => value,
                };
                if anchor > 0 {
                    self.anchors.insert(anchor, value.clone());
                }
                self.insert(value, mark);
            }
            Event::StreamStart | Event::StreamEnd | Event::Nothing => {}
        }
    }
}

fn scalar_key(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn scalar(text: String, style: TScalarStyle, tag: Option<&Tag>) -> Value {
    if let Some(t) = tag
        && t.handle == "tag:yaml.org,2002:"
    {
        return match t.suffix.as_str() {
            "str" => Value::String(text),
            "null" => Value::Null,
            _ => from_yaml(Yaml::from_str(&text)).unwrap_or(Value::String(text)),
        };
    }
    if style != TScalarStyle::Plain {
        return Value::String(text);
    }
    from_yaml(Yaml::from_str(&text)).unwrap_or(Value::String(text))
}

fn from_yaml(y: Yaml) -> Option<Value> {
    Some(match y {
        Yaml::Null => Value::Null,
        Yaml::Boolean(b) => Value::Bool(b),
        Yaml::Integer(i) => Value::Number(i.into()),
        Yaml::Real(r) => {
            let f: f64 = r.parse().ok()?;
            Value::Number(Number::from_f64(f)?)
        }
        Yaml::String(s) => Value::String(s),
        _ => return None,
    })
}

/// CloudFormation short-form intrinsic tags. Other local tags (Compose `!reset`, ...) are
/// ignored and their value kept as is.
const CFN_FUNCTIONS: &[&str] = &[
    "Base64",
    "Cidr",
    "FindInMap",
    "GetAZs",
    "ImportValue",
    "Join",
    "Select",
    "Split",
    "Sub",
    "Transform",
    "And",
    "Equals",
    "If",
    "Not",
    "Or",
    "Length",
    "ToJsonString",
];

fn apply_tag(tag: &Tag, value: Value) -> Value {
    if tag.handle != "!" {
        return value;
    }
    match tag.suffix.as_str() {
        "Ref" => obj("Ref", value),
        "Condition" => obj("Condition", value),
        "GetAtt" => match value {
            Value::String(s) => {
                let (res, attr) = s.split_once('.').unwrap_or((s.as_str(), ""));
                obj("Fn::GetAtt", Value::Array(vec![res.into(), attr.into()]))
            }
            other => obj("Fn::GetAtt", other),
        },
        f if CFN_FUNCTIONS.contains(&f) => obj(&format!("Fn::{f}"), value),
        _ => value,
    }
}

fn obj(key: &str, value: Value) -> Value {
    let mut m = Map::new();
    m.insert(key.to_string(), value);
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn short_form_intrinsics() {
        let docs = load_all(
            "Resources:\n  Db:\n    Type: AWS::RDS::DBInstance\n    Properties:\n      A: !Ref Foo\n      B: !GetAtt Db.Endpoint.Address\n      C: !Sub '${Db}-x'\n      D: !If [Cond, 1, 2]\n",
        )
        .unwrap();
        let v = &docs[0].value["Resources"]["Db"]["Properties"];
        assert_eq!(v["A"], json!({"Ref": "Foo"}));
        assert_eq!(v["B"], json!({"Fn::GetAtt": ["Db", "Endpoint.Address"]}));
        assert_eq!(v["C"], json!({"Fn::Sub": "${Db}-x"}));
        assert_eq!(v["D"], json!({"Fn::If": ["Cond", 1, 2]}));
        assert_eq!(docs[0].line(&["Resources", "Db"]), Some(2));
    }

    #[test]
    fn anchors_merge_and_multi_doc() {
        let docs = load_all("x: &base\n  a: 1\n  b: '2'\ny:\n  <<: *base\n  b: 3\n---\n---\nkind: Service\n").unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].value["y"], json!({"b": 3, "a": 1}));
        assert_eq!(docs[0].value["x"]["b"], json!("2"));
        assert_eq!(docs[1].value["kind"], json!("Service"));
    }
}
