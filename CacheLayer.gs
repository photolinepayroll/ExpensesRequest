/**
 * CacheService layer for read-heavy, rarely-changing sheets.
 *
 * - Values are JSON, split into chunks (CacheService caps one value at 100KB).
 * - Each cached sheet has a version token. A reader captures the token before it reads the
 *   sheet and stores the result under that version; a writer bumps the token. A reader that
 *   raced a writer therefore stores under a dead version and is never served.
 * - Any cache failure falls back to reading the sheet directly — the cache is only an
 *   optimization, never a source of truth.
 * - Dates come back from the cache as ISO strings (JSON round trip); callers already wrap
 *   date fields with new Date(...).
 *
 * Requests / RequestLines are deliberately NOT cached: approval decisions (status, routing,
 * recompute) must always read fresh data.
 */

var CACHE_CHUNK_CHARS_ = 30000; // well under 100KB even at 3 bytes/char (UTF-8)
var CACHE_VERSION_TTL_SECONDS_ = 21600; // CacheService max (6h)

// Sheets served from cache, and for how long (seconds). Employees/Approvers have no app-level
// writes (hand-edited in the Sheet), so TTL is what bounds staleness; Approvers holds
// passwords so it gets the shorter TTL. SubmissionExemptions is also invalidated on every write.
// Built lazily (not at load time) because Apps Script loads files in project order, so
// Config.gs's SHEET_* constants may not exist yet when this file's top level runs.
function cacheableSheetTtls_() {
  var ttls = {};
  ttls[SHEET_EMPLOYEES] = 300;
  ttls[SHEET_APPROVERS] = 120;
  ttls[SHEET_SUBMISSION_EXEMPTIONS] = 30;
  return ttls;
}

function cachePutChunked_(key, value, ttlSeconds) {
  var cache = CacheService.getScriptCache();
  var json = JSON.stringify(value);
  var chunkCount = Math.max(1, Math.ceil(json.length / CACHE_CHUNK_CHARS_));
  var entries = {};
  for (var i = 0; i < chunkCount; i++) {
    entries[key + ':' + i] = json.substring(i * CACHE_CHUNK_CHARS_, (i + 1) * CACHE_CHUNK_CHARS_);
  }
  entries[key + ':meta'] = String(chunkCount);
  cache.putAll(entries, ttlSeconds);
}

/** Returns the cached value, or null on a miss / incomplete / corrupt entry. */
function cacheGetChunked_(key) {
  var cache = CacheService.getScriptCache();
  var meta = cache.get(key + ':meta');
  if (!meta) return null;
  var chunkCount = Number(meta);
  var keys = [];
  for (var i = 0; i < chunkCount; i++) keys.push(key + ':' + i);
  var got = cache.getAll(keys);
  var json = '';
  for (var j = 0; j < chunkCount; j++) {
    var part = got[key + ':' + j];
    if (part === undefined || part === null) return null; // a chunk was evicted
    json += part;
  }
  try {
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function getSheetCacheVersion_(sheetName) {
  var cache = CacheService.getScriptCache();
  var key = 'ver:' + sheetName;
  var ver = cache.get(key);
  if (!ver) {
    ver = String(new Date().getTime()) + '-' + Math.floor(Math.random() * 1e9);
    cache.put(key, ver, CACHE_VERSION_TTL_SECONDS_);
  }
  return ver;
}

/** Drops every cached copy of a sheet (new version token). Call after any write to it. */
function invalidateSheetCache_(sheetName) {
  if (!cacheableSheetTtls_()[sheetName]) return;
  try {
    var ver = String(new Date().getTime()) + '-' + Math.floor(Math.random() * 1e9);
    CacheService.getScriptCache().put('ver:' + sheetName, ver, CACHE_VERSION_TTL_SECONDS_);
  } catch (e) {
    Logger.log('invalidateSheetCache_ failed for ' + sheetName + ': ' + e.message);
  }
}

/** Cached rows for a cacheable sheet; loader() reads the sheet directly. Falls back to loader() on any cache error. */
function getCachedRows_(sheetName, loader) {
  var ttl = cacheableSheetTtls_()[sheetName];
  try {
    var ver = getSheetCacheVersion_(sheetName);
    var key = 'rows:' + sheetName + ':' + ver;
    var cached = cacheGetChunked_(key);
    if (cached) return cached;
    var rows = loader();
    try {
      cachePutChunked_(key, rows, ttl);
    } catch (putErr) {
      Logger.log('Cache put failed for ' + sheetName + ': ' + putErr.message);
    }
    return rows;
  } catch (e) {
    Logger.log('Cache read failed for ' + sheetName + ', reading sheet directly: ' + e.message);
    return loader();
  }
}

/** Run from the Apps Script editor after hand-editing Employees/Approvers to make the change show immediately. */
function clearAllCaches_() {
  Object.keys(cacheableSheetTtls_()).forEach(invalidateSheetCache_);
  CacheService.getScriptCache().remove(STORE_DIRECTORY_CACHE_KEY + ':meta');
  Logger.log('Caches cleared.');
}
