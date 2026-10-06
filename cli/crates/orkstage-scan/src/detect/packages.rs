//! Package manifests: client libraries imply *required* backing services (provider-neutral,
//! low/medium confidence). ORMs alone do not count; drivers do.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::evidence::{Findings, PackageHint, src};
use crate::model::{Confidence, ResourceType as RT, SourceKind};
use crate::util::{self, get};

type Hint = (RT, Confidence, &'static str, Option<u16>);

const PG: Hint = (RT::Postgres, Confidence::Medium, "postgres", Some(5432));
const REDIS: Hint = (RT::Redis, Confidence::Medium, "redis", Some(6379));
const REDIS_LOW: Hint = (RT::Redis, Confidence::Low, "redis", Some(6379));
const AMQP: Hint = (RT::Queue, Confidence::Medium, "amqp", Some(5672));
const SQS: Hint = (RT::Queue, Confidence::Medium, "https", None);
const KAFKA: Hint = (RT::Queue, Confidence::Low, "tcp", Some(9092));
const S3: Hint = (RT::ObjectStorage, Confidence::Medium, "https", None);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Eco {
    Npm,
    Pypi,
    Go,
    Maven,
    Gem,
    Composer,
    Cargo,
}

/// `extra` carries extras/features (`celery[redis]`, Cargo `features = ["postgres"]`).
fn hints(eco: Eco, name: &str, extra: &str, prisma_pg: bool) -> Vec<Hint> {
    let n = name.to_ascii_lowercase();
    let n = n.as_str();
    let has = |f: &str| extra.split([',', ' ']).any(|e| e.trim().contains(f));
    let one = |h: Hint| vec![h];
    match eco {
        Eco::Npm => match n {
            "pg"
            | "postgres"
            | "pg-promise"
            | "slonik"
            | "@mikro-orm/postgresql"
            | "@neondatabase/serverless"
            | "@vercel/postgres" => one(PG),
            "@prisma/client" | "prisma" if prisma_pg => one(PG),
            "redis" | "ioredis" | "@redis/client" | "connect-redis" | "@keyv/redis" | "cache-manager-redis-yet" => {
                one(REDIS)
            }
            "bullmq" | "bull" | "bee-queue" => one(REDIS_LOW),
            "amqplib" | "amqp-connection-manager" | "rascal" => one(AMQP),
            "@aws-sdk/client-sqs" | "sqs-consumer" | "sqs-producer" => one(SQS),
            "kafkajs" | "@confluentinc/kafka-javascript" | "node-rdkafka" => one(KAFKA),
            "@aws-sdk/client-s3"
            | "@aws-sdk/lib-storage"
            | "minio"
            | "@azure/storage-blob"
            | "@google-cloud/storage" => one(S3),
            _ => vec![],
        },
        Eco::Pypi => {
            let mut out = match n {
                "psycopg" | "psycopg2" | "psycopg2-binary" | "psycopg-binary" | "asyncpg" | "pg8000" => one(PG),
                "redis" | "hiredis" | "django-redis" | "aioredis" | "valkey" => one(REDIS),
                "rq" | "dramatiq" => one(REDIS_LOW),
                "pika" | "aio-pika" | "aiormq" => one(AMQP),
                "kafka-python" | "confluent-kafka" | "aiokafka" => one(KAFKA),
                "minio"
                | "google-cloud-storage"
                | "azure-storage-blob"
                | "mypy-boto3-s3"
                | "types-boto3-s3"
                | "types-aiobotocore-s3" => one(S3),
                "mypy-boto3-sqs" | "types-boto3-sqs" => one(SQS),
                _ => vec![],
            };
            if matches!(n, "celery" | "kombu" | "dramatiq" | "boto3-stubs" | "types-boto3" | "sqlalchemy") {
                if has("redis") {
                    out.push(REDIS);
                }
                if has("sqs") {
                    out.push(SQS);
                }
                if has("s3") {
                    out.push(S3);
                }
                if has("rabbitmq") || has("amqp") || has("librabbitmq") {
                    out.push(AMQP);
                }
                if has("postgresql") || has("asyncpg") || has("psycopg") {
                    out.push(PG);
                }
            }
            out
        }
        Eco::Go => {
            let m = |prefix: &str| n.starts_with(prefix);
            if m("github.com/jackc/pgx")
                || m("github.com/lib/pq")
                || m("gorm.io/driver/postgres")
                || m("github.com/go-pg/pg")
            {
                one(PG)
            } else if m("github.com/redis/go-redis")
                || m("github.com/go-redis/redis")
                || m("github.com/gomodule/redigo")
                || m("github.com/redis/rueidis")
                || m("github.com/valkey-io/valkey-go")
            {
                one(REDIS)
            } else if m("github.com/rabbitmq/amqp091-go") || m("github.com/streadway/amqp") {
                one(AMQP)
            } else if m("github.com/aws/aws-sdk-go-v2/service/sqs") {
                one(SQS)
            } else if m("github.com/aws/aws-sdk-go-v2/service/s3")
                || m("github.com/minio/minio-go")
                || m("cloud.google.com/go/storage")
                || m("github.com/azure/azure-sdk-for-go/sdk/storage/azblob")
            {
                one(S3)
            } else if m("github.com/segmentio/kafka-go")
                || m("github.com/ibm/sarama")
                || m("github.com/shopify/sarama")
                || m("github.com/confluentinc/confluent-kafka-go")
                || m("github.com/twmb/franz-go")
            {
                one(KAFKA)
            } else {
                vec![]
            }
        }
        Eco::Maven => {
            // name = "group:artifact"
            let (group, artifact) = n.split_once(':').unwrap_or(("", n));
            match (group, artifact) {
                ("org.postgresql", "postgresql" | "r2dbc-postgresql") | (_, "r2dbc-postgresql") => one(PG),
                (
                    _,
                    "spring-boot-starter-data-redis"
                    | "spring-boot-starter-data-redis-reactive"
                    | "jedis"
                    | "lettuce-core"
                    | "redisson",
                ) => one(REDIS),
                (_, "spring-boot-starter-amqp" | "amqp-client" | "spring-rabbit") => one(AMQP),
                ("software.amazon.awssdk", "sqs") | (_, "spring-cloud-aws-starter-sqs" | "aws-java-sdk-sqs") => {
                    one(SQS)
                }
                ("software.amazon.awssdk", "s3")
                | (
                    _,
                    "spring-cloud-aws-starter-s3"
                    | "aws-java-sdk-s3"
                    | "minio"
                    | "azure-storage-blob"
                    | "google-cloud-storage",
                ) => one(S3),
                (_, "kafka-clients" | "spring-kafka") => one(KAFKA),
                _ => vec![],
            }
        }
        Eco::Gem => match n {
            "pg" | "sequel_pg" => one(PG),
            "redis" | "redis-client" | "hiredis" => one(REDIS),
            "sidekiq" | "resque" => one(REDIS_LOW),
            "bunny" | "sneakers" => one(AMQP),
            "aws-sdk-sqs" | "shoryuken" => one(SQS),
            "aws-sdk-s3" | "google-cloud-storage" | "azure-storage-blob" => one(S3),
            "ruby-kafka" | "rdkafka" | "karafka" => one(KAFKA),
            _ => vec![],
        },
        Eco::Composer => match n {
            "ext-pgsql" | "ext-pdo_pgsql" => one(PG),
            "predis/predis" | "ext-redis" | "snc/redis-bundle" => one(REDIS),
            "php-amqplib/php-amqplib" | "ext-amqp" => one(AMQP),
            "enqueue/sqs" => one(SQS),
            "league/flysystem-aws-s3-v3" | "async-aws/s3" => one(S3),
            _ => vec![],
        },
        Eco::Cargo => match n {
            "tokio-postgres" | "postgres" | "deadpool-postgres" | "bb8-postgres" => one(PG),
            "sqlx" | "diesel" | "sea-orm" | "sqlx-core" if has("postgres") => one(PG),
            "redis" | "fred" | "deadpool-redis" | "bb8-redis" => one(REDIS),
            "lapin" | "amiquip" => one(AMQP),
            "aws-sdk-sqs" => one(SQS),
            "aws-sdk-s3" | "rust-s3" => one(S3),
            "object_store" if has("aws") || has("gcp") || has("azure") => one(S3),
            "rdkafka" => one(KAFKA),
            _ => vec![],
        },
    }
}

static PRISMA_PG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"provider\s*=\s*"(postgresql|postgres|cockroachdb)""#).unwrap());

pub(crate) fn prisma_uses_postgres(files: &[&crate::InputFile]) -> bool {
    files.iter().any(|f| f.path.ends_with(".prisma") && PRISMA_PG.is_match(&f.content))
}

pub(crate) fn detect(file: &str, content: &str, prisma_pg: bool, out: &mut Findings) {
    let name = util::file_name(file).to_ascii_lowercase();
    let deps: Vec<(Eco, String, String)> = match name.as_str() {
        "package.json" => npm(content),
        "requirements.txt" | "requirements.in" | "requirements-prod.txt" => requirements(content),
        "pyproject.toml" => pyproject(content),
        "go.mod" => gomod(content),
        "pom.xml" => pom(content),
        "build.gradle" | "build.gradle.kts" => gradle(content),
        "gemfile" => gemfile(content),
        "composer.json" => composer(content),
        "cargo.toml" => cargo(content),
        _ => return,
    };
    out.count(SourceKind::Package, file);
    let dir = util::dir_of(file).to_string();
    for (eco, dep, extra) in deps {
        for (kind, confidence, protocol, port) in hints(eco, &dep, &extra, prisma_pg) {
            let needle = dep.rsplit(':').next().unwrap_or(&dep);
            out.packages.push(PackageHint {
                dir: dir.clone(),
                kind,
                library: dep.clone(),
                confidence,
                protocol,
                port,
                source: src(SourceKind::Package, file, util::line_of(content, needle), dep.clone()),
            });
        }
    }
}

fn npm(content: &str) -> Vec<(Eco, String, String)> {
    let Ok(v) = serde_json::from_str::<Value>(content) else { return vec![] };
    ["dependencies", "optionalDependencies", "peerDependencies"]
        .iter()
        .filter_map(|k| get(&v, k).and_then(Value::as_object))
        .flat_map(|m| m.keys().map(|k| (Eco::Npm, k.clone(), String::new())))
        .collect()
}

static PY_REQ: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?").unwrap());

fn py_dep(spec: &str) -> Option<(Eco, String, String)> {
    let c = PY_REQ.captures(spec)?;
    Some((
        Eco::Pypi,
        c[1].to_ascii_lowercase().replace('_', "-"),
        c.get(2).map(|m| m.as_str().to_ascii_lowercase()).unwrap_or_default(),
    ))
}

fn requirements(content: &str) -> Vec<(Eco, String, String)> {
    content
        .lines()
        .map(|l| l.split('#').next().unwrap_or(""))
        .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('-'))
        .filter_map(py_dep)
        .collect()
}

