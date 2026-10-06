//! Scans a synthetic repository of ~2,000 files (Terraform, Compose, Kubernetes, packages and
//! noise) to keep the engine fast.

use criterion::{Criterion, criterion_group, criterion_main};
use orkstage_scan::{InputFile, ScanOptions, scan_files};

fn synthetic_repo(n_services: usize) -> Vec<InputFile> {
    let mut files = Vec::new();
    for i in 0..n_services {
        let dir = format!("services/svc{i}");
        files.push(InputFile::new(
            format!("{dir}/package.json"),
            format!(r#"{{"name":"svc{i}","dependencies":{{"pg":"^8","ioredis":"^5","express":"^5"}}}}"#),
        ));
        files.push(InputFile::new(
            format!("{dir}/Dockerfile"),
            "FROM node:22\nEXPOSE 3000\nCMD [\"node\",\"index.js\"]\n",
        ));
        files.push(InputFile::new(
            format!("{dir}/k8s/deployment.yaml"),
            format!(
                "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: svc{i}\nspec:\n  replicas: 2\n  template:\n    metadata:\n      labels: {{app: svc{i}}}\n    spec:\n      containers:\n        - name: app\n          image: registry.local/svc{i}:1.0\n          ports: [{{containerPort: 3000}}]\n          env:\n            - {{name: DATABASE_URL, value: 'postgres://db:5432/app'}}\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: svc{i}\nspec:\n  selector: {{app: svc{i}}}\n  ports: [{{port: 80}}]\n"
            ),
        ));
        files.push(InputFile::new(
            format!("infra/svc{i}.tf"),
            format!(
                "resource \"aws_sqs_queue\" \"q{i}\" {{\n  name = \"svc{i}-jobs\"\n}}\nresource \"aws_s3_bucket\" \"b{i}\" {{\n  bucket = \"svc{i}-files\"\n}}\n"
            ),
        ));
        files.push(InputFile::new(format!("{dir}/README.md"), "# readme\n".repeat(20)));
    }
    files.push(InputFile::new(
        "docker-compose.yml",
        "services:\n  db:\n    image: postgres:17\n  cache:\n    image: redis:8\n",
    ));
    files
}

fn bench(c: &mut Criterion) {
    let files = synthetic_repo(400); // 2,001 files
    let opts = ScanOptions::default();
    c.bench_function("scan 2k files", |b| b.iter(|| scan_files(&files, &opts)));
}

criterion_group!(benches, bench);
criterion_main!(benches);
