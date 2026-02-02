/**
 * Working Memory Layer - v3.0 Implementation
 *
 * Redis-based cache for last 5 conversations with 7-day TTL.
 * Simple but effective - instant recall for recent context.
 */

import { Redis } from 'ioredis';

export interface WorkingMemory {
  conversationId: string;
  timestamp: Date;
  fullText: string;
  embedding?: number[];
  keyEntities: string[];
  topics: string[];
  userIntent: string;
}

export class WorkingMemoryLayer {
  private redis: Redis;
  private readonly MAX_CONVERSATIONS: number;
  private readonly TTL_DAYS = 7;

  constructor(redis: Redis, maxConversations: number = 5) {
    this.redis = redis;
    this.MAX_CONVERSATIONS = maxConversations;
  }

  async store(memory: WorkingMemory): Promise<void> {
    const key = `working:${memory.conversationId}`;
    const ttl = this.TTL_DAYS * 24 * 60 * 60;

    await this.redis.setex(key, ttl, JSON.stringify(memory));
    await this.redis.lpush('working:recent', memory.conversationId);

    // Get IDs that will be evicted (beyond MAX_CONVERSATIONS)
    const allIds = await this.redis.lrange('working:recent', 0, -1);
    const toEvict = allIds.slice(this.MAX_CONVERSATIONS);

    await this.redis.ltrim('working:recent', 0, this.MAX_CONVERSATIONS - 1);

    // Delete evicted conversation data
    for (const id of toEvict) {
      await this.redis.del(`working:${id}`);
    }
  }

  async search(query: string, limit: number = 3): Promise<Array<{ memory: WorkingMemory; similarity: number }>> {
    const recentIds = await this.redis.lrange('working:recent', 0, this.MAX_CONVERSATIONS - 1);
    const results: Array<{ memory: WorkingMemory; similarity: number }> = [];

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);

    for (const id of recentIds) {
      const data = await this.redis.get(`working:${id}`);
      if (!data) continue;

      const memory = JSON.parse(data) as WorkingMemory;
      const textLower = memory.fullText.toLowerCase();
      const matchCount = queryWords.filter(word => textLower.includes(word)).length;
      const similarity = matchCount / queryWords.length;

      if (similarity > 0.3) {
        results.push({ memory, similarity });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  async getRecent(limit: number = 5): Promise<WorkingMemory[]> {
    const recentIds = await this.redis.lrange('working:recent', 0, limit - 1);
    const memories: WorkingMemory[] = [];

    for (const id of recentIds) {
      const data = await this.redis.get(`working:${id}`);
      if (data) memories.push(JSON.parse(data));
    }

    return memories;
  }

  async getAll(limit?: number): Promise<WorkingMemory[]> {
    return this.getRecent(limit || this.MAX_CONVERSATIONS);
  }

  async get(conversationId: string): Promise<WorkingMemory | null> {
    const data = await this.redis.get(`working:${conversationId}`);
    return data ? JSON.parse(data) : null;
  }

  async delete(conversationId: string): Promise<void> {
    await this.redis.del(`working:${conversationId}`);
    await this.redis.lrem('working:recent', 1, conversationId);
  }

  async searchByEntities(entities: string[], limit: number = 3): Promise<Array<{ memory: WorkingMemory; similarity: number; matchedEntities: string[] }>> {
    const recentIds = await this.redis.lrange('working:recent', 0, this.MAX_CONVERSATIONS - 1);
    const results: Array<{ memory: WorkingMemory; similarity: number; matchedEntities: string[] }> = [];

    for (const id of recentIds) {
      const data = await this.redis.get(`working:${id}`);
      if (!data) continue;

      const memory = JSON.parse(data) as WorkingMemory;
      const matchedEntities = entities.filter(entity =>
        memory.keyEntities.some(ke => ke.toLowerCase() === entity.toLowerCase())
      );
      const similarity = matchedEntities.length / entities.length;

      if (similarity > 0) {
        results.push({ memory, similarity, matchedEntities });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  async searchByTopics(topics: string[], limit: number = 3): Promise<Array<{ memory: WorkingMemory; similarity: number; matchedTopics: string[] }>> {
    const recentIds = await this.redis.lrange('working:recent', 0, this.MAX_CONVERSATIONS - 1);
    const results: Array<{ memory: WorkingMemory; similarity: number; matchedTopics: string[] }> = [];

    for (const id of recentIds) {
      const data = await this.redis.get(`working:${id}`);
      if (!data) continue;

      const memory = JSON.parse(data) as WorkingMemory;
      const matchedTopics = topics.filter(topic =>
        memory.topics.some(t => t.toLowerCase() === topic.toLowerCase())
      );
      const similarity = matchedTopics.length / topics.length;

      if (similarity > 0) {
        results.push({ memory, similarity, matchedTopics });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  async getStats(): Promise<{
    totalConversations: number;
    oldestConversation: Date | null;
    newestConversation: Date | null;
    totalTextSize: number;
  }> {
    const recentIds = await this.redis.lrange('working:recent', 0, this.MAX_CONVERSATIONS - 1);
    const memories: WorkingMemory[] = [];

    for (const id of recentIds) {
      const data = await this.redis.get(`working:${id}`);
      if (data) memories.push(JSON.parse(data));
    }

    if (memories.length === 0) {
      return {
        totalConversations: 0,
        oldestConversation: null,
        newestConversation: null,
        totalTextSize: 0
      };
    }

    const timestamps = memories.map(m => new Date(m.timestamp));
    const totalTextSize = memories.reduce((sum, m) => sum + m.fullText.length, 0);

    return {
      totalConversations: memories.length,
      oldestConversation: new Date(Math.min(...timestamps.map(d => d.getTime()))),
      newestConversation: new Date(Math.max(...timestamps.map(d => d.getTime()))),
      totalTextSize
    };
  }

  /**
   * Clear all working memory entries
   *
   * Uses SCAN instead of KEYS to avoid blocking Redis server.
   * Deletes keys in batches to prevent memory exhaustion.
   *
   * Security: Prevents DoS attacks on Redis
   */
  async clear(): Promise<void> {
    let cursor = '0';
    const keysToDelete: string[] = [];

    // Use SCAN to iterate through keys without blocking
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH', 'working:*',
        'COUNT', 100
      );
      cursor = nextCursor;
      keysToDelete.push(...keys);
    } while (cursor !== '0');

    // Delete in batches to avoid memory issues
    const BATCH_SIZE = 100;
    for (let i = 0; i < keysToDelete.length; i += BATCH_SIZE) {
      const batch = keysToDelete.slice(i, i + BATCH_SIZE);
      if (batch.length > 0) {
        await this.redis.del(...batch);
      }
    }
  }
}
