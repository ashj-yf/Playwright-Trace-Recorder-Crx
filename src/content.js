// Content script for User Interaction Recorder
// Runs in every frame: DOM events never cross frame boundaries, so each
// frame's document needs its own listeners for iframe interactions to be
// recorded.
if (window._ventriloquistInjected) {
  // Already injected in this frame (e.g. due to a programmatic re-injection race).
  // Send current recording status instead of re-initialising.
  chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
} else {
  window._ventriloquistInjected = true;

let isRecording = false;
let isReplaying = false;

// Drag gesture tracking: mousedown anchors a potential drag, mouseup decides
// whether the pointer travelled past DRAG_MIN_DISTANCE pixels (one dragTo
// action) or whether it was an ordinary click. The click browsers fire after
// a drag (on the common ancestor of the mousedown/mouseup targets) is
// swallowed through suppressClickUntil.
let dragGesture = null;
let suppressClickUntil = 0;
const DRAG_MIN_DISTANCE = 6;

// Hover dwell tracking. A hover is only an action when the pointer comes to
// rest on an element: the recorder waits HOVER_DWELL_MS without any press or
// click, then records one `hover` action. Merely passing over an element (the
// pointer's trail on the way to a click) produces nothing, and any press
// cancels the pending hover — so an ordinary click never leaves a spurious
// hover in front of it.
let hoverTimer = null;
let hoverCandidate = null;
const HOVER_DWELL_MS = 350;

// Touch tracking. A tap is a touch that neither travelled (a swipe) nor was
// held (a long press). A real touch also makes the browser synthesize a click
// afterwards; that click is swallowed so the gesture is recorded once, as the
// `tap` action the viewer titles "Tap".
let touchGesture = null;
const TAP_MAX_DISTANCE = 10;
const TAP_MAX_MS = 700;

// Initialize content script
console.log('Ventriloquist content script loaded');

// ── Side Panel Open Handler ───────────────────────────────────────────────────
// Listen for postMessage from the page (crosses JS isolation boundary).
window.addEventListener('message', (event) => {
  if (event.source !== window) return; // Only accept messages from the same page
  if (!event.data || event.data.type !== 'playwrightTraceViewer:openSidePanel') return;

  console.log('[Playwright Trace Recorder] Received playwrightTraceViewer:openSidePanel via postMessage — relaying to service worker');
  chrome.runtime.sendMessage({ type: 'open_side_panel' })
    .then(response => {
      if (response && response.success) {
        console.log('[Playwright Trace Recorder] ✅ Side panel opened via service worker');
      } else {
        console.warn('[Playwright Trace Recorder] ❌ Service worker could not open side panel:', response?.error);
      }
    })
    .catch(err => console.warn('[Playwright Trace Recorder] ❌ Failed to relay to service worker:', err.message));
});

// Check initial recording status
chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' }, (response) => {
  if (response && response.recording) {
    startRecording();
  }
});

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'RECORDING_STARTED':
      startRecording();
      break;
    
    case 'RECORDING_STOPPED':
      stopRecording();
      break;
    
    case 'REPLAY_EVENTS':
      replayEvents(message.events, message.speed, message.loop);
      break;
  }
});

