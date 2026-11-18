import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
const clipboard = vi.hoisted(() => { vi.stubEnv("VITE_TOKENTRACKER_PUBLIC_PROFILES", "1"); return vi.fn(async () => true); });
vi.mock("../../lib/safe-browser", async importOriginal => ({...await importOriginal(),safeWriteClipboard:clipboard}));
vi.mock("../../contexts/InsforgeAuthContext.jsx", () => ({ useInsforgeAuth: () => ({signedIn:true,user:{id:"synthetic-public"}}) }));
vi.mock("../../ui/dashboard/components/LikeButton.jsx", () => ({LikeButton: () => <span>Unsupported likes</span>}));
vi.mock("../../ui/dashboard/components/TrendMonitorZoomModal", () => ({TrendMonitorZoomModal: () => null}));
import { ProfileContent } from "./LeaderboardProfileModal.jsx";
import { ThemeContext } from "../../ui/foundation/ThemeProvider.jsx";
it("shares the current self-host domain and hides unsupported social/embed actions", async () => {
 const {container}=render(<MemoryRouter><ProfileContent data={{
  user:{user_id:"synthetic-public",display_name:"Synthetic public"},totals:{},streak:{},models:{},by_provider:[],heatmap:[],badges:[],period:{},
 }} currency="USD" rate={1} variant="page" onClose={() => {}} /></MemoryRouter>);
 expect([...container.querySelectorAll("a")].some(a=>a.href === `${window.location.origin}/u/synthetic-public`)).toBe(true);
 expect(container.textContent).not.toContain("Unsupported likes");
 fireEvent.click(screen.getByRole("button", {name:"Copy profile URL"}));
 await waitFor(() => expect(clipboard).toHaveBeenCalledWith(`${window.location.origin}/u/synthetic-public`));
 expect(screen.queryByText("Copy badge")).not.toBeInTheDocument();
 expect(container.innerHTML).not.toContain("https://www.tokentracker.cc/u/");
});

it("prioritizes activity and limits the personal profile to its five most used models", () => {
  const data = {
    user: { user_id: "synthetic-public", display_name: "Synthetic public" },
    totals: {},
    streak: {},
    models: {
      breakdown: [1, 7, 3, 6, 2, 5, 4].map((total_tokens) => ({
        total_tokens,
        model_name: `model-${total_tokens}`,
        estimated_cost_usd: 0,
      })),
    },
    by_provider: [],
    heatmap: [{ date: "2026-11-17", total_tokens: 28 }],
    badges: [],
    period: {},
  };
  const view = (variant) => (
    <MemoryRouter>
      <ThemeContext.Provider value={{ resolvedTheme: "light" }}>
        <ProfileContent data={data} currency="USD" rate={1} variant={variant} />
      </ThemeContext.Provider>
    </MemoryRouter>
  );
  const { container, rerender } = render(view("personal"));
  const sectionTitles = () => screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
  expect(sectionTitles()).toEqual(["Activity (last 365 days)", "All models", "By provider"]);
  const models = screen.getByRole("heading", { name: "All models" }).closest("section");
  expect([...models.querySelectorAll(":scope > details.nord-profile-model > summary > span:first-child")]
    .map((name) => name.textContent)).toEqual(["model-7", "model-6", "model-5", "model-4", "model-3"]);
  const more = container.querySelector(".nord-profile-more");
  expect(more).not.toHaveAttribute("open");
  expect(screen.getByText("model-2")).not.toBeVisible();
  fireEvent.click(screen.getByText("Show all models"));
  expect(more).toHaveAttribute("open");
  expect(screen.getByText("model-2")).toBeVisible();

  rerender(view("page"));
  expect(sectionTitles()).toEqual(["All models", "Achievements", "Activity (last 365 days)", "By provider"]);
  expect(container.querySelector(".nord-profile-more")).toBeNull();
  expect(screen.getByText("model-2")).toBeVisible();
});
