//! Terraform / OpenTofu (`*.tf`, `*.tf.json`).
//!
//! Files are grouped by directory (one module per directory). Directories that are called as
//! local modules (`source = "./modules/db"`) are expanded once per call with the call's
//! arguments; every other directory is a root. Remote modules are reported as unmapped.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{Map, Value, json};

use super::hcl_eval::{Scope, body_to_json, collect_refs, json_config_value, ref_address, ref_segments};
use crate::evidence::{Candidate, Endpoint, Findings, src};
use crate::model::{Confidence, Provider, ResourceType as RT, SourceKind, SourceRef};
use crate::sizing;
use crate::util::{self, blocks, bool_of, dir_name, get, int_of, num_of, str_of};

#[derive(Debug, Clone)]
struct TfResource {
    rtype: String,
    name: String,
    body: Value,
    file: String,
    line: Option<u32>,
}

#[derive(Debug, Clone)]
struct TfModuleCall {
    name: String,
    source: String,
    args: Value,
    file: String,
    line: Option<u32>,
}

#[derive(Debug, Default)]
struct TfDir {
    vars: BTreeMap<String, Value>,
    locals: BTreeMap<String, Value>,
    outputs: BTreeMap<String, Value>,
    resources: Vec<TfResource>,
    modules: Vec<TfModuleCall>,
}

pub(crate) fn detect(files: &[&crate::InputFile], out: &mut Findings) {
    let mut dirs: BTreeMap<String, TfDir> = BTreeMap::new();
    for f in files {
        out.count(SourceKind::Terraform, &f.path);
        let dir = dirs.entry(util::dir_of(&f.path).to_string()).or_default();
        if let Err(e) = parse_file(f, dir) {
            out.warn(format!("{}: could not parse Terraform: {e}", f.path));
        }
    }

    // Which directories are local modules called from elsewhere?
    let mut called: BTreeSet<String> = BTreeSet::new();
    for (dir, d) in &dirs {
        for m in &d.modules {
            if let Some(target) = local_source(dir, &m.source)
                && dirs.contains_key(&target)
                && target != *dir
            {
                called.insert(target);
            }
        }
    }
    let mut ctx = Ctx { dirs: &dirs, out, instances: HashMap::new(), supporting: 0 };
    for dir in dirs.keys() {
        if !called.contains(dir) {
            let vars = dirs[dir].vars.clone();
            ctx.instance(dir, dir.clone(), vars, None, 0);
        }
    }
    if ctx.supporting > 0 {
        ctx.out.warn(format!(
            "{} supporting Terraform resource(s) (IAM, security groups, logs, subnets, ...) are created by OrkStage implementations and were not mapped individually",
            ctx.supporting
        ));
    }
}

fn local_source(dir: &str, source: &str) -> Option<String> {
    (source.starts_with("./") || source.starts_with("../")).then(|| util::join(dir, source))
}

fn parse_file(f: &crate::InputFile, dir: &mut TfDir) -> Result<(), String> {
    if f.path.ends_with(".json") {
        let v: Value = serde_json::from_str(&f.content).map_err(|e| e.to_string())?;
        return parse_json_config(f, &v, dir);
    }
    let body = hcl::parse(&f.content).map_err(|e| e.to_string())?;
    for block in body.blocks() {
        let labels: Vec<&str> = block.labels().iter().map(|l| l.as_str()).collect();
        let inner = body_to_json(block.body());
        match (block.identifier(), labels.as_slice()) {
            ("resource", [t, n]) => dir.resources.push(TfResource {
                rtype: t.to_string(),
                name: n.to_string(),
                line: resource_line(&f.content, t, n),
                body: inner,
                file: f.path.clone(),
            }),
            ("variable", [n]) => {
                if let Some(d) = get(&inner, "default") {
                    dir.vars.insert(n.to_string(), d.clone());
                }
            }
            ("locals", []) => {
                if let Value::Object(m) = inner {
                    dir.locals.extend(m);
                }
            }
            ("output", [n]) => {
                if let Some(v) = get(&inner, "value") {
                    dir.outputs.insert(n.to_string(), v.clone());
                }
            }
            ("module", [n]) => dir.modules.push(TfModuleCall {
                name: n.to_string(),
                source: str_of(get(&inner, "source")).unwrap_or_default().to_string(),
                line: util::line_of(&f.content, &format!("module \"{n}\"")),
                args: inner,
                file: f.path.clone(),
            }),
            _ => {}
        }
    }
    Ok(())
}

fn parse_json_config(f: &crate::InputFile, v: &Value, dir: &mut TfDir) -> Result<(), String> {
    let v = json_config_value(v);
    if let Some(Value::Object(types)) = get(&v, "resource") {
        for (t, named) in types {
            for (n, body) in named.as_object().into_iter().flatten() {
                dir.resources.push(TfResource {
                    rtype: t.clone(),
                    name: n.clone(),
                    body: body.clone(),
                    file: f.path.clone(),
                    line: util::line_of(&f.content, &format!("\"{n}\"")),
                });
            }
        }
    }
    if let Some(Value::Object(vars)) = get(&v, "variable") {
        for (n, body) in vars {
            if let Some(d) = get(body, "default") {
                dir.vars.insert(n.clone(), d.clone());
            }
        }
    }
    for locals in blocks(&v, "locals") {
        dir.locals.extend(locals.clone());
    }
    if let Some(Value::Object(outputs)) = get(&v, "output") {
        for (n, body) in outputs {
            if let Some(val) = get(body, "value") {
                dir.outputs.insert(n.clone(), val.clone());
            }
        }
    }
    if let Some(Value::Object(mods)) = get(&v, "module") {
        for (n, body) in mods {
            dir.modules.push(TfModuleCall {
                name: n.clone(),
                source: str_of(get(body, "source")).unwrap_or_default().to_string(),
                args: body.clone(),
                file: f.path.clone(),
                line: None,
            });
        }
    }
    Ok(())
}