// Start recording user interactions
function startRecording() {
  if (isRecording) return;
  
  isRecording = true;
  // Recording indicator removed - it was appearing in traces and obscuring elements
  
  // Add event listeners for various user interactions
  document.addEventListener('click', handleClick, true);
  document.addEventListener('dblclick', handleDblclick, true);
  document.addEventListener('contextmenu', handleContextmenu, true);
  document.addEventListener('mouseover', handleMouseOver, true);
  document.addEventListener('mousedown', handleMouseDown, true);
  document.addEventListener('mouseup', handleMouseUp, true);
  document.addEventListener('touchstart', handleTouchStart, true);
  document.addEventListener('touchend', handleTouchEnd, true);
  document.addEventListener('touchcancel', handleTouchCancel, true);
  document.addEventListener('keydown', handleKeydown, true);
  document.addEventListener('scroll', handleScroll, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('change', handleChange, true);
  
  console.log('Recording started');
}

// Stop recording user interactions
function stopRecording() {
  if (!isRecording) return;
  
  isRecording = false;
  // hideRecordingIndicator() removed - indicator was removed
  
  // Remove event listeners
  cancelPendingHover();
  touchGesture = null;
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('dblclick', handleDblclick, true);
  document.removeEventListener('contextmenu', handleContextmenu, true);
  document.removeEventListener('mouseover', handleMouseOver, true);
  document.removeEventListener('mousedown', handleMouseDown, true);
  document.removeEventListener('mouseup', handleMouseUp, true);
  document.removeEventListener('touchstart', handleTouchStart, true);
  document.removeEventListener('touchend', handleTouchEnd, true);
  document.removeEventListener('touchcancel', handleTouchCancel, true);
  document.removeEventListener('keydown', handleKeydown, true);
  document.removeEventListener('scroll', handleScroll, true);
  document.removeEventListener('input', handleInput, true);
  document.removeEventListener('change', handleChange, true);
  
  console.log('Recording stopped');
}

// Records the interaction a pointer gesture performed on `target`: a toggle
// control becomes check/uncheck, anything else a plain click. Both a mouse
// click and a synthesized post-touch click route through here, so the two
// paths can never disagree about what a given element produces.
function recordPointerAction(target, type, clientX, clientY) {
  const selector = getElementSelector(target);
  if (isToggleControl(target)) {
    // The target's state is already settled when its click fires, so `checked`
    // describes the outcome.
    sendEventToBackground({
      type: target.checked ? 'check' : 'uncheck',
      selector, x: clientX, y: clientY, box: getElementBox(target)
    });
    return;
  }
  sendEventToBackground({
    type, selector, x: clientX, y: clientY, box: getElementBox(target)
  });
}

// Handle click events
function handleClick(event) {
  if (!isRecording || isReplaying) return;

  // A click synthesized by the browser AFTER a touch carries
  // `sourceCapabilities.firesTouchEvents`; the `tap` action already records the
  // gesture, so this echo is dropped. This is a precise signal rather than a
  // time-window guess, so it can never swallow a genuine mouse click that
  // happens to follow a tap quickly.
  if (event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents) return;

  // A double click's second strike is expressed by its dblclick event.
  if (event.detail >= 2) return;
  // The click trailing a drag gesture (browsers fire it on the common ancestor
  // of the mousedown/mouseup targets); the dragTo action already covers it.
  // No 350ms click delay — event timing stays untouched.
  if (Date.now() < suppressClickUntil) { suppressClickUntil = 0; return; }

  try {
    recordPointerAction(event.target, 'click', event.clientX, event.clientY);
  } catch (e) {
    console.warn('Failed to capture click event:', e);
  }
}

// A touch that neither travelled past TAP_MAX_DISTANCE (a swipe) nor was held
// past TAP_MAX_MS (a long press) is one tap. The browser synthesizes a click
// after a real tap, so it is suppressed; and since a tap can land on a toggle,
// the same target dispatch the click path uses is reused rather than assuming
// a tap is always a click.
function handleTouchStart(event) {
  if (!isRecording || isReplaying) return;
  // A touch is a press: any pending hover dwell is over.
  cancelPendingHover();
  const touch = event.changedTouches && event.changedTouches[0];
  if (!touch) { touchGesture = null; return; }
  touchGesture = {
    target: event.target,
    x: touch.clientX,
    y: touch.clientY,
    startedAt: Date.now()
  };
}

function handleTouchEnd(event) {
  if (!isRecording || isReplaying) { touchGesture = null; return; }
  const gesture = touchGesture;
  touchGesture = null;
  if (!gesture) return;

  const touch = event.changedTouches && event.changedTouches[0];
  if (!touch) return;
  const dx = touch.clientX - gesture.x;
  const dy = touch.clientY - gesture.y;
  if (dx * dx + dy * dy > TAP_MAX_DISTANCE * TAP_MAX_DISTANCE) return;  // swipe
  if (Date.now() - gesture.startedAt > TAP_MAX_MS) return;              // long press

  // No click suppression is needed here: the click the browser synthesizes for
  // this tap is tagged `sourceCapabilities.firesTouchEvents` and handleClick
  // drops it. Leaving that signal to do the job avoids a timing window that
  // could swallow an unrelated real click landing just after the tap.
  try {
    recordPointerAction(gesture.target, 'tap', touch.clientX, touch.clientY);
  } catch (e) {
    console.warn('Failed to capture tap event:', e);
  }
}

function handleTouchCancel() {
  touchGesture = null;
}

// Hover dwell: the pointer came to rest on an element. Only one hover is
// recorded per resting place, and it is cancelled by any press — the pointer
// merely travelling towards a click is not an action.
function handleMouseOver(event) {
  if (!isRecording || isReplaying) return;
  // `mouseover` also fires while a button is held: dragging the pointer across
  // elements is part of the drag, not a sequence of hovers. Only a pointer that
  // is genuinely at rest (no button down) can start a dwell.
  if (event.buttons !== 0) { cancelPendingHover(); return; }
  const target = event.target;
  if (!target || !(target instanceof Element)) return;
  // A mouseover on a frame element means the pointer entered the CHILD
  // document, whose own content script records the interaction that follows.
  // This frame never sees that child's mousedown (DOM events do not cross the
  // frame boundary), so a dwell started here can never be cancelled by the
  // click it precedes — it would surface as a stray hover AFTER the action.
  const tag = target.tagName;
  if (tag === 'IFRAME' || tag === 'FRAME') { cancelPendingHover(); return; }
  // Re-entering the same element (child-to-parent bubbling) is not a new dwell.
  if (hoverCandidate && hoverCandidate.element === target) return;

  cancelPendingHover();
  const candidate = {
    element: target,
    selector: getElementSelector(target),
    box: getElementBox(target)
  };
  hoverCandidate = candidate;
  hoverTimer = setTimeout(() => {
    // Only the latest resting element wins; a stale timer must not emit.
    if (hoverCandidate !== candidate) return;
    hoverCandidate = null;
    hoverTimer = null;
    sendEventToBackground({ type: 'hover', selector: candidate.selector, box: candidate.box });
  }, HOVER_DWELL_MS);
}

function cancelPendingHover() {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = null;
  hoverCandidate = null;
}

// Handle dblclick events: the whole double click is one action; handleClick
// has already swallowed the second strike (event.detail >= 2).
function handleDblclick(event) {
  if (!isRecording || isReplaying) return;

  sendEventToBackground({
    type: 'dblclick',
    selector: getElementSelector(event.target),
    x: event.clientX,
    y: event.clientY,
    box: getElementBox(event.target)
  });
}

// Handle contextmenu events (right click).
function handleContextmenu(event) {
  if (!isRecording || isReplaying) return;

  sendEventToBackground({
    type: 'contextmenu',
    selector: getElementSelector(event.target),
    x: event.clientX,
    y: event.clientY,
    box: getElementBox(event.target)
  });
}

// Handle mousedown events: anchor a potential drag gesture.
function handleMouseDown(event) {
  if (!isRecording || isReplaying) return;
  // Pressing means the pointer did not come to rest: no hover action.
  cancelPendingHover();
  // Only the primary button anchors a drag. Non-primary drags (middle-click
  // autoscroll pan, canvas panning) fire no click in Chrome, so a fabricated
  // dragTo would arm a suppressClickUntil window that never gets consumed
  // and could swallow the next genuine left click.
  if (event.button !== 0) { dragGesture = null; return; }

  dragGesture = {
    selector: getElementSelector(event.target),
    x: event.clientX,
    y: event.clientY
  };
}

// Handle mouseup events: decide drag vs ordinary click. A pointer that
// travelled at least DRAG_MIN_DISTANCE pixels is one dragTo action carrying
// the source element and the drop point; the accompanying click is suppressed.
function handleMouseUp(event) {
  if (!isRecording || isReplaying) { dragGesture = null; return; }

  const g = dragGesture;
  dragGesture = null;
  if (!g) return;
  const dx = event.clientX - g.x, dy = event.clientY - g.y;
  if (dx * dx + dy * dy < DRAG_MIN_DISTANCE * DRAG_MIN_DISTANCE) return; // ordinary click
  // A non-collapsed selection means the pointer was selecting text, not
  // dragging: drop the gesture and leave the click window unarmed.
  const sel = window.getSelection && window.getSelection();
  if (sel && !sel.isCollapsed) return;   // text selection, not a drag
  suppressClickUntil = Date.now() + 100;
  sendEventToBackground({
    type: 'dragTo',
    sourceSelector: g.selector,
    selector: getElementSelector(event.target),
    x: event.clientX,
    y: event.clientY,
    box: getElementBox(event.target)
  });
}

// Elements whose keystrokes describe a text value. Typing into them is merged
// into a single fill action (the 'input' event carries the whole value), the
// same way Playwright codegen collapses a burst of keystrokes.
function isTextEditable(element) {
  if (!element || !(element instanceof Element)) return false;
  if (element.isContentEditable) return true;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName === 'INPUT') {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    return ['text', 'search', 'url', 'tel', 'email', 'password', 'number', ''].includes(type);
  }
  return false;
}

