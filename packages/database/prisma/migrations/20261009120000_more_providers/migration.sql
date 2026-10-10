-- Infrastructure clouds and application platforms added to the provider list.
ALTER TYPE "CloudProvider" ADD VALUE IF NOT EXISTS 'digitalocean';
ALTER TYPE "CloudProvider" ADD VALUE IF NOT EXISTS 'vultr';
ALTER TYPE "CloudProvider" ADD VALUE IF NOT EXISTS 'coreweave';
ALTER TYPE "CloudProvider" ADD VALUE IF NOT EXISTS 'magalu';
ALTER TYPE "CloudProvider" ADD VALUE IF NOT EXISTS 'vercel';
ALTER TYPE "CloudProvider" ADD VALUE IF NOT EXISTS 'render';
ALTER TYPE "CloudProvider" ADD VALUE IF NOT EXISTS 'supabase';