fn resource_line(content: &str, t: &str, n: &str) -> Option<u32> {
    // Fast path for the canonical `resource "type" "name"` formatting.
    if let Some(idx) = content.find(&format!("resource \"{t}\" \"{n}\"")) {
        return Some(content[..idx].bytes().filter(|b| *b == b'\n').count() as u32 + 1);
    }
    let re =
        regex::Regex::new(&format!(r#"(?m)^[ \t]*resource\s+"{}"\s+"{}""#, regex::escape(t), regex::escape(n))).ok()?;
    let m = re.find(content)?;
    Some(content[..m.start()].bytes().filter(|b| *b == b'\n').count() as u32 + 1)
}

struct Ctx<'a, 'o> {
    dirs: &'a BTreeMap<String, TfDir>,
    out: &'o mut Findings,
    /// (scope, module call name) → child scope
    instances: HashMap<(String, String), String>,
    /// Supporting resources (IAM, security groups, ...) absorbed by OrkStage implementations.
    supporting: usize,
}

/// A resource with its body evaluated in its module instance.
struct Res<'r> {
    r: &'r TfResource,
    body: Value,
    addr: String,
    key: String,
    source: SourceRef,
}

impl<'r> Res<'r> {
    fn refs(&self, field: &str) -> Vec<String> {
        let mut refs = Vec::new();
        if let Some(v) = get(&self.body, field) {
            collect_refs(v, &mut refs);
        }
        refs
    }

    fn ref_addrs(&self, field: &str) -> Vec<String> {
        self.refs(field).iter().filter_map(|r| ref_address(r)).collect()
    }

    fn str(&self, field: &str) -> Option<&str> {
        str_of(get(&self.body, field)).filter(|s| !s.contains("${"))
    }

    fn num(&self, field: &str) -> Option<f64> {
        num_of(get(&self.body, field))
    }

    fn int(&self, field: &str) -> Option<i64> {
        int_of(get(&self.body, field))
    }

    fn bool(&self, field: &str) -> Option<bool> {
        bool_of(get(&self.body, field))
    }
}

fn provider_of(rtype: &str) -> Option<Provider> {
    match rtype.split('_').next()? {
        "aws" => Some(Provider::Aws),
        "azurerm" | "azapi" => Some(Provider::Azure),
        "google" => Some(Provider::Gcp),
        "oci" => Some(Provider::Oci),
        _ => None,
    }
}

impl Ctx<'_, '_> {
    fn instance(
        &mut self,
        dir: &str,
        scope: String,
        vars: BTreeMap<String, Value>,
        call_name: Option<&str>,
        depth: u8,
    ) {
        let Some(d) = self.dirs.get(dir) else { return };
        if depth > 6 {
            self.out.warn(format!("{dir}: module nesting too deep; stopped expanding"));
            return;
        }
        let s = Scope { vars: &vars, locals: &d.locals };

        // Expand local modules first so their outputs can be referenced.
        for m in &d.modules {
            let source = src(SourceKind::Terraform, &m.file, m.line, format!("module.{}", m.name));
            match local_source(dir, &m.source) {
                Some(target) if self.dirs.contains_key(&target) && target != dir => {
                    let mut child_vars = self.dirs[&target].vars.clone();
                    if let Value::Object(args) = absolutize(&s.resolve(&m.args), &scope, dir, self.dirs) {
                        for (k, v) in args {
                            if !matches!(
                                k.as_str(),
                                "source" | "version" | "count" | "for_each" | "providers" | "depends_on"
                            ) {
                                child_vars.insert(k, v);
                            }
                        }
                    }
                    let child_scope = format!("{scope}/module.{}", m.name);
                    self.instances
                        .insert((scope.clone(), m.name.clone()), child_scope.clone());
                    self.instance(&target, child_scope, child_vars, Some(&m.name), depth + 1);
                }
                Some(target) => self.out.unmapped(
                    source,
                    "terraform_module",
                    format!("local module source {target} is not part of the scanned files; scan it too to map its resources"),
                ),
                None => self.out.unmapped(
                    source,
                    "terraform_module",
                    format!(
                        "remote module \"{}\" was not expanded; scan its source to map the resources it creates",
                        m.source
                    ),
                ),
            }
        }

        let resources: Vec<Res<'_>> = d
            .resources
            .iter()
            .filter_map(|r| {
                let body = s.resolve(&r.body);
                // `count = 0` disables a resource.
                if int_of(get(&body, "count")) == Some(0) {
                    return None;
                }
                let addr = format!("{}.{}", r.rtype, r.name);
                Some(Res {
                    key: format!("tf:{scope}:{addr}"),
                    source: src(SourceKind::Terraform, &r.file, r.line, addr.clone()),
                    addr,
                    r,
                    body,
                })
            })
            .collect();
        let call = call_name.map(str::to_string);
        Mapper { ctx: self, scope: &scope, dir, call, res: &resources, outputs: &d.outputs, folded: BTreeSet::new() }
            .run();
    }
}

struct Mapper<'c, 'a, 'o, 'r> {
    ctx: &'c mut Ctx<'a, 'o>,
    scope: &'c str,
    dir: &'c str,
    call: Option<String>,
    res: &'c [Res<'r>],
    outputs: &'c BTreeMap<String, Value>,
    folded: BTreeSet<String>,
}

fn by_addr<'a, 'r>(res: &'a [Res<'r>], addr: &str) -> Option<&'a Res<'r>> {
    res.iter().find(|r| r.addr == addr)
}

fn of<'a, 'r>(res: &'a [Res<'r>], types: &'a [&'a str]) -> impl Iterator<Item = &'a Res<'r>> + 'a {
    res.iter().filter(move |r| types.contains(&r.r.rtype.as_str()))
}

impl Mapper<'_, '_, '_, '_> {
    fn key(&self, addr: &str) -> String {
        format!("tf:{}:{addr}", self.scope)
    }

    /// Name hint: explicit label > module call name > literal `name` attribute > directory.
    fn name(&self, r: &Res<'_>, attrs: &[&str]) -> String {
        if !util::is_generic_label(&r.r.name) {
            return r.r.name.clone();
        }
        if let Some(c) = &self.call {
            return c.clone();
        }
        for a in attrs {
            if let Some(v) = r.str(a)
                && !v.is_empty()
            {
                return v.to_string();
            }
        }
        let d = dir_name(self.dir);
        if d.is_empty() { r.r.name.clone() } else { d.to_string() }
    }

    fn cand(&self, kind: RT, r: &Res<'_>, name: String, conf: Confidence) -> Candidate {
        Candidate::new(kind, provider_of(&r.r.rtype), name, r.source.clone(), conf, r.key.clone())
    }

    fn push(&mut self, c: Candidate) {
        self.ctx.out.candidates.push(c);
    }

    fn run(&mut self) {
        self.network();
        self.registries();
        self.containers();
        self.postgres();
        self.redis();
        self.queues();
        self.buckets();
        self.ingress();
        self.dns();
        self.other_clouds();
        self.leftovers();
    }

    // ── network ──────────────────────────────────────────────────────────────
    fn network(&mut self) {
        let vpcs: Vec<&Res<'_>> =
            of(self.res, &["aws_vpc", "azurerm_virtual_network", "google_compute_network", "oci_core_vcn"]).collect();
        let mut subnet_azs = BTreeSet::new();
        let mut subnet_count = 0i64;
        for s in of(self.res, &["aws_subnet"]) {
            subnet_count += s.int("count").unwrap_or(1);
            if let Some(az) = s.str("availability_zone") {
                subnet_azs.insert(az.to_string());
            }
        }
        let nat = of(
            self.res,
            &["aws_nat_gateway", "google_compute_router_nat", "azurerm_nat_gateway", "oci_core_nat_gateway"],
        )
        .next()
        .is_some();
        let mut new = Vec::new();
        for v in &vpcs {
            let mut c = self.cand(RT::Network, v, self.name(v, &["name"]), Confidence::High);
            c.implementation = match provider_of(&v.r.rtype) {
                Some(Provider::Aws) => Some("vpc".into()),
                Some(Provider::Azure) => Some("vnet".into()),
                Some(Provider::Oci) => Some("vcn".into()),
                _ => None,
            };
            if v.r.rtype == "aws_vpc" {
                let azs = if !subnet_azs.is_empty() {
                    subnet_azs.len() as i64
                } else if subnet_count >= 4 {
                    2
                } else {
                    subnet_count.clamp(1, 3)
                };
                c.set("availabilityZones", azs.clamp(1, 3));
            } else {
                c.set("availabilityZones", 1);
            }
            c.set("natGateway", nat);
            new.push(c);
        }
        for c in new {
            self.push(c);
        }
        for r in of(self.res, &["aws_subnet", "aws_nat_gateway"]) {
            self.folded.insert(r.addr.clone());
        }
        let addrs: Vec<String> = vpcs.iter().map(|v| v.addr.clone()).collect();
        self.folded.extend(addrs);
    }

