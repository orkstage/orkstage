// SPDX-License-Identifier: AGPL-3.0-only
import {
  listingQuerySchema,
  reviewListingSchema,
  submitListingSchema,
  updateListingSchema,
  type ListingDetailDto,
  type ListingSummaryDto,
  type UseListingResultDto,
} from '@orkstage/contracts';
import type { MarketplaceListing, MarketplaceStar, PrismaClient, Template, TemplateVersion } from '@orkstage/database';
import { previewTemplate, type TemplatePreview } from '@orkstage/provisioning';
import { environmentTemplate } from '@orkstage/templates';
import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, Scope } from '../common/auth.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { FeatureFlagsService } from '../common/feature-flags.service.js';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/validation.js';
import { Adapters, PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

type ListingRow = MarketplaceListing & {
  template: Template & { versions: TemplateVersion[] };
  stars: Pick<MarketplaceStar, 'userId'>[];
};

const include = {
  template: { include: { versions: { where: { status: 'PUBLISHED' as const }, orderBy: { createdAt: 'desc' as const }, take: 1 } } },
  stars: { select: { userId: true } },
};

/**
 * Template marketplace. Everyone signed in browses published listings; template publishers
 * (`publish Template`) submit their own templates; reviewers (`approve Marketplace`, platform
 * admins and owners) publish them, with the VERIFIED and DEVOPS badges when earned. Using a
 * listing hands the template version to the instance wizard; nothing is copied.
 */
@ApiTags('marketplace')
@Controller('marketplace/listings')
export class MarketplaceController {
  /** Previews by template version id. Versions are immutable once published, so this never goes stale. */
  private readonly previews = new Map<string, TemplatePreview | null>();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly adapters: Adapters,
    private readonly audit: AuditService,
    private readonly flags: FeatureFlagsService,
  ) {}

  @Scope('templates:read')
  @Get()
  async list(@CurrentPrincipal() p: RequestPrincipal, @ZodQuery(listingQuerySchema) q: z.infer<typeof listingQuerySchema>): Promise<ListingSummaryDto[]> {
    await this.ensureEnabled(p);
    const reviewer = this.canReview(p);
    const visibility = q.mine
      ? { submittedById: p.userId }
      : reviewer && q.status
        ? { status: q.status }
        : { status: 'PUBLISHED' as const };
    const rows = await this.prisma.marketplaceListing.findMany({
      where: {
        ...visibility,
        ...(q.category ? { categories: { has: q.category } } : {}),
        ...(q.badge ? { badges: { has: q.badge } } : {}),
        ...(q.q
          ? {
              OR: [
                { title: { contains: q.q, mode: 'insensitive' as const } },
                { summary: { contains: q.q, mode: 'insensitive' as const } },
                { tags: { has: q.q.toLowerCase() } },
              ],
            }
          : {}),
      },
      include,
      take: 200,
    });
    let items = rows.map((r) => this.summary(r, p));
    if (q.provider) items = items.filter((i) => i.providers.length === 0 || i.providers.includes(q.provider!));
    const by = {
      popular: (a: ListingSummaryDto, b: ListingSummaryDto) => b.stars + b.useCount - (a.stars + a.useCount) || a.title.localeCompare(b.title),
      new: (a: ListingSummaryDto, b: ListingSummaryDto) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''),
      name: (a: ListingSummaryDto, b: ListingSummaryDto) => a.title.localeCompare(b.title),
    }[q.sort];
    return items.sort(by);
  }

  @Scope('templates:read')
  @Get(':slug')
  async get(@CurrentPrincipal() p: RequestPrincipal, @Param('slug') slug: string): Promise<ListingDetailDto> {
    await this.ensureEnabled(p);
    const row = await this.prisma.marketplaceListing.findUnique({ where: { slug }, include });
    if (!row || !this.visible(row, p)) throw notFound('Listing');
    const version = row.template.versions[0];
    const preview = this.preview(version);
    const doc = version ? environmentTemplate.safeParse(version.document) : null;
    const template = doc?.success ? doc.data : null;
    const owner = row.submittedById === p.userId;
    return {
      ...this.summary(row, p),
      description: row.description,
      reviewNotes: this.canReview(p) || owner ? row.reviewNotes : null,
      canReview: this.canReview(p),
      canEdit: owner || this.canReview(p),
      template: {
        versionId: version?.id ?? null,
        source: version?.source ?? null,
        placements: (template?.spec.placements ?? []).map((s) => ({ name: s.name, description: s.description ?? null, providers: s.providers.filter((x) => x !== 'mock') })),
        resources: (template?.spec.resources ?? []).filter((r) => r.enabled).map((r) => ({ id: r.id, type: r.type, placement: r.placement })),
        triggers: (template?.spec.triggers ?? []).map((t) => ({ name: t.name, resource: t.resource, action: t.action })),
      },
      cost: preview ? { currency: preview.cost.currency, total: preview.cost.total, confidence: preview.cost.confidence, lines: preview.cost.lines.map((l) => ({ resourceId: l.resourceId, category: l.category, monthly: l.monthly })) } : null,
    };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  @ApiZodBody(submitListingSchema)
  async submit(@CurrentPrincipal() p: RequestPrincipal, @ZodBody(submitListingSchema) body: z.infer<typeof submitListingSchema>, @CorrelationId() correlationId: string): Promise<ListingSummaryDto> {
    await this.ensureEnabled(p);
    authorize(p, 'publish', 'Template');
    const template = await this.prisma.template.findUnique({ where: { id: body.templateId }, include: { versions: { where: { status: 'PUBLISHED' }, take: 1 }, listing: true } });
    if (!template) throw notFound('Template');
    if (template.versions.length === 0) throw unprocessable('TEMPLATE_NOT_PUBLISHED', 'Publish a version of the template before submitting it.');
    if (template.listing) throw conflict('ALREADY_LISTED', 'This template already has a listing; edit that one.');
    if (await this.prisma.marketplaceListing.findUnique({ where: { slug: body.slug } })) throw conflict('SLUG_TAKEN', `The slug "${body.slug}" is taken.`);
    const row = await this.prisma.marketplaceListing.create({
      data: { ...body, publisherName: p.name || p.email, submittedById: p.userId, status: 'PENDING_REVIEW' },
      include,
    });
    await this.audit.record({ principal: p, resourceType: 'MarketplaceListing', resourceId: row.id, action: 'SUBMIT', correlationId, changes: { slug: row.slug, templateId: row.templateId } });
    return this.summary(row, p);
  }

  /** Edits by the submitter go back to review and lose their badges; reviewers keep the status. */
  @Patch(':id')
  @ApiZodBody(updateListingSchema)
  async update(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(updateListingSchema) body: z.infer<typeof updateListingSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<ListingSummaryDto> {
    await this.ensureEnabled(p);
    const row = await this.prisma.marketplaceListing.findUnique({ where: { id } });
    if (!row) throw notFound('Listing');
    const reviewer = this.canReview(p);
    if (!reviewer && row.submittedById !== p.userId) throw notFound('Listing');
    if (body.slug && body.slug !== row.slug && (await this.prisma.marketplaceListing.findUnique({ where: { slug: body.slug } }))) throw conflict('SLUG_TAKEN', `The slug "${body.slug}" is taken.`);
    const updated = await this.prisma.marketplaceListing.update({
      where: { id },
      data: { ...body, ...(reviewer ? {} : { status: 'PENDING_REVIEW' as const, badges: [] }) },
      include,
    });
    await this.audit.record({ principal: p, resourceType: 'MarketplaceListing', resourceId: id, action: 'UPDATE', correlationId, changes: body });
    return this.summary(updated, p);
  }

  @Post(':id/review')
  @HttpCode(200)
  @ApiZodBody(reviewListingSchema)
  async review(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(reviewListingSchema) body: z.infer<typeof reviewListingSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<ListingSummaryDto> {
    await this.ensureEnabled(p);
    authorize(p, 'approve', 'Marketplace');
    const row = await this.prisma.marketplaceListing.findUnique({ where: { id } });
    if (!row) throw notFound('Listing');
    const status = { approve: 'PUBLISHED', reject: 'REJECTED', unlist: 'UNLISTED' }[body.decision] as 'PUBLISHED' | 'REJECTED' | 'UNLISTED';
    const updated = await this.prisma.marketplaceListing.update({
      where: { id },
      data: {
        status,
        badges: body.decision === 'approve' ? [...new Set(body.badges)] : [],
        reviewNotes: body.notes ?? null,
        reviewedById: p.userId,
        reviewedAt: new Date(),
        ...(status === 'PUBLISHED' && !row.publishedAt ? { publishedAt: new Date() } : {}),
      },
      include,
    });
    await this.audit.record({ principal: p, resourceType: 'MarketplaceListing', resourceId: id, action: `REVIEW_${body.decision.toUpperCase()}`, correlationId, changes: { badges: body.badges } });
    return this.summary(updated, p);
  }

  @Put(':id/star')
  @HttpCode(204)
  async star(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.ensureEnabled(p);
    const row = await this.prisma.marketplaceListing.findUnique({ where: { id } });
    if (!row || !this.visible(row, p)) throw notFound('Listing');
    await this.prisma.marketplaceStar.upsert({ where: { listingId_userId: { listingId: id, userId: p.userId } }, update: {}, create: { listingId: id, userId: p.userId } });
  }

  @Delete(':id/star')
  @HttpCode(204)
  async unstar(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.marketplaceStar.deleteMany({ where: { listingId: id, userId: p.userId } });
  }

  /** Records a use and returns the template version for the instance wizard. */
  @Scope('templates:read')
  @Post(':id/use')
  @HttpCode(200)
  async use(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<UseListingResultDto> {
    await this.ensureEnabled(p);
    authorize(p, 'read', 'Template');
    const row = await this.prisma.marketplaceListing.findUnique({ where: { id }, include });
    if (!row || row.status !== 'PUBLISHED') throw notFound('Listing');
    const version = row.template.versions[0];
    if (!version) throw unprocessable('TEMPLATE_NOT_PUBLISHED', 'This template has no published version.');
    await this.prisma.marketplaceListing.update({ where: { id }, data: { useCount: { increment: 1 } } });
    return { templateId: row.templateId, templateVersionId: version.id };
  }

  // ───────────────────────── helpers ─────────────────────────

  private canReview(p: RequestPrincipal): boolean {
    return p.ability.can('approve', 'Marketplace');
  }

  private visible(row: MarketplaceListing, p: RequestPrincipal): boolean {
    return row.status === 'PUBLISHED' || row.submittedById === p.userId || this.canReview(p);
  }

  private async ensureEnabled(p: RequestPrincipal) {
    authorize(p, 'read', 'Marketplace');
    const flags = await this.flags.forTenant(null);
    if (!flags.TEMPLATE_MARKETPLACE) throw notFound('Marketplace');
  }

  private preview(version: TemplateVersion | undefined): TemplatePreview | null {
    if (!version) return null;
    if (!this.previews.has(version.id)) {
      const parsed = environmentTemplate.safeParse(version.document);
      let preview: TemplatePreview | null = null;
      try {
        preview = parsed.success ? previewTemplate(parsed.data, this.adapters.registry) : null;
      } catch {
        preview = null;
      }
      if (this.previews.size > 500) this.previews.clear();
      this.previews.set(version.id, preview);
    }
    return this.previews.get(version.id) ?? null;
  }

  private summary(row: ListingRow, p: RequestPrincipal): ListingSummaryDto {
    const version = row.template.versions[0];
    const doc = version ? environmentTemplate.safeParse(version.document) : null;
    const template = doc?.success ? doc.data : null;
    const preview = this.preview(version);
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      categories: row.categories,
      // The listing's own tags first, then the template's (ADR 0007).
      tags: [...new Set([...row.tags, ...(template?.metadata.tags ?? [])])],
      badges: row.badges,
      status: row.status,
      publisherName: row.publisherName,
      templateId: row.templateId,
      templateName: row.template.name,
      version: version?.version ?? null,
      providers: preview?.providers ?? [],
      resourceCount: (template?.spec.resources ?? []).filter((r) => r.enabled).length,
      estimatedMonthlyCost: preview && preview.cost.confidence !== 'unavailable' ? Math.round(preview.cost.total * 100) / 100 : null,
      stars: row.stars.length,
      starred: row.stars.some((s) => s.userId === p.userId),
      useCount: row.useCount,
      publishedAt: row.publishedAt?.toISOString() ?? null,
    };
  }
}
