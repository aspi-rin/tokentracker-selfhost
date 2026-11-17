/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://www.tokentracker.cc"} */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";

const labels = {
  cloud: "Public Cloud plans",
  checkout: "Owned Cloud checkout",
  selfHost: "Self-host deployment guidance",
  dashboard: "Account dashboard",
  shell: "App shell",
};
const auth = vi.hoisted(() => ({
  enabled: true,
  signedIn: false,
  loading: false,
  user: null,
  getAccessToken: vi.fn(),
}));
vi.mock("./contexts/InsforgeAuthContext.jsx", () => ({
  useInsforgeAuth: () => auth,
}));
vi.mock("./hooks/useLocale.js", () => ({
  useLocale: () => ({ resolvedLocale: "en" }),
}));
vi.mock("./hooks/use-cloud-usage-sync", () => ({ useCloudUsageSync: vi.fn() }));
vi.mock("./lib/mock-mode", () => ({ isMockEnabled: () => false }));
vi.mock("./lib/dashboard-preload.js", () => ({
  getLeaderboardPreloadContextKey: () => "test",
  markDashboardMainContentVisible: vi.fn(),
  preloadDashboardPageResources: vi.fn(),
  preloadLeaderboardDefaultState: vi.fn(),
}));
vi.mock("./ui/foundation/ThemeProvider.jsx", () => ({
  ThemeProvider: ({ children }) => children,
}));
vi.mock("./contexts/LoginModalContext.jsx", () => ({
  LoginModalProvider: ({ children }) => children,
}));
vi.mock("./components/LoginModal.jsx", () => ({ LoginModal: () => null }));
vi.mock("./ui/components/Sidebar.jsx", () => ({
  AppLayout: ({ children }) => <div aria-label={labels.shell}>{children}</div>,
}));
vi.mock("./ui/dashboard/components/CommandPalette.jsx", () => ({
  CommandPalette: () => null,
}));
vi.mock("./pages/PersonalHomePage.jsx", () => ({ default: () => <h1>Personal public usage</h1> }));
vi.mock("./pages/SettingsPage.jsx", () => ({ SettingsPage: () => <h1>Sync settings</h1> }));
vi.mock("./pages/LimitsPage.jsx", () => ({ LimitsPage: () => <h1>Usage limits</h1> }));
vi.mock("./pages/WidgetsPage.jsx", () => ({ WidgetsPage: () => <h1>Widgets</h1> }));
vi.mock("./pages/DashboardPage.jsx", () => ({
  DashboardPage: () => <h1>{labels.dashboard}</h1>,
}));
vi.mock("./pages/LoginPage.jsx", () => ({
  LoginPage: () => <h1>{useLocation().pathname + useLocation().search}</h1>,
}));

beforeEach(() => {
  auth.signedIn = false;
  auth.user = null;
  sessionStorage.clear();
});
afterEach(cleanup);

describe("Cloud public routing", () => {
  it("retains the protected account route when authentication must be restored", async () => {
    render(<MemoryRouter initialEntries={["/settings?section=account"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "/login?next=%2Fsettings%3Fsection%3Daccount" })).toBeInTheDocument();
  });
  it("does not carry OAuth credentials into the protected sign-in destination", async () => {
    render(<MemoryRouter initialEntries={["/dashboard?insforge_code=fixture-only-code&state=private-state&from=2026-10-01"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "/login?next=%2Fdashboard%3Ffrom%3D2026-10-01" })).toBeInTheDocument();
  });
  it.each(["/cloud", "/billing/checkout", "/self-host", "/devices"])("protects legacy sync route %s", async path => {
    render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", {name:"/login?next="+encodeURIComponent(path)})).toBeInTheDocument();
  });
  it.each(["/", "/public", "/leaderboard"])("shows the personal public home at %s", async path => {
    render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", {name:"Personal public usage"})).toBeInTheDocument();
  });
  it.each([["/cloud","Sync settings"],["/billing/checkout","Sync settings"],["/skills","Account dashboard"],["/pet-settings","Account dashboard"],["/limits","Usage limits"],["/widgets","Widgets"]])("signed-in route %s keeps the intended tool", async (path,label) => {
    auth.signedIn=true;auth.user={id:"owner"};
    render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", {name:label})).toBeInTheDocument();
  });
});