    // ── registry ─────────────────────────────────────────────────────────────
    fn registries(&mut self) {
        let mut new = Vec::new();
        for r in
            of(self.res, &["aws_ecr_repository", "azurerm_container_registry", "google_artifact_registry_repository"])
        {
            let mut c = self.cand(RT::ContainerRegistry, r, self.name(r, &["name"]), Confidence::High);
            match r.r.rtype.as_str() {
                "aws_ecr_repository" => {
                    c.implementation = Some("ecr".into());
                    let scan = blocks(&r.body, "image_scanning_configuration")
                        .first()
                        .and_then(|b| bool_of(b.get("scan_on_push")));
                    c.set("scanOnPush", scan.unwrap_or(false));
                    c.set("immutableTags", r.str("image_tag_mutability").is_some_and(|m| m.starts_with("IMMUTABLE")));
                }
                "azurerm_container_registry" => c.implementation = Some("acr".into()),
                _ => {}
            }
            new.push(c);
            self.folded.insert(r.addr.clone());
        }
        for c in new {
            self.push(c);
        }
    }

    // ── containers ───────────────────────────────────────────────────────────
    fn containers(&mut self) {
        let mut used_tds = BTreeSet::new();
        let mut new = Vec::new();
        let mut links = Vec::new();

        // Target group address → (service key, container port)
        for svc in of(self.res, &["aws_ecs_service"]) {
            let td = svc.ref_addrs("task_definition").into_iter().find_map(|a| by_addr(self.res, &a));
            let mut c = self.cand(RT::ContainerService, svc, self.name(svc, &["name"]), Confidence::High);
            if let Some(td) = td {
                used_tds.insert(td.addr.clone());
                c.aliases.push(td.key.clone());
                c.sources.push(td.source.clone());
                self.task_definition(td, &mut c, &mut links);
            }
            c.set_opt("replicas", svc.int("desired_count").map(|n| n.clamp(0, 100)));
            // Launch type / capacity providers.
            let launch = svc.str("launch_type").map(str::to_string).or_else(|| {
                blocks(&svc.body, "capacity_provider_strategy").iter().find_map(|b| match b.get("capacity_provider") {
                    Some(Value::String(s)) if !s.contains("${") => Some(s.clone()),
                    Some(v) if v.get("$ref").is_some() => Some("EC2".into()),
                    _ => None,
                })
            });
            match launch.as_deref() {
                Some("EC2") => c.implementation = Some("ecs-ec2".into()),
                Some(l) if l.starts_with("FARGATE") => c.implementation = Some("ecs-fargate".into()),
                _ => {
                    if c.implementation.is_none() {
                        c.implementation = Some("ecs-fargate".into());
                    }
                }
            }
            if let Some(net) = blocks(&svc.body, "network_configuration").first()
                && bool_of(net.get("assign_public_ip")) == Some(true)
            {
                c.set("public", true);
            }
            for lb in blocks(&svc.body, "load_balancer") {
                let mut refs = Vec::new();
                if let Some(v) = lb.get("target_group_arn") {
                    collect_refs(v, &mut refs);
                }
                for tg in refs.iter().filter_map(|r| ref_address(r)) {
                    c.aliases.push(self.key(&tg));
                    if let Some(tg_res) = by_addr(self.res, &tg)
                        && let Some(hc) = blocks(&tg_res.body, "health_check").first()
                        && let Some(path) = str_of(hc.get("path")).filter(|p| p.starts_with('/'))
                    {
                        c.set("healthCheckPath", path);
                    }
                }
                if let Some(port) = int_of(lb.get("container_port")) {
                    c.set("port", port.clamp(1, 65535));
                }
            }
            new.push(c);
        }
        for td in of(self.res, &["aws_ecs_task_definition"]) {
            if used_tds.contains(&td.addr) {
                continue;
            }
            let mut c = self.cand(RT::ContainerService, td, self.name(td, &["family"]), Confidence::Medium);
            self.task_definition(td, &mut c, &mut links);
            if c.implementation.is_none() {
                c.implementation = Some("ecs-fargate".into());
            }
            new.push(c);
        }

        // Autoscaling (Application Auto Scaling on ECS services).
        for target in of(self.res, &["aws_appautoscaling_target"]) {
            let mut refs = Vec::new();
            if let Some(v) = get(&target.body, "resource_id") {
                collect_refs(v, &mut refs);
            }
            let Some(svc_key) = refs
                .iter()
                .filter_map(|r| ref_address(r))
                .find(|a| a.starts_with("aws_ecs_service."))
                .map(|a| self.key(&a))
            else {
                continue;
            };
            let (Some(min), Some(max)) = (target.int("min_capacity"), target.int("max_capacity")) else {
                continue;
            };
            let cpu_target = of(self.res, &["aws_appautoscaling_policy"])
                .filter(|p| {
                    let mut r = Vec::new();
                    collect_refs(&p.body, &mut r);
                    r.iter().any(|x| ref_address(x).as_deref() == Some(target.addr.as_str()))
                })
                .find_map(|p| {
                    blocks(&p.body, "target_tracking_scaling_policy_configuration")
                        .first()
                        .and_then(|b| num_of(b.get("target_value")))
                })
                .unwrap_or(70.0);
            if let Some(c) = new.iter_mut().find(|c: &&mut Candidate| c.key == svc_key) {
                c.set(
                    "autoscaling",
                    json!({
                        "minReplicas": min.max(0),
                        "maxReplicas": max.max(1),
                        "targetCpuPercent": (cpu_target.round() as i64).clamp(10, 95),
                    }),
                );
                c.sources.push(target.source.clone());
            }
        }

        for c in new {
            self.push(c);
        }
        for (from, to, evidence) in links {
            self.ctx.out.link(Endpoint::Key(from), Endpoint::Key(to), None, None, evidence);
        }
        let addrs: Vec<String> = of(
            self.res,
            &["aws_ecs_service", "aws_ecs_task_definition", "aws_appautoscaling_target", "aws_appautoscaling_policy"],
        )
        .map(|r| r.addr.clone())
        .collect();
        self.folded.extend(addrs);
    }

