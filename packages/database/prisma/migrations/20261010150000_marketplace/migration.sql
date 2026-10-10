-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('PENDING_REVIEW', 'PUBLISHED', 'REJECTED', 'UNLISTED');

-- CreateEnum
CREATE TYPE "ListingBadge" AS ENUM ('VERIFIED', 'DEVOPS');

-- CreateTable
CREATE TABLE "MarketplaceListing" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "badges" "ListingBadge"[] DEFAULT ARRAY[]::"ListingBadge"[],
    "status" "ListingStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "publisherName" TEXT NOT NULL,
    "submittedById" UUID,
    "reviewedById" UUID,
    "reviewNotes" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MarketplaceListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceStar" (
    "listingId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceStar_pkey" PRIMARY KEY ("listingId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceListing_templateId_key" ON "MarketplaceListing"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceListing_slug_key" ON "MarketplaceListing"("slug");

-- CreateIndex
CREATE INDEX "MarketplaceListing_status_publishedAt_idx" ON "MarketplaceListing"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "MarketplaceStar_userId_idx" ON "MarketplaceStar"("userId");

-- AddForeignKey
ALTER TABLE "MarketplaceListing" ADD CONSTRAINT "MarketplaceListing_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceStar" ADD CONSTRAINT "MarketplaceStar_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

