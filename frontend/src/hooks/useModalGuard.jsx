import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog.jsx";

let seq = 0;

// Test hook: reset the per-open id counter.
export function __resetModalGuardForTests() {
  seq = 0;
}

// Makes the browser Back button close an open dialog instead of leaving the
// page, and asks before discarding unsaved input.
//
// - On open it pushes ONE history entry tagged with a per-open id.
// - Back (popstate whose state is not our id): clean => close; dirty => push
//   the entry back and show the discard confirm.
// - Any close path (X, Escape, Cancel, parent success, forced logout/unmount)
//   pops our entry with history.back() ONLY if it is still the current one, so
//   there are no counters to drift and no dead Back entries.
// - Dialogs must stay mounted and toggle `open` (not be conditionally rendered).
// - The discard confirm has no history entry of its own; while it is open
//   Escape only dismisses it.
export function useModalGuard({
  open,
  dirty = false,
  onClose,
  escape = true,
  discardTitle = "Discard changes?",
  discardBody = "You have unsaved input. Close without saving?",
  discardLabel = "Discard",
}) {
  const [confirming, setConfirming] = useState(false);
  const live = useRef({});
  live.current.onClose = onClose;
  live.current.dirty = dirty;
  live.current.confirming = confirming;
  const entry = useRef({ id: null, consumed: true });

  // Push on open / pop on close. Keyed on [open] only: onClose and dirty are
  // read from refs so an App re-render never touches history.
  useEffect(() => {
    if (!open) return undefined;
    const id = ++seq;
    entry.current = { id, consumed: false };
    window.history.pushState({ smModal: id }, "");

    function onPop(event) {
      const e = entry.current;
      if (e.consumed) return;
      if (event.state?.smModal === id) return; // still on our entry
      if (live.current.dirty) {
        window.history.pushState({ smModal: id }, "");
        setConfirming(true);
      } else {
        e.consumed = true;
        live.current.onClose();
      }
    }
    window.addEventListener("popstate", onPop);

    return () => {
      window.removeEventListener("popstate", onPop);
      const e = entry.current;
      if (!e.consumed && window.history.state?.smModal === e.id) {
        window.history.back();
      }
      e.consumed = true;
      setConfirming(false);
    };
  }, [open]);

  const requestClose = useCallback(() => {
    if (live.current.dirty) setConfirming(true);
    else live.current.onClose();
  }, []);

  // Escape: close (or prompt). Ignored while the discard confirm is open so a
  // single press only dismisses the confirm.
  useEffect(() => {
    if (!open || !escape) return undefined;
    function onKey(event) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (live.current.confirming) return;
      requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, escape, requestClose]);

  // Closing/reloading the tab with unsaved input.
  useEffect(() => {
    if (!open || !dirty) return undefined;
    function onBeforeUnload(event) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [open, dirty]);

  const discardDialog = (
    <ConfirmDialog
      open={open && confirming}
      layer="z-50"
      title={discardTitle}
      body={discardBody}
      confirmLabel={discardLabel}
      danger
      onConfirm={() => {
        setConfirming(false);
        live.current.onClose();
      }}
      onClose={() => setConfirming(false)}
    />
  );

  return { requestClose, confirming, discardDialog };
}
