// SPDX-License-Identifier: AGPL-3.0-only
import { DEFAULT_ENTITLEMENTS, PLAN_CODES } from '@orkstage/domain';
import { loadBuiltinTemplates, loadMarketplaceTemplates } from '@orkstage/templates/builtin';
import { createPrismaClient } from './index.js';

/**
 * Idempotent seed (spec §45).
 *
 * Always: plans, built in and marketplace templates, one organization, and the platform owner
 * named by PLATFORM_OWNER_EMAIL (their first SSO sign in with that verified email links to it).
 * Demo data (simulated cloud targets, sample images with placeholder digests, demo tenants and users
 * that can only sign in through the dev login) is added outside production, or with
 * SEED_DEMO_DATA=true; SEED_DEMO_DATA=false turns it off anywhere.
 */
const prisma = createPrismaClient();

const production = process.env.NODE_ENV === 'production';
const withDemoData = process.env.SEED_DEMO_DATA ? process.env.SEED_DEMO_DATA === 'true' : !production;

/** The first platform owner of a real installation (there is no dev login in production). */
async function seedPlatformOwner() {
  const email = process.env.PLATFORM_OWNER_EMAIL?.trim().toLowerCase();
  if (!email) {
    if (production) console.warn('No PLATFORM_OWNER_EMAIL: nobody can administer the platform yet. Set it and run the seed again.');
    return;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`PLATFORM_OWNER_EMAIL is not an email address: ${email}`);
  await prisma.user.upsert({
    where: { email },
    update: { platformRole: 'PlatformOwner' },
    create: { email, name: email, platformRole: 'PlatformOwner' },
  });
  console.log(`Platform owner: ${email} (sign in with SSO using this verified email).`);
}