    fn task_definition(&self, td: &Res<'_>, c: &mut Candidate, links: &mut Vec<(String, String, String)>) {
        if let Some(compat) = get(&td.body, "requires_compatibilities").and_then(Value::as_array) {
            if compat.iter().any(|v| v == "FARGATE") {
                c.implementation = Some("ecs-fargate".into());
            } else if compat.iter().any(|v| v == "EC2") {
                c.implementation = Some("ecs-ec2".into());
            }
        }
        if let Some(cpu) = get(&td.body, "cpu").and_then(sizing::ecs_cpu) {
            c.set("cpu", sizing::clamp_cpu(cpu));
        }
        if let Some(mem) = get(&td.body, "memory").and_then(sizing::ecs_memory) {
            c.set("memoryMiB", sizing::clamp_memory(mem));
        }
        let defs = match get(&td.body, "container_definitions") {
            Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
            Some(v) => v.clone(),
            None => Value::Null,
        };
        let containers: Vec<&Value> = defs.as_array().map(|a| a.iter().collect()).unwrap_or_default();
        let main = containers
            .iter()
            .find(|c| bool_of(get(c, "essential")) != Some(false) && get(c, "portMappings").is_some())
            .or_else(|| containers.first())
            .copied();
        if let Some(main) = main {
            if let Some(image) = str_of(get(main, "image")).filter(|s| !s.contains("${")) {
                c.set("sourceImage", image);
            }
            if let Some(port) = get(main, "portMappings")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|p| int_of(get(p, "containerPort")))
            {
                c.set("port", port.clamp(1, 65535));
            }
            if !c.props.contains_key("cpu")
                && let Some(cpu) = get(main, "cpu").and_then(sizing::ecs_cpu)
                && cpu > 0.0
            {
                c.set("cpu", sizing::clamp_cpu(cpu));
            }
            if !c.props.contains_key("memoryMiB")
                && let Some(mem) = get(main, "memory").and_then(sizing::ecs_memory)
            {
                c.set("memoryMiB", sizing::clamp_memory(mem));
            }
            if let Some(path) =
                get(main, "healthCheck").and_then(|h| get(h, "command")).and_then(|c| c.as_array()).and_then(|cmd| {
                    cmd.iter().filter_map(Value::as_str).find_map(|s| {
                        let idx = s.find("http://")?;
                        let rest = &s[idx + 7..];
                        let slash = rest.find('/')?;
                        Some(rest[slash..].split_whitespace().next()?.to_string())
                    })
                })
            {
                c.set("healthCheckPath", path);
            }
            // References from environment/secrets → connections to backing services.
            for field in ["environment", "secrets"] {
                let Some(v) = get(main, field) else { continue };
                if !v.is_array() {
                    let mut refs = Vec::new();
                    collect_refs(v, &mut refs);
                    for r in refs {
                        for to in self.target_keys(&r) {
                            links.push((c.key.clone(), to, format!("{} {field} → {}", td.addr, display_ref(&r))));
                        }
                    }
                    continue;
                }
                for item in v.as_array().into_iter().flatten() {
                    let var = str_of(get(item, "name")).unwrap_or("?");
                    let mut refs = Vec::new();
                    if let Some(val) = get(item, "value").or_else(|| get(item, "valueFrom")) {
                        collect_refs(val, &mut refs);
                    }
                    for r in refs {
                        for to in self.target_keys(&r) {
                            links.push((c.key.clone(), to, format!("{} {var} = {}", td.addr, display_ref(&r))));
                        }
                    }
                }
            }
        }
    }

    /// Candidate keys designated by a reference, following module outputs.
    fn target_keys(&self, r: &str) -> Vec<String> {
        if let Some(abs) = r.strip_prefix('@') {
            return vec![abs.to_string()];
        }
        let Some(addr) = ref_address(r) else { return Vec::new() };
        if let Some(module) = addr.strip_prefix("module.") {
            let segs = ref_segments(r);
            let Some(output) = segs.get(2) else { return Vec::new() };
            let Some(child) = self.ctx.instances.get(&(self.scope.to_string(), module.to_string())) else {
                return Vec::new();
            };
            let child_dir = child_dir(self.ctx.dirs, self.dir, self.scope, child);
            let Some(val) = child_dir.and_then(|d| d.outputs.get(*output)) else {
                return Vec::new();
            };
            let mut refs = Vec::new();
            collect_refs(val, &mut refs);
            return refs
                .iter()
                .filter_map(|x| ref_address(x))
                .filter(|a| !a.starts_with("module."))
                .map(|a| format!("tf:{child}:{a}"))
                .collect();
        }
        if addr.starts_with("aws_secretsmanager") || addr.starts_with("aws_ssm") {
            // Secrets created next to a database usually belong to it; resolved by merge via alias.
            return vec![self.key(&addr)];
        }
        vec![self.key(&addr)]
    }

    // ── postgres ─────────────────────────────────────────────────────────────
    fn postgres(&mut self) {
        let mut new = Vec::new();
        let cluster_instances: Vec<&Res<'_>> = of(self.res, &["aws_rds_cluster_instance"]).collect();
        for r in of(self.res, &["aws_db_instance", "aws_rds_cluster"]) {
            let engine = r.str("engine").unwrap_or(if r.r.rtype == "aws_rds_cluster" { "aurora-mysql" } else { "" });
            let is_pg = engine.contains("postgres");
            if !engine.is_empty() && !is_pg {
                self.ctx.out.unmapped(
                    r.source.clone(),
                    r.r.rtype.clone(),
                    format!("engine \"{engine}\" is not supported; OrkStage databases are PostgreSQL"),
                );
                self.folded.insert(r.addr.clone());
                continue;
            }
            if r.r.rtype == "aws_db_instance" && r.str("replicate_source_db").is_some()
                || get(&r.body, "replicate_source_db").is_some_and(|v| !v.is_null())
            {
                // Read replicas are part of the primary's HA story, not separate databases.
                self.folded.insert(r.addr.clone());
                continue;
            }
            let conf = if is_pg { Confidence::High } else { Confidence::Medium };
            let mut c = self.cand(
                RT::Postgres,
                r,
                self.name(r, &["identifier", "cluster_identifier", "db_name", "name"]),
                conf,
            );
            c.implementation = Some("rds-postgres".into());
            c.set_opt("version", r.str("engine_version").and_then(sizing::pg_major));
            let mut class = r.str("instance_class").map(str::to_string);
            let mut members = 0;
            if r.r.rtype == "aws_rds_cluster" {
                for ci in &cluster_instances {
                    if ci.ref_addrs("cluster_identifier").contains(&r.addr) {
                        members += ci.int("count").unwrap_or(1);
                        class = class.or_else(|| ci.str("instance_class").map(str::to_string));
                        c.aliases.push(ci.key.clone());
                        c.sources.push(ci.source.clone());
                    }
                }
                c.set("storageGiB", 20);
                c.set("highAvailability", if members >= 2 { "zone-redundant" } else { "none" });
            } else {
                c.set_opt("storageGiB", r.int("allocated_storage").map(|g| g.clamp(1, 16384)));
                c.set("highAvailability", if r.bool("multi_az") == Some(true) { "zone-redundant" } else { "none" });
            }
            c.set_opt("size", class.as_deref().and_then(sizing::aws_class_size));
            if let Some(days) = r.int("backup_retention_period") {
                c.set("backup", json!({ "enabled": days > 0, "retentionDays": days.clamp(0, 35) }));
            }
            c.set_opt("publicAccess", r.bool("publicly_accessible"));
            if !is_pg {
                self.ctx.out.warn(format!("{}: database engine is not a literal; assumed PostgreSQL", r.addr));
            }
            // Secrets created in the same module usually hold this database's credentials.
            if of(self.res, &["aws_db_instance", "aws_rds_cluster"]).count() == 1 {
                for s in of(self.res, &["aws_secretsmanager_secret"]) {
                    c.aliases.push(s.key.clone());
                }
            }
            new.push(c);
            self.folded.insert(r.addr.clone());
        }
        for c in new {
            self.push(c);
        }
        let addrs: Vec<String> = cluster_instances.iter().map(|r| r.addr.clone()).collect();
        self.folded.extend(addrs);
    }

    // ── redis ────────────────────────────────────────────────────────────────
    fn redis(&mut self) {
        let mut new = Vec::new();
        let groups: Vec<String> =
            of(self.res, &["aws_elasticache_replication_group"]).map(|r| r.addr.clone()).collect();
        for r in of(
            self.res,
            &["aws_elasticache_replication_group", "aws_elasticache_cluster", "aws_elasticache_serverless_cache"],
        ) {
            self.folded.insert(r.addr.clone());
            if r.r.rtype == "aws_elasticache_cluster"
                && r.ref_addrs("replication_group_id").iter().any(|a| groups.contains(a))
            {
                continue;
            }
            let engine = r.str("engine").unwrap_or("redis");
            if engine == "memcached" {
                self.ctx.out.unmapped(
                    r.source.clone(),
                    r.r.rtype.clone(),
                    "memcached is not supported; OrkStage caches are Redis/Valkey compatible",
                );
                continue;
            }
            let mut c = self.cand(
                RT::Redis,
                r,
                self.name(r, &["replication_group_id", "cluster_id", "name"]),
                Confidence::High,
            );
            c.implementation = Some("elasticache-valkey".into());
            c.set_opt("size", r.str("node_type").and_then(sizing::aws_class_size).map(sizing::cache_size));
            let replicas = r
                .int("replicas_per_node_group")
                .or_else(|| r.int("num_cache_clusters").map(|n| n - 1))
                .or_else(|| r.int("num_cache_nodes").map(|n| n - 1));
            c.set_opt("replicas", replicas.map(|n| n.clamp(0, 5)));
            new.push(c);
        }
        for c in new {
            self.push(c);
        }
    }

    // ── queues ───────────────────────────────────────────────────────────────
    fn queues(&mut self) {
        let queues: Vec<&Res<'_>> = of(self.res, &["aws_sqs_queue"]).collect();
        // A queue referenced as another queue's deadLetterTargetArn is that queue's DLQ.
        let mut dlq_of: BTreeMap<String, String> = BTreeMap::new();
        for q in &queues {
            for a in q.ref_addrs("redrive_policy") {
                dlq_of.insert(a, q.addr.clone());
            }
        }
        for rp in of(self.res, &["aws_sqs_queue_redrive_policy"]) {
            let owners = rp.ref_addrs("queue_url");
            for a in rp.ref_addrs("redrive_policy") {
                if let Some(o) = owners.first() {
                    dlq_of.insert(a, o.clone());
                }
            }
        }
        let mut new = Vec::new();
        for q in &queues {
            self.folded.insert(q.addr.clone());
            if dlq_of.contains_key(&q.addr) {
                continue;
            }
            let mut c = self.cand(RT::Queue, q, self.name(q, &["name"]), Confidence::High);
            c.implementation = Some("sqs".into());
            let fifo = q.bool("fifo_queue").unwrap_or(false) || q.str("name").is_some_and(|n| n.ends_with(".fifo"));
            c.set("fifo", fifo);
            let has_dlq = dlq_of.values().any(|o| o == &q.addr);
            c.set("deadLetter", has_dlq);
            for (dlq, owner) in &dlq_of {
                if owner == &q.addr {
                    c.aliases.push(self.key(dlq));
                    if let Some(d) = by_addr(self.res, dlq) {
                        c.sources.push(d.source.clone());
                    }
                }
            }
            new.push(c);
        }
        for r in of(self.res, &["aws_mq_broker", "aws_msk_cluster", "azurerm_servicebus_queue", "google_pubsub_topic"])
        {
            self.folded.insert(r.addr.clone());
            let mut c =
                self.cand(RT::Queue, r, self.name(r, &["broker_name", "cluster_name", "name"]), Confidence::Medium);
            match r.r.rtype.as_str() {
                "aws_mq_broker" => {
                    if r.str("engine_type").is_some_and(|e| !e.eq_ignore_ascii_case("rabbitmq")) {
                        self.ctx.out.warn(format!("{}: ActiveMQ mapped to a queue", r.addr));
                    }
                }
                "aws_msk_cluster" => {
                    self.ctx.out.warn(format!("{}: Kafka (MSK) mapped to a queue; stream semantics differ", r.addr))
                }
                "azurerm_servicebus_queue" => {
                    c.implementation = Some("service-bus".into());
                    c.confidence = Confidence::High;
                    c.set("fifo", r.bool("requires_session").unwrap_or(false));
                    c.set("deadLetter", r.bool("dead_lettering_on_message_expiration").unwrap_or(false));
                }
                _ => {}
            }
            new.push(c);
        }
        for c in new {
            self.push(c);
        }
        let addrs: Vec<String> =
            of(self.res, &["aws_sqs_queue_redrive_policy", "aws_sqs_queue_policy", "azurerm_servicebus_namespace"])
                .map(|r| r.addr.clone())
                .collect();
        self.folded.extend(addrs);
    }

    // ── object storage ───────────────────────────────────────────────────────
    fn buckets(&mut self) {
        let mut new = Vec::new();
        for b in of(self.res, &["aws_s3_bucket"]) {
            self.folded.insert(b.addr.clone());
            let mut c = self.cand(RT::ObjectStorage, b, self.name(b, &["bucket", "bucket_prefix"]), Confidence::High);
            c.implementation = Some("s3".into());
            let mut versioning =
                blocks(&b.body, "versioning").first().and_then(|v| bool_of(v.get("enabled"))).unwrap_or(false);
            let mut retention = None;
            let mut public = matches!(b.str("acl"), Some("public-read" | "public-read-write"));
            for aux in self.res.iter().filter(|r| r.r.rtype.starts_with("aws_s3_bucket_")) {
                if !aux.ref_addrs("bucket").contains(&b.addr) {
                    continue;
                }
                c.aliases.push(aux.key.clone());
                match aux.r.rtype.as_str() {
                    "aws_s3_bucket_versioning" => {
                        c.sources.push(aux.source.clone());
                        versioning =
                            blocks(&aux.body, "versioning_configuration").first().and_then(|v| str_of(v.get("status")))
                                == Some("Enabled");
                    }
                    "aws_s3_bucket_lifecycle_configuration" => {
                        for rule in blocks(&aux.body, "rule") {
                            if let Some(days) = rule
                                .get("expiration")
                                .map(|e| match e {
                                    Value::Array(a) => a.first().cloned().unwrap_or(Value::Null),
                                    o => o.clone(),
                                })
                                .and_then(|e| int_of(get(&e, "days")))
                            {
                                retention = Some(days.max(0));
                            }
                        }
                    }
                    "aws_s3_bucket_public_access_block" => {
                        public = aux.bool("block_public_acls") == Some(false)
                            && aux.bool("restrict_public_buckets") == Some(false);
                    }
                    "aws_s3_bucket_acl" => {
                        public |= matches!(aux.str("acl"), Some("public-read" | "public-read-write"));
                    }
                    _ => {}
                }
                self.folded.insert(aux.addr.clone());
            }
            c.set("versioning", versioning);
            c.set("publicAccess", public);
            c.set_opt("retentionDays", retention);
            new.push(c);
        }
        for c in new {
            self.push(c);
        }
    }

    // ── ingress ──────────────────────────────────────────────────────────────
    fn ingress(&mut self) {
        // Target group → service keys, from ECS load_balancer blocks.
        let mut tg_services: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for svc in of(self.res, &["aws_ecs_service"]) {
            for lb in blocks(&svc.body, "load_balancer") {
                let mut refs = Vec::new();
                if let Some(v) = lb.get("target_group_arn") {
                    collect_refs(v, &mut refs);
                }
                for tg in refs.iter().filter_map(|r| ref_address(r)) {
                    tg_services.entry(tg).or_default().push(svc.key.clone());
                }
            }
        }
        let listeners: Vec<&Res<'_>> = of(self.res, &["aws_lb_listener", "aws_alb_listener"]).collect();
        let rules: Vec<&Res<'_>> = of(self.res, &["aws_lb_listener_rule", "aws_alb_listener_rule"]).collect();
        let has_cert = of(self.res, &["aws_acm_certificate"]).next().is_some();
        let mut new = Vec::new();
        let mut public_services = BTreeSet::new();
        for lb in of(self.res, &["aws_lb", "aws_alb"]) {
            self.folded.insert(lb.addr.clone());
            let mut c = self.cand(RT::Ingress, lb, self.name(lb, &["name"]), Confidence::High);
            c.implementation = Some("alb".into());
            let internal = lb.bool("internal").unwrap_or(false);
            let mut tls = has_cert;
            let mut routes: Vec<(String, String)> = Vec::new();
            for l in listeners.iter().filter(|l| l.ref_addrs("load_balancer_arn").contains(&lb.addr)) {
                c.sources.push(l.source.clone());
                if l.str("protocol") == Some("HTTPS") || l.int("port") == Some(443) {
                    tls = true;
                }
                for action in blocks(&l.body, "default_action") {
                    for tg in action_target_groups(action) {
                        for s in tg_services.get(&tg).into_iter().flatten() {
                            routes.push((s.clone(), "/".into()));
                        }
                    }
                }
                for rule in rules.iter().filter(|r| r.ref_addrs("listener_arn").contains(&l.addr)) {
                    c.sources.push(rule.source.clone());
                    let prefix = blocks(&rule.body, "condition")
                        .iter()
                        .flat_map(|cond| {
                            blocks(&Value::Object((*cond).clone()), "path_pattern")
                                .into_iter()
                                .cloned()
                                .collect::<Vec<_>>()
                        })
                        .find_map(|pp| {
                            pp.get("values")
                                .and_then(Value::as_array)
                                .and_then(|v| v.first())
                                .and_then(Value::as_str)
                                .map(path_prefix)
                        })
                        .unwrap_or_else(|| "/".into());
                    for action in blocks(&rule.body, "action") {
                        for tg in action_target_groups(action) {
                            for s in tg_services.get(&tg).into_iter().flatten() {
                                routes.push((s.clone(), prefix.clone()));
                            }
                        }
                    }
                }
            }
            routes.sort();
            routes.dedup_by(|a, b| a.0 == b.0);
            if !internal {
                public_services.extend(routes.iter().map(|r| r.0.clone()));
            }
            c.set("tls", tls);
            c.routes = routes;
            new.push(c);
        }
        for r in of(self.res, &["azurerm_application_gateway"]) {
            self.folded.insert(r.addr.clone());
            let c = self
                .cand(RT::Ingress, r, self.name(r, &["name"]), Confidence::Medium)
                .implementation("application-gateway");
            new.push(c);
        }
        // Services behind a public load balancer are public.
        for cand in self.ctx.out.candidates.iter_mut() {
            if public_services.contains(&cand.key) {
                cand.set("public", true);
            }
        }
        for c in new {
            self.push(c);
        }
        let addrs: Vec<String> = self
            .res
            .iter()
            .filter(|r| {
                r.r.rtype.starts_with("aws_lb_")
                    || r.r.rtype.starts_with("aws_alb_")
                    || r.r.rtype.starts_with("aws_acm_")
            })
            .map(|r| r.addr.clone())
            .collect();
        self.folded.extend(addrs);
    }

    // ── dns ──────────────────────────────────────────────────────────────────
    fn dns(&mut self) {
        let records: Vec<&Res<'_>> = of(
            self.res,
            &[
                "aws_route53_record",
                "aws_route53_zone",
                "azurerm_dns_zone",
                "azurerm_dns_a_record",
                "azurerm_dns_cname_record",
                "google_dns_managed_zone",
                "google_dns_record_set",
            ],
        )
        .collect();
        let Some(first) = records.first() else { return };
        let mut c = self.cand(RT::Dns, first, "dns".to_string(), Confidence::High);
        c.implementation = match provider_of(&first.r.rtype) {
            Some(Provider::Aws) => Some("route53".into()),
            Some(Provider::Azure) => Some("azure-dns".into()),
            _ => None,
        };
        let mut custom = false;
        for r in &records {
            if r.addr != first.addr {
                c.sources.push(r.source.clone());
                c.aliases.push(r.key.clone());
            }
            if r.r.rtype.ends_with("_zone") && r.bool("private_zone") != Some(true) && r.str("name").is_some() {
                custom = true;
            }
            let mut refs = Vec::new();
            collect_refs(&r.body, &mut refs);
            if let Some(lb) = refs.iter().filter_map(|x| ref_address(x)).find(|a| {
                a.starts_with("aws_lb.") || a.starts_with("aws_alb.") || a.starts_with("azurerm_application_gateway.")
            }) {
                c.dns_target = Some(self.key(&lb));
            }
        }
        c.set("customDomain", if custom { "optional" } else { "disabled" });
        let addrs: Vec<String> = records.iter().map(|r| r.addr.clone()).collect();
        self.folded.extend(addrs);
        self.push(c);
    }

    // ── Azure / GCP / OCI equivalents ────────────────────────────────────────
    fn other_clouds(&mut self) {
        let mut new = Vec::new();
        for r in self.res {
            let t = r.r.rtype.as_str();
            let c = match t {
                "azurerm_postgresql_flexible_server" | "azurerm_postgresql_server" => {
                    let mut c = self
                        .cand(RT::Postgres, r, self.name(r, &["name"]), Confidence::High)
                        .implementation("flexible-server");
                    c.set_opt("version", r.str("version").and_then(sizing::pg_major));
                    c.set_opt("size", r.str("sku_name").and_then(sizing::azure_sku_size));
                    c.set_opt("storageGiB", r.int("storage_mb").map(|mb| (mb / 1024).clamp(1, 16384)));
                    let ha = blocks(&r.body, "high_availability")
                        .first()
                        .and_then(|b| str_of(b.get("mode")))
                        .map(|m| if m == "SameZone" { "same-zone" } else { "zone-redundant" })
                        .unwrap_or("none");
                    c.set("highAvailability", ha);
                    if let Some(days) = r.int("backup_retention_days") {
                        c.set("backup", json!({ "enabled": true, "retentionDays": days.clamp(0, 35) }));
                    }
                    c.set_opt("publicAccess", r.bool("public_network_access_enabled"));
                    if t == "azurerm_postgresql_server" {
                        self.ctx
                            .out
                            .warn(format!("{}: Azure single server is retired; mapped to Flexible Server", r.addr));
                    }
                    c
                }
                "azurerm_redis_cache" => {
                    let mut c = self
                        .cand(RT::Redis, r, self.name(r, &["name"]), Confidence::High)
                        .implementation("azure-cache-redis");
                    let size = match (r.str("sku_name"), r.int("capacity")) {
                        (Some("Basic"), Some(0)) => "micro",
                        (Some("Basic"), _) | (Some("Standard"), Some(0..=1)) => "small",
                        (Some("Standard"), _) => "medium",
                        (Some("Premium"), _) => "large",
                        _ => "micro",
                    };
                    c.set("size", size);
                    c.set_opt("replicas", r.int("replicas_per_master").map(|n| n.clamp(0, 5)));
                    c
                }
                "azurerm_storage_account" => {
                    let mut c = self
                        .cand(RT::ObjectStorage, r, self.name(r, &["name"]), Confidence::High)
                        .implementation("blob-storage");
                    let versioning = blocks(&r.body, "blob_properties")
                        .first()
                        .and_then(|b| bool_of(b.get("versioning_enabled")))
                        .unwrap_or(false);
                    c.set("versioning", versioning);
                    c.set("tier", if r.str("access_tier") == Some("Cool") { "infrequent" } else { "standard" });
                    c
                }
                "azurerm_container_app" => {
                    let mut c = self
                        .cand(RT::ContainerService, r, self.name(r, &["name"]), Confidence::High)
                        .implementation("container-apps");
                    if let Some(tpl) = blocks(&r.body, "template").first().map(|m| Value::Object((*m).clone())) {
                        if let Some(ct) = blocks(&tpl, "container").first() {
                            c.set_opt("sourceImage", str_of(ct.get("image")).filter(|s| !s.contains("${")));
                            c.set_opt("cpu", num_of(ct.get("cpu")).map(sizing::clamp_cpu));
                            c.set_opt(
                                "memoryMiB",
                                str_of(ct.get("memory")).and_then(sizing::memory_mib).map(sizing::clamp_memory),
                            );
                        }
                        c.set_opt("replicas", int_of(get(&tpl, "min_replicas")).map(|n| n.clamp(0, 100)));
                    }
                    if let Some(ing) = blocks(&r.body, "ingress").first() {
                        c.set_opt("port", int_of(ing.get("target_port")).map(|p| p.clamp(1, 65535)));
                        c.set_opt("public", bool_of(ing.get("external_enabled")));
                    }
                    c
                }
                "google_sql_database_instance" => {
                    let version = r.str("database_version").unwrap_or("");
                    if !version.starts_with("POSTGRES") {
                        self.ctx.out.unmapped(
                            r.source.clone(),
                            t,
                            format!("engine \"{version}\" is not supported; OrkStage databases are PostgreSQL"),
                        );
                        continue;
                    }
                    let mut c = self.cand(RT::Postgres, r, self.name(r, &["name"]), Confidence::High);
                    c.set_opt("version", sizing::pg_major(version));
                    if let Some(settings) = blocks(&r.body, "settings").first().map(|m| Value::Object((*m).clone())) {
                        c.set_opt("size", str_of(get(&settings, "tier")).and_then(sizing::gcp_tier_size));
                        c.set_opt("storageGiB", int_of(get(&settings, "disk_size")).map(|g| g.clamp(1, 16384)));
                        c.set(
                            "highAvailability",
                            if str_of(get(&settings, "availability_type")) == Some("REGIONAL") {
                                "zone-redundant"
                            } else {
                                "none"
                            },
                        );
                        if let Some(b) = blocks(&settings, "backup_configuration").first() {
                            let enabled = bool_of(b.get("enabled")).unwrap_or(false);
                            let days = blocks(&Value::Object((*b).clone()), "backup_retention_settings")
                                .first()
                                .and_then(|x| int_of(x.get("retained_backups")))
                                .unwrap_or(7);
                            c.set("backup", json!({ "enabled": enabled, "retentionDays": days.clamp(0, 35) }));
                        }
                    }
                    c
                }
                "google_redis_instance" => {
                    let mut c = self.cand(RT::Redis, r, self.name(r, &["name"]), Confidence::High);
                    let size = match r.num("memory_size_gb").unwrap_or(1.0) {
                        g if g <= 1.0 => "micro",
                        g if g <= 3.0 => "small",
                        g if g <= 6.0 => "medium",
                        _ => "large",
                    };
                    c.set("size", size);
                    c.set("replicas", if r.str("tier") == Some("STANDARD_HA") { 1 } else { 0 });
                    c
                }
                "google_storage_bucket" => {
                    let mut c = self.cand(RT::ObjectStorage, r, self.name(r, &["name"]), Confidence::High);
                    let versioning =
                        blocks(&r.body, "versioning").first().and_then(|b| bool_of(b.get("enabled"))).unwrap_or(false);
                    c.set("versioning", versioning);
                    c.set(
                        "tier",
                        match r.str("storage_class") {
                            Some("NEARLINE" | "COLDLINE") => "infrequent",
                            Some("ARCHIVE") => "archive",
                            _ => "standard",
                        },
                    );
                    c
                }
                "google_cloud_run_service" | "google_cloud_run_v2_service" => {
                    let mut c = self.cand(RT::ContainerService, r, self.name(r, &["name"]), Confidence::High);
                    let mut stack = vec![r.body.clone()];
                    // Walk template/spec/containers wherever they are nested.
                    while let Some(v) = stack.pop() {
                        if let Some(img) = str_of(get(&v, "image")).filter(|s| !s.contains("${")) {
                            c.set("sourceImage", img);
                            if let Some(port) =
                                blocks(&v, "ports").first().and_then(|p| int_of(p.get("container_port")))
                            {
                                c.set("port", port.clamp(1, 65535));
                            }
                            if let Some(limits) = blocks(&v, "resources").first().and_then(|r| r.get("limits")) {
                                c.set_opt(
                                    "cpu",
                                    str_of(get(limits, "cpu")).and_then(sizing::k8s_cpu).map(sizing::clamp_cpu),
                                );
                                c.set_opt(
                                    "memoryMiB",
                                    str_of(get(limits, "memory"))
                                        .and_then(sizing::memory_mib)
                                        .map(sizing::clamp_memory),
                                );
                            }
                        }
                        for key in ["template", "spec", "containers"] {
                            for b in blocks(&v, key) {
                                stack.push(Value::Object(b.clone()));
                            }
                        }
                    }
                    c.set("public", true);
                    c
                }
                "oci_psql_db_system" => {
                    let mut c = self
                        .cand(RT::Postgres, r, self.name(r, &["display_name"]), Confidence::High)
                        .implementation("oci-postgresql");
                    c.set_opt("version", r.str("db_version").and_then(sizing::pg_major));
                    let nodes = r.int("instance_count").unwrap_or(1);
                    c.set("highAvailability", if nodes >= 2 { "zone-redundant" } else { "none" });
                    c
                }
                "oci_objectstorage_bucket" => {
                    let mut c = self
                        .cand(RT::ObjectStorage, r, self.name(r, &["name"]), Confidence::High)
                        .implementation("object-storage");
                    c.set("versioning", r.str("versioning") == Some("Enabled"));
                    c.set("tier", if r.str("storage_tier") == Some("Archive") { "archive" } else { "standard" });
                    c
                }
                "oci_container_instances_container_instance" => {
                    let mut c = self
                        .cand(RT::ContainerService, r, self.name(r, &["display_name"]), Confidence::High)
                        .implementation("container-instances");
                    if let Some(ct) = blocks(&r.body, "containers").first() {
                        c.set_opt("sourceImage", str_of(ct.get("image_url")).filter(|s| !s.contains("${")));
                    }
                    if let Some(shape) = blocks(&r.body, "shape_config").first() {
                        c.set_opt("cpu", num_of(shape.get("ocpus")).map(sizing::clamp_cpu));
                        c.set_opt(
                            "memoryMiB",
                            num_of(shape.get("memory_in_gbs")).map(|g| sizing::clamp_memory(g * 1024.0)),
                        );
                    }
                    c
                }
                _ => continue,
            };
            self.folded.insert(r.addr.clone());
            new.push(c);
        }
        for c in new {
            self.push(c);
        }
    }

    // ── everything else ──────────────────────────────────────────────────────
    fn leftovers(&mut self) {
        let mut supporting = 0usize;
        let res: Vec<&Res<'_>> = self.res.iter().filter(|r| !self.folded.contains(&r.addr)).collect();
        for r in res {
            let t = r.r.rtype.as_str();
            if is_supporting(t) {
                supporting += 1;
                continue;
            }
            self.ctx.out.unmapped(r.source.clone(), t, unmapped_reason(t));
        }
        self.ctx.supporting += supporting;
        let _ = self.outputs;
    }
}

