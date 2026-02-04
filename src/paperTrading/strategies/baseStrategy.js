/**
 * Base Strategy Class
 * All strategies inherit from this base class
 */

export class BaseStrategy {
  constructor(name, options = {}) {
    this.name = name;
    this.enabled = options.enabled !== false;
    this.minConfidence = options.minConfidence || 0.55;
    this.cooldownMs = options.cooldownMs || 60000; // 1 min between trades
    this.lastTradeTime = 0;
    this.simulatedTime = null; // For backtesting
    this.parameters = {};

    // Regime compatibility - override in child classes
    // Valid regimes: TREND_UP, TREND_DOWN, RANGE, CHOP
    this.regimeCompatibility = options.regimeCompatibility || ['TREND_UP', 'TREND_DOWN', 'RANGE', 'CHOP'];
    this.riskLevel = options.riskLevel || 'medium'; // low, medium, high
  }

  /**
   * Check if strategy is compatible with current regime
   */
  isCompatibleWithRegime(regime) {
    return this.regimeCompatibility.includes(regime);
  }

  /**
   * Set simulated time for backtesting
   */
  setSimulatedTime(timestamp) {
    this.simulatedTime = timestamp;
  }

  /**
   * Get current time (real or simulated)
   */
  getCurrentTime() {
    return this.simulatedTime !== null ? this.simulatedTime : Date.now();
  }

  /**
   * Check if strategy is ready to trade
   */
  canTrade() {
    if (!this.enabled) return false;
    const now = this.getCurrentTime();
    return now - this.lastTradeTime >= this.cooldownMs;
  }

  /**
   * Record that a trade was made
   */
  recordTrade() {
    this.lastTradeTime = this.getCurrentTime();
  }

  /**
   * Analyze market data and return a signal
   * Override in child classes
   * @returns {Object|null} { side: 'UP'|'DOWN', confidence: 0-1, signals: {} }
   */
  analyze(data) {
    throw new Error('analyze() must be implemented by child class');
  }

  /**
   * Get strategy description
   */
  getDescription() {
    return `${this.name} strategy`;
  }

  /**
   * Get current parameters for logging
   */
  getParameters() {
    return this.parameters;
  }
}
