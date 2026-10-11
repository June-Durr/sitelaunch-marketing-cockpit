/**
 * Which mark belongs to which integration provider.
 *
 * Kept apart from icons.tsx so that file exports components and nothing else,
 * which is what React Fast Refresh needs to reload a module cleanly. Keyed by
 * the provider strings in types/integrations.ts rather than by label, so a
 * renamed label cannot silently detach a service from its mark.
 */
import {
  FacebookIcon, Ga4Icon, GoogleCalendarIcon, InstagramIcon, LinkedInIcon,
  SearchConsoleIcon, SheetsIcon, TikTokIcon, WebsiteFormsIcon,
  type IconComponent,
} from './icons';
import type { IntegrationProvider } from '../types/integrations';

export const PROVIDER_ICONS: Record<IntegrationProvider, IconComponent> = {
  ga4: Ga4Icon,
  search_console: SearchConsoleIcon,
  google_sheets: SheetsIcon,
  google_calendar: GoogleCalendarIcon,
  website_forms: WebsiteFormsIcon,
  instagram: InstagramIcon,
  facebook: FacebookIcon,
  linkedin: LinkedInIcon,
  tiktok: TikTokIcon,
};