fn pyproject(content: &str) -> Vec<(Eco, String, String)> {
    let Ok(v) = content.parse::<toml::Table>() else { return vec![] };
    let mut out = Vec::new();
    if let Some(deps) = v.get("project").and_then(|p| p.get("dependencies")).and_then(|d| d.as_array()) {
        out.extend(deps.iter().filter_map(|d| d.as_str()).filter_map(py_dep));
    }
    if let Some(groups) = v.get("project").and_then(|p| p.get("optional-dependencies")).and_then(|d| d.as_table()) {
        for list in groups.values().filter_map(|l| l.as_array()) {
            out.extend(list.iter().filter_map(|d| d.as_str()).filter_map(py_dep));
        }
    }
    if let Some(deps) =
        v.get("tool").and_then(|t| t.get("poetry")).and_then(|p| p.get("dependencies")).and_then(|d| d.as_table())
    {
        for (name, spec) in deps {
            let extras = spec
                .get("extras")
                .and_then(|e| e.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(","))
                .unwrap_or_default();
            out.push((Eco::Pypi, name.to_ascii_lowercase().replace('_', "-"), extras));
        }
    }
    out
}

fn gomod(content: &str) -> Vec<(Eco, String, String)> {
    let mut out = Vec::new();
    let mut in_block = false;
    for line in content.lines() {
        let t = line.split("//").next().unwrap_or("").trim();
        if t.starts_with("require (") {
            in_block = true;
            continue;
        }
        if in_block && t == ")" {
            in_block = false;
            continue;
        }
        let spec = if in_block { Some(t) } else { t.strip_prefix("require ") };
        if let Some(module) = spec.and_then(|s| s.split_whitespace().next())
            && !module.is_empty()
        {
            out.push((Eco::Go, module.to_ascii_lowercase(), String::new()));
        }
    }
    out
}