// A checkbox/radio input. Toggling it produces click + input + change in one
// burst; the click handler emits the single canonical `check`/`uncheck` action
// (carrying the resulting state) and the other two events are ignored, so the
// toggle never appears twice. No standalone `input` action is emitted — the
// state itself rides on the DOM snapshot's __playwright_checked_ marker.
function isToggleControl(el) {
  if (!el || el.tagName !== 'INPUT') return false;
  const t = (el.getAttribute('type') || '').toLowerCase();
  return t === 'checkbox' || t === 'radio';
}

// A <select>. Choosing an option produces input + change; the viewer titles a
// dedicated `Frame.selectOption` action, so it is recorded as one action
// carrying the selected value rather than folded into a generic `change`.
function isSelectControl(el) {
  return !!el && el.tagName === 'SELECT';
}

// A file input. Its `change` is the only event that reports the chosen files;
// the viewer titles a dedicated `Frame.setInputFiles` action.
function isFileInput(el) {
  return !!el && el.tagName === 'INPUT' &&
    (el.getAttribute('type') || '').toLowerCase() === 'file';
}

// A key that edits the field's text. The resulting 'input' event covers it.
function isTextEditingKey(key) {
  return key.length === 1 || key === 'Backspace' || key === 'Delete';
}

// Bare modifier presses (the Control keydown preceding Control+a, …) carry no
// action of their own, the way Playwright codegen ignores them.
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Meta', 'Alt', 'AltGraph', 'OS']);

