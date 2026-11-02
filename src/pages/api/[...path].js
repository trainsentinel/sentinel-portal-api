// All /api/* requests go to the shared handler. Nothing here is prerendered.
import { handle } from '../../lib/core.js';
export const prerender = false;

function envFrom(locals) {
  return (locals && locals.runtime && locals.runtime.env) || {};
}
export const ALL = ({ request, locals }) => handle(request, envFrom(locals));