fn child_dir<'d>(dirs: &'d BTreeMap<String, TfDir>, dir: &str, _scope: &str, child_scope: &str) -> Option<&'d TfDir> {
    // The child module's directory is recovered from its call in `dir`.
    let call = child_scope.rsplit("/module.").next()?;
    let d = dirs.get(dir)?;
    let m = d.modules.iter().find(|m| m.name == call)?;
    dirs.get(&local_source(dir, &m.source)?)
}

fn action_target_groups(action: &Map<String, Value>) -> Vec<String> {
    let mut refs = Vec::new();
    if let Some(v) = action.get("target_group_arn") {
        collect_refs(v, &mut refs);
    }
    if let Some(v) = action.get("forward") {
        collect_refs(v, &mut refs);
    }
    refs.iter().filter_map(|r| ref_address(r)).collect()
}

fn path_prefix(pattern: &str) -> String {
    let p = pattern.trim_end_matches('*').trim_end_matches('/');
    if p.is_empty() || !p.starts_with('/') { "/".into() } else { p.to_string() }
}

const SUPPORTING_PREFIXES: &[&str] = &[
    "aws_iam_",
    "aws_security_group",
    "aws_vpc_security_group_",
    "aws_cloudwatch_",
    "aws_kms_",
    "aws_secretsmanager_",
    "aws_ssm_",
    "aws_route_table",
    "aws_route",
    "aws_internet_gateway",
    "aws_egress_only_internet_gateway",
    "aws_eip",
    "aws_db_subnet_group",
    "aws_db_parameter_group",
    "aws_db_option_group",
    "aws_rds_cluster_parameter_group",
    "aws_elasticache_subnet_group",
    "aws_elasticache_parameter_group",
    "aws_ecs_cluster",
    "aws_ecs_capacity_provider",
    "aws_autoscaling_",
    "aws_launch_template",
    "aws_ecr_lifecycle_policy",
    "aws_ecr_repository_policy",
    "aws_service_discovery_",
    "aws_vpc_endpoint",
    "aws_flow_log",
    "aws_network_acl",
    "aws_main_route_table_association",
    "aws_default_",
    "aws_vpc_dhcp_options",
    "aws_wafv2_web_acl_association",
    "random_",
    "null_",
    "time_",
    "tls_",
    "local_",
    "terraform_data",
    "azurerm_resource_group",
    "azurerm_subnet",
    "azurerm_network_security_group",
    "azurerm_role_assignment",
    "azurerm_user_assigned_identity",
    "azurerm_log_analytics_workspace",
    "azurerm_container_app_environment",
    "azurerm_postgresql_flexible_server_",
    "azurerm_storage_container",
    "azurerm_private_dns_",
    "azurerm_private_endpoint",
    "azurerm_key_vault",
    "azurerm_servicebus_namespace",
    "azurerm_public_ip",
    "google_project_service",
    "google_service_account",
    "google_project_iam",
    "google_compute_subnetwork",
    "google_compute_firewall",
    "google_compute_router",
    "google_sql_database",
    "google_sql_user",
    "google_vpc_access_connector",
    "google_compute_global_address",
    "google_service_networking_connection",
    "google_cloud_run_service_iam",
    "google_cloud_run_v2_service_iam",
    "google_secret_manager_",
    "oci_core_subnet",
    "oci_core_internet_gateway",
    "oci_core_nat_gateway",
    "oci_core_service_gateway",
    "oci_core_route_table",
    "oci_core_security_list",
    "oci_core_network_security_group",
    "oci_identity_",
];