// Playwright-style key name for a modifier chord (Control+a, Meta+v, …).
function chordKey(event) {
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return null;
  const parts = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(event.key.length === 1 ? event.key.toLowerCase() : event.key);
  return parts.join('+');
}

// Handle keydown events
function handleKeydown(event) {
  if (!isRecording || isReplaying) return;

  // IME composition (e.g. Chinese/Japanese input): the composing 'input'
  // events and final fill value already capture the result.
  if (event.isComposing || event.keyCode === 229) return;
  // Bare modifier keydowns precede their chord; nothing to record.
  if (MODIFIER_KEYS.has(event.key)) return;

  const editable = isTextEditable(event.target);
  const chord = chordKey(event);

  // Plain editing keystrokes in a text field are folded into the fill action.
  if (editable && !chord && isTextEditingKey(event.key)) return;

  // Printable keys on a non-editable target are not meaningful actions;
  // special keys (Enter, Tab, Escape, arrows, F-keys) and chords are presses.
  if (!editable && !chord && event.key.length === 1) return;

  const eventData = {
    type: 'press',
    selector: getElementSelector(event.target),
    key: chord || event.key,
    box: getElementBox(event.target)
  };

  sendEventToBackground(eventData);
}

// Handle scroll events
function handleScroll(event) {
  if (!isRecording || isReplaying) return;
  
  // Throttle scroll events to avoid overhead
  if (this.scrollTimeout) clearTimeout(this.scrollTimeout);
  this.scrollTimeout = setTimeout(() => {
    const eventData = {
      type: 'scroll',
      url: window.location.href,
      scrollX: window.scrollX,
      scrollY: window.scrollY
      // Snapshot omitted for scroll to save space
    };
    sendEventToBackground(eventData);
  }, 200);
}

