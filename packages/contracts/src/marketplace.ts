// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Template marketplace: discovery metadata and review state on top of templates. Curated listings
 * ship with OrkStage; platform staff submit their own templates and reviewers publish them with
 * badges.
 */
export const MARKETPLACE_CATEGORIES = [
  'disaster-recovery',
  'payments',
  'fintech',
  'ecommerce',
  'logistics',
  'delivery',
  'web',
  'saas',
  'data',
  'ai-ml',
  'internal-tools',
  'security',
  'observability',
] as const;
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

/** VERIFIED: reviewed by platform staff. DEVOPS: reviewed for operations readiness. */
export const LISTING_BADGES = ['VERIFIED', 'DEVOPS'] as const;
export type ListingBadge = (typeof LISTING_BADGES)[number];

export const LISTING_STATUSES = ['PENDING_REVIEW', 'PUBLISHED', 'REJECTED', 'UNLISTED'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

const slug = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/, 'lowercase letters, digits and dashes');
const tag = z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/, 'lowercase letters, digits and dashes');

const listingFields = {
  slug,
  title: z.string().min(3).max(80),
  summary: z.string().min(10).max(240),
  description: z.string().max(8000).default(''),
  categories: z.array(z.enum(MARKETPLACE_CATEGORIES)).min(1).max(4),
  tags: z.array(tag).max(8).default([]),
};

/** Submit a template (it needs a published version) for review. */
export const submitListingSchema = z.object({ templateId: z.uuid(), ...listingFields });
export const updateListingSchema = z.object(listingFields).partial();

export const reviewListingSchema = z.object({
  decision: z.enum(['approve', 'reject', 'unlist']),
  badges: z.array(z.enum(LISTING_BADGES)).default([]),
  notes: z.string().max(2000).optional(),
});

export const listingQuerySchema = z.object({
  q: z.string().max(100).optional(),
  category: z.enum(MARKETPLACE_CATEGORIES).optional(),
  badge: z.enum(LISTING_BADGES).optional(),
  provider: z.string().max(40).optional(),
  /** Staff with review rights only; everyone else sees published listings (plus their own with `mine`). */
  status: z.enum(LISTING_STATUSES).optional(),
  mine: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(['popular', 'new', 'name']).default('popular'),
});

export interface ListingSummaryDto {
  id: string;
  slug: string;
  title: string;
  summary: string;
  categories: string[];
  tags: string[];
  badges: ListingBadge[];
  status: ListingStatus;
  publisherName: string;
  templateId: string;
  templateName: string;
  version: string | null;
  /** Providers the template's placement slots allow (empty means any). */
  providers: string[];
  plans: string[];
  resourceCount: number;
  /** Approximate monthly cost on the first allowed provider of each slot, or null when unknown. */
  estimatedMonthlyCost: number | null;
  stars: number;
  starred: boolean;
  useCount: number;
  publishedAt: string | null;
}

export interface ListingDetailDto extends ListingSummaryDto {
  description: string;
  /** Only for reviewers and the submitter. */
  reviewNotes: string | null;
  canReview: boolean;
  canEdit: boolean;
  template: {
    versionId: string | null;
    source: string | null;
    placements: { name: string; description: string | null; providers: string[] }[];
    resources: { id: string; type: string; placement: string }[];
    triggers: { name: string; resource: string; action: string }[];
  };
  cost: { currency: string; total: number; confidence: string; lines: { resourceId: string; category: string; monthly: number | null }[] } | null;
}

export interface UseListingResultDto {
  templateId: string;
  templateVersionId: string;
}
