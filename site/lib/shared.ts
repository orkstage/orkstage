/** Site-wide constants. Everything public about OrkStage links from here. Copy lives in lib/i18n. */
export const appName = 'OrkStage';
export const siteUrl = 'https://orkstage.io';
export const docsRoute = '/docs';

export const links = {
  github: 'https://github.com/orkstage/orkstage',
  githubOrg: 'https://github.com/orkstage',
  license: 'https://github.com/orkstage/orkstage/blob/main/LICENSE',
  security: '/docs/self-hosting/security/',
  contact: 'mailto:hello@orkstage.io',
  securityContact: 'mailto:security@orkstage.io',
  quickstart: '/docs/get-started/quickstart/',
  docs: '/docs/',
  apiReference: '/docs/developer/api-reference/',
  editions: '/docs/enterprise/editions/',
  enterprise: '/docs/enterprise/',
};

/** "Edit this page" points at the site repository, where the MDX lives. */
export const gitConfig = {
  user: 'orkstage',
  repo: 'orkstage-site',
  branch: 'main',
};

export function editUrl(pagePath: string): string {
  return `https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/content/docs/${pagePath}`;
}

/** Absolute URL for a site path. */
export function absoluteUrl(path: string): string {
  return new URL(path, siteUrl).toString();
}