// Handle input events
function handleInput(event) {
  if (!isRecording || isReplaying) return;

  // A toggle is covered by its own check/uncheck action.
  if (isToggleControl(event.target)) return;
  // A <select>'s input event is the same choice its change event reports; only
  // the change handler emits the selectOption action.
  if (isSelectControl(event.target)) return;
  // A file input fires `input` AND `change` for the same selection. Only the
  // change handler emits the setInputFiles action; `value` here is the
  // browser's fake path ("C:\fakepath\..."), which describes nothing.
  if (isFileInput(event.target)) return;

  try {
    const target = event.target;
    const selector = getElementSelector(target);
    const box = getElementBox(target);
    const eventData = isTextEditable(target)
      ? {
          type: 'fill',
          selector,
          value: target.isContentEditable ? (target.textContent || '') : target.value,
          box
        }
      : {
          type: 'input',
          selector,
          value: target.value,
          box
        };

    sendEventToBackground(eventData);
  } catch (e) {
    console.warn('Failed to capture input event:', e);
  }
}

// Handle change events
function handleChange(event) {
  if (!isRecording || isReplaying) return;

  const target = event.target;

  // A toggle's change fires alongside its click; the click handler already
  // emitted the canonical check/uncheck action.
  if (isToggleControl(target)) return;

  // Text fields already produced a fill action carrying the final value;
  // their change event only fires at blur and would duplicate it.
  if (isTextEditable(target)) return;

  try {
    const selector = getElementSelector(target);

    // A file input reports its selection only here. Only the file NAMES travel
    // with the action: the contents are the page's business and may be large or
    // private, and Playwright's own trace format carries paths, not bytes.
    if (isFileInput(target)) {
      sendEventToBackground({
        type: 'setInputFiles',
        selector,
        files: [...(target.files || [])].map(f => f.name),
        box: getElementBox(target)
      });
      return;
    }

    // A <select> choice: one action carrying the chosen value(s), which is what
    // the viewer's "Select option" row renders.
    if (isSelectControl(target)) {
      const options = [...target.selectedOptions].map(o => o.value);
      sendEventToBackground({
        type: 'selectOption',
        selector,
        options,
        value: target.value,
        box: getElementBox(target)
      });
      return;
    }

    sendEventToBackground({
      type: 'change',
      selector: selector,
      value: target.value
    });
  } catch (e) {
    console.warn('Failed to capture change event:', e);
  }
}

// Generate CSS selector for an element
function getElementSelector(element) {
  if (!element) return '';
  
  // Try to use ID first
  if (element.id) {
    return `#${element.id}`;
  }
  
  // Try to use unique class combination
  if (element.className && typeof element.className === 'string') {
    const classes = element.className.trim().split(/\s+/);
    if (classes.length > 0) {
      const classSelector = '.' + classes.map(cls => escapeCssSelector(cls)).join('.');
      if (document.querySelectorAll(classSelector).length === 1) {
        return classSelector;
      }
    }
  }
  
  // Use tag name with nth-child
  const tagName = element.tagName.toLowerCase();
  const parent = element.parentElement;
  
  if (parent) {
    const siblings = Array.from(parent.children).filter(child => 
      child.tagName.toLowerCase() === tagName
    );
    const index = siblings.indexOf(element) + 1;
    const parentSelector = getElementSelector(parent);
    return `${parentSelector} > ${tagName}:nth-child(${index})`;
  }
  
  return tagName;
}

// High-Fidelity: DOM Snapshotting via CDP now

/**
 * Viewport-relative rectangle of an element, in CSS pixels.
 *
 * The trace viewer draws a translucent highlight over the element an action
 * addressed, reading `box` from the action's input line. A detached or
 * zero-sized element yields undefined rather than a bogus rectangle, and the
 * caller simply omits the field.
 */
function getElementBox(element) {
  if (!element || typeof element.getBoundingClientRect !== 'function') return undefined;
  try {
    const r = element.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return undefined;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  } catch (e) {
    return undefined;
  }
}
function captureSnapshot() {
  return null;
}

