import { config } from "zod";

/**
 * Turns off Zod's compiled object parsers. Zod builds them with `new Function`, and probes for
 * it while schemas are constructed, which a content security policy without 'unsafe-eval'
 * reports as a violation. Browsers (the web app and its game worker) import this module
 * before anything else that loads `@bgp/schema`; the server keeps the faster compiled parsers.
 */
config({ jitless: true });
