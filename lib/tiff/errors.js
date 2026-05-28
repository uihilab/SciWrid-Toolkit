// lib/tiff/errors.js
//
// Typed errors thrown by the TIFF reader. UnsupportedCRSError is new;
// the rest are re-exported from the shared error module.

import { WebparsersError } from '../errors.js';

export class UnsupportedCRSError extends WebparsersError {
  constructor(message, { epsg, crsName } = {}) {
    super(message);
    this.name = 'UnsupportedCRSError';
    this.epsg = epsg;
    this.crsName = crsName;
  }
}