// Escape special characters for CSS selector
function escapeCssSelector(selector) {
  // Escape characters that have special meaning in CSS selectors
  // This regex is more comprehensive for characters that might appear in class names
  return selector.replace(/([.#:;,\(\)\[\]{}*+?|^$!"'~`@%&])/g, '\\$1');
}

// Send event data to background script
function sendEventToBackground(eventData) {
  eventData.url = window.location.href; // Ensure URL is always present
  chrome.runtime.sendMessage({
    type: 'RECORD_EVENT',
    event: eventData
  }).catch(error => {
    console.error('Error sending event to background:', error);
  });
}

// Replay events
async function replayEvents(events, speed = 1, loop = false) {
  if (isReplaying) return;
  
  isReplaying = true;
  const delay = 1000 / speed; // Base delay between events
  
  do {
    for (const event of events) {
      try {
        await replayEvent(event);
      } catch (error) {
        console.error('Error replaying event:', error);
      }
    }
  } while (loop && isReplaying);
  
  isReplaying = false;
}

// Replay a single event
async function replayEvent(event) {
  switch (event.type) {
    case 'click':
      await replayClick(event);
      break;

    // A hover has no lasting effect; highlighting the element is the faithful
    // re-enactment of "the pointer came to rest here".
    case 'hover':
      replayHighlight(event.selector);
      break;

    case 'check':
    case 'uncheck':
      await replayToggle(event);
      break;

    case 'selectOption':
      await replaySelectOption(event);
      break;

    case 'setInputFiles':
      await replaySetInputFiles(event);
      break;

    // contextmenu/dblclick/dragTo share the click-shaped replay: dispatch the
    // same mouse event kind at the recorded point.
    case 'dblclick':
    case 'contextmenu':
      await replayClick(event);
      break;

    // A tap replays as a touch at the recorded point; the page's own handlers
    // see it the same way they saw the original.
    case 'tap':
      await replayTap(event);
      break;

    case 'dragTo':
      await replayDragTo(event);
      break;
    
    case 'press':
    case 'keydown':
      await replayKeydown(event);
      break;

    case 'scroll':
      await replayScroll(event);
      break;

    case 'fill':
    case 'input':
    case 'change':
      await replayInput(event);
      break;
  }
}

/** Outline the element an event addressed, without changing page state. */
function replayHighlight(selector) {
  const element = document.querySelector(selector);
  if (element) highlightElement(element);
  else console.warn('Element not found for hover:', selector);
}

/**
 * Replay a checkbox/radio toggle. The recorded action's type already states the
 * intended outcome, so the box is driven TO that state rather than flipped —
 * flipping would invert the result whenever replay starts from a different
 * initial state (e.g. after a page reload, where markup defaults decide).
 */
async function replayToggle(event) {
  const element = document.querySelector(event.selector);
  if (!element) { console.warn('Element not found for toggle:', event.selector); return; }
  element.checked = event.type === 'check';
  for (const type of ['input', 'change']) {
    try {
      element.dispatchEvent(new Event(type, { bubbles: true }));
    } catch (e) {
      console.warn(`Failed to dispatch ${type} for toggle:`, event.selector, e);
    }
  }
  highlightElement(element);
}

/** Replay choosing option(s) in a <select>. */
async function replaySelectOption(event) {
  const element = document.querySelector(event.selector);
  if (!element) { console.warn('Element not found for selectOption:', event.selector); return; }
  const wanted = new Set(event.options || (event.value != null ? [event.value] : []));
  for (const option of element.options) option.selected = wanted.has(option.value);
  for (const type of ['input', 'change']) {
    try {
      element.dispatchEvent(new Event(type, { bubbles: true }));
    } catch (e) {
      console.warn(`Failed to dispatch ${type} for selectOption:`, event.selector, e);
    }
  }
  highlightElement(element);
}

/**
 * Replay a file selection. A page cannot be handed files programmatically (the
 * FileList is read-only and browsers reject synthetic input), so this reports
 * the recorded file names and highlights the input instead of pretending to
 * reproduce a selection it cannot make.
 */
async function replaySetInputFiles(event) {
  const element = document.querySelector(event.selector);
  if (!element) { console.warn('Element not found for setInputFiles:', event.selector); return; }
  console.warn(
    `File input ${event.selector} was recorded with ${(event.files || []).join(', ') || 'no files'}; ` +
    'file contents cannot be replayed programmatically');
  highlightElement(element);
}

/** Replay a drag: press at the source, move to the drop point, release. */
/**
 * Replay a tap as a synthetic touch sequence at the element's centre. The page
 * cannot be sent a trusted touch, so this dispatches the same touchstart/touchend
 * pair a real finger produces and lets the page's own handlers react.
 */
async function replayTap(event) {
  const element = document.querySelector(event.selector);
  if (!element) { console.warn('Element not found for tap:', event.selector); return; }
  const rect = element.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  for (const type of ['touchstart', 'touchend']) {
    try {
      // `Touch`/`TouchEvent` are not constructible in every engine, so the
      // plain Event path is the portable fallback.
      let touchEvent;
      if (typeof Touch === 'function' && typeof TouchEvent === 'function') {
        const touch = new Touch({ identifier: 1, target: element, clientX: x, clientY: y });
        touchEvent = new TouchEvent(type, {
          bubbles: true, cancelable: true,
          touches: type === 'touchend' ? [] : [touch],
          changedTouches: [touch]
        });
      } else {
        touchEvent = new Event(type, { bubbles: true, cancelable: true });
      }
      element.dispatchEvent(touchEvent);
    } catch (e) {
      console.warn(`Failed to dispatch ${type} for tap:`, event.selector, e);
    }
  }
  highlightElement(element);
}

async function replayDragTo(event) {
  const source = document.querySelector(event.sourceSelector || event.selector);
  const target = document.querySelector(event.selector);
  if (!source || !target) {
    console.warn('Element not found for dragTo:', event.sourceSelector, event.selector);
    return;
  }
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const init = {
    bubbles: true, cancelable: true, view: window, button: 0, buttons: 1
  };
  const at = (type, el, x, y, buttons) => {
    try {
      el.dispatchEvent(new MouseEvent(type, { ...init, clientX: x, clientY: y, buttons }));
    } catch (e) {
      console.warn(`Failed to dispatch ${type} during dragTo:`, e);
    }
  };
  const fromX = from.x + from.width / 2, fromY = from.y + from.height / 2;
  const toX = to.x + to.width / 2, toY = to.y + to.height / 2;
  at('mousedown', source, fromX, fromY, 1);
  at('mousemove', target, toX, toY, 1);
  at('mouseup', target, toX, toY, 0);
  highlightElement(target);
}

// Replay click event. The recorded type also names the DOM event to dispatch
// (`click`/`dblclick`/`contextmenu`), so a right click replays as a contextmenu
// rather than as another left click.
async function replayClick(event) {
  const element = document.querySelector(event.selector);
  if (element) {
    const domType = ['click', 'dblclick', 'contextmenu'].includes(event.type)
      ? event.type : 'click';
    try {
      const clickEvent = new MouseEvent(domType, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: domType === 'contextmenu' ? 2 : 0,
        clientX: event.x,
        clientY: event.y
      });
      element.dispatchEvent(clickEvent);
    } catch (e) {
      console.warn('Failed to replay click event (untrusted event):', event.selector, e);
    }
    highlightElement(element);
  } else {
    console.warn('Element not found for click:', event.selector);
  }
}

// Replay keydown event
async function replayKeydown(event) {
  const element = document.querySelector(event.selector);
  if (element) {
    element.focus();
    
    const keyEvent = new KeyboardEvent('keydown', {
      key: event.key,
      keyCode: event.keyCode,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      bubbles: true
    });
    
    try {
      element.dispatchEvent(keyEvent);
    } catch (e) {
      console.warn('Failed to replay keydown event (untrusted event):', event.selector, e);
    }
    highlightElement(element);
  } else {
    console.warn('Element not found for keydown:', event.selector);
  }
}

// Replay scroll event
async function replayScroll(event) {
  window.scrollTo(event.scrollX, event.scrollY);
}

// Replay input event
async function replayInput(event) {
  const element = document.querySelector(event.selector);
  if (element) {
    element.focus();
    element.value = event.value;
    
    // Trigger input and change events
    try {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) {
      console.warn('Failed to dispatch input event (untrusted event):', event.selector, e);
    }
    try {
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      console.warn('Failed to dispatch change event (untrusted event):', event.selector, e);
    }
    
    highlightElement(element);
  } else {
    console.warn('Element not found for input:', event.selector);
  }
}

// Highlight element during replay
function highlightElement(element) {
  element.style.outline = '3px solid #00ff00';
  element.style.outlineOffset = '2px';
  
  setTimeout(() => {
    element.style.outline = '';
    element.style.outlineOffset = '';
  }, 500);
}

} // end injection guard