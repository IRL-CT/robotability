#!/usr/bin/env node
// T14 performance gates. The script checks the built site in dist/.
// It runs three gates and exits non-zero when any gate fails.
//
// Gate A: no single static asset in dist/ exceeds 1 MB. PMTiles files
//         are the only exception. They stream by range requests.
// Gate B: the built home page ships less than 300 KB of gzipped JS.
//         The script sums every local JS chunk that dist/index.html
//         references (script src and modulepreload href).
// Gate C: the /map page never requests the legacy GeoJSON files and
//         transfers less than 3 MB before first interactive.
//
// The script starts its own preview server on port 4391. The port sits
// in the 4390-4399 range reserved for manually started servers.
// Run `pnpm build` before this script.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { chromium } from '@playwright/test';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(scriptDir, '..', '..');
const distDir = path.join(rootDir, 'dist');

const PORT = 4391;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ONE_MB = 1024 * 1024;
const HOME_JS_BUDGET = 300 * 1024; // 300 KB gzipped.
const TRANSFER_BUDGET = 3 * ONE_MB; // 3 MB before first interactive.
// The network silence window for the stable-idle marker. See gate C.
const IDLE_WINDOW_MS = 2000;

// The gate results. The script prints one line per gate and exits with
// a non-zero code when one entry stays false.
const results = {
  assetSize: false,
  homeJs: false,
  network: false,
};

// ---------------------------------------------------------------------
// Gate A. Walk dist/ and check every file size.
// ---------------------------------------------------------------------

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function gateAssetSize() {
  console.log('--- Gate A: static asset sizes in dist/ ---');
  if (!fs.existsSync(distDir)) {
    console.log('FAIL: dist/ does not exist. Run `pnpm build` first.');
    return false;
  }
  const violations = [];
  let largest = { file: '', bytes: 0 };
  for (const file of walk(distDir)) {
    const bytes = fs.statSync(file).size;
    const rel = path.relative(distDir, file);
    if (bytes > largest.bytes) largest = { file: rel, bytes };
    if (bytes > ONE_MB && !file.endsWith('.pmtiles')) {
      violations.push({ file: rel, bytes });
    }
  }
  console.log(
    `Largest file: ${largest.file} (${(largest.bytes / ONE_MB).toFixed(2)} MB).`
  );
  if (violations.length > 0) {
    for (const item of violations) {
      console.log(`FAIL: ${item.file} is ${(item.bytes / ONE_MB).toFixed(2)} MB. Limit is 1 MB.`);
    }
    return false;
  }
  console.log('PASS: every non-PMTiles asset is at most 1 MB.');
  return true;
}

// ---------------------------------------------------------------------
// Gate B. Sum the gzipped JS that the built home page references.
// ---------------------------------------------------------------------

function gateHomeJs() {
  console.log('--- Gate B: home page JS budget (300 KB gzipped) ---');
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    console.log('FAIL: dist/index.html does not exist. Run `pnpm build` first.');
    return false;
  }
  const html = fs.readFileSync(indexPath, 'utf8');
  // Collect local URLs from script src and modulepreload href attributes.
  const urls = new Set();
  const pattern = /(?:<script[^>]+\bsrc|<link[^>]+\bhref)="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const url = match[1];
    if (!url.startsWith('/')) continue; // Skip remote URLs.
    if (!url.endsWith('.js')) continue; // Count JS chunks only.
    urls.add(url);
  }
  let gzipTotal = 0;
  let rawTotal = 0;
  for (const url of [...urls].sort()) {
    const file = path.join(distDir, url.slice(1));
    if (!fs.existsSync(file)) {
      console.log(`FAIL: index.html references ${url} but the file is missing.`);
      return false;
    }
    const raw = fs.readFileSync(file);
    const gzipped = zlib.gzipSync(raw);
    rawTotal += raw.byteLength;
    gzipTotal += gzipped.byteLength;
    console.log(
      `  ${url}: raw ${(raw.byteLength / 1024).toFixed(1)} KB, gzip ${(gzipped.byteLength / 1024).toFixed(1)} KB`
    );
  }
  console.log(
    `Total: raw ${(rawTotal / 1024).toFixed(1)} KB, gzip ${(gzipTotal / 1024).toFixed(1)} KB. Budget ${(HOME_JS_BUDGET / 1024).toFixed(0)} KB gzipped.`
  );
  if (gzipTotal >= HOME_JS_BUDGET) {
    console.log('FAIL: the home page JS exceeds the gzipped budget.');
    return false;
  }
  console.log('PASS: the home page JS fits the budget.');
  return true;
}

// ---------------------------------------------------------------------
// Gate C. The /map network log.
//
// First-interactive marker. The script waits for the map hook to report
// a loaded style, a segments layer, and at least one rendered segment
// feature. That moment is MAP_READY: the user sees scored segments and
// can interact. The script then waits for one network silence window
// (IDLE_WINDOW_MS with zero new responses). The end of that window is
// STABLE_IDLE. It proves every load-time request finished. The total
// transfer counts every response body received up to STABLE_IDLE.
// ---------------------------------------------------------------------

function waitForServer(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`The preview server did not answer at ${url}.`));
        return;
      }
      setTimeout(attempt, 500);
    };
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });
      request.on('error', retry);
    };
    attempt();
  });
}