fn is_supporting(t: &str) -> bool {
    SUPPORTING_PREFIXES.iter().any(|p| t.starts_with(p)) && !t.ends_with("_iam_member_binding_unused")
}

fn unmapped_reason(t: &str) -> String {
    let r = if t.contains("lambda")
        || t.starts_with("google_cloudfunctions")
        || t.starts_with("azurerm_function_app")
        || t.starts_with("azurerm_linux_function_app")
    {
        "functions are not supported yet"
    } else if t == "aws_instance"
        || t.contains("virtual_machine")
        || t == "google_compute_instance"
        || t == "oci_core_instance"
    {
        "virtual machines are not supported; containerize the workload"
    } else if t.contains("dynamodb") || t.contains("cosmosdb") || t.contains("firestore") || t.contains("bigtable") {
        "NoSQL databases have no OrkStage logical type yet"
    } else if t.contains("eks_")
        || t.contains("kubernetes_cluster")
        || t.contains("container_cluster")
        || t.contains("containerengine")
    {
        "Kubernetes clusters are infrastructure, not template resources; scan the workload manifests instead"
    } else if t.contains("cloudfront") || t.contains("cdn") {
        "CDNs are not supported yet"
    } else if t.contains("sns_")
        || t.contains("eventbridge")
        || t.contains("cloudwatch_event")
        || t.contains("eventgrid")
    {
        "pub/sub and event buses are not supported yet (queues are)"
    } else if t.contains("api_gateway") || t.contains("apigateway") || t.contains("api_management") {
        "API gateways are not supported yet; use an ingress"
    } else if t.contains("mysql") || t.contains("mssql") || t.contains("mariadb") || t.contains("oracle") {
        "only PostgreSQL databases are supported"
    } else if t.starts_with("kubernetes_") || t.starts_with("helm_") {
        "Kubernetes provider resources are not mapped from Terraform; scan the manifests instead"
    } else {
        "no OrkStage mapping for this resource type"
    };
    r.to_string()
}

