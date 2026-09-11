/** Message names shared by the side panel, the service worker and the page. */
export const MSG = {
  // Side panel → service worker
  SCAN_PAGE: 'scan-page',
  START_PICK: 'start-pick',
  CANCEL_PICK: 'cancel-pick',
  ASK: 'ask',
  STOP: 'stop',
  EXPORT_CSS: 'export-css',
  GET_SETTINGS: 'get-settings',

  // Options page → service worker (one-off, not over the port)
  TEST_KEY: 'test-key',

  // Service worker → page
  COLLECT_PAGE: 'collect-page',
  PICK_ELEMENT: 'pick-element',
  ABORT_PICK: 'abort-pick',

  // Page → service worker
  ELEMENT_PICKED: 'element-picked',
  PICK_ABORTED: 'pick-aborted',

  // Service worker → side panel (over the streaming port)
  STATUS: 'status',
  AUDIT: 'audit',
  DELTA: 'delta',
  THINKING: 'thinking',
  DONE: 'done',
  ERROR: 'error',
};

/** The long-lived port the side panel opens to receive streamed answers. */
export const PORT_NAME = 'pantheon-copilot';
