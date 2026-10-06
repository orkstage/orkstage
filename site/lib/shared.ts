/** Site-wide constants. Everything public about OrkStage links from here. */
export const appName = 'OrkStage';
export const siteUrl = 'https://orkstage.io';
export const docsRoute = '/docs';

export const slogan = 'Command every stage of your cloud.';
export const tagline = 'Raw scale. Precise control.';
export const siteDescription =
  'OrkStage is an open-source multi-cloud control plane. One provider-neutral template, each resource placed on AWS, Azure or OCI, a reviewed plan with policies and an approximate cost, then an asynchronous OpenTofu deployment you can watch, operate and audit.';

export const links = {
  github: 'https://github.com/orkstage/orkstage',
  license: 'https://github.com/orkstage/orkstage/blob/main/LICENSE',
  security: '/docs/self-hosting/security',
  contact: 'mailto:hello@orkstage.io',
  securityContact: 'mailto:security@orkstage.io',
  quickstart: '/docs/get-started/quickstart',
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
