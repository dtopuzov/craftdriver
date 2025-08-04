// WebDriver virtual key codes (PUA) per W3C WebDriver spec
// Reference values are public spec constants; mapping implemented independently.

export const WebDriverKeyCodes: Record<string, string> = {
  null: '\uE000',
  cancel: '\uE001',
  help: '\uE002',
  backspace: '\uE003',
  tab: '\uE004',
  clear: '\uE005',
  return: '\uE006',
  enter: '\uE007',
  shift: '\uE008',
  control: '\uE009',
  alt: '\uE00A',
  pause: '\uE00B',
  escape: '\uE00C',
  space: '\uE00D',
  pageup: '\uE00E',
  pagedown: '\uE00F',
  end: '\uE010',
  home: '\uE011',
  arrowleft: '\uE012',
  left: '\uE012',
  arrowup: '\uE013',
  up: '\uE013',
  arrowright: '\uE014',
  right: '\uE014',
  arrowdown: '\uE015',
  down: '\uE015',
  insert: '\uE016',
  delete: '\uE017',
  semicolon: '\uE018',
  equals: '\uE019',

  numpad0: '\uE01A',
  numpad1: '\uE01B',
  numpad2: '\uE01C',
  numpad3: '\uE01D',
  numpad4: '\uE01E',
  numpad5: '\uE01F',
  numpad6: '\uE020',
  numpad7: '\uE021',
  numpad8: '\uE022',
  numpad9: '\uE023',
  multiply: '\uE024',
  add: '\uE025',
  separator: '\uE026',
  subtract: '\uE027',
  decimal: '\uE028',
  divide: '\uE029',

  f1: '\uE031',
  f2: '\uE032',
  f3: '\uE033',
  f4: '\uE034',
  f5: '\uE035',
  f6: '\uE036',
  f7: '\uE037',
  f8: '\uE038',
  f9: '\uE039',
  f10: '\uE03A',
  f11: '\uE03B',
  f12: '\uE03C',

  command: '\uE03D',
  meta: '\uE03D',
};

// Aliases mapping for common test-friendly names to canonical keys
const Aliases: Record<string, string> = {
  esc: 'escape',
  escape: 'escape',
  enter: 'enter',
  return: 'return',
  space: 'space',
  ' ': 'space',
  arrowleft: 'arrowleft',
  left: 'arrowleft',
  arrowup: 'arrowup',
  up: 'arrowup',
  arrowright: 'arrowright',
  right: 'arrowright',
  arrowdown: 'arrowdown',
  down: 'arrowdown',
  pageup: 'pageup',
  pagedown: 'pagedown',
  backspace: 'backspace',
  delete: 'delete',
  shift: 'shift',
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  meta: 'meta',
  command: 'command',
};

function normalizeName(name: string): string {
  return name.replace(/[_\-\s]/g, '').toLowerCase();
}

export type KeyValue = keyof typeof Key | string; // allow Key.* or single characters

// Public Key enum-like for consumer code: Key.Enter, Key.Escape, etc.
export const Key = {
  Null: WebDriverKeyCodes.null,
  Cancel: WebDriverKeyCodes.cancel,
  Help: WebDriverKeyCodes.help,
  Backspace: WebDriverKeyCodes.backspace,
  Tab: WebDriverKeyCodes.tab,
  Clear: WebDriverKeyCodes.clear,
  Return: WebDriverKeyCodes.return,
  Enter: WebDriverKeyCodes.enter,
  Shift: WebDriverKeyCodes.shift,
  Control: WebDriverKeyCodes.control,
  Alt: WebDriverKeyCodes.alt,
  Pause: WebDriverKeyCodes.pause,
  Escape: WebDriverKeyCodes.escape,
  Space: WebDriverKeyCodes.space,
  PageUp: WebDriverKeyCodes.pageup,
  PageDown: WebDriverKeyCodes.pagedown,
  End: WebDriverKeyCodes.end,
  Home: WebDriverKeyCodes.home,
  ArrowLeft: WebDriverKeyCodes.arrowleft,
  ArrowUp: WebDriverKeyCodes.arrowup,
  ArrowRight: WebDriverKeyCodes.arrowright,
  ArrowDown: WebDriverKeyCodes.arrowdown,
  Insert: WebDriverKeyCodes.insert,
  Delete: WebDriverKeyCodes.delete,
  F1: WebDriverKeyCodes.f1,
  F2: WebDriverKeyCodes.f2,
  F3: WebDriverKeyCodes.f3,
  F4: WebDriverKeyCodes.f4,
  F5: WebDriverKeyCodes.f5,
  F6: WebDriverKeyCodes.f6,
  F7: WebDriverKeyCodes.f7,
  F8: WebDriverKeyCodes.f8,
  F9: WebDriverKeyCodes.f9,
  F10: WebDriverKeyCodes.f10,
  F11: WebDriverKeyCodes.f11,
  F12: WebDriverKeyCodes.f12,
  Meta: WebDriverKeyCodes.meta,
} as const;

// Accept KeyValue and return the WebDriver key string to send.
export function getKeyValue(input: KeyValue): string {
  if (typeof input !== 'string') return String(input);
  if (!input) return input;
  if (input.length === 1) return input; // single character typed as-is
  const canonical = Aliases[normalizeName(input)] ?? normalizeName(input);
  return WebDriverKeyCodes[canonical] ?? input;
}
