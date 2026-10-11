"use strict";

// One source-area selection produces one atomic PDF-only edit. The workspace
// command owns page transforms, validation, retained identities and undo.
(function (root) {
  root.CeasefireTakeoffInitialPages = function (host) {
    const { state, G, S, svg, currentDocument, pageMetadata, pageRotation,
      pageDisplayKey, signatureMode, drawingPoint, flushSettings, requireFinishedEdits,
      cancelTrace, setTool, command, safely, message, renderOverlay, renderSelection } = host;
    let generation = 0;
    const context = () => JSON.stringify([pageDisplayKey(), signatureMode(), currentDocument()?.sha256]);
    async function activate() {
      if (state.tool === "initial-pages") { cancelTrace(); message("Initial Pages cancelled."); return; }
      await flushSettings(); requireFinishedEdits();
      if (!S || !state.viewport || !currentDocument()) throw new Error("Open a rendered PDF page before initialling pages.");
      cancelTrace(); setTool("initial-pages");
      message("Drag a box for your name, initials or signature. Right-click or click Initial Pages again to cancel.");
    }
    function cancel() {
      generation++;
      if (state.gesture?.kind === "initial-pages") { state.gesture.cleanup?.(); state.gesture = null; }
    }
    function displayPoint(point) {
      const [x,y] = G.transform(point, state.viewport.transform);
      return [Math.max(0, Math.min(state.viewport.width, x)), Math.max(0, Math.min(state.viewport.height, y))];
    }
    function rectangle(gesture) {
      const [a,b] = [gesture.initial, gesture.current].map(displayPoint);
      return [Math.min(a[0],b[0]), Math.min(a[1],b[1]), Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1])];
    }
    function paint(overlay) {
      const gesture = state.gesture;
      if (gesture?.kind !== "initial-pages" || !state.viewport) return;
      const [x,y,width,height] = rectangle(gesture);
      overlay.append(svg("rect", { x,y,width,height, class: "takeoff-pending", "aria-label": "Initial Pages area", "pointer-events": "none" }));
    }
    function begin(event) {
      if (state.tool !== "initial-pages" || event.button !== 0) return false;
      event.preventDefault(); event.stopImmediatePropagation();
      if (state.busy || state.modal || state.gesture || !state.viewport) return true;
      requireFinishedEdits();
      const initial = drawingPoint(event), view = pageMetadata()?.view;
      if (!view || initial[0] < view[0] || initial[0] > view[2] || initial[1] < view[1] || initial[1] > view[3]) return true;
      const element = state.ui.overlay, token = ++generation, key = context(), revision = state.session.revision;
      const transform = JSON.stringify(state.viewport.transform), pointer = event.pointerId;
      const gesture = { kind: "initial-pages", initial, current: initial };
      state.gesture = gesture;
      const valid = () => token === generation && state.gesture === gesture && key === context() && revision === state.session?.revision && transform === JSON.stringify(state.viewport?.transform) && state.tool === "initial-pages";
      const cleanup = () => {
        element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", finish);
        element.removeEventListener("pointercancel", abort); element.removeEventListener("lostpointercapture", abort);
        if (element.hasPointerCapture(pointer)) element.releasePointerCapture(pointer);
      };
      gesture.cleanup = cleanup;
      const move = next => { if (next.pointerId !== pointer || !valid()) return; next.preventDefault(); gesture.current = drawingPoint(next); renderOverlay(); };
      const abort = next => { if (next.pointerId !== pointer) return; cleanup(); if (state.gesture === gesture) { state.gesture = null; cancelTrace(); } };
      const finish = next => {
        if (next.pointerId !== pointer) return;
        next.preventDefault(); next.stopPropagation(); const current = valid(); if (current) gesture.current = drawingPoint(next);
        const box = current ? rectangle(gesture) : null;
        cleanup(); if (state.gesture === gesture) state.gesture = null;
        state.suppressSelectionClickUntil = Date.now() + 500; renderOverlay();
        if (!current) return;
        if (box[2] < 4 || box[3] < 4) { message("Drag a larger area for Initial Pages.", true); return; }
        const x = box[0]/state.viewport.width, y = box[1]/state.viewport.height;
        const normalized = [x, y, Math.min(box[2]/state.viewport.width, 1-x), Math.min(box[3]/state.viewport.height, 1-y)];
        void safely(async () => {
          if (token !== generation || key !== context() || revision !== state.session?.revision || state.tool !== "initial-pages") return;
          let chosen; state.modal = true;
          try { chosen = await S.chooseInitial(); } finally { state.modal = false; }
          if (token !== generation || key !== context() || revision !== state.session?.revision || state.tool !== "initial-pages") return;
          if (!chosen) { cancelTrace(); return; }
          const initials = { mode: signatureMode(), document_id: state.document, source_sha256: currentDocument().sha256,
            page: state.page, normalized_box: normalized, display_rotation: ((pageMetadata().rotation || 0) + pageRotation()) % 360,
            text: chosen.name, strokes: chosen.signature?.strokes || [], signature_ratio: chosen.signature?.ratio ?? null,
            text_appearance: {}, signature_appearance: {} };
          const reply = await command("initial_pages", { initials }, () => token === generation && key === context() && revision === state.session?.revision && state.tool === "initial-pages");
          if (!reply || token !== generation || key !== context() || state.tool !== "initial-pages") return;
          cancelTrace(); state.annotationSelected = null; state.signatureSelected = null; state.graphicSelected = null;
          renderSelection(); message(`Initials placed on ${reply.initial_pages_count} pages. Undo last edit removes this whole placement.`);
        });
      };
      element.addEventListener("pointermove", move); element.addEventListener("pointerup", finish);
      element.addEventListener("pointercancel", abort); element.addEventListener("lostpointercapture", abort);
      element.setPointerCapture(pointer); renderOverlay(); return true;
    }
    return Object.freeze({ activate, begin, cancel, paint });
  };
})(window);
