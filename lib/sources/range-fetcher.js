/*
 * lib/sources/range-fetcher.js
 *
 * Fetch a byte range from a remote object over HTTP(S). Uses the global
 * fetch present in both the browser and Node 18+, which honors the Range
 * request header. s3:// and gs:// URLs are translated to their public HTTPS
 * endpoints. Anonymous/public access only in v1.
 */

export function translateUrl(rawUrl) {
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) return rawUrl;
  if (rawUrl.startsWith('s3://')) {
    const rest = rawUrl.slice('s3://'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) throw new Error('range-fetcher: malformed s3 url ' + rawUrl);
    return 'https://' + rest.slice(0, slash) + '.s3.amazonaws.com/' + rest.slice(slash + 1);
  }
  if (rawUrl.startsWith('gs://')) {
    const rest = rawUrl.slice('gs://'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) throw new Error('range-fetcher: malformed gs url ' + rawUrl);
    return 'https://storage.googleapis.com/' + rest.slice(0, slash) + '/' + rest.slice(slash + 1);
  }
  throw new Error('range-fetcher: unsupported URL scheme: ' + rawUrl);
}

/*
 * Total size of a remote object, in the order most likely to survive CORS.
 *
 * A browser can only read CORS-safelisted response headers unless the server
 * sends Access-Control-Expose-Headers. Content-Length is safelisted;
 * Content-Range and Accept-Ranges are not, and no public bucket tested exposes
 * them. So:
 *
 *   1. HEAD, whose Content-Length is the FULL size and is readable anywhere.
 *   2. Content-Range from a 1-byte GET, for hosts that forbid HEAD.
 *   3. Content-Length of that GET -- but ONLY on a 200. On a 206 it is the
 *      length of the returned range, which is 1. Trusting it there is what
 *      made a 139 MB file report itself as 1 byte in the browser.
 */
export async function remoteSize(rawUrl, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function')
    throw new Error('remoteSize: no fetch implementation available in this runtime');
  const url = translateUrl(rawUrl);

  try {
    const head = await fetchImpl(url, { method: 'HEAD' });
    const cl = Number(head.headers.get('content-length'));
    if (head.ok && Number.isFinite(cl) && cl > 0) return cl;
  } catch (_) {
    // HEAD may be disallowed, or blocked by CORS. Fall through.
  }

  const res = await fetchImpl(url, { headers: { Range: 'bytes=0-0' } });
  const cr = res.headers.get('content-range');
  const m = cr && /\/(\d+)\s*$/.exec(cr);
  if (m) return Number(m[1]);

  const cl = Number(res.headers.get('content-length'));
  if (res.status === 200 && Number.isFinite(cl) && cl > 0) return cl;

  throw new Error('remoteSize: cannot determine size of ' + url +
    ' (status ' + res.status + '; Content-Range not readable — if this is a ' +
    'browser, the server must send Access-Control-Expose-Headers: Content-Range)');
}

export async function fetchRange(rawUrl, offset, length, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function')
    throw new Error('range-fetcher: no fetch implementation available in this runtime');
  const url = translateUrl(rawUrl);
  const end = offset + length - 1;
  const res = await fetchImpl(url, { headers: { Range: 'bytes=' + offset + '-' + end } });
  if (res.status !== 206) {
    throw new Error('range-fetcher: expected 206 from ' + url +
      ' (Range ' + offset + '-' + end + '), got ' + res.status);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length !== length) {
    throw new Error('range-fetcher: short read from ' + url + ': expected ' +
      length + ' bytes, got ' + buf.length);
  }
  return buf;
}
