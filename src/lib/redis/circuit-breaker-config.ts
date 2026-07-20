/**
 * Redis 熔断器配置缓存层
 *
 * 功能：
 * 1. 从 Redis 读取供应商的熔断器配置（热数据）
 * 2. 缓存未命中时从数据库加载
 * 3. 保存配置到 Redis
 * 4. 启动时批量加载所有供应商配置
 * 5. 降级策略：Redis 不可用时从数据库读取
 */

import { logger } from "@/lib/logger";
import { findAllProviders, findProviderById } from "@/repository/provider";
import { getRedisClient } from "./client";

export interface CircuitBreakerConfig {
  failureThreshold: number;
  openDuration: number; // 毫秒
  halfOpenSuccessThreshold: number;
  rollingWindowDuration?: number;
  minimumSamples?: number;
  failureRateThreshold?: number;
  consecutiveFailureThreshold?: number;
  halfOpenMaxConcurrency?: number;
  halfOpenLeaseDuration?: number;
  baseOpenDuration?: number; // 指数退避初始开路时长（毫秒）
}

// 默认配置（向后兼容）
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  openDuration: 1800000, // 30 分钟
  halfOpenSuccessThreshold: 2,
  rollingWindowDuration: 60000,
  minimumSamples: 20,
  failureRateThreshold: 0.4,
  consecutiveFailureThreshold: 8,
  halfOpenMaxConcurrency: 2,
  halfOpenLeaseDuration: 120000,
  baseOpenDuration: 60000, // 60 秒
};

/**
 * 生成 Redis Key
 */
function getConfigKey(providerId: number): string {
  return `circuit_breaker:config:${providerId}`;
}

/**
 * 从 Redis 加载供应商的熔断器配置
 * 缓存未命中时从数据库加载并缓存
 *
 * @param providerId 供应商 ID
 * @returns 熔断器配置，失败时返回默认配置
 */