/// Rewrites references in module arguments so they keep meaning inside the child module:
/// `aws_x.y` → `@tf:<scope>:aws_x.y`, `module.m.out` → the resource behind that output.
fn absolutize(v: &Value, scope: &str, dir: &str, dirs: &BTreeMap<String, TfDir>) -> Value {
    match v {
        Value::Object(m) => {
            if let Some(Value::String(r)) = m.get("$ref") {
                if let Some(abs) = absolute_ref(r, scope, dir, dirs) {
                    return json!({ "$ref": abs });
                }
                return v.clone();
            }
            Value::Object(m.iter().map(|(k, x)| (k.clone(), absolutize(x, scope, dir, dirs))).collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| absolutize(x, scope, dir, dirs)).collect()),
        other => other.clone(),
    }
}

fn absolute_ref(r: &str, scope: &str, dir: &str, dirs: &BTreeMap<String, TfDir>) -> Option<String> {
    if r.starts_with('@') {
        return Some(r.to_string());
    }
    let addr = ref_address(r)?;
    let Some(module) = addr.strip_prefix("module.") else {
        return Some(format!("@tf:{scope}:{addr}"));
    };
    let segs = ref_segments(r);
    let output = segs.get(2)?;
    let call = dirs.get(dir)?.modules.iter().find(|m| m.name == module)?;
    let child_dir = local_source(dir, &call.source)?;
    let value = dirs.get(&child_dir)?.outputs.get(*output)?;
    let mut refs = Vec::new();
    collect_refs(value, &mut refs);
    let child_scope = format!("{scope}/module.{module}");
    refs.iter().find_map(|x| absolute_ref(x, &child_scope, &child_dir, dirs))
}

/// `@tf:<scope>:aws_db_instance.this` → `aws_db_instance.this` for evidence strings.
fn display_ref(r: &str) -> &str {
    r.strip_prefix('@').and_then(|x| x.rsplit(':').next()).unwrap_or(r)
}
