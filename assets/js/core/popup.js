/* ============================================================
   Shared popup layer — geometry and lifecycle
   ------------------------------------------------------------
   EbSelect and EbDate both hang a floating panel off a trigger, and
   both have the same problem to solve: several of their triggers sit
   inside .table-wrap (overflow:auto) or inside a modal, each of which
   is its own clipping and stacking context. A panel rendered in place
   is cut off at the edge of whichever one it is inside.

   THE ANSWER, ONCE. The panel is appended to document.body and
   positioned `fixed` from the trigger's viewport rect, which puts it
   outside every clipping context on the page. The cost is that a fixed
   panel does not travel with the page, so closeOn() below watches for
   the page moving underneath and REPOSITIONS the panel against its
   trigger, closing only once the trigger itself is gone. It listens in
   the CAPTURE phase because most scrolling in this app happens in
   #main-content and .table-wrap rather than on window — and that same
   capture phase is what made the first version eat the popup's own
   scroll, which is written up on closeOn() itself.

   Written here rather than duplicated because the two components must
   flip, clamp and dismiss identically or they stop feeling like one
   system — which is the whole point of building them.
   ============================================================ */

/**
 * Place `pop` against `trigger`, flipping above when there is no room below.
 *
 * Returns "above" | "below" so the caller can set a matching transform-origin:
 * a panel that grows downward out of a trigger it is sitting ON TOP of reads
 * as a glitch.
 */
export function placeLayer(trigger, pop, opts = {}) {
  const { gap = 6, maxH = 280, minSpace = 140, matchWidth = true } = opts;

  const r = trigger.getBoundingClientRect();
  if (matchWidth) pop.style.minWidth = r.width + "px";

  const below = window.innerHeight - r.bottom - gap;
  const above = r.top - gap;
  const flip  = below < minSpace && above > below;

  const space = Math.max(120, Math.min(maxH, flip ? above : below));
  pop.style.maxHeight = space + "px";

  const h = Math.min(pop.scrollHeight + 2, space);
  pop.style.top = flip ? (r.top - gap - h) + "px" : (r.bottom + gap) + "px";
  pop.style.setProperty("--ebs-origin", flip ? "bottom center" : "top center");

  /* Horizontal clamp: a filter near the right-hand edge would otherwise hang
     off it, and one inside a narrow modal would hang off the left. */
  const w = Math.max(pop.offsetWidth, matchWidth ? r.width : 0);
  let left = r.left;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  pop.style.left = Math.max(8, left) + "px";

  return flip ? "above" : "below";
}

/**
 * Is the trigger still somewhere a popup can point at?
 *
 * Two ways it stops being: scrolled out of the viewport, or scrolled out of a
 * clipping ancestor — a filter inside .table-wrap can leave that box long
 * before it leaves the window.
 */
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

/**
 * Wire the dismissals a fixed panel needs, and hand back one function that
 * removes all of them. Returning a single teardown means a caller cannot
 * detach three listeners and forget the fourth.
 *
 * THE BUG THIS REPLACES — and it made the product pickers unusable.
 *
 * This was `const onScroll = () => close()` bound to window in the CAPTURE
 * phase. Capture means it fires for a scroll on ANY element, and the popup is
 * an element: turning the mouse wheel over the open option list scrolled the
 * list, which fired `scroll` on the popup, which reached this handler, which
 * closed it. The Restock and Adjustment pickers list every unarchived product,
 * so they are exactly the lists a person needs to scroll — and the wheel shut
 * them instantly. Arrowing past the last visible row did the same thing, via
 * the scrollIntoView() the keyboard handler calls.
 *
 * THREE DIFFERENT SCROLLS, THREE DIFFERENT ANSWERS:
 *
 *   inside the popup   the list scrolling itself. Ignore it entirely. CSS
 *                      `overscroll-behavior: contain` stops it chaining to the
 *                      page once the list hits its end.
 *   the page moving    the panel is `fixed`, so it does not travel with the
 *                      page — REPOSITION it against the trigger rather than
 *                      dismissing. Throttled through requestAnimationFrame so
 *                      a fast wheel does not run the geometry every event.
 *   trigger gone       scrolled out of the viewport or out of a clipping
 *                      ancestor. Only now is there nothing to attach to, and
 *                      only now does it close.
 */
export function closeOn(pop, trigger, close, reposition) {
  let frame = null;
  let timer = null;

  const follow = () => {
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!triggerVisible(trigger)) { close(); return; }
    if (reposition) reposition();
  };

  /* rAF is the right throttle for geometry — it runs once per painted frame,
     so a fast wheel cannot make this recompute per event. It is NOT reliable
     on its own: browsers suspend rAF in a hidden or background tab, and a
     popup left open in one would then sit at a stale position (or fail to
     close) until the tab was looked at again. The timeout is the floor that
     guarantees the work happens either way; whichever fires first cancels the
     other. */
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(follow);
    if (timer === null) timer = setTimeout(follow, 100);
  };

  const onScroll = e => {
    /* A scroll that started inside the popup is the list scrolling itself.
       `e.target` is the scrolled element; for a document scroll it is the
       document, which pop.contains() correctly reports false for. */
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

/** Is the visitor pointing with a finger? Both components defer to the OS
    picker there — see the note in select.js's shouldEnhance(). */
export function isCoarsePointer() {
  return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
}

/** True when the viewer has asked for less motion. */
export function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/**
 * Remove a panel once its exit transition has run.
 *
 * The timeout is not belt-and-braces: under reduced motion the transition is
 * removed altogether, so transitionend never fires and the node would leak
 * into the DOM on every close.
 */
export function removeAfterExit(pop, ms = 250) {
  const done = () => pop.remove();
  if (reducedMotion()) { done(); return; }
  pop.addEventListener("transitionend", done, { once: true });
  setTimeout(done, ms);
}
