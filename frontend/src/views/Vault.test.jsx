import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import Vault from "./Vault.jsx";
import { DOT_MASK } from "../lib/format.js";

const SECRETS = [
  { key: "ALPHA", folder: "Root", id: "Root ALPHA" },
  { key: "BETA", folder: "Root", id: "Root BETA" },
];

function renderVault(loadSecret) {
  return render(
    <Vault
      secrets={SECRETS}
      folders={["Root"]}
      meta={{}}
      role="write"
      busy={false}
      searchTerm=""
      folderFilter="All"
      onFolderFilter={() => {}}
      onCopy={() => {}}
      onDelete={() => {}}
      loadSecret={loadSecret}
    />,
  );
}

// Reveal handlers await loadSecret (a resolved mock). Wrapping the click in an
// async act flushes that microtask and the resulting state update.
async function reveal(label) {
  await act(async () => {
    fireEvent.click(screen.getByLabelText(label));
  });
}

describe("Vault reveal lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reveals with a 15s countdown, ticks down, then re-masks and prunes", async () => {
    const loadSecret = vi.fn().mockResolvedValue("supersecret");
    renderVault(loadSecret);

    await reveal("Reveal ALPHA in Root");

    expect(screen.getByText("supersecret")).toBeInTheDocument();
    expect(screen.getByText("15s")).toBeInTheDocument();

    // 14s in: one second left.
    act(() => vi.advanceTimersByTime(14000));
    expect(screen.getByText("1s")).toBeInTheDocument();

    // Past 15s: the reveal is pruned and the row re-masks.
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByText("supersecret")).not.toBeInTheDocument();
    expect(screen.getAllByText(DOT_MASK)).toHaveLength(2);
    expect(screen.getByLabelText("Reveal ALPHA in Root")).toBeInTheDocument();
  });

  it("masks every revealed row on Escape", async () => {
    const loadSecret = vi.fn().mockResolvedValue("val");
    renderVault(loadSecret);

    await reveal("Reveal ALPHA in Root");
    await reveal("Reveal BETA in Root");
    expect(screen.getAllByText("val")).toHaveLength(2);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(screen.queryByText("val")).not.toBeInTheDocument();
    expect(screen.getAllByText(DOT_MASK)).toHaveLength(2);
  });

  it("masks only the row whose mask button is clicked", async () => {
    const loadSecret = vi.fn().mockResolvedValue("val");
    renderVault(loadSecret);

    await reveal("Reveal ALPHA in Root");
    await reveal("Reveal BETA in Root");
    expect(screen.getAllByText("val")).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Mask ALPHA in Root"));
    });

    // ALPHA is masked again; BETA stays revealed.
    expect(screen.getByLabelText("Reveal ALPHA in Root")).toBeInTheDocument();
    expect(screen.getByLabelText("Mask BETA in Root")).toBeInTheDocument();
    expect(screen.getAllByText("val")).toHaveLength(1);
  });
});
