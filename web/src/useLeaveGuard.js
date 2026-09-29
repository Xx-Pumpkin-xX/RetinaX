import { useEffect } from "react";

const MESSAGE = "You have unsaved changes. Leaving this page will discard them. Continue?";

/**
 * Ask before unsaved work is thrown away.
 *
 * `beforeunload` covers closing the tab, reloading, and typing another address.
 * It does not fire for a move inside a single-page app, and the browser's Back
 * button is exactly that - so Back silently discarded a half-written note while
 * every link on the page asked first.
 *
 * React Router's own blocker needs a data router and this app mounts
 * BrowserRouter, so the guard works on history directly: while there is unsaved
 * work an extra entry sits on top of the stack, Back pops that one instead of
 * leaving, and the answer decides whether the real move happens.
 *
 * The entry is taken back off on cleanup, but only when it is still the current
 * one - after a link navigation it is not, and popping then would drag the
 * doctor back a page they chose to leave.
 */
export default function useLeaveGuard(dirty) {
  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ""; };

    let guarding = true;
    const arm = () => window.history.pushState({ rxGuard: true }, "");

    function onPopState() {
      if (window.confirm(MESSAGE)) {
        guarding = false;
        window.removeEventListener("popstate", onPopState);
        window.history.back();
      } else {
        arm();
      }
    }

    arm();
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("popstate", onPopState);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPopState);
      if (guarding && window.history.state?.rxGuard) window.history.back();
    };
  }, [dirty]);
}

export { MESSAGE as LEAVE_MESSAGE };
