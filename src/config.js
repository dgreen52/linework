// Single source of truth for product naming. Rename the app here. The version lives in version.js.
import './version.js';

export const APP_NAME = 'Linework';
export const APP_VERSION = globalThis.LINEWORK_VERSION;
export const APP_TAGLINE = 'Open-source CAD drawing viewer & markup';
// Bump when the markup sidecar schema changes (see MARKUP_FORMAT.md).
export const MARKUP_SCHEMA = 'linework-markup';
export const MARKUP_VERSION = 1;
