/* Shared popup positioning for EbSelect and EbDate: panels go on document.body with position fixed, repositioning when the page scrolls and closing only when the trigger is gone. */

/** Place the popup against its trigger, flipping above when there is no room below; returns "above" or "below" for the transform-origin. */
export function placeLayer(trigger, pop, opts = {}) {
  const { gap = 6, maxH = 280, minSpace = 140, matchWidth = true, prefer = "below" } = opts;

  const r = trigger.getBoundingClientRect();
  if (matchWidth) pop.style.minWidth = r.width + "px";

  const below = window.innerHeight - r.bottom - gap;
  const above = r.top - gap;
  /* prefer "above" opens upward whenever there is room. */
  const flip  = prefer === "above" ? (above >= minSpace || above > below) : (below < minSpace && above > below);

  const space = Math.max(120, Math.min(maxH, flip ? above : below));
  pop.style.maxHeight = space + "px";

  const h = Math.min(pop.scrollHeight + 2, space);
  pop.style.top = flip ? (r.top - gap - h) + "px" : (r.bottom + gap) + "px";
  pop.style.setProperty("--ebs-origin", flip ? "bottom center" : "top center");

  /* Clamp horizontally so the panel never hangs off either edge. */
  const w = Math.max(pop.offsetWidth, matchWidth ? r.width : 0);
  let left = r.left;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  pop.style.left = Math.max(8, left) + "px";

  return flip ? "above" : "below";
}

/** Is the trigger still visible, both in the viewport and inside any clipping ancestor? */
function triggerVisible(el) {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  if (r.bottom < 0 || r.top > window.innerHeight) return false;
  if (r.right < 0 || r.left > window.innerWidth) return false;

  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (!/(auto|scroll|hidden|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY)) continue;
    const nr = n.getBoundingClientRect();
    if (r.bottom < nr.top || r.top > nr.bottom) return false;
    if (r.right < nr.left || r.left > nr.right) return false;
  }
  return true;
}

/** Wire a fixed panel's dismissals and return one teardown function: scrolling inside the popup is ignored, page scrolls reposition it, and it closes only when the trigger is gone. */
export function closeOn(pop, trigger, close, reposition) {
  let frame = null;
  let timer = null;

  const follow = () => {
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!triggerVisible(trigger)) { close(); return; }
    if (reposition) reposition();
  };

  /* Throttle with requestAnimationFrame plus a timeout fallback, since rAF pauses in background tabs. */
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(follow);
    if (timer === null) timer = setTimeout(follow, 100);
  };

  const onScroll = e => {
    /* Ignore scrolls that start inside the popup. */
    const t = e.target;
    if (t === pop || (t && t.nodeType === 1 && pop.contains(t))) return;
    schedule();
  };
  const onResize = () => schedule();
  const onDown   = e => {
    if (!trigger.contains(e.target) && !pop.contains(e.target)) close();
  };

  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  document.addEventListener("mousedown", onDown, true);

  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("mousedown", onDown, true);
  };
}

/** Is the visitor using touch? (see select.js shouldEnhance()) */
/** True on the staff portal, which uses the themed dropdowns and calendar on phones too (the storefront keeps the native pickers there). */
export function isPortal() {
  return /\/portal\//.test(location.pathname);
}

export function isCoarsePointer() {
  return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
}

/** True when the viewer has asked for less motion. */
export function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/** Remove a panel after its exit transition, with a timeout because reduced motion skips transitionend. */
export function removeAfterExit(pop, ms = 250) {
  const done = () => pop.remove();
  if (reducedMotion()) { done(); return; }
  pop.addEventListener("transitionend", done, { once: true });
  setTimeout(done, ms);
}
