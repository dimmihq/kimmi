import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useMe } from './api/queries';
import { Analytics } from './pages/Analytics';
import { ErrorDetail } from './pages/ErrorDetail';
import { Errors } from './pages/Errors';
import { Feedback } from './pages/Feedback';
import { Friction } from './pages/Friction';
import { Funnels } from './pages/Funnels';
import { Heatmaps } from './pages/Heatmaps';
import { Invite } from './pages/Invite';
import { Live } from './pages/Live';
import { Login } from './pages/Login';
import { NewProject } from './pages/NewProject';
import { Overview } from './pages/Overview';
import { Performance } from './pages/Performance';
import { Player } from './pages/Player';
import { Projects } from './pages/Projects';
import { AlertSettings } from './pages/project-settings/Alerts';
import { AnalyticsSettings } from './pages/project-settings/Analytics';
import { Capture } from './pages/project-settings/Capture';
import { General } from './pages/project-settings/General';
import { Install } from './pages/project-settings/Install';
import { ProjectMembers } from './pages/project-settings/Members';
import { Privacy } from './pages/project-settings/Privacy';
import { Retention } from './pages/project-settings/Retention';
import { SharingSettings } from './pages/project-settings/Sharing';
import { Recordings } from './pages/Recordings';
import { Shared } from './pages/Shared';
import { Signup } from './pages/Signup';
import { Instance } from './pages/settings/Instance';
import { Preferences } from './pages/settings/Preferences';
import { Profile } from './pages/settings/Profile';
import { Storage } from './pages/settings/Storage';
import { Team } from './pages/settings/Team';
import { Tokens } from './pages/settings/Tokens';
import { VisitorDetail } from './pages/VisitorDetail';
import { Visitors } from './pages/Visitors';
import { AppFrame } from './shell/AppFrame';
import { type ReturnState, returnPath } from './shell/auth';
import { ErrorNote } from './shell/states';
import { Toaster, TooltipProvider } from './ui';

/** Signed-out visitors go to /login, remembering where they were headed. */
function SignedIn() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <div className="h-full bg-canvas" />;
  if (me.isError) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <ErrorNote error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  if (!me.data) {
    const state: ReturnState = { from: { pathname: location.pathname, search: location.search } };
    return <Navigate to="/login" replace state={state} />;
  }
  return <Outlet />;
}

/** Signed-in users skip /login and /signup. */
function SignedOut() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <div className="h-full bg-canvas" />;
  if (me.data) return <Navigate to={returnPath(location.state)} replace />;
  return <Outlet />;
}

export function App() {
  return (
    <TooltipProvider delay={350}>
      <Routes>
        <Route element={<SignedOut />}>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
        </Route>
        <Route path="/invite/:token" element={<Invite />} />
        <Route path="/shared/:token" element={<Shared />} />
        <Route element={<SignedIn />}>
          <Route element={<AppFrame />}>
            <Route path="/" element={<Navigate to="/projects" replace />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/new" element={<NewProject />} />
            <Route path="/projects/:projectId">
              <Route index element={<Overview />} />
              <Route path="recordings" element={<Recordings />} />
              <Route path="recordings/:recordingId" element={<Player />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="funnels" element={<Funnels />} />
              <Route path="heatmaps" element={<Heatmaps />} />
              <Route path="errors" element={<Errors />} />
              <Route path="errors/:fingerprint" element={<ErrorDetail />} />
              <Route path="friction" element={<Friction />} />
              <Route path="performance" element={<Performance />} />
              <Route path="feedback" element={<Feedback />} />
              <Route path="live" element={<Live />} />
              <Route path="visitors" element={<Visitors />} />
              <Route path="visitors/:visitorId" element={<VisitorDetail />} />
              <Route path="settings" element={<Navigate to="general" replace />} />
              <Route path="settings/general" element={<General />} />
              <Route path="settings/install" element={<Install />} />
              <Route path="settings/privacy" element={<Privacy />} />
              <Route path="settings/capture" element={<Capture />} />
              <Route path="settings/analytics" element={<AnalyticsSettings />} />
              <Route path="settings/alerts" element={<AlertSettings />} />
              <Route path="settings/sharing" element={<SharingSettings />} />
              <Route path="settings/retention" element={<Retention />} />
              <Route path="settings/members" element={<ProjectMembers />} />
            </Route>
            <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
            <Route path="/settings/profile" element={<Profile />} />
            <Route path="/settings/preferences" element={<Preferences />} />
            <Route path="/settings/team" element={<Team />} />
            <Route path="/settings/tokens" element={<Tokens />} />
            <Route path="/settings/storage" element={<Storage />} />
            <Route path="/settings/instance" element={<Instance />} />
            <Route path="*" element={<Navigate to="/projects" replace />} />
          </Route>
        </Route>
      </Routes>
      <Toaster />
    </TooltipProvider>
  );
}
