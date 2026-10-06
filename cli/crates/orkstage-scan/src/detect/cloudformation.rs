//! CloudFormation, SAM and CDK synthesized templates (`cdk.out/*.template.json`).
//! YAML short-form intrinsics are normalised by `crate::yaml` to their long form.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use crate::evidence::{Candidate, Endpoint, Findings, src};
use crate::model::{Confidence, Provider, ResourceType as RT, SourceKind, SourceRef};
use crate::sizing;
use crate::util::{bool_of, get, int_of, num_of, str_of};

pub(crate) struct CfnDoc<'a> {
    pub file: &'a str,
    pub kind: SourceKind,
    pub value: Value,
    pub lines: BTreeMap<String, u32>,
}

/// Is this parsed document a CloudFormation template?
pub(crate) fn is_cfn(v: &Value) -> bool {
    if get(v, "AWSTemplateFormatVersion").is_some() {
        return true;
    }
    get(v, "Resources").and_then(Value::as_object).is_some_and(|m| {
        m.values().any(|r| str_of(get(r, "Type")).is_some_and(|t| t.starts_with("AWS::") || t.starts_with("Custom::")))
    })
}

pub(crate) fn is_sam(v: &Value) -> bool {
    match get(v, "Transform") {
        Some(Value::String(s)) => s.starts_with("AWS::Serverless"),
        Some(Value::Array(a)) => a.iter().any(|t| t.as_str().is_some_and(|s| s.starts_with("AWS::Serverless"))),
        _ => false,
    }
}

struct R<'a> {
    id: &'a str,
    rtype: &'a str,
    props: Value,
    key: String,
    source: SourceRef,
}

impl R<'_> {
    fn p(&self, k: &str) -> Option<&Value> {
        get(&self.props, k)
    }
    fn s(&self, k: &str) -> Option<&str> {
        str_of(self.p(k))
    }
    fn i(&self, k: &str) -> Option<i64> {
        int_of(self.p(k))
    }
    fn b(&self, k: &str) -> Option<bool> {
        bool_of(self.p(k))
    }
    fn refs(&self, k: &str) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(v) = self.p(k) {
            refs(v, &mut out);
        }
        out
    }
}

static SUB_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$\{([A-Za-z0-9]+)(?:\.[A-Za-z0-9.]+)?\}").unwrap());

/// Logical ids referenced by `Ref`, `Fn::GetAtt` and `Fn::Sub`.
pub(crate) fn refs(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            if let Some(Value::String(r)) = m.get("Ref")
                && !r.starts_with("AWS::")
            {
                out.push(r.clone());
            }
            match m.get("Fn::GetAtt") {
                Some(Value::Array(a)) => {
                    if let Some(Value::String(r)) = a.first() {
                        out.push(r.clone());
                    }
                }
                Some(Value::String(s)) => out.push(s.split('.').next().unwrap_or(s).to_string()),
                _ => {}
            }
            let sub = match m.get("Fn::Sub") {
                Some(Value::String(s)) => Some(s.as_str()),
                Some(Value::Array(a)) => a.first().and_then(Value::as_str),
                _ => None,
            };
            if let Some(s) = sub {
                for cap in SUB_REF.captures_iter(s) {
                    out.push(cap[1].to_string());
                }
            }
            for (k, child) in m {
                if k != "Ref" && k != "Fn::GetAtt" {
                    refs(child, out);
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| refs(x, out)),
        _ => {}
    }
}

/// Substitutes `Ref`s to parameters that have a `Default`.
fn resolve_params(v: &Value, params: &BTreeMap<String, Value>) -> Value {
    match v {
        Value::Object(m) => {
            if m.len() == 1
                && let Some(Value::String(r)) = m.get("Ref")
                && let Some(d) = params.get(r)
            {
                return d.clone();
            }
            Value::Object(m.iter().map(|(k, x)| (k.clone(), resolve_params(x, params))).collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| resolve_params(x, params)).collect()),
        other => other.clone(),
    }
}

