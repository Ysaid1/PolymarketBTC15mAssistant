/**
 * Strategy Index
 * Export all trading strategies
 */

export { BaseStrategy } from './baseStrategy.js';
export { MomentumStrategy } from './momentumStrategy.js';
export { MeanReversionStrategy } from './meanReversionStrategy.js';
export { VolatilityBreakoutStrategy } from './volatilityBreakoutStrategy.js';
export { RSIStrategy } from './rsiStrategy.js';
export { MACDStrategy } from './macdStrategy.js';

/**
 * Create all strategies with default configuration
 */
export function createAllStrategies(options = {}) {
  return [
    new (await import('./momentumStrategy.js')).MomentumStrategy(options.momentum),
    new (await import('./meanReversionStrategy.js')).MeanReversionStrategy(options.meanReversion),
    new (await import('./volatilityBreakoutStrategy.js')).VolatilityBreakoutStrategy(options.volatilityBreakout),
    new (await import('./rsiStrategy.js')).RSIStrategy(options.rsi),
    new (await import('./macdStrategy.js')).MACDStrategy(options.macd)
  ];
}
