import { env } from 'cloudflare:workers';
import { Compression, EtagMismatch, PMTiles, RangeResponse, ResolvedValueCache, Source, TileType } from './shared2';
import { pmtiles_path, tileJSON, tile_path } from './shared';

const ALLOWED_ORIGINS = new Set(
  (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const ALLOW_ANY_ORIGIN = ALLOWED_ORIGINS.has('*');

function getAllowedOrigin(origin: string | null): string {
  if (ALLOW_ANY_ORIGIN) return '*';
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : '';
}

const CACHE_CONTROL_HEADER = `max-age=${env.CACHE_MAX_AGE || 86400}`;

const SPRITE_PATHS = new Set(['sprite.json', 'sprite@2x.json', 'sprite.png', 'sprite@2x.png']);

class KeyNotFoundError extends Error {}

async function nativeDecompress(buf: ArrayBuffer, compression: Compression): Promise<ArrayBuffer> {
  if (compression === Compression.None || compression === Compression.Unknown) {
    return buf;
  }
  if (compression === Compression.Gzip) {
    const stream = new Response(buf).body;
    const result = stream?.pipeThrough(new DecompressionStream('gzip'));
    return new Response(result).arrayBuffer();
  }
  throw Error('Compression method not supported');
}

const CACHE = new ResolvedValueCache(25, undefined, nativeDecompress);

class R2Source implements Source {
  archiveName: string;

  constructor(archiveName: string) {
    this.archiveName = archiveName;
  }

  getKey() {
    return this.archiveName;
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    const resp = await env.BUCKET.get(pmtiles_path(this.archiveName, env.PMTILES_PATH), {
      range: { offset: offset, length: length },
      onlyIf: { etagMatches: etag },
    });
    if (!resp) {
      throw new KeyNotFoundError('Archive not found');
    }

    const o = resp as R2ObjectBody;

    if (!o.body) {
      throw new EtagMismatch();
    }

    const a = await o.arrayBuffer();
    return {
      data: a,
      etag: o.etag,
      cacheControl: o.httpMetadata?.cacheControl,
      expires: o.httpMetadata?.cacheExpiry?.toISOString(),
    };
  }
}

const PMTILES_BY_NAME = new Map<string, PMTiles>();
const MAX_PMTILES_INSTANCES = 50;

function getPMTiles(name: string): PMTiles {
  let p = PMTILES_BY_NAME.get(name);
  if (p) {
    PMTILES_BY_NAME.delete(name);
    PMTILES_BY_NAME.set(name, p);
    return p;
  }
  p = new PMTiles(new R2Source(name), CACHE, nativeDecompress);
  PMTILES_BY_NAME.set(name, p);
  if (PMTILES_BY_NAME.size > MAX_PMTILES_INSTANCES) {
    const lru = PMTILES_BY_NAME.keys().next().value;
    if (lru !== undefined) PMTILES_BY_NAME.delete(lru);
  }
  return p;
}

function cacheHitResponse(cached: Response, allowedOrigin: string): Response {
  const resp = new Response(cached.body, cached);
  if (allowedOrigin) resp.headers.set('Access-Control-Allow-Origin', allowedOrigin);
  resp.headers.set('Vary', 'Origin');
  resp.headers.set('X-Worker-Cache', 'HIT');
  return resp;
}

export default {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'GET') return new Response(undefined, { status: 405 });

    const allowedOrigin = getAllowedOrigin(request.headers.get('Origin'));

    const url = new URL(request.url);
    const cache = caches.default;

    const cacheableResponse = (body: ArrayBuffer | string | undefined, cacheableHeaders: Headers, status: number) => {
      cacheableHeaders.set('Cache-Control', CACHE_CONTROL_HEADER);
      const cacheable = new Response(body, {
        headers: cacheableHeaders,
        status: status,
      });

      ctx.waitUntil(cache.put(request.url, cacheable));

      const respHeaders = new Headers(cacheableHeaders);
      if (allowedOrigin) respHeaders.set('Access-Control-Allow-Origin', allowedOrigin);
      respHeaders.set('Vary', 'Origin');
      respHeaders.set('X-Worker-Cache', 'MISS');
      return new Response(body, { headers: respHeaders, status: status });
    };

    if (SPRITE_PATHS.has(url.pathname.split('/').pop() || '')) {
      // Serve these direct from the bucket or cache
      const cached = await cache.match(request.url);

      if (cached) {
        return cacheHitResponse(cached, allowedOrigin);
      }

      // Rip from R2 bucket
      const bucketKey = decodeURIComponent(url.pathname).slice(1);
      const resp = await env.BUCKET.get(bucketKey);
      if (!resp) {
        return new Response('Sprites not found', { status: 404 });
      }

      const o = resp as R2ObjectBody;
      const a = await o.arrayBuffer();
      const cacheableHeaders = new Headers();
      cacheableHeaders.set('Cache-Control', CACHE_CONTROL_HEADER);
      cacheableHeaders.set(
        'Content-Type',
        o.httpMetadata?.contentType || (url.pathname.endsWith('.json') ? 'application/json' : 'image/png'),
      );
      cacheableHeaders.set('ETag', o.etag);

      return cacheableResponse(a, cacheableHeaders, 200);
    }

    if (url.pathname.startsWith('/font/')) {
      // Serve these direct from the bucket or cache
      const cached = await cache.match(request.url);

      if (cached) {
        return cacheHitResponse(cached, allowedOrigin);
      }

      // Rip from R2 bucket
      const bucketKey = decodeURIComponent(url.pathname).slice(1);
      const resp = await env.BUCKET.get(bucketKey);

      if (!resp) {
        return new Response('Font not found', { status: 404 });
      }

      const o = resp as R2ObjectBody;
      const a = await o.arrayBuffer();
      const cacheableHeaders = new Headers();
      cacheableHeaders.set('Cache-Control', CACHE_CONTROL_HEADER);
      cacheableHeaders.set('Content-Type', 'application/x-protobuf');
      // pregzipped
      cacheableHeaders.set('Content-Encoding', 'gzip');
      cacheableHeaders.set('ETag', o.etag);

      return cacheableResponse(a, cacheableHeaders, 200);
    }

    const { ok, name, tile, ext } = tile_path(url.pathname);

    if (ok) {
      const cached = await cache.match(request.url);
      if (cached) {
        return cacheHitResponse(cached, allowedOrigin);
      }

      const cacheableHeaders = new Headers();
      const p = getPMTiles(name);
      try {
        const pHeader = await p.getHeader();

        if (!tile) {
          cacheableHeaders.set('Content-Type', 'application/json');

          const t = tileJSON(pHeader, await p.getMetadata(), env.PUBLIC_HOSTNAME || url.hostname, name);

          return cacheableResponse(JSON.stringify(t), cacheableHeaders, 200);
        }

        if (tile[0] < pHeader.minZoom || tile[0] > pHeader.maxZoom) {
          return cacheableResponse(undefined, cacheableHeaders, 404);
        }

        for (const pair of [
          [TileType.Mvt, 'mvt'],
          [TileType.Png, 'png'],
          [TileType.Jpeg, 'jpg'],
          [TileType.Webp, 'webp'],
          [TileType.Avif, 'avif'],
          [TileType.Mlt, 'mlt'],
        ]) {
          if (pHeader.tileType === pair[0] && ext !== pair[1]) {
            if (pHeader.tileType === TileType.Mvt && ext === 'pbf') {
              // allow this for now. Eventually we will delete this in favor of .mvt
              continue;
            }
            return cacheableResponse(`Bad request: requested .${ext} but archive has type .${pair[1]}`, cacheableHeaders, 400);
          }
        }

        const tiledata = await p.getZxy(tile[0], tile[1], tile[2]);

        switch (pHeader.tileType) {
          case TileType.Mvt:
            cacheableHeaders.set('Content-Type', 'application/x-protobuf');
            break;
          case TileType.Png:
            cacheableHeaders.set('Content-Type', 'image/png');
            break;
          case TileType.Jpeg:
            cacheableHeaders.set('Content-Type', 'image/jpeg');
            break;
          case TileType.Webp:
            cacheableHeaders.set('Content-Type', 'image/webp');
            break;
          case TileType.Avif:
            cacheableHeaders.set('Content-Type', 'image/avif');
            break;
          case TileType.Mlt:
            cacheableHeaders.set('Content-Type', 'application/vnd.maplibre-tile');
            break;
        }

        if (tiledata) {
          return cacheableResponse(tiledata.data, cacheableHeaders, 200);
        }
        return cacheableResponse(undefined, cacheableHeaders, 204);
      } catch (e) {
        if (e instanceof KeyNotFoundError) {
          return cacheableResponse('Archive not found', cacheableHeaders, 404);
        }
        throw e;
      }
    }

    return new Response('Invalid URL', { status: 404 });
  },
};
