/**
 * HTTP Client for Node.js < 18
 * Uses native https module for compatibility
 */

import https from 'https';
import http from 'http';

/**
 * Simple fetch-like function using native Node.js modules
 */
export function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PolymarketBot/1.0',
        ...(options.headers || {})
      },
      timeout: options.timeout || 30000
    };

    const req = lib.request(requestOptions, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

/**
 * Fetch Binance klines
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @param {string} interval - Candle interval (e.g., '1m', '5m', '1h')
 * @param {number} limit - Number of candles to fetch
 * @param {number} startTime - Optional start time in milliseconds
 */
export async function fetchBinanceKlines(symbol, interval, limit, startTime = null) {
  let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  if (startTime) {
    url += `&startTime=${startTime}`;
  }
  const data = await fetchJson(url);

  return data.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6]
  }));
}

/**
 * Fetch Binance last price
 */
export async function fetchBinanceLastPrice(symbol = 'BTCUSDT') {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
  const data = await fetchJson(url);
  return parseFloat(data.price);
}

/**
 * Fetch Polymarket events
 */
export async function fetchPolymarketEvents(seriesId, limit = 10) {
  const url = `https://gamma-api.polymarket.com/events?series_id=${seriesId}&active=true&closed=false&limit=${limit}`;
  const data = await fetchJson(url);
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch Polymarket order book
 */
export async function fetchPolymarketOrderBook(tokenId) {
  const url = `https://clob.polymarket.com/book?token_id=${tokenId}`;
  return await fetchJson(url);
}

/**
 * Fetch Polymarket live price for a token
 * This is the CORRECT endpoint for real-time prices
 * @param {string} tokenId - The token ID
 * @param {string} side - 'BUY' or 'SELL'
 * @returns {Promise<number>} - The price as a decimal (e.g., 0.35 = 35 cents)
 */
export async function fetchPolymarketPrice(tokenId, side = 'BUY') {
  const url = `https://clob.polymarket.com/price?token_id=${tokenId}&side=${side}`;
  const data = await fetchJson(url);
  return parseFloat(data.price);
}
