//! What a container image is: a backing service, a dev tool, or an application.

use crate::model::ResourceType as RT;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImageKind {
    Backing {
        kind: RT,
        protocol: &'static str,
        port: u16,
    },
    /// AWS emulators (LocalStack, MiniStack): the services in use come from configuration.
    AwsEmulator,
    Unsupported(&'static str),
    DevTool,
    App,
}

/// Classifies an image reference like `bitnami/postgresql:16`, `docker.io/library/redis:8`.
pub(crate) fn classify(image: &str) -> ImageKind {
    let no_tag = strip_tag(image).to_ascii_lowercase();
    let path = no_tag
        .trim_start_matches("docker.io/")
        .trim_start_matches("library/")
        .trim_start_matches("public.ecr.aws/")
        .trim_start_matches("quay.io/")
        .trim_start_matches("ghcr.io/")
        .trim_start_matches("mcr.microsoft.com/");
    let last = path.rsplit('/').next().unwrap_or(path);
    use ImageKind::*;
    match last {
        "postgres" | "postgresql" | "postgis" | "timescaledb" | "timescaledb-ha" | "pgvector" | "postgresql-repmgr" => {
            Backing { kind: RT::Postgres, protocol: "postgres", port: 5432 }
        }
        "redis" | "valkey" | "redis-stack" | "redis-stack-server" | "keydb" | "dragonfly" | "redis-cluster" => {
            Backing { kind: RT::Redis, protocol: "redis", port: 6379 }
        }
        "rabbitmq" => Backing { kind: RT::Queue, protocol: "amqp", port: 5672 },
        "elasticmq" | "elasticmq-native" => Backing { kind: RT::Queue, protocol: "https", port: 9324 },
        "kafka" | "cp-kafka" | "redpanda" | "nats" => Backing { kind: RT::Queue, protocol: "tcp", port: 9092 },
        "minio" | "azurite" | "fake-gcs-server" | "seaweedfs" => {
            Backing { kind: RT::ObjectStorage, protocol: "https", port: 9000 }
        }
        "localstack" | "localstack-pro" | "ministack" => AwsEmulator,
        "mysql" | "mariadb" | "percona" => Unsupported("only PostgreSQL databases are supported"),
        "mongo" | "mongodb" | "cassandra" | "couchdb" | "dynamodb-local" => {
            Unsupported("NoSQL databases have no OrkStage logical type yet")
        }
        "memcached" => Unsupported("memcached is not supported; OrkStage caches are Redis/Valkey compatible"),
        "elasticsearch" | "opensearch" => Unsupported("search clusters are not supported yet"),
        "mailpit"
        | "mailhog"
        | "maildev"
        | "adminer"
        | "pgadmin4"
        | "redis-commander"
        | "redisinsight"
        | "jaeger"
        | "all-in-one"
        | "opentelemetry-collector"
        | "opentelemetry-collector-contrib"
        | "otel-collector"
        | "grafana"
        | "prometheus"
        | "loki"
        | "tempo"
        | "promtail"
        | "kafka-ui"
        | "traefik"
        | "wiremock"
        | "mockserver"
        | "smtp4dev" => DevTool,
        _ => App,
    }
}

pub(crate) fn strip_tag(image: &str) -> &str {
    let no_digest = image.split('@').next().unwrap_or(image);
    match no_digest.rfind(':') {
        Some(i) if !no_digest[i..].contains('/') => &no_digest[..i],
        _ => no_digest,
    }
}

pub(crate) fn tag(image: &str) -> Option<&str> {
    let no_digest = image.split('@').next().unwrap_or(image);
    let i = no_digest.rfind(':')?;
    (!no_digest[i..].contains('/')).then(|| &no_digest[i + 1..])
}

/// Postgres major version from an image tag (`postgres:18-alpine` → `18`).
pub(crate) fn pg_version(image: &str) -> Option<String> {
    let t = tag(image)?;
    let major: String = t.chars().take_while(char::is_ascii_digit).collect();
    (!major.is_empty() && major.len() <= 2).then_some(major)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_images() {
        assert!(matches!(classify("postgres:18-alpine"), ImageKind::Backing { kind: RT::Postgres, .. }));
        assert!(matches!(classify("bitnami/redis:7"), ImageKind::Backing { kind: RT::Redis, .. }));
        assert!(matches!(classify("valkey/valkey:8"), ImageKind::Backing { kind: RT::Redis, .. }));
        assert!(matches!(classify("quay.io/minio/minio"), ImageKind::Backing { kind: RT::ObjectStorage, .. }));
        assert_eq!(classify("localhost:5000/team/api:1.0"), ImageKind::App);
        assert_eq!(classify("axllent/mailpit:latest"), ImageKind::DevTool);
        assert_eq!(strip_tag("localhost:5000/api:1"), "localhost:5000/api");
        assert_eq!(pg_version("postgres:18-alpine").as_deref(), Some("18"));
    }
}