async function main() {
  const plans = new Map<string, string>();
  for (const code of PLAN_CODES) {
    const plan = await prisma.plan.upsert({
      where: { code },
      update: {},
      create: { code, name: code.charAt(0) + code.slice(1).toLowerCase(), entitlements: DEFAULT_ENTITLEMENTS[code] as object },
    });
    plans.set(code, plan.id);
  }

  for (const { source, template } of loadBuiltinTemplates()) {
    const t = await prisma.template.upsert({
      where: { name: template.metadata.name },
      update: { displayName: template.metadata.displayName, description: template.metadata.description },
      create: {
        name: template.metadata.name,
        displayName: template.metadata.displayName,
        description: template.metadata.description,
        visibility: 'SYSTEM',
      },
    });
    await prisma.templateVersion.upsert({
      where: { templateId_version: { templateId: t.id, version: template.metadata.version } },
      update: {},
      create: {
        templateId: t.id,
        version: template.metadata.version,
        status: 'PUBLISHED',
        source,
        document: template as object,
        validation: { valid: true, issues: [] },
        publishedAt: new Date(),
      },
    });
  }

  // Curated marketplace listings: system templates published as VERIFIED and DEVOPS by OrkStage.
  for (const m of loadMarketplaceTemplates()) {
    const t = await prisma.template.upsert({
      where: { name: m.template.metadata.name },
      update: { displayName: m.template.metadata.displayName, description: m.template.metadata.description },
      create: { name: m.template.metadata.name, displayName: m.template.metadata.displayName, description: m.template.metadata.description, visibility: 'SYSTEM' },
    });
    await prisma.templateVersion.upsert({
      where: { templateId_version: { templateId: t.id, version: m.template.metadata.version } },
      update: {},
      create: {
        templateId: t.id,
        version: m.template.metadata.version,
        status: 'PUBLISHED',
        source: m.source,
        document: m.template as object,
        validation: { valid: true, issues: [] },
        publishedAt: new Date(),
      },
    });
    const listing = { title: m.title, summary: m.summary, description: m.template.metadata.description, categories: m.categories, tags: m.tags, badges: m.badges };
    await prisma.marketplaceListing.upsert({
      where: { slug: m.slug },
      update: listing,
      create: { ...listing, slug: m.slug, templateId: t.id, status: 'PUBLISHED', publisherName: 'OrkStage', publishedAt: new Date(), reviewedAt: new Date() },
    });
  }

  await seedPlatformOwner();
  if (!withDemoData) {
    if (!(await prisma.organization.findFirst())) {
      await prisma.organization.create({ data: { name: process.env.ORGANIZATION_NAME?.trim() || 'Organization', slug: 'default' } });
    }
    console.log('Seed complete: plans, templates and the organization (no demo data; SEED_DEMO_DATA=true adds it).');
    return;
  }

  const apps = [
    { name: 'sample-api', displayName: 'Sample API', repository: 'platform/sample-api', port: 8080, healthPath: '/health', readinessPath: '/ready' },
    { name: 'sample-worker', displayName: 'Sample worker', repository: 'platform/sample-worker', port: 8081, healthPath: '/health', readinessPath: null },
  ];
  for (const app of apps) {
    const a = await prisma.application.upsert({ where: { name: app.name }, update: {}, create: app });
    await prisma.applicationVersion.upsert({
      where: { applicationId_version: { applicationId: a.id, version: '1.0.0' } },
      update: {},
      create: {
        applicationId: a.id,
        version: '1.0.0',
        imageUri: `registry.example.local/${app.repository}`,
        // Placeholder digest for the demo catalog; real entries come from CI with the pushed digest.
        digest: `sha256:${'0'.repeat(56)}${app.name === 'sample-api' ? '00000a01' : '00000b01'}`,
        architectures: ['amd64', 'arm64'],
        scanStatus: 'PASSED',
      },
    });
    // A real, runnable image (MIT, serves 200 on any path incl. /health, port 8080) so local AWS
    // deployments on MiniStack start actual containers. Pinned by digest, never by tag.
    await prisma.applicationVersion.upsert({
      where: { applicationId_version: { applicationId: a.id, version: '1.1.0' } },
      update: {},
      create: {
        applicationId: a.id,
        version: '1.1.0',
        imageUri: 'docker.io/mendhak/http-https-echo',
        digest: 'sha256:f55000d9196bd3c853d384af7315f509d21ffb85de315c26e9874033b9f83e15',
        architectures: ['amd64', 'arm64'],
        scanStatus: 'UNKNOWN',
      },
    });
  }

  const org = await prisma.organization.upsert({
    where: { slug: 'demo' },
    update: {},
    create: { name: 'Demo Organization', slug: 'demo' },
  });

  const acme = await prisma.tenant.upsert({
    where: { slug: 'acme' },
    update: {},
    create: { organizationId: org.id, name: 'Acme Corp', slug: 'acme', planId: plans.get('GROWTH')! },
  });
  await prisma.tenant.upsert({
    where: { slug: 'globex' },
    update: {},
    create: { organizationId: org.id, name: 'Globex', slug: 'globex', planId: plans.get('STARTER')! },
  });

  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.local' },
    update: { platformRole: 'PlatformOwner' },
    create: { email: 'admin@example.local', name: 'Platform Admin', platformRole: 'PlatformOwner' },
  });
  await prisma.user.upsert({
    where: { email: 'operator@example.local' },
    update: { platformRole: 'PlatformOperator' },
    create: { email: 'operator@example.local', name: 'Platform Operator', platformRole: 'PlatformOperator' },
  });
  const customer = await prisma.user.upsert({
    where: { email: 'customer@example.local' },
    update: {},
    create: { email: 'customer@example.local', name: 'Acme Owner' },
  });
  await prisma.membership.upsert({
    where: { tenantId_userId: { tenantId: acme.id, userId: customer.id } },
    update: { role: 'CustomerOwner' },
    create: { tenantId: acme.id, userId: customer.id, role: 'CustomerOwner' },
  });

  const targets = [
    { name: 'Simulated AWS — us-east-1', simulate: 'aws', regions: ['us-east-1', 'us-west-2', 'sa-east-1'] },
    { name: 'Simulated Azure — East US', simulate: 'azure', regions: ['eastus', 'westeurope', 'brazilsouth'] },
    { name: 'Simulated OCI — Ashburn', simulate: 'oci', regions: ['us-ashburn-1', 'sa-saopaulo-1'] },
  ];
  const targetIds: Record<string, string> = {};
  for (const t of targets) {
    const existing = await prisma.cloudTarget.findFirst({ where: { name: t.name, provider: 'mock' } });
    const row =
      existing ??
      (await prisma.cloudTarget.create({
        data: {
          provider: 'mock',
          name: t.name,
          environment: 'any',
          // The local default: instances whose slots are left unbound use it.
          isDefault: t.name === 'Simulated AWS — us-east-1',
          config: { simulate: t.simulate, seed: t.simulate, latencyMs: { min: 600, max: 2200 } },
          allowedRegions: t.regions,
          defaultRegion: t.regions[0]!,
        },
      }));
    targetIds[t.simulate] = row.id;
  }

  if ((await prisma.alertRule.count({ where: { tenantId: null } })) === 0) {
    await prisma.alertRule.createMany({
      data: [
        {
          name: 'Critical resource unhealthy',
          condition: { signal: 'health', critical: true, consecutiveFailures: 3 },
          severity: 'high',
          actions: ['create_incident', 'notify_owners'],
          cooldownSeconds: 900,
        },
        {
          name: 'Non-critical resource unhealthy',
          condition: { signal: 'health', critical: false, consecutiveFailures: 5 },
          severity: 'medium',
          actions: ['create_incident', 'notify_owners'],
          cooldownSeconds: 1800,
        },
      ],
    });
  }

  const multicloud = await prisma.templateVersion.findFirstOrThrow({
    where: { template: { name: 'multicloud-reference' }, version: '1.0.0' },
  });
  await prisma.instance.upsert({
    where: { tenantId_slug: { tenantId: acme.id, slug: 'production' } },
    update: {},
    create: {
      tenantId: acme.id,
      name: 'Acme Production',
      slug: 'production',
      environment: 'production',
      templateVersionId: multicloud.id,
      bindings: {
        primary: { targetId: targetIds.aws, region: 'us-east-1' },
        data: { targetId: targetIds.azure, region: 'eastus' },
        storage: { targetId: targetIds.oci, region: 'us-ashburn-1' },
      },
      createdById: admin.id,
    },
  });

  // Local AWS through MiniStack (`pnpm local:aws`). Real OpenTofu provisioning; real containers
  // for ECS, RDS and ElastiCache. Validation fails clearly when the emulator is not running.
  const localAwsName = 'Local AWS (MiniStack)';
  const localAws =
    (await prisma.cloudTarget.findFirst({ where: { name: localAwsName, provider: 'aws' } })) ??
    (await prisma.cloudTarget.create({
      data: {
        provider: 'aws',
        name: localAwsName,
        environment: 'any',
        config: {
          accountId: '000000000000',
          emulator: 'ministack',
          endpointUrl: 'http://localhost:4566',
          runnerEndpointUrl: 'http://ministack:4566',
          dnsZone: 'orkstage.local',
          createDnsZone: true,
        },
        allowedRegions: ['us-east-1'],
        defaultRegion: 'us-east-1',
        maxConcurrentDeployments: 2,
      },
    }));

  const starter = await prisma.templateVersion.findFirstOrThrow({ where: { template: { name: 'starter-standard' }, version: '1.0.0' } });
  await prisma.instance.upsert({
    where: { tenantId_slug: { tenantId: acme.id, slug: 'staging' } },
    update: {},
    create: {
      tenantId: acme.id,
      name: 'Acme Staging (local AWS)',
      slug: 'staging',
      environment: 'staging',
      templateVersionId: starter.id,
      bindings: { primary: { targetId: localAws.id, region: 'us-east-1' } },
      createdById: admin.id,
    },
  });

  console.log('Seed complete: plans, templates, catalog, simulated + local AWS targets, demo tenants and users.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
