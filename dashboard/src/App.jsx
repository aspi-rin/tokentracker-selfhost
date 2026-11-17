import React, { lazy, Suspense, useMemo } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { useLocale } from "./hooks/useLocale.js";
import { copy } from "./lib/copy";
import { ThemeProvider } from "./ui/foundation/ThemeProvider.jsx";
import { useInsforgeAuth } from "./contexts/InsforgeAuthContext.jsx";
import { LoginModalProvider } from "./contexts/LoginModalContext.jsx";
import { getBackendBaseUrl } from "./lib/config";
import { isMockEnabled } from "./lib/mock-mode";
import { useCloudUsageSync } from "./hooks/use-cloud-usage-sync";
import { AppLayout } from "./ui/components/Sidebar.jsx";
import { ToastProvider } from "./ui/components/Toast.jsx";
// Eager: OAuth callback values must be captured before the SDK removes them.
import { NativeAuthCallbackPage } from "./pages/NativeAuthCallbackPage.jsx";
const DashboardPage = lazy(() => import("./pages/DashboardPage.jsx").then(m=>({default:m.DashboardPage})));
const SettingsPage = lazy(() => import("./pages/SettingsPage.jsx").then(m=>({default:m.SettingsPage})));
const LoginPage = lazy(() => import("./pages/LoginPage.jsx").then(m=>({default:m.LoginPage})));
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage.jsx").then(m=>({default:m.ResetPasswordPage})));
const PersonalHomePage = lazy(() => import("./pages/PersonalHomePage.jsx"));
const ProfilePage = lazy(() => import("./pages/LeaderboardProfilePage.jsx").then(m=>({default:m.LeaderboardProfilePage})));
const LimitsPage = lazy(() => import("./pages/LimitsPage.jsx").then(m=>({default:m.LimitsPage})));
const SessionsPage = lazy(() => import("./pages/SessionsPage.jsx").then(m=>({default:m.SessionsPage})));
const WidgetsPage = lazy(() => import("./pages/WidgetsPage.jsx").then(m=>({default:m.WidgetsPage})));
const IpCheckPage = lazy(() => import("./pages/IpCheckPage.jsx"));
const ServiceStatusPage = lazy(() => import("./pages/ServiceStatusPage.jsx"));
const AchievementsPage = lazy(() => import("./pages/AchievementsPage.jsx"));
const WrappedPage = lazy(() => import("./pages/WrappedPage.jsx"));
const DevicePage = lazy(() => import("./pages/DevicePage.jsx"));
const LoginModal = lazy(() => import("./components/LoginModal.jsx").then(m=>({default:m.LoginModal})));
const CommandPalette = lazy(() => import("./ui/dashboard/components/CommandPalette.jsx").then(m=>({default:m.CommandPalette})));

export default function App() {
  const { resolvedLocale } = useLocale();
  const location = useLocation();
  const insforge = useInsforgeAuth();
  useCloudUsageSync();
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const local = ["localhost","127.0.0.1"].includes(window.location.hostname);
  const mock = isMockEnabled();
  const signedIn = local || mock || insforge.signedIn;
  const auth = useMemo(() => insforge.signedIn ? {
    getAccessToken: () => insforge.getAccessToken(), userId: insforge.user?.id, name: insforge.displayName || "",
  } : null, [insforge]);
  const profileId = path.match(/^\/u\/([^/]+)$/)?.[1];
  const shareToken = path.match(/^\/share\/([^/]+)$/)?.[1] || new URLSearchParams(location.search).get("token");
  const publicShare = path === "/share" || path.startsWith("/share/") || path === "/share.html";
  const guestHome = path === "/" && !local && !mock && !insforge.signedIn;
  const home = ["/public","/leaderboard","/landing"].includes(path) || guestHome;
  const authRoute = ["/login","/reset-password","/auth/callback","/auth/native-callback"].includes(path);
  const standalone = home || profileId || publicShare || authRoute || path === "/device" || path === "/wrapped";
  let content;
  if (["/auth/callback","/auth/native-callback"].includes(path)) content = <NativeAuthCallbackPage />;
  else if (path === "/login") content = <LoginPage />;
  else if (path === "/reset-password") content = <ResetPasswordPage />;
  else if (path === "/device") content = <DevicePage />;
  else if (profileId) content = <ProfilePage userId={profileId} auth={auth} signedIn={signedIn} />;
  else if (guestHome && insforge.loading) content = <div role="status" className="p-6 text-sm">{copy("shared.loading")}</div>;
  else if (home) content = <PersonalHomePage auth={auth} signedIn={signedIn} />;
  else if (publicShare) content = <DashboardPage publicMode publicToken={shareToken} baseUrl={getBackendBaseUrl()} />;
  else if (!local && !mock && insforge.loading) content = <div role="status" className="p-6 text-sm">{copy("shared.loading")}</div>;
  else if (!signedIn) {
    const params = new URLSearchParams(location.search);
    for (const key of ["insforge_code","code","state","access_token","refresh_token"]) params.delete(key);
    const query = params.toString(), next = path + (query ? `?${query}` : "");
    content = <Navigate replace to={`/login?next=${encodeURIComponent(next)}`} />;
  } else if (["/cloud","/billing/checkout","/self-host","/devices"].includes(path)) content = <Navigate replace to="/settings?section=cloud" />;
  else if (["/skills","/pet-settings"].includes(path)) content = <Navigate replace to="/dashboard" />;
  else {
    const Page = ({"/settings":SettingsPage,"/limits":LimitsPage,"/sessions":SessionsPage,
      "/widgets":WidgetsPage,"/ip-check":IpCheckPage,"/service-status":ServiceStatusPage,
      "/achievements":AchievementsPage,"/wrapped":WrappedPage})[path] || DashboardPage;
    content = <Page key={resolvedLocale} auth={auth} signedIn={signedIn} sessionSoftExpired={false}
      baseUrl={getBackendBaseUrl()} signOut={()=>insforge.signOut()} onMainContentVisible={()=>{}} />;
  }
  return <ErrorBoundary><ThemeProvider><ToastProvider><LoginModalProvider>
    <Suspense fallback={null}>{standalone || !signedIn ? content : <AppLayout>{content}</AppLayout>}</Suspense>
    <Suspense fallback={null}>{!standalone && signedIn ? <CommandPalette /> : null}<LoginModal /></Suspense>
  </LoginModalProvider></ToastProvider></ThemeProvider></ErrorBoundary>;
}
