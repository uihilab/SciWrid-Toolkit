import { gridToJSON } from '../grid-output.js';

/* pretty stays undefined-by-default: extractGridOutput('json') has always
 * produced compact JSON, and this layer must not change that. */
export function encodeGridJSON(grid, opts = {}) {
  return gridToJSON(grid, { pretty: opts.pretty });
}

/* Matches extractOutput('json'): the result object, pretty-printed. */
export function encodeSeriesJSON(result) {
  return JSON.stringify(result, null, 2);
}