static POM_DEP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)<groupId>\s*([^<\s]+)\s*</groupId>\s*<artifactId>\s*([^<\s]+)\s*</artifactId>").unwrap()
});

fn pom(content: &str) -> Vec<(Eco, String, String)> {
    POM_DEP.captures_iter(content).map(|c| (Eco::Maven, format!("{}:{}", &c[1], &c[2]), String::new())).collect()
}

static GRADLE_DEP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"["']([A-Za-z0-9_.\-]+):([A-Za-z0-9_.\-]+)(?::[^"']*)?["']"#).unwrap());

fn gradle(content: &str) -> Vec<(Eco, String, String)> {
    GRADLE_DEP.captures_iter(content).map(|c| (Eco::Maven, format!("{}:{}", &c[1], &c[2]), String::new())).collect()
}

static GEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?m)^\s*gem\s+["']([^"']+)["']"#).unwrap());

fn gemfile(content: &str) -> Vec<(Eco, String, String)> {
    GEM.captures_iter(content).map(|c| (Eco::Gem, c[1].to_string(), String::new())).collect()
}

fn composer(content: &str) -> Vec<(Eco, String, String)> {
    let Ok(v) = serde_json::from_str::<Value>(content) else { return vec![] };
    get(&v, "require")
        .and_then(Value::as_object)
        .map(|m| m.keys().map(|k| (Eco::Composer, k.clone(), String::new())).collect())
        .unwrap_or_default()
}

