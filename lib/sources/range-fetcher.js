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
