/* DOM shim for the extracted core: extractTextFromHtml() calls
   `new DOMParser()` the way the browser app does. linkedom's DOMParser
   never executes scripts — pure text extraction, same as the app.
   Imported before the core so the global exists at call time. */
import { DOMParser } from 'linkedom';

if (!globalThis.DOMParser) globalThis.DOMParser = DOMParser;
