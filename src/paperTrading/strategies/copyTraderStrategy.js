/**
 * Copy Trader Strategy - Universal Position Mirroring
 *
 * Copies ALL of gabagool22's crypto positions proportionally:
 * - BTC/ETH/SOL 15-minute markets (btc-updown-15m-TIMESTAMP)
 * - BTC/ETH hourly markets (bitcoin-up-or-down-february-5-2am-et)
 * - Any other active crypto up/down markets
 *
 * Default target: gabagool22 (0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d)
 */

import https from 'https';
import { BaseStrategy } from './baseStrategy.js';

export class CopyTraderStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('COPY_TRADER', {
      minConfidence: options.minConfidence || 0.55,
      cooldownMs: options.cooldownMs || 15000,
      ...options
    });

    // Target wallet to copy
    this.targetWallet = options.targetWallet || '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
    this.targetName = options.targetName || 'gabagool22';

    // Our trading balance for proportional sizing
    this.ourBalance = options.ourBalance || 500;

    // Minimum position value to copy
    this.minPositionValue = options.minPositionValue || 100;

    // Cache
    this.lastPositions = null;
    this.lastFetchTime = 0;
    this.cacheTTL = 8000;

    // Track signaled markets
    this.signaledMarkets = new Map();
  }

  /**
   * Fetch current positions for target wallet
   */
  async fetchPositions() {
    const now = Date.now();

    if (this.lastPositions && (now - this.lastFetchTime) < this.cacheTTL) {
      return this.lastPositions;
    }

    const url = `https://data-api.polymarket.com/positions?user=${this.targetWallet}`;

    return new Promise((resolve) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const positions = JSON.parse(data);
            this.lastPositions = positions;
            this.lastFetchTime = now;
            resolve(positions);
          } catch (e) {
            resolve(this.lastPositions || []);
          }
        });
      }).on('error', () => resolve(this.lastPositions || []));
    });
  }

  /**
   * Detect market type and asset from slug
   */
  parseMarketInfo(slug) {
    const slugLower = slug?.toLowerCase() || '';

    // Detect asset
    let asset = 'UNKNOWN';
    if (slugLower.includes('btc') || slugLower.includes('bitcoin')) asset = 'BTC';
    else if (slugLower.includes('eth') || slugLower.includes('ethereum')) asset = 'ETH';
    else if (slugLower.includes('sol') || slugLower.includes('solana')) asset = 'SOL';
    else if (slugLower.includes('xrp')) asset = 'XRP';
    else if (slugLower.includes('doge')) asset = 'DOGE';

    // Detect market type
    let marketType = 'unknown';
    let endTime = null;

    // 15-minute markets have timestamp in slug: btc-updown-15m-1770276600
    const timestampMatch = slugLower.match(/(\d{10})$/);
    if (timestampMatch) {
      marketType = '15m';
      endTime = parseInt(timestampMatch[1]) * 1000;
    }
    // Hourly markets: bitcoin-up-or-down-february-5-2am-et
    else if (slugLower.includes('up-or-down') && slugLower.match(/\d+am-et|\d+pm-et/)) {
      marketType = 'hourly';
      // Parse hour from slug like "february-5-2am-et"
      const hourMatch = slugLower.match(/(\d+)(am|pm)-et/);
      if (hourMatch) {
        let hour = parseInt(hourMatch[1]);
        if (hourMatch[2] === 'pm' && hour !== 12) hour += 12;
        if (hourMatch[2] === 'am' && hour === 12) hour = 0;

        // Create end time for today at that hour ET
        const now = new Date();
        const etOffset = -5 * 60; // ET is UTC-5
        const utcHour = hour + 5; // Convert ET to UTC
        endTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), utcHour, 0, 0).getTime();

        // If end time is in the past, it might be tomorrow's market or already resolved
        if (endTime < Date.now()) {
          endTime = null; // Will check using price instead
        }
      }
    }

    return { asset, marketType, endTime };
  }

  /**
   * Check if position is in an active (unresolved) market
   */
  isActivePosition(pos) {
    // If price is near 0 or 1, market is resolved
    const price = pos.curPrice;
    if (price <= 0.02 || price >= 0.98) {
      return false;
    }

    // If has meaningful value and not at extreme price, consider active
    if (pos.currentValue > 10) {
      return true;
    }

    return false;
  }

  /**
   * Find ALL active crypto up/down positions
   */
  findActiveCryptoPositions(positions) {
    return positions.filter(p => {
      const slug = p.slug?.toLowerCase() || '';

      // Must be a crypto up/down market
      const isCryptoUpDown = (
        slug.includes('updown') ||
        slug.includes('up-or-down')
      ) && (
        slug.includes('btc') ||
        slug.includes('bitcoin') ||
        slug.includes('eth') ||
        slug.includes('ethereum') ||
        slug.includes('sol') ||
        slug.includes('solana')
      );

      if (!isCryptoUpDown) return false;

      // Must be active (not resolved)
      return this.isActivePosition(p);
    });
  }

  /**
   * Group positions by market
   */
  groupPositionsByMarket(positions) {
    const markets = {};

    for (const pos of positions) {
      const conditionId = pos.conditionId;
      const marketInfo = this.parseMarketInfo(pos.slug);

      if (!markets[conditionId]) {
        markets[conditionId] = {
          slug: pos.slug,
          asset: marketInfo.asset,
          marketType: marketInfo.marketType,
          endTime: marketInfo.endTime,
          conditionId,
          up: null,
          down: null
        };
      }

      if (pos.outcome === 'Up') {
        markets[conditionId].up = pos;
      } else if (pos.outcome === 'Down') {
        markets[conditionId].down = pos;
      }
    }

    return Object.values(markets);
  }

  /**
   * Calculate position details for a market
   */
  calculateMarketPosition(market) {
    const upValue = market.up?.currentValue || 0;
    const downValue = market.down?.currentValue || 0;
    const totalValue = upValue + downValue;

    if (totalValue < this.minPositionValue) {
      return null;
    }

    const upPercent = (upValue / totalValue) * 100;
    const downPercent = (downValue / totalValue) * 100;

    const dominantSide = upPercent >= downPercent ? 'UP' : 'DOWN';
    const dominantPercent = Math.max(upPercent, downPercent);

    // Proportional sizes for our balance
    const ourUpSize = (upPercent / 100) * this.ourBalance;
    const ourDownSize = (downPercent / 100) * this.ourBalance;

    // Confidence based on bias (50/50 = 0.55, 100/0 = 0.80)
    const confidence = Math.min(0.80, 0.55 + (dominantPercent - 50) * 0.005);

    return {
      slug: market.slug,
      asset: market.asset,
      marketType: market.marketType,
      endTime: market.endTime,
      upValue,
      downValue,
      totalValue,
      upPercent,
      downPercent,
      dominantSide,
      dominantPercent,
      ourUpSize,
      ourDownSize,
      confidence
    };
  }

  /**
   * Main analysis function
   */
  async analyze(data) {
    try {
      const positions = await this.fetchPositions();

      if (!positions || positions.length === 0) {
        return null;
      }

      // Find ALL active crypto positions
      const activeCryptoPositions = this.findActiveCryptoPositions(positions);

      if (activeCryptoPositions.length === 0) {
        return null;
      }

      // Group by market
      const markets = this.groupPositionsByMarket(activeCryptoPositions);

      if (markets.length === 0) {
        return null;
      }

      // Sort by total value (largest first) - copy biggest positions first
      markets.sort((a, b) => {
        const aTotal = (a.up?.currentValue || 0) + (a.down?.currentValue || 0);
        const bTotal = (b.up?.currentValue || 0) + (b.down?.currentValue || 0);
        return bTotal - aTotal;
      });

      const now = Date.now();

      // Find best market to signal
      for (const market of markets) {
        const position = this.calculateMarketPosition(market);

        if (!position) continue;

        // Need at least 55% bias for clear direction
        if (position.dominantPercent < 55) continue;

        // Check if already signaled this market/side
        const marketKey = position.slug;
        const prevSignal = this.signaledMarkets.get(marketKey);

        if (prevSignal && prevSignal.side === position.dominantSide) {
          continue; // Already signaled
        }

        // Record signal
        this.signaledMarkets.set(marketKey, {
          side: position.dominantSide,
          timestamp: now
        });

        // Cleanup old entries
        if (this.signaledMarkets.size > 30) {
          const entries = Array.from(this.signaledMarkets.entries());
          entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
          for (let i = 0; i < entries.length - 30; i++) {
            this.signaledMarkets.delete(entries[i][0]);
          }
        }

        return {
          side: position.dominantSide,
          confidence: position.confidence,
          signals: {
            strategy: 'COPY_TRADER',
            trader: this.targetName,
            asset: position.asset,
            marketType: position.marketType,
            market: position.slug,
            targetUpValue: position.upValue.toFixed(2),
            targetDownValue: position.downValue.toFixed(2),
            targetTotalValue: position.totalValue.toFixed(2),
            targetUpPercent: position.upPercent.toFixed(1),
            targetDownPercent: position.downPercent.toFixed(1),
            ourUpSize: position.ourUpSize.toFixed(2),
            ourDownSize: position.ourDownSize.toFixed(2),
            dominantSide: position.dominantSide,
            dominantPercent: position.dominantPercent.toFixed(1)
          }
        };
      }

      return null;
    } catch (error) {
      console.error(`CopyTrader error: ${error.message}`);
      return null;
    }
  }

  /**
   * Get detailed status
   */
  async getStatus() {
    const positions = await this.fetchPositions();
    const activeCrypto = this.findActiveCryptoPositions(positions);
    const markets = this.groupPositionsByMarket(activeCrypto);
    const marketDetails = markets.map(m => this.calculateMarketPosition(m)).filter(Boolean);

    return {
      name: this.name,
      targetWallet: this.targetWallet,
      targetName: this.targetName,
      ourBalance: this.ourBalance,
      totalPositions: positions?.length || 0,
      activeCryptoPositions: activeCrypto.length,
      activeMarkets: marketDetails.length,
      markets: marketDetails,
      signaledCount: this.signaledMarkets.size
    };
  }

  resetSignalTracking() {
    this.signaledMarkets.clear();
  }
}

export default CopyTraderStrategy;
