import { createContext, createElement, useContext, type ReactNode } from 'react';

export type ServiceBranding = { appName: string; badgeText: string; accentColor: string; logoUrl?: string };
export type IntegrationHost = { id: string; name: string; origin: string; returnPath: string };
export type IntegrationConfig = { version: 1; revision?: number; branding: ServiceBranding; hosts: IntegrationHost[]; routes?: { games: string; game: string; embed: string; studio: string } };

export const defaultIntegrationConfig: IntegrationConfig = {
  version: 1, revision: 0,
  branding: { appName: 'Game Studio', badgeText: 'Powered by Game Studio', accentColor: '#176a63' },
  hosts: [],
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > limit || /[\u0000-\u001f\u007f-\u009f<>]/.test(value)) throw new Error(`${label} must contain 1–${limit} characters.`);
  return value;
}
function validOrigin(value: unknown): string {
  const origin = text(value, 'Application origin', 255);
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error('Use an HTTPS application origin without a path.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.origin !== origin) throw new Error('Use an HTTPS application origin without a path.');
  return origin;
}
export function parseIntegrationConfig(value: unknown): IntegrationConfig {
  if (!record(value) || value.version !== 1 || !record(value.branding) || !Array.isArray(value.hosts) || value.hosts.length > 20) throw new Error('The Game Studio integration settings are invalid.');
  if (Object.keys(value).some(key => !['version', 'revision', 'branding', 'hosts', 'routes'].includes(key))) throw new Error('The integration settings include unsupported fields.');
  const { branding } = value;
  if (Object.keys(branding).some(key => !['appName', 'badgeText', 'accentColor', 'logoUrl'].includes(key))) throw new Error('The branding settings include unsupported fields.');
  const result: ServiceBranding = {
    appName: text(branding.appName, 'Application name', 80),
    badgeText: text(branding.badgeText, 'Badge text', 80),
    accentColor: text(branding.accentColor, 'Accent color', 7),
  };
  if (!/^#[0-9a-fA-F]{6}$/.test(result.accentColor)) throw new Error('Choose an accent color using six hexadecimal digits.');
  if (branding.logoUrl !== undefined && branding.logoUrl !== '') {
    const logo = text(branding.logoUrl, 'Logo URL', 2048);
    let url: URL;
    try { url = new URL(logo); } catch { throw new Error('The logo must use an HTTPS URL.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || /[\\\s<>]/.test(logo)) throw new Error('The logo must use an HTTPS URL without credentials or a query string.');
    result.logoUrl = logo;
  }
  const ids = new Set<string>();
  const hosts = value.hosts.map(item => {
    if (!record(item)) throw new Error('Each connected application needs an ID, name, origin, and return path.');
    if (Object.keys(item).some(key => !['id', 'name', 'origin', 'returnPath'].includes(key))) throw new Error('The connected application includes unsupported fields.');
    const id = text(item.id, 'Application ID', 64);
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || ids.has(id)) throw new Error('Connected application IDs must be unique and use letters, numbers, underscores, or hyphens.');
    ids.add(id);
    const returnPath = text(item.returnPath, 'Application return path', 500);
    if (!/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(returnPath) || returnPath.split('/').some(part => part === '.' || part === '..')) throw new Error('Use a return path on the connected application, starting with a single /.');
    return { id, name: text(item.name, 'Application name', 80), origin: validOrigin(item.origin), returnPath };
  });
  if (value.revision !== undefined && (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision > 1000000000)) throw new Error('The integration revision is invalid.');
  const routes = { games: '/games', game: '/games/{gameId}', embed: '/embed/games/{gameId}', studio: '/game-studio' };
  if (value.routes !== undefined && (!record(value.routes) || Object.keys(value.routes).length !== 4 || Object.entries(routes).some(([key, path]) => (value.routes as Record<string, unknown>)[key] !== path))) throw new Error('The public integration routes are invalid.');
  return { version: 1, ...(value.routes !== undefined ? { routes } : {}), ...(value.revision !== undefined ? { revision: value.revision as number } : {}), branding: result, hosts };
}
const BrandingContext = createContext<IntegrationConfig>(defaultIntegrationConfig);
export function BrandingProvider({ config, children }: { config: IntegrationConfig; children: ReactNode }) {
  return createElement(BrandingContext.Provider, { value: config }, children);
}
export function useIntegrationConfig(): IntegrationConfig { return useContext(BrandingContext); }
export function useBranding(): ServiceBranding { return useIntegrationConfig().branding; }
