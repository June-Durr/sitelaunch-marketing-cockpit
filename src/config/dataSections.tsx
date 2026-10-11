/**
 * The six places the Data & Import screen goes.
 *
 * One definition, read by both the jump bar and the anchors it points at, so an
 * id can never appear in one and not the other and two groups cannot end up
 * sharing one. A test asserts the ids are unique, because a duplicate would
 * silently send the bar to whichever element the browser found first.
 *
 * In its own module rather than beside the screen so that file exports a
 * component and nothing else, which is what Fast Refresh needs.
 */
import {
  AnalyticsGroupIcon, GoogleCalendarIcon, LeadsGroupIcon, ManualImportIcon,
  SettingsGroupIcon, SocialGroupIcon,
} from '../components/icons';
import type { SectionNavItem } from '../components/SectionNav';

export const DATA_SECTIONS: SectionNavItem[] = [
  { id: 'analytics', label: 'Analytics', Icon: AnalyticsGroupIcon },
  { id: 'leads', label: 'Leads', Icon: LeadsGroupIcon },
  { id: 'calendar', label: 'Calendar', Icon: GoogleCalendarIcon },
  { id: 'social', label: 'Social', Icon: SocialGroupIcon },
  { id: 'fallback', label: 'Fallback', Icon: ManualImportIcon },
  { id: 'settings', label: 'Settings', Icon: SettingsGroupIcon },
];
