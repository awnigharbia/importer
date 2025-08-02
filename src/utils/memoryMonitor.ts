import { logger } from './logger';

export interface MemoryStats {
  rss: number; // Resident Set Size
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export class MemoryMonitor {
  private static readonly WARNING_THRESHOLD = 0.85; // 85% of max heap
  private static readonly CRITICAL_THRESHOLD = 0.95; // 95% of max heap
  private static readonly CHECK_INTERVAL = 10000; // 10 seconds
  
  private maxHeapSize: number;
  private monitorInterval?: NodeJS.Timeout | undefined;
  private isMonitoring = false;

  constructor() {
    // Get max heap size from V8 or use configured value
    this.maxHeapSize = this.getMaxHeapSize();
  }

  private getMaxHeapSize(): number {
    try {
      const v8 = require('v8');
      const heapStats = v8.getHeapStatistics();
      return heapStats.heap_size_limit;
    } catch (error) {
      // Fallback to configured value
      const { env } = require('../config/env');
      return env.NODE_MAX_OLD_SPACE_SIZE * 1024 * 1024; // Convert MB to bytes
    }
  }

  startMonitoring(): void {
    if (this.isMonitoring) {
      return;
    }

    this.isMonitoring = true;
    logger.info('Starting memory monitoring', {
      maxHeapSize: Math.round(this.maxHeapSize / 1024 / 1024),
      warningThreshold: `${MemoryMonitor.WARNING_THRESHOLD * 100}%`,
      criticalThreshold: `${MemoryMonitor.CRITICAL_THRESHOLD * 100}%`
    });

    this.monitorInterval = setInterval(() => {
      this.checkMemoryUsage();
    }, MemoryMonitor.CHECK_INTERVAL);
  }

  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = undefined;
    }
    this.isMonitoring = false;
    logger.info('Memory monitoring stopped');
  }

  getMemoryStats(): MemoryStats {
    const memUsage = process.memoryUsage();
    return {
      rss: memUsage.rss,
      heapTotal: memUsage.heapTotal,
      heapUsed: memUsage.heapUsed,
      external: memUsage.external,
      arrayBuffers: memUsage.arrayBuffers || 0,
    };
  }

  private checkMemoryUsage(): void {
    const stats = this.getMemoryStats();
    const heapUsageRatio = stats.heapUsed / this.maxHeapSize;

    if (heapUsageRatio >= MemoryMonitor.CRITICAL_THRESHOLD) {
      logger.error('CRITICAL: Memory usage is critically high!', {
        heapUsed: Math.round(stats.heapUsed / 1024 / 1024),
        heapTotal: Math.round(stats.heapTotal / 1024 / 1024),
        maxHeap: Math.round(this.maxHeapSize / 1024 / 1024),
        usagePercentage: Math.round(heapUsageRatio * 100),
        rss: Math.round(stats.rss / 1024 / 1024),
      });

      // Force garbage collection if available
      this.forceGarbageCollection();

    } else if (heapUsageRatio >= MemoryMonitor.WARNING_THRESHOLD) {
      logger.warn('WARNING: Memory usage is high', {
        heapUsed: Math.round(stats.heapUsed / 1024 / 1024),
        heapTotal: Math.round(stats.heapTotal / 1024 / 1024),
        maxHeap: Math.round(this.maxHeapSize / 1024 / 1024),
        usagePercentage: Math.round(heapUsageRatio * 100),
      });

      // Suggest garbage collection
      this.forceGarbageCollection();
    }
  }

  private forceGarbageCollection(): void {
    try {
      if (global.gc) {
        global.gc();
        logger.debug('Forced garbage collection');
      } else {
        logger.debug('Garbage collection not available (run with --expose-gc)');
      }
    } catch (error) {
      logger.warn('Failed to force garbage collection', { error });
    }
  }

  logCurrentMemoryUsage(): void {
    const stats = this.getMemoryStats();
    const heapUsageRatio = stats.heapUsed / this.maxHeapSize;

    logger.info('Current memory usage', {
      heapUsed: Math.round(stats.heapUsed / 1024 / 1024),
      heapTotal: Math.round(stats.heapTotal / 1024 / 1024),
      maxHeap: Math.round(this.maxHeapSize / 1024 / 1024),
      usagePercentage: Math.round(heapUsageRatio * 100),
      rss: Math.round(stats.rss / 1024 / 1024),
      external: Math.round(stats.external / 1024 / 1024),
    });
  }
}

// Singleton instance
let memoryMonitor: MemoryMonitor | null = null;

export function getMemoryMonitor(): MemoryMonitor {
  if (!memoryMonitor) {
    memoryMonitor = new MemoryMonitor();
  }
  return memoryMonitor;
}