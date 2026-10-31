import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ getAnalytics: vi.fn() }));
vi.mock("../api.js", () => api);

import Analytics from "./Analytics.jsx";

function payload(overrides = {}) {
  return {
    range: "7d",
    since: "2026-10-25T00:00:00.000Z",
    generated_at: "2026-10-31T10:30:00.000Z",
    retention_days: 90,
    clamped: false,
    admin: true,
    secrets: {
      total: 5,
      folders: [
        { folder: "Prod", count: 3 },
        { folder: "Staging", count: 2 },
      ],
    },
    tokens: { active: 4, expiring_7d: 1, expired: 2, revoked_all_time: 3 },
    activity: {
      bucket: "day",
      points: [
        {
          t: "2026-10-30T00:00:00.000Z",
          reads: 7,
          secret_writes: 2,
          auth_failures: 1,
          rate_limited: 0,
        },
        {
          t: "2026-10-31T00:00:00.000Z",
          reads: 3,
          secret_writes: 0,
          auth_failures: 0,
          rate_limited: 4,
        },
      ],
    },
    top_keys: [{ key: "API_KEY", reads: 9 }],
    top_tokens: [{ name: "ci-bot", events: 12 }],
    unread: {
      total: 1,
      items: [
        {
          folder: "Prod",
          key: "OLD_KEY",
          created_at: "2026-01-02T03:04:05.000Z",
        },
      ],
    },
    ...overrides,
  };
}

const NON_ADMIN = {
  admin: false,
  tokens: null,
  activity: null,
  top_keys: null,
  top_tokens: null,
  unread: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getAnalytics.mockResolvedValue(payload());
});

