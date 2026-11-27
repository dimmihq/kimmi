import { Navigate, Outlet, useParams } from 'react-router-dom';
import { useAnalyticsOn } from '@/api/queries';

/**
 * Routes that have nothing to show until the project counts visits. An old
 * link to one lands on the Overview, or on the analytics settings for a
 * settings page, rather than on an empty page.
 */
export function NeedsAnalytics({ settings = false }: { settings?: boolean }) {
  const { projectId = '' } = useParams();
  const on = useAnalyticsOn(projectId);
  // Not known yet: neither the page nor a redirect.
  if (on === undefined) return null;
  if (on) return <Outlet />;
  const base = `/projects/${projectId}`;
  return <Navigate to={settings ? `${base}/settings/analytics` : base} replace />;
}