fn cargo(content: &str) -> Vec<(Eco, String, String)> {
    let Ok(v) = content.parse::<toml::Table>() else { return vec![] };
    let mut out = Vec::new();
    let mut tables = vec![v.get("dependencies")];
    if let Some(ws) = v.get("workspace") {
        tables.push(ws.get("dependencies"));
    }
    for deps in tables.into_iter().flatten().filter_map(|d| d.as_table()) {
        for (name, spec) in deps {
            let features = spec
                .get("features")
                .and_then(|f| f.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(","))
                .unwrap_or_default();
            let pkg = spec.get("package").and_then(|p| p.as_str()).unwrap_or(name);
            out.push((Eco::Cargo, pkg.to_string(), features));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_manifests() {
        assert!(requirements("psycopg[binary]==3.2\ncelery[redis]>=5\n# x\n").len() == 2);
        assert_eq!(hints(Eco::Pypi, "celery", "redis", false)[0].0, RT::Redis);
        assert_eq!(gomod("module x\nrequire (\n github.com/jackc/pgx/v5 v5.7.0\n)\n")[0].1, "github.com/jackc/pgx/v5");
        assert_eq!(hints(Eco::Cargo, "sqlx", "runtime-tokio,postgres", false)[0].0, RT::Postgres);
        assert!(hints(Eco::Npm, "typeorm", "", false).is_empty());
        assert_eq!(
            pom("<dependency><groupId>org.postgresql</groupId>\n<artifactId>postgresql</artifactId></dependency>")[0].1,
            "org.postgresql:postgresql"
        );
    }
}
