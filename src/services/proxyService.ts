import { logger } from '../utils/logger';

interface Proxy {
  id: string;
  url: string;
  host: string;
  port: number;
  username: string;
  password: string;
  type: string;
  status: string;
  priority: number;
  successRate: number;
}

export class ProxyService {
  private proxies: Proxy[] = [];
  private lastFetch: number = 0;
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  private readonly ADMIN_API_URL = process.env['ADMIN_API_URL'] || 'http://localhost:3000';
  private readonly ADMIN_API_KEY = process.env['ADMIN_API_KEY'] || '';

  constructor() {
    this.fetchProxies();
  }

  async fetchProxies(): Promise<void> {
    try {
      const response = await fetch(`${this.ADMIN_API_URL}/api/importer/proxies`, {
        headers: {
          'Authorization': `Bearer ${this.ADMIN_API_KEY}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch proxies: ${response.statusText}`);
      }

      const data = await response.json() as { proxies: Proxy[] };
      
      // Filter and sort proxies
      this.proxies = data.proxies
        .filter((p: Proxy) => p.status === 'active')
        .sort((a: Proxy, b: Proxy) => {
          // Sort by priority first, then by success rate
          if (b.priority !== a.priority) {
            return b.priority - a.priority;
          }
          return b.successRate - a.successRate;
        });

      this.lastFetch = Date.now();
      logger.info(`Fetched ${this.proxies.length} active proxies from database`);
    } catch (error) {
      logger.error('Failed to fetch proxies from database:', error);
      
      // Fallback to hardcoded proxies if database fetch fails
      this.proxies = this.getHardcodedProxies();
    }
  }

  private getHardcodedProxies(): Proxy[] {
    // Fallback proxies - same as the ones currently in youtubeDownloader.ts
    const hardcodedUrls = [
      "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10001",
      "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10002",
      "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10003",
      "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10004",
      "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10005",
      "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10006",
      "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10007",
      "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10008",
      "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10009",
      "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10010",
    ];

    return hardcodedUrls.map((url, index) => {
      const urlObj = new URL(url);
      return {
        id: `hardcoded-${index}`,
        url,
        host: urlObj.hostname,
        port: parseInt(urlObj.port),
        username: urlObj.username || '',
        password: urlObj.password || '',
        type: 'http',
        status: 'active',
        priority: 1,
        successRate: 100,
      };
    });
  }

  async getProxies(): Promise<string[]> {
    // Refresh proxies if cache is expired
    if (Date.now() - this.lastFetch > this.CACHE_DURATION) {
      await this.fetchProxies();
    }

    // If no proxies available from database, use hardcoded ones
    if (this.proxies.length === 0) {
      this.proxies = this.getHardcodedProxies();
    }

    return this.proxies.map(p => p.url);
  }

  async reportProxyResult(proxyUrl: string, success: boolean, responseTime?: number): Promise<void> {
    try {
      const proxy = this.proxies.find(p => p.url === proxyUrl);
      if (!proxy || proxy.id.startsWith('hardcoded-')) {
        return; // Don't report for hardcoded proxies
      }

      // Report result back to admin API
      await fetch(`${this.ADMIN_API_URL}/api/proxies/${proxy.id}/report`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.ADMIN_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          success,
          responseTime,
        }),
      });
    } catch (error) {
      // Silently fail - don't interrupt the download process
      logger.debug('Failed to report proxy result:', error);
    }
  }
}

// Singleton instance
export const proxyService = new ProxyService();