describe("Analytics", () => {
  it("shows a skeleton, then loads 7d by default", async () => {
    render(<Analytics token="tok" />);
    expect(
      screen.getByRole("status", { name: "Loading analytics" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Secrets per folder")).toBeInTheDocument();
    expect(api.getAnalytics).toHaveBeenCalledWith("tok", "7d");
    expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByRole("status", { name: "Loading analytics" }),
    ).toBeNull();
  });

  it("renders KPI tiles, panels, UTC labels and the exact unread footnote", async () => {
    render(<Analytics token="tok" />);
    await screen.findByText("Secrets per folder");
    for (const label of [
      "Secrets",
      "Folders",
      "Active tokens",
      "Expiring in 7d",
      "Expired",
      "Revoked (all time)",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("Top keys (by key name)")).toBeInTheDocument();
    expect(screen.getByText("ci-bot")).toBeInTheDocument();
    expect(screen.getByText("Not read in window")).toBeInTheDocument();
    expect(screen.getByText("OLD_KEY")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Reads through .env export count by folder. Secrets renamed or moved in the window count as read. Reads logged before this version are matched by key name only.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/all times UTC/)).toBeInTheDocument();
    expect(screen.getByText(/count logged audit rows/)).toBeInTheDocument();
    expect(screen.queryByText(/Window limited by audit retention/)).toBeNull();
  });

  it("labels the activity chart by its summary, titles each bucket and gives a table fallback", async () => {
    render(<Analytics token="tok" />);
    await screen.findByText("Secrets per folder");
    expect(
      screen.getByRole("img", {
        name: /10 reads · 2 secret writes · 1 auth failures · 4 rate limited/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle(
        "2026-10-30 UTC: 7 reads, 2 secret writes, 1 auth failures, 0 rate limited",
      ),
    ).toBeInTheDocument();
    // Distinct title per stacked segment, so colour is not the only cue.
    expect(screen.getByTitle("Reads: 7")).toHaveClass("min-h-[2px]");
    expect(screen.getByTitle("Secret writes: 2")).toBeInTheDocument();
    expect(screen.getByText(/^peak \d+ per day$/)).toBeInTheDocument();
    expect(screen.getByText("Show as table")).toBeInTheDocument();
    expect(screen.getByText("Day (UTC)")).toBeInTheDocument();
  });

  it("has a hidden Analytics h1 and a visible Definitions block with the tile caveats", async () => {
    render(<Analytics token="tok" />);
    await screen.findByText("Secrets per folder");
    expect(
      screen.getByRole("heading", { level: 1, name: "Analytics" }),
    ).toHaveClass("sr-only");
    expect(screen.getByText("Definitions").closest("details")).toHaveAttribute(
      "open",
    );
    expect(
      screen.getByText(/Expired: not revoked, past their expiry/),
    ).toBeInTheDocument();
    // Caveats no longer live in title-only tooltips.
    expect(screen.getByText("Expired").closest("div")).not.toHaveAttribute(
      "title",
    );
  });

  it("shows the clamped note with the retention days", async () => {
    api.getAnalytics.mockResolvedValue(
      payload({ clamped: true, retention_days: 30 }),
    );
    render(<Analytics token="tok" />);
    expect(
      await screen.findByText("Window limited by audit retention (30 days)"),
    ).toBeInTheDocument();
  });

  it("non-admin: shows the note and only secrets panels", async () => {
    api.getAnalytics.mockResolvedValue(payload(NON_ADMIN));
    render(<Analytics token="tok" />);
    await screen.findByText("Secrets per folder");
    expect(
      screen.getByText(/only shown for an unscoped write token/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Active tokens")).toBeNull();
    expect(screen.queryByText("Revoked (all time)")).toBeNull();
    expect(screen.queryByText("Activity")).toBeNull();
    expect(screen.queryByText("Top tokens")).toBeNull();
    expect(screen.queryByText("Not read in window")).toBeNull();
  });

  it("refetches on range change", async () => {
    const user = userEvent.setup();
    render(<Analytics token="tok" />);
    await screen.findByText("Secrets per folder");
    await user.click(screen.getByRole("button", { name: "30d" }));
    await waitFor(() =>
      expect(api.getAnalytics).toHaveBeenLastCalledWith("tok", "30d"),
    );
    await screen.findByText("Secrets per folder");
    expect(screen.getByRole("button", { name: "30d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("ignores a stale response that resolves after a newer range", async () => {
    const user = userEvent.setup();
    let resolveSlow;
    api.getAnalytics.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
    );
    api.getAnalytics.mockResolvedValueOnce(
      payload({
        range: "24h",
        secrets: { total: 99, folders: [{ folder: "Fast", count: 99 }] },
      }),
    );
    render(<Analytics token="tok" />);
    await user.click(screen.getByRole("button", { name: "24h" }));
    expect(await screen.findByText("Fast")).toBeInTheDocument();
    resolveSlow(
      payload({
        secrets: { total: 1, folders: [{ folder: "Slow", count: 1 }] },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("Fast")).toBeInTheDocument();
    expect(screen.queryByText("Slow")).toBeNull();
  });

  it("shows an error with retry", async () => {
    const user = userEvent.setup();
    api.getAnalytics.mockRejectedValueOnce(new Error("boom"));
    render(<Analytics token="tok" />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("boom");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Secrets per folder")).toBeInTheDocument();
    expect(api.getAnalytics).toHaveBeenCalledTimes(2);
  });

  it("shows empty states", async () => {
    api.getAnalytics.mockResolvedValue(
      payload({
        secrets: { total: 0, folders: [] },
        activity: {
          bucket: "hour",
          points: [
            {
              t: "2026-10-31T10:00:00.000Z",
              reads: 0,
              secret_writes: 0,
              auth_failures: 0,
              rate_limited: 0,
            },
          ],
        },
        top_keys: [],
        top_tokens: [],
        unread: { total: 0, items: [] },
      }),
    );
    render(<Analytics token="tok" />);
    expect(await screen.findByText("No secrets yet.")).toBeInTheDocument();
    expect(screen.getByText("No activity in this window.")).toBeInTheDocument();
    expect(screen.getByText("No reads in this window.")).toBeInTheDocument();
    expect(
      screen.getByText("No token activity in this window."),
    ).toBeInTheDocument();
    expect(screen.getByText("No unread secrets found.")).toBeInTheDocument();
  });

  it("truncates long key names but keeps the full name in title", async () => {
    const long = "K".repeat(120);
    api.getAnalytics.mockResolvedValue(
      payload({ top_keys: [{ key: long, reads: 1 }] }),
    );
    render(<Analytics token="tok" />);
    const el = await screen.findByText(long);
    expect(el).toHaveAttribute("title", long);
    expect(el.className).toContain("truncate");
  });

  it("notes 'Showing N of total' when the unread list is capped", async () => {
    api.getAnalytics.mockResolvedValue(
      payload({
        unread: {
          total: 80,
          items: [{ folder: "A", key: "K", created_at: "2026-01-01 00:00:00" }],
        },
      }),
    );
    render(<Analytics token="tok" />);
    expect(await screen.findByText("Showing 1 of 80.")).toBeInTheDocument();
    expect(screen.getByText("2026-01-01 00:00 UTC")).toBeInTheDocument();
  });
});