function startPreviewServer() {
  const astroBin = path.join(rootDir, 'node_modules', '.bin', 'astro');
  const child = spawn(astroBin, ['preview', '--host', '127.0.0.1', '--port', String(PORT)], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('error', (error) => {
    console.log(`FAIL: the preview server did not start: ${error.message}`);
  });
  return {
    child,
    stderr: () => stderr,
  };
}

async function gateNetwork() {
  console.log('--- Gate C: /map network log ---');
  const server = startPreviewServer();
  let browser;
  try {
    await waitForServer(`${BASE_URL}/map`, 60_000);
  } catch (error) {
    const stderr = server.stderr();
    if (/EADDRINUSE|address in use|Port \d+ is already in use/i.test(stderr)) {
      console.log(`FAIL: port ${PORT} is already in use. Free it and retry.`);
    } else {
      console.log(`FAIL: ${error.message}`);
    }
    server.child.kill('SIGTERM');
    return false;
  }

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // One entry per response. The byte count uses the response body.
    // The preview server sends no compression, so the body bytes equal
    // the wire bytes. blob: and data: URLs are not network transfers.
    // The browser builds them in memory, so the total skips them.
    const responses = [];
    const requestUrls = [];
    page.on('request', (request) => {
      requestUrls.push(request.url());
    });
    page.on('response', async (response) => {
      const url = response.url();
      const networkUrl = !url.startsWith('blob:') && !url.startsWith('data:');
      const entry = { url, bytes: 0, at: Date.now(), network: networkUrl };
      responses.push(entry);
      if (!networkUrl) return;
      try {
        const body = await response.body();
        entry.bytes = body.byteLength;
      } catch {
        // Streamed or aborted responses fall back to content-length.
        const header = response.headers()['content-length'];
        entry.bytes = header ? Number.parseInt(header, 10) || 0 : 0;
      }
    });

    const navStart = Date.now();
    await page.goto(`${BASE_URL}/map`, { waitUntil: 'domcontentloaded' });

    // MAP_READY: the user sees scored segments and can interact.
    await page.waitForFunction(
      () => {
        const map = window.__robotabilityMap;
        return (
          !!map &&
          map.isStyleLoaded() &&
          !!map.getLayer('segments') &&
          map.queryRenderedFeatures({ layers: ['segments'] }).length > 0
        );
      },
      undefined,
      { timeout: 60_000 }
    );
    const readyAt = Date.now();

    // STABLE_IDLE: one silence window with zero new responses.
    let lastCount = responses.length;
    let silenceStart = Date.now();
    while (Date.now() - silenceStart < IDLE_WINDOW_MS) {
      // Poll every 100 ms. A new response restarts the silence window.
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (responses.length !== lastCount) {
        lastCount = responses.length;
        silenceStart = Date.now();
      }
    }
    const idleAt = Date.now();

    // The transfer total counts every network response before STABLE_IDLE.
    let totalBytes = 0;
    for (const entry of responses) {
      if (entry.at <= idleAt && entry.network) totalBytes += entry.bytes;
    }

    // The legacy GeoJSON files must never appear in any request URL.
    const banned = requestUrls.filter(
      (url) => url.includes('sidewalks.geojson') || url.includes('census.geojson')
    );

    console.log(`Requests sent: ${requestUrls.length}.`);
    console.log(`Responses received up to STABLE_IDLE: ${responses.filter((entry) => entry.at <= idleAt).length}.`);
    console.log(`MAP_READY at +${readyAt - navStart} ms; STABLE_IDLE at +${idleAt - navStart} ms (${IDLE_WINDOW_MS} ms silence window).`);
    console.log(`Total transfer before first interactive: ${(totalBytes / ONE_MB).toFixed(2)} MB. Budget ${(TRANSFER_BUDGET / ONE_MB).toFixed(0)} MB.`);
    for (const entry of responses.filter((item) => item.at <= idleAt)) {
      const short = entry.url.length > 110 ? `${entry.url.slice(0, 110)}…` : entry.url;
      console.log(`  ${(entry.bytes / 1024).toFixed(1).padStart(9)} KB  ${short}`);
    }

    if (banned.length > 0) {
      for (const url of banned) {
        console.log(`FAIL: a banned request appeared: ${url}`);
      }
      return false;
    }
    console.log('PASS: no request names sidewalks.geojson or census.geojson.');
    if (totalBytes >= TRANSFER_BUDGET) {
      console.log('FAIL: the transfer before first interactive exceeds 3 MB.');
      return false;
    }
    console.log('PASS: the transfer before first interactive fits the 3 MB budget.');
    return true;
  } catch (error) {
    console.log(`FAIL: the network gate crashed: ${String(error)}`);
    return false;
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------

results.assetSize = gateAssetSize();
results.homeJs = gateHomeJs();
results.network = await gateNetwork();

console.log('--- Summary ---');
console.log(`Gate A (asset sizes):        ${results.assetSize ? 'PASS' : 'FAIL'}`);
console.log(`Gate B (home JS budget):     ${results.homeJs ? 'PASS' : 'FAIL'}`);
console.log(`Gate C (map network budget): ${results.network ? 'PASS' : 'FAIL'}`);

const allPass = results.assetSize && results.homeJs && results.network;
process.exit(allPass ? 0 : 1);