export async function loadProviderCircuitConfig(providerId: number): Promise<CircuitBreakerConfig> {
  const redis = getRedisClient();

  try {
    // 尝试从 Redis 读取
    if (redis) {
      const key = getConfigKey(providerId);
      const cached = await redis.hgetall(key);

      if (cached && Object.keys(cached).length > 0) {
        logger.debug(`[CircuitBreakerConfig] Loaded from Redis`, { providerId });
        return {
          failureThreshold: parseInt(cached.failureThreshold || "5", 10),
          openDuration: parseInt(cached.openDuration || "1800000", 10),
          halfOpenSuccessThreshold: parseInt(cached.halfOpenSuccessThreshold || "2", 10),
          rollingWindowDuration: parseInt(cached.rollingWindowDuration || "60000", 10),
          minimumSamples: parseInt(cached.minimumSamples || "20", 10),
          failureRateThreshold: Number(cached.failureRateThreshold || "0.4"),
          consecutiveFailureThreshold: parseInt(cached.consecutiveFailureThreshold || "8", 10),
          halfOpenMaxConcurrency: parseInt(cached.halfOpenMaxConcurrency || "2", 10),
          halfOpenLeaseDuration: parseInt(cached.halfOpenLeaseDuration || "120000", 10),
          baseOpenDuration: parseInt(cached.baseOpenDuration || "60000", 10),
        };
      }
    }

    // 缓存未命中，从数据库加载
    logger.debug(`[CircuitBreakerConfig] Cache miss, loading from database`, { providerId });
    const provider = await findProviderById(providerId);

    if (!provider) {
      logger.warn(`[CircuitBreakerConfig] Provider not found, using default config`, {
        providerId,
      });
      return DEFAULT_CIRCUIT_BREAKER_CONFIG;
    }

    const config: CircuitBreakerConfig = {
      failureThreshold: provider.circuitBreakerFailureThreshold,
      openDuration: provider.circuitBreakerOpenDuration,
      halfOpenSuccessThreshold: provider.circuitBreakerHalfOpenSuccessThreshold,
      rollingWindowDuration: provider.circuitBreakerRollingWindowDuration ?? 60000,
      minimumSamples: provider.circuitBreakerMinimumSamples ?? 20,
      failureRateThreshold: provider.circuitBreakerFailureRateThreshold ?? 0.4,
      consecutiveFailureThreshold: provider.circuitBreakerConsecutiveFailureThreshold ?? 8,
      halfOpenMaxConcurrency: provider.circuitBreakerHalfOpenMaxConcurrency ?? 2,
      halfOpenLeaseDuration: provider.circuitBreakerHalfOpenLeaseDuration ?? 120000,
      baseOpenDuration: provider.circuitBreakerBaseOpenDuration ?? 60000,
    };

    // 保存到 Redis（异步，不阻塞）
    if (redis) {
      saveProviderCircuitConfig(providerId, config).catch((error) => {
        logger.warn(`[CircuitBreakerConfig] Failed to cache config to Redis`, {
          providerId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return config;
  } catch (error) {
    logger.error(`[CircuitBreakerConfig] Failed to load config, using default`, {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_CIRCUIT_BREAKER_CONFIG;
  }
}

/**
 * 保存供应商的熔断器配置到 Redis
 *
 * @param providerId 供应商 ID
 * @param config 熔断器配置
 */
export async function saveProviderCircuitConfig(
  providerId: number,
  config: CircuitBreakerConfig
): Promise<void> {
  const redis = getRedisClient();

  if (!redis) {
    logger.debug(`[CircuitBreakerConfig] Redis not available, skip caching`, { providerId });
    return;
  }

  try {
    const key = getConfigKey(providerId);
    await redis.hset(key, {
      failureThreshold: config.failureThreshold.toString(),
      openDuration: config.openDuration.toString(),
      halfOpenSuccessThreshold: config.halfOpenSuccessThreshold.toString(),
      rollingWindowDuration: (config.rollingWindowDuration ?? 60000).toString(),
      minimumSamples: (config.minimumSamples ?? 20).toString(),
      failureRateThreshold: (config.failureRateThreshold ?? 0.4).toString(),
      consecutiveFailureThreshold: (config.consecutiveFailureThreshold ?? 8).toString(),
      halfOpenMaxConcurrency: (config.halfOpenMaxConcurrency ?? 2).toString(),
      halfOpenLeaseDuration: (config.halfOpenLeaseDuration ?? 120000).toString(),
      baseOpenDuration: (config.baseOpenDuration ?? 60000).toString(),
    });

    // 设置 TTL：永久或 24 小时（根据需求调整）
    // await redis.expire(key, 86400); // 24 小时

    logger.debug(`[CircuitBreakerConfig] Saved to Redis`, { providerId, config });
  } catch (error) {
    logger.warn(`[CircuitBreakerConfig] Failed to save to Redis`, {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    // 不抛出错误，降级处理
  }
}

/**
 * 删除供应商的熔断器配置缓存
 *
 * @param providerId 供应商 ID
 */
export async function deleteProviderCircuitConfig(providerId: number): Promise<void> {
  const redis = getRedisClient();

  if (!redis) {
    return;
  }

  try {
    const key = getConfigKey(providerId);
    await redis.del(key);
    logger.debug(`[CircuitBreakerConfig] Deleted from Redis`, { providerId });
  } catch (error) {
    logger.warn(`[CircuitBreakerConfig] Failed to delete from Redis`, {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 启动时批量加载所有供应商的熔断器配置到 Redis
 * 用于应用启动时的预热
 */
export async function loadAllProvidersCircuitConfig(): Promise<void> {
  const redis = getRedisClient();

  if (!redis) {
    logger.info(`[CircuitBreakerConfig] Redis not available, skip preloading`);
    return;
  }

  try {
    logger.info(`[CircuitBreakerConfig] Starting to preload all provider configs`);

    // 从数据库获取所有供应商
    const providers = await findAllProviders();

    logger.info(`[CircuitBreakerConfig] Found ${providers.length} providers to preload`);

    // 批量保存到 Redis
    const promises = providers.map((provider) => {
      const config: CircuitBreakerConfig = {
        failureThreshold: provider.circuitBreakerFailureThreshold,
        openDuration: provider.circuitBreakerOpenDuration,
          halfOpenSuccessThreshold: provider.circuitBreakerHalfOpenSuccessThreshold,
          rollingWindowDuration: provider.circuitBreakerRollingWindowDuration ?? 60000,
          minimumSamples: provider.circuitBreakerMinimumSamples ?? 20,
          failureRateThreshold: provider.circuitBreakerFailureRateThreshold ?? 0.4,
          consecutiveFailureThreshold: provider.circuitBreakerConsecutiveFailureThreshold ?? 8,
          halfOpenMaxConcurrency: provider.circuitBreakerHalfOpenMaxConcurrency ?? 2,
          halfOpenLeaseDuration: provider.circuitBreakerHalfOpenLeaseDuration ?? 120000,
          baseOpenDuration: provider.circuitBreakerBaseOpenDuration ?? 60000,
      };
      return saveProviderCircuitConfig(provider.id, config);
    });

    await Promise.allSettled(promises);

    logger.info(`[CircuitBreakerConfig] Preload completed`, {
      total: providers.length,
    });
  } catch (error) {
    logger.error(`[CircuitBreakerConfig] Failed to preload configs`, {
      error: error instanceof Error ? error.message : String(error),
    });
    // 不抛出错误，应用仍可启动，配置会按需加载
  }
}