pub(crate) fn detect(doc: CfnDoc<'_>, out: &mut Findings) {
    out.count(doc.kind, doc.file);
    let params: BTreeMap<String, Value> = get(&doc.value, "Parameters")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, p)| get(p, "Default").map(|d| (k.clone(), d.clone()))).collect())
        .unwrap_or_default();
    let Some(resources) = get(&doc.value, "Resources").and_then(Value::as_object) else { return };
    let res: Vec<R<'_>> = resources
        .iter()
        .map(|(id, r)| {
            let rtype = str_of(get(r, "Type")).unwrap_or("");
            let line = doc.lines.get(&format!("Resources/{id}")).copied();
            R {
                id,
                rtype,
                props: resolve_params(get(r, "Properties").unwrap_or(&Value::Null), &params),
                key: format!("cfn:{}:{id}", doc.file),
                source: src(doc.kind, doc.file, line, id.clone()),
            }
        })
        .collect();
    Mapper { file: doc.file, res: &res, out, folded: BTreeSet::new() }.run();
}

struct Mapper<'a, 'o> {
    file: &'a str,
    res: &'a [R<'a>],
    out: &'o mut Findings,
    folded: BTreeSet<String>,
}

fn of<'a>(res: &'a [R<'a>], types: &'a [&'a str]) -> impl Iterator<Item = &'a R<'a>> + 'a {
    res.iter().filter(move |r| types.contains(&r.rtype))
}

fn by_id<'a>(res: &'a [R<'a>], id: &str) -> Option<&'a R<'a>> {
    res.iter().find(|r| r.id == id)
}

fn name(r: &R<'_>, attrs: &[&str]) -> String {
    for a in attrs {
        if let Some(v) = r.s(a)
            && !v.is_empty()
        {
            return v.to_string();
        }
    }
    r.id.to_string()
}

impl Mapper<'_, '_> {
    fn key(&self, id: &str) -> String {
        format!("cfn:{}:{id}", self.file)
    }

    fn cand(&self, kind: RT, r: &R<'_>, name: String, conf: Confidence) -> Candidate {
        Candidate::new(kind, Some(Provider::Aws), name, r.source.clone(), conf, r.key.clone())
    }

    fn fold(&mut self, id: &str) {
        self.folded.insert(id.to_string());
    }

    fn run(&mut self) {
        let res = self.res;
        // network
        let azs: BTreeSet<String> = of(res, &["AWS::EC2::Subnet"])
            .map(|s| s.p("AvailabilityZone").map(|v| v.to_string()).unwrap_or_default())
            .collect();
        let nat = of(res, &["AWS::EC2::NatGateway"]).next().is_some();
        for v in of(res, &["AWS::EC2::VPC"]) {
            let mut c = self.cand(RT::Network, v, v.id.to_string(), Confidence::High).implementation("vpc");
            c.set("availabilityZones", (azs.len() as i64).clamp(1, 3));
            c.set("natGateway", nat);
            self.out.candidates.push(c);
            self.fold(v.id);
        }
        for r in of(res, &["AWS::EC2::Subnet", "AWS::EC2::NatGateway"]) {
            self.fold(r.id);
        }

        // registry
        for r in of(res, &["AWS::ECR::Repository"]) {
            let mut c = self
                .cand(RT::ContainerRegistry, r, name(r, &["RepositoryName"]), Confidence::High)
                .implementation("ecr");
            c.set(
                "scanOnPush",
                r.p("ImageScanningConfiguration").and_then(|v| bool_of(get(v, "ScanOnPush"))).unwrap_or(false),
            );
            c.set("immutableTags", r.s("ImageTagMutability").is_some_and(|m| m.starts_with("IMMUTABLE")));
            self.out.candidates.push(c);
            self.fold(r.id);
        }

        self.containers();
        self.data();
        self.leftovers();
    }

    fn containers(&mut self) {
        let res = self.res;
        let mut used = BTreeSet::new();
        let mut tg_services: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for svc in of(res, &["AWS::ECS::Service"]) {
            self.fold(svc.id);
            let mut c = self.cand(RT::ContainerService, svc, name(svc, &["ServiceName"]), Confidence::High);
            if let Some(td) = svc.refs("TaskDefinition").first().and_then(|id| by_id(res, id)) {
                used.insert(td.id);
                c.aliases.push(td.key.clone());
                c.sources.push(td.source.clone());
                self.task_definition(td, &mut c);
            }
            c.set_opt("replicas", svc.i("DesiredCount").map(|n| n.clamp(0, 100)));
            let launch = svc.s("LaunchType").map(str::to_string).or_else(|| {
                svc.p("CapacityProviderStrategy").and_then(Value::as_array).and_then(|a| a.first()).map(
                    |s| match str_of(get(s, "CapacityProvider")) {
                        Some(cp) if cp.starts_with("FARGATE") => "FARGATE".to_string(),
                        _ => "EC2".to_string(),
                    },
                )
            });
            c.implementation = Some(if launch.as_deref() == Some("EC2") { "ecs-ec2" } else { "ecs-fargate" }.into());
            if svc
                .p("NetworkConfiguration")
                .and_then(|n| get(n, "AwsvpcConfiguration"))
                .and_then(|a| str_of(get(a, "AssignPublicIp")))
                == Some("ENABLED")
            {
                c.set("public", true);
            }
            for lb in svc.p("LoadBalancers").and_then(Value::as_array).into_iter().flatten() {
                let mut tgs = Vec::new();
                if let Some(v) = get(lb, "TargetGroupArn") {
                    refs(v, &mut tgs);
                }
                for tg in tgs {
                    tg_services.entry(tg.clone()).or_default().push(c.key.clone());
                    c.aliases.push(self.key(&tg));
                    if let Some(path) =
                        by_id(res, &tg).and_then(|t| t.s("HealthCheckPath")).filter(|p| p.starts_with('/'))
                    {
                        c.set("healthCheckPath", path);
                    }
                }
                c.set_opt("port", int_of(get(lb, "ContainerPort")).map(|p| p.clamp(1, 65535)));
            }
            self.out.candidates.push(c);
        }
        for td in of(res, &["AWS::ECS::TaskDefinition"]) {
            self.fold(td.id);
            if used.contains(td.id) {
                continue;
            }
            let mut c = self
                .cand(RT::ContainerService, td, name(td, &["Family"]), Confidence::Medium)
                .implementation("ecs-fargate");
            self.task_definition(td, &mut c);
            self.out.candidates.push(c);
        }
        // Autoscaling
        for t in of(res, &["AWS::ApplicationAutoScaling::ScalableTarget"]) {
            self.fold(t.id);
            let svc = t
                .refs("ResourceId")
                .into_iter()
                .find(|id| by_id(res, id).is_some_and(|r| r.rtype == "AWS::ECS::Service"));
            let (Some(svc), Some(min), Some(max)) = (svc, t.i("MinCapacity"), t.i("MaxCapacity")) else { continue };
            let target = of(res, &["AWS::ApplicationAutoScaling::ScalingPolicy"])
                .filter(|p| p.refs("ScalingTargetId").iter().any(|x| x == t.id))
                .find_map(|p| {
                    p.p("TargetTrackingScalingPolicyConfiguration").and_then(|c| num_of(get(c, "TargetValue")))
                })
                .unwrap_or(70.0);
            let key = self.key(&svc);
            if let Some(c) = self.out.candidates.iter_mut().find(|c| c.key == key) {
                c.set(
                    "autoscaling",
                    json!({ "minReplicas": min.max(0), "maxReplicas": max.max(1), "targetCpuPercent": (target.round() as i64).clamp(10, 95) }),
                );
                c.sources.push(t.source.clone());
            }
        }
        for p in of(res, &["AWS::ApplicationAutoScaling::ScalingPolicy"]) {
            self.fold(p.id);
        }
        // Ingress routing needs the TG → service map.
        self.ingress(&tg_services);
    }

    fn task_definition(&mut self, td: &R<'_>, c: &mut Candidate) {
        if let Some(compat) = td.p("RequiresCompatibilities").and_then(Value::as_array) {
            if compat.iter().any(|v| v == "FARGATE") {
                c.implementation = Some("ecs-fargate".into());
            } else if compat.iter().any(|v| v == "EC2") {
                c.implementation = Some("ecs-ec2".into());
            }
        }
        if let Some(cpu) = td.p("Cpu").and_then(sizing::ecs_cpu) {
            c.set("cpu", sizing::clamp_cpu(cpu));
        }
        if let Some(mem) = td.p("Memory").and_then(sizing::ecs_memory) {
            c.set("memoryMiB", sizing::clamp_memory(mem));
        }
        let Some(defs) = td.p("ContainerDefinitions").and_then(Value::as_array) else { return };
        let Some(main) = defs.iter().find(|d| get(d, "PortMappings").is_some()).or_else(|| defs.first()) else {
            return;
        };
        if let Some(img) = str_of(get(main, "Image")) {
            c.set("sourceImage", img);
        }
        if let Some(port) = get(main, "PortMappings")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|p| int_of(get(p, "ContainerPort")))
        {
            c.set("port", port.clamp(1, 65535));
        }
        for field in ["Environment", "Secrets"] {
            for item in get(main, field).and_then(Value::as_array).into_iter().flatten() {
                let var = str_of(get(item, "Name")).unwrap_or("?");
                let mut ids = Vec::new();
                if let Some(v) = get(item, "Value").or_else(|| get(item, "ValueFrom")) {
                    refs(v, &mut ids);
                }
                for id in ids {
                    self.out.link(
                        Endpoint::Key(c.key.clone()),
                        Endpoint::Key(self.key(&id)),
                        None,
                        None,
                        format!("{} {var} → {id}", td.id),
                    );
                }
            }
        }
    }

    fn data(&mut self) {
        let res = self.res;
        let dbs: Vec<&R<'_>> = of(res, &["AWS::RDS::DBInstance", "AWS::RDS::DBCluster"]).collect();
        let single_db = dbs.len() == 1;
        for r in &dbs {
            self.fold(r.id);
            let engine = r.s("Engine").unwrap_or("");
            if r.rtype == "AWS::RDS::DBInstance" && r.p("DBClusterIdentifier").is_some() {
                continue; // member of a cluster
            }
            if r.p("SourceDBInstanceIdentifier").is_some() {
                continue; // read replica
            }
            if !engine.contains("postgres") {
                self.out.unmapped(
                    r.source.clone(),
                    r.rtype,
                    format!("engine \"{engine}\" is not supported; OrkStage databases are PostgreSQL"),
                );
                continue;
            }
            let mut c = self
                .cand(
                    RT::Postgres,
                    r,
                    name(r, &["DBInstanceIdentifier", "DBClusterIdentifier", "DBName"]),
                    Confidence::High,
                )
                .implementation("rds-postgres");
            c.set_opt("version", r.s("EngineVersion").and_then(sizing::pg_major));
            let mut class = r.s("DBInstanceClass").map(str::to_string);
            if r.rtype == "AWS::RDS::DBCluster" {
                let members: Vec<&R<'_>> =
                    dbs.iter().filter(|m| m.refs("DBClusterIdentifier").iter().any(|x| x == r.id)).copied().collect();
                for m in &members {
                    class = class.or_else(|| m.s("DBInstanceClass").map(str::to_string));
                    c.aliases.push(m.key.clone());
                    c.sources.push(m.source.clone());
                }
                c.set("storageGiB", 20);
                c.set("highAvailability", if members.len() >= 2 { "zone-redundant" } else { "none" });
            } else {
                c.set_opt("storageGiB", r.i("AllocatedStorage").map(|g| g.clamp(1, 16384)));
                c.set("highAvailability", if r.b("MultiAZ") == Some(true) { "zone-redundant" } else { "none" });
            }
            c.set_opt("size", class.as_deref().and_then(sizing::aws_class_size));
            if let Some(days) = r.i("BackupRetentionPeriod") {
                c.set("backup", json!({ "enabled": days > 0, "retentionDays": days.clamp(0, 35) }));
            }
            c.set_opt("publicAccess", r.b("PubliclyAccessible"));
            if single_db {
                for s in of(res, &["AWS::SecretsManager::Secret"]) {
                    c.aliases.push(s.key.clone());
                }
            }
            self.out.candidates.push(c);
        }

        let groups: Vec<&str> = of(res, &["AWS::ElastiCache::ReplicationGroup"]).map(|r| r.id).collect();
        for r in of(
            res,
            &[
                "AWS::ElastiCache::ReplicationGroup",
                "AWS::ElastiCache::CacheCluster",
                "AWS::ElastiCache::ServerlessCache",
            ],
        ) {
            self.fold(r.id);
            if r.rtype == "AWS::ElastiCache::CacheCluster"
                && r.refs("ReplicationGroupId").iter().any(|g| groups.contains(&g.as_str()))
            {
                continue;
            }
            let engine = r.s("Engine").unwrap_or("redis").to_ascii_lowercase();
            if engine == "memcached" {
                self.out.unmapped(
                    r.source.clone(),
                    r.rtype,
                    "memcached is not supported; OrkStage caches are Redis/Valkey compatible",
                );
                continue;
            }
            let mut c = self
                .cand(
                    RT::Redis,
                    r,
                    name(r, &["ReplicationGroupId", "ClusterName", "ServerlessCacheName"]),
                    Confidence::High,
                )
                .implementation("elasticache-valkey");
            c.set_opt("size", r.s("CacheNodeType").and_then(sizing::aws_class_size).map(sizing::cache_size));
            let replicas = r
                .i("ReplicasPerNodeGroup")
                .or_else(|| r.i("NumCacheClusters").map(|n| n - 1))
                .or_else(|| r.i("NumCacheNodes").map(|n| n - 1));
            c.set_opt("replicas", replicas.map(|n| n.clamp(0, 5)));
            self.out.candidates.push(c);
        }

        let queues: Vec<&R<'_>> = of(res, &["AWS::SQS::Queue"]).collect();
        let mut dlq_of: BTreeMap<String, String> = BTreeMap::new();
        for q in &queues {
            for d in q.refs("RedrivePolicy") {
                dlq_of.insert(d, q.id.to_string());
            }
        }
        for q in &queues {
            self.fold(q.id);
            if dlq_of.contains_key(q.id) {
                continue;
            }
            let mut c = self.cand(RT::Queue, q, name(q, &["QueueName"]), Confidence::High).implementation("sqs");
            c.set("fifo", q.b("FifoQueue").unwrap_or(false));
            let mut has_dlq = false;
            for (dlq, owner) in &dlq_of {
                if owner == q.id {
                    has_dlq = true;
                    c.aliases.push(self.key(dlq));
                    if let Some(d) = by_id(res, dlq) {
                        c.sources.push(d.source.clone());
                    }
                }
            }
            c.set("deadLetter", has_dlq);
            self.out.candidates.push(c);
        }
        for r in of(res, &["AWS::AmazonMQ::Broker", "AWS::MSK::Cluster"]) {
            self.fold(r.id);
            let c = self.cand(RT::Queue, r, name(r, &["BrokerName", "ClusterName"]), Confidence::Medium);
            self.out.candidates.push(c);
        }

        for b in of(res, &["AWS::S3::Bucket"]) {
            self.fold(b.id);
            let mut c =
                self.cand(RT::ObjectStorage, b, name(b, &["BucketName"]), Confidence::High).implementation("s3");
            c.set(
                "versioning",
                b.p("VersioningConfiguration").and_then(|v| str_of(get(v, "Status"))) == Some("Enabled"),
            );
            let retention = b
                .p("LifecycleConfiguration")
                .and_then(|l| get(l, "Rules"))
                .and_then(Value::as_array)
                .and_then(|rules| rules.iter().find_map(|r| int_of(get(r, "ExpirationInDays"))));
            c.set_opt("retentionDays", retention.map(|d| d.max(0)));
            let public = b.p("PublicAccessBlockConfiguration").is_some_and(|p| {
                bool_of(get(p, "BlockPublicAcls")) == Some(false)
                    && bool_of(get(p, "RestrictPublicBuckets")) == Some(false)
            }) || matches!(b.s("AccessControl"), Some("PublicRead" | "PublicReadWrite"));
            c.set("publicAccess", public);
            self.out.candidates.push(c);
        }
    }

    fn ingress(&mut self, tg_services: &BTreeMap<String, Vec<String>>) {
        let res = self.res;
        let has_cert = of(res, &["AWS::CertificateManager::Certificate"]).next().is_some();
        let listeners: Vec<&R<'_>> = of(res, &["AWS::ElasticLoadBalancingV2::Listener"]).collect();
        let rules: Vec<&R<'_>> = of(res, &["AWS::ElasticLoadBalancingV2::ListenerRule"]).collect();
        let mut public_services = BTreeSet::new();
        for lb in of(res, &["AWS::ElasticLoadBalancingV2::LoadBalancer"]) {
            self.fold(lb.id);
            let mut c = self.cand(RT::Ingress, lb, name(lb, &["Name"]), Confidence::High).implementation("alb");
            let mut tls = has_cert;
            let mut routes: Vec<(String, String)> = Vec::new();
            for l in listeners.iter().filter(|l| l.refs("LoadBalancerArn").iter().any(|x| x == lb.id)) {
                c.sources.push(l.source.clone());
                if l.s("Protocol") == Some("HTTPS") || l.i("Port") == Some(443) {
                    tls = true;
                }
                for tg in l.refs("DefaultActions") {
                    for s in tg_services.get(&tg).into_iter().flatten() {
                        routes.push((s.clone(), "/".into()));
                    }
                }
                for rule in rules.iter().filter(|r| r.refs("ListenerArn").iter().any(|x| x == l.id)) {
                    c.sources.push(rule.source.clone());
                    let prefix = rule
                        .p("Conditions")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .find_map(|cond| {
                            let values =
                                get(cond, "PathPatternConfig").and_then(|p| get(p, "Values")).or_else(|| {
                                    (str_of(get(cond, "Field")) == Some("path-pattern"))
                                        .then(|| get(cond, "Values"))
                                        .flatten()
                                })?;
                            values.as_array()?.first()?.as_str().map(path_prefix)
                        })
                        .unwrap_or_else(|| "/".into());
                    for tg in rule.refs("Actions") {
                        for s in tg_services.get(&tg).into_iter().flatten() {
                            routes.push((s.clone(), prefix.clone()));
                        }
                    }
                }
            }
            routes.sort();
            routes.dedup_by(|a, b| a.0 == b.0);
            if lb.s("Scheme") != Some("internal") {
                public_services.extend(routes.iter().map(|r| r.0.clone()));
            }
            c.set("tls", tls);
            c.routes = routes;
            self.out.candidates.push(c);
        }
        for cand in self.out.candidates.iter_mut() {
            if public_services.contains(&cand.key) {
                cand.set("public", true);
            }
        }
        for r in res.iter().filter(|r| {
            r.rtype.starts_with("AWS::ElasticLoadBalancingV2::") || r.rtype.starts_with("AWS::CertificateManager::")
        }) {
            self.fold(r.id);
        }

        // DNS
        let records: Vec<&R<'_>> =
            of(res, &["AWS::Route53::RecordSet", "AWS::Route53::RecordSetGroup", "AWS::Route53::HostedZone"]).collect();
        if let Some(first) = records.first() {
            let mut c = self.cand(RT::Dns, first, "dns".into(), Confidence::High).implementation("route53");
            let mut custom = false;
            for r in &records {
                self.fold(r.id);
                if r.id != first.id {
                    c.sources.push(r.source.clone());
                    c.aliases.push(r.key.clone());
                }
                if r.rtype == "AWS::Route53::HostedZone" && r.p("VpcS").is_none() && r.p("VPCs").is_none() {
                    custom = true;
                }
                if r.p("HostedZoneName").is_some() {
                    custom = true;
                }
                let mut ids = Vec::new();
                refs(&r.props, &mut ids);
                if let Some(lb) = ids
                    .iter()
                    .find(|id| by_id(res, id).is_some_and(|x| x.rtype == "AWS::ElasticLoadBalancingV2::LoadBalancer"))
                {
                    c.dns_target = Some(self.key(lb));
                }
            }
            c.set("customDomain", if custom { "optional" } else { "disabled" });
            self.out.candidates.push(c);
        }
    }

    fn leftovers(&mut self) {
        let mut supporting = 0;
        for r in self.res {
            if self.folded.contains(r.id) {
                continue;
            }
            let reason = match r.rtype {
                t if t.starts_with("AWS::Serverless::Function") || t.starts_with("AWS::Lambda::") => {
                    "functions are not supported yet"
                }
                t if t.starts_with("AWS::Serverless::Api")
                    || t.starts_with("AWS::Serverless::HttpApi")
                    || t.starts_with("AWS::ApiGateway") =>
                {
                    "API gateways are not supported yet; use an ingress"
                }
                t if t.contains("DynamoDB") || t == "AWS::Serverless::SimpleTable" => {
                    "NoSQL databases have no OrkStage logical type yet"
                }
                t if t.starts_with("AWS::SNS::") || t.starts_with("AWS::Events::") => {
                    "pub/sub and event buses are not supported yet (queues are)"
                }
                t if t.starts_with("AWS::CloudFront::") => "CDNs are not supported yet",
                "AWS::EC2::Instance" => "virtual machines are not supported; containerize the workload",
                t if t.starts_with("AWS::EKS::") => {
                    "Kubernetes clusters are infrastructure, not template resources; scan the workload manifests instead"
                }
                t if is_supporting(t) => {
                    supporting += 1;
                    continue;
                }
                _ => "no OrkStage mapping for this resource type",
            };
            self.out.unmapped(r.source.clone(), r.rtype, reason);
        }
        if supporting > 0 {
            self.out.warn(format!(
                "{}: {supporting} supporting CloudFormation resource(s) (IAM, security groups, logs, ...) are created by OrkStage implementations and were not mapped individually",
                self.file
            ));
        }
    }
}

fn is_supporting(t: &str) -> bool {
    const P: &[&str] = &[
        "AWS::IAM::",
        "AWS::EC2::SecurityGroup",
        "AWS::EC2::Route",
        "AWS::EC2::InternetGateway",
        "AWS::EC2::VPCGatewayAttachment",
        "AWS::EC2::SubnetRouteTableAssociation",
        "AWS::EC2::EIP",
        "AWS::EC2::VPCEndpoint",
        "AWS::EC2::NetworkAcl",
        "AWS::Logs::",
        "AWS::KMS::",
        "AWS::SecretsManager::",
        "AWS::SSM::",
        "AWS::RDS::DBSubnetGroup",
        "AWS::RDS::DBParameterGroup",
        "AWS::RDS::DBClusterParameterGroup",
        "AWS::ElastiCache::SubnetGroup",
        "AWS::ElastiCache::ParameterGroup",
        "AWS::ECS::Cluster",
        "AWS::ECS::CapacityProvider",
        "AWS::ECS::ClusterCapacityProviderAssociations",
        "AWS::CDK::Metadata",
        "AWS::S3::BucketPolicy",
        "AWS::SQS::QueuePolicy",
        "AWS::ServiceDiscovery::",
        "AWS::CloudWatch::",
        "AWS::AutoScaling::",
        "AWS::EC2::LaunchTemplate",
        "AWS::ECR::RegistryPolicy",
        "AWS::ECR::ReplicationConfiguration",
        "Custom::",
        "AWS::CloudFormation::",
    ];
    P.iter().any(|p| t.starts_with(p))
}

fn path_prefix(pattern: &str) -> String {
    let p = pattern.trim_end_matches('*').trim_end_matches('/');
    if p.is_empty() || !p.starts_with('/') { "/".into() } else { p.to_string() }
}
