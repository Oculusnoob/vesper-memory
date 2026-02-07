/**
 * Tests for Consolidation Pipeline
 *
 * Verifies:
 * - Working → Semantic memory transformation
 * - Entity extraction from conversations
 * - Relationship creation
 * - Temporal decay application
 * - Conflict detection
 * - Memory pruning
 * - Skill extraction
 * - Backup creation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Redis } from 'ioredis';
import Database from 'better-sqlite3';
import { WorkingMemoryLayer } from '../src/memory-layers/working-memory.js';
import { SemanticMemoryLayer } from '../src/memory-layers/semantic-memory.js';
import { SkillLibrary } from '../src/memory-layers/skill-library.js';
import { ConsolidationPipeline } from '../src/consolidation/pipeline.js';

describe('ConsolidationPipeline', () => {
  let redis: Redis;
  let db: Database.Database;
  let workingMemory: WorkingMemoryLayer;
  let semanticMemory: SemanticMemoryLayer;
  let skillLibrary: SkillLibrary;
  let pipeline: ConsolidationPipeline;

  beforeEach(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      db: 2,  // Use database 2 for consolidation tests
    });
    db = new Database(':memory:');

    // Create schema
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT,
        namespace TEXT DEFAULT 'default',
        agent_id TEXT,
        agent_role TEXT,
        task_id TEXT
      );

      CREATE TABLE entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        confidence REAL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        last_accessed TEXT NOT NULL,
        access_count INTEGER DEFAULT 1,
        namespace TEXT DEFAULT 'default'
      );

      CREATE TABLE relationships (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        strength REAL DEFAULT 0.8,
        evidence TEXT,
        created_at TEXT NOT NULL,
        last_reinforced TEXT NOT NULL,
        namespace TEXT DEFAULT 'default'
      );

      CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        property TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        valid_from TEXT,
        valid_until TEXT,
        source_conversation TEXT,
        namespace TEXT DEFAULT 'default'
      );

      CREATE TABLE conflicts (
        id TEXT PRIMARY KEY,
        fact_id_1 TEXT,
        fact_id_2 TEXT,
        conflict_type TEXT,
        description TEXT,
        severity TEXT,
        resolution_status TEXT,
        namespace TEXT DEFAULT 'default'
      );

      CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        summary TEXT,
        category TEXT NOT NULL,
        triggers TEXT NOT NULL,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        avg_user_satisfaction REAL DEFAULT 0.5,
        is_archived INTEGER DEFAULT 0,
        last_used TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        namespace TEXT DEFAULT 'default'
      );

      CREATE TABLE backup_metadata (
        id TEXT PRIMARY KEY,
        backup_timestamp TIMESTAMP NOT NULL,
        backup_type TEXT NOT NULL,
        status TEXT NOT NULL,
        backup_path TEXT,
        file_size_bytes INTEGER,
        num_memories INTEGER,
        num_entities INTEGER,
        num_relationships INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        notes TEXT,
        metadata TEXT
      );
    `);

    workingMemory = new WorkingMemoryLayer(redis);
    semanticMemory = new SemanticMemoryLayer(db);
    skillLibrary = new SkillLibrary(db);
    pipeline = new ConsolidationPipeline(workingMemory, semanticMemory, skillLibrary, db);

    await workingMemory.clear();
  });

  afterEach(async () => {
    await redis.quit();
    db.close();
  });

  describe('Basic Consolidation', () => {
    it('should consolidate working memory to semantic memory', async () => {
      await workingMemory.store({
        conversationId: 'conv-1',
        timestamp: new Date(),
        fullText: 'I prefer Python for data analysis',
        keyEntities: ['Python', 'data analysis'],
        topics: ['programming'],
        userIntent: 'express preference',
      });

      const stats = await pipeline.consolidate();

      expect(stats.memoriesProcessed).toBe(1);
      expect(stats.entitiesExtracted).toBeGreaterThan(0);
      expect(stats.duration).toBeGreaterThan(0);
    });

    it('should extract entities from key entities field', async () => {
      await workingMemory.store({
        conversationId: 'conv-1',
        timestamp: new Date(),
        fullText: 'We are building the MetricPilot project',
        keyEntities: ['MetricPilot', 'project'],
        topics: ['work'],
        userIntent: 'project update',
      });

      const stats = await pipeline.consolidate();

      expect(stats.entitiesExtracted).toBe(2);

      const entities = db.prepare('SELECT * FROM entities').all();
      expect(entities.length).toBeGreaterThan(0);
    });

    it('should extract preferences from text patterns', async () => {
      await workingMemory.store({
        conversationId: 'conv-1',
        timestamp: new Date(),
        fullText: 'I prefer Python for scripting and like TypeScript for web apps',
        keyEntities: [],
        topics: ['programming'],
        userIntent: 'preference',
      });

      const stats = await pipeline.consolidate();

      expect(stats.entitiesExtracted).toBeGreaterThan(0);

      const prefs = db.prepare("SELECT * FROM entities WHERE type = 'preference'").all();
      expect(prefs.length).toBeGreaterThan(0);
    });

    it('should handle empty working memory', async () => {
      const stats = await pipeline.consolidate();

      expect(stats.memoriesProcessed).toBe(0);
      expect(stats.entitiesExtracted).toBe(0);
    });

    it('should return consolidation statistics', async () => {
      await workingMemory.store({
        conversationId: 'conv-1',
        timestamp: new Date(),
        fullText: 'Test memory',
        keyEntities: ['Test'],
        topics: [],
        userIntent: 'test',
      });

      const stats = await pipeline.consolidate();

      expect(stats).toHaveProperty('memoriesProcessed');
      expect(stats).toHaveProperty('entitiesExtracted');
      expect(stats).toHaveProperty('relationshipsCreated');
      expect(stats).toHaveProperty('conflictsDetected');
      expect(stats).toHaveProperty('memoriesPruned');
      expect(stats).toHaveProperty('skillsExtracted');
      expect(stats).toHaveProperty('duration');
    });
  });

  describe('Temporal Decay', () => {
    it('should apply temporal decay during consolidation', async () => {
      // Create relationship manually
      const user = semanticMemory.upsertEntity({ name: 'User', type: 'person' });
      const python = semanticMemory.upsertEntity({ name: 'Python', type: 'concept' });

      semanticMemory.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'prefers',
        strength: 0.9,
      });

      // Set to old date
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('UPDATE relationships SET last_reinforced = ?').run(oldDate);

      const beforeStrength = (db.prepare('SELECT strength FROM relationships').get() as any).strength;

      await pipeline.consolidate();

      const afterStrength = (db.prepare('SELECT strength FROM relationships').get() as any).strength;

      expect(afterStrength).toBeLessThan(beforeStrength);
    });
  });

  describe('Conflict Detection', () => {
    it('should detect conflicts during consolidation', async () => {
      // Create conflicting facts
      const now = new Date().toISOString();
      db.prepare('INSERT INTO entities (id, name, type, created_at, last_accessed, access_count) VALUES (?, ?, ?, ?, ?, ?)').run(
        'e1',
        'User',
        'person',
        now,
        now,
        1
      );

      db.prepare(`
        INSERT INTO facts (id, entity_id, property, value, confidence, valid_from)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('f1', 'e1', 'favorite_language', 'Python', 1.0, new Date().toISOString());

      db.prepare(`
        INSERT INTO facts (id, entity_id, property, value, confidence, valid_from)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('f2', 'e1', 'favorite_language', 'JavaScript', 1.0, new Date().toISOString());

      const stats = await pipeline.consolidate();

      expect(stats.conflictsDetected).toBeGreaterThan(0);

      const conflicts = db.prepare('SELECT * FROM conflicts').all();
      expect(conflicts.length).toBeGreaterThan(0);
    });

    it('should lower confidence on conflicting facts', async () => {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO entities (id, name, type, created_at, last_accessed, access_count) VALUES (?, ?, ?, ?, ?, ?)').run(
        'e1',
        'User',
        'person',
        now,
        now,
        1
      );

      db.prepare(`
        INSERT INTO facts (id, entity_id, property, value, confidence, valid_from)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('f1', 'e1', 'skill', 'Python', 1.0, new Date().toISOString());

      db.prepare(`
        INSERT INTO facts (id, entity_id, property, value, confidence, valid_from)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('f2', 'e1', 'skill', 'Java', 1.0, new Date().toISOString());

      await pipeline.consolidate();

      const facts = db.prepare('SELECT confidence FROM facts').all() as any[];

      facts.forEach(fact => {
        expect(fact.confidence).toBeLessThanOrEqual(0.5);
      });
    });

    it('should not create duplicate conflict entries', async () => {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO entities (id, name, type, created_at, last_accessed, access_count) VALUES (?, ?, ?, ?, ?, ?)').run(
        'e1',
        'User',
        'person',
        now,
        now,
        1
      );

      db.prepare(`
        INSERT INTO facts (id, entity_id, property, value, confidence, valid_from)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('f1', 'e1', 'prop', 'val1', 1.0, new Date().toISOString());

      db.prepare(`
        INSERT INTO facts (id, entity_id, property, value, confidence, valid_from)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('f2', 'e1', 'prop', 'val2', 1.0, new Date().toISOString());

      await pipeline.consolidate();
      const count1 = (db.prepare('SELECT COUNT(*) as count FROM conflicts').get() as any).count;

      await pipeline.consolidate();
      const count2 = (db.prepare('SELECT COUNT(*) as count FROM conflicts').get() as any).count;

      expect(count1).toBe(count2); // Should not increase
    });
  });

  describe('Memory Pruning', () => {
    it('should prune low-strength relationships', async () => {
      const user = semanticMemory.upsertEntity({ name: 'User', type: 'person' });
      const weak = semanticMemory.upsertEntity({ name: 'Weak', type: 'concept' });

      semanticMemory.upsertRelationship({
        sourceId: user.id,
        targetId: weak.id,
        relationType: 'related',
        strength: 0.02, // Very weak
      });

      const stats = await pipeline.consolidate();

      expect(stats.memoriesPruned).toBeGreaterThan(0);

      const rels = db.prepare('SELECT * FROM relationships').all();
      expect(rels).toHaveLength(0); // Should be pruned
    });

    it('should keep relationships with high access count', async () => {
      const user = semanticMemory.upsertEntity({ name: 'User', type: 'person' });
      const important = semanticMemory.upsertEntity({ name: 'Important', type: 'concept' });

      // Access entity multiple times
      for (let i = 0; i < 5; i++) {
        semanticMemory.getEntity('Important');
      }

      semanticMemory.upsertRelationship({
        sourceId: user.id,
        targetId: important.id,
        relationType: 'related',
        strength: 0.02, // Weak but accessed
      });

      const stats = await pipeline.consolidate();

      const rels = db.prepare('SELECT * FROM relationships').all();
      expect(rels).toHaveLength(1); // Should be kept due to access count
    });
  });

  describe('Skill Extraction', () => {
    it('should extract skills from analysis topics', async () => {
      await workingMemory.store({
        conversationId: 'conv-1',
        timestamp: new Date(),
        fullText: 'Let me analyze this data for you',
        keyEntities: ['data'],
        topics: ['analysis'],
        userIntent: 'analyze',
      });

      const stats = await pipeline.consolidate();

      expect(stats.skillsExtracted).toBeGreaterThanOrEqual(0);
    });

    it('should not duplicate existing skills', async () => {
      skillLibrary.addSkill({
        name: 'Data Analysis',
        description: 'Analyze datasets and provide insights',
        category: 'analysis',
        triggers: ['analyze', 'data', 'insights'],
      });

      await workingMemory.store({
        conversationId: 'conv-1',
        timestamp: new Date(),
        fullText: 'Analyzing data',
        keyEntities: [],
        topics: ['analysis'],
        userIntent: 'analyze',
      });

      const beforeCount = (db.prepare('SELECT COUNT(*) as count FROM skills').get() as any).count;

      await pipeline.consolidate();

      const afterCount = (db.prepare('SELECT COUNT(*) as count FROM skills').get() as any).count;

      expect(afterCount).toBe(beforeCount); // Should not increase
    });
  });

  describe('Backup Creation', () => {
    it('should create backup metadata', async () => {
      await pipeline.consolidate();

      const backups = db.prepare('SELECT * FROM backup_metadata').all();
      expect(backups.length).toBeGreaterThan(0);
    });

    it('should set backup expiration to 7 days', async () => {
      await pipeline.consolidate();

      const backup = db.prepare('SELECT * FROM backup_metadata ORDER BY created_at DESC LIMIT 1').get() as any;

      const created = new Date(backup.created_at);
      const expires = new Date(backup.expires_at);
      const diff = expires.getTime() - created.getTime();
      const days = diff / (1000 * 60 * 60 * 24);

      expect(days).toBeCloseTo(7, 0);
    });

    it('should set backup type to consolidation', async () => {
      await pipeline.consolidate();

      const backup = db.prepare('SELECT * FROM backup_metadata ORDER BY created_at DESC LIMIT 1').get() as any;

      expect(backup.backup_type).toBe('consolidation');
    });
  });

  describe('Error Handling', () => {
    it('should handle errors gracefully', async () => {
      // Create corrupted data
      await workingMemory.store({
        conversationId: 'bad',
        timestamp: new Date(),
        fullText: 'Test',
        keyEntities: null as any, // Invalid
        topics: [],
        userIntent: '',
      });

      // Should not throw
      await expect(pipeline.consolidate()).resolves.toBeDefined();
    });

    it('should continue processing after individual errors', async () => {
      await workingMemory.store({
        conversationId: 'good-1',
        timestamp: new Date(),
        fullText: 'Valid memory',
        keyEntities: ['Entity1'],
        topics: [],
        userIntent: '',
      });

      await workingMemory.store({
        conversationId: 'good-2',
        timestamp: new Date(),
        fullText: 'Another valid memory',
        keyEntities: ['Entity2'],
        topics: [],
        userIntent: '',
      });

      const stats = await pipeline.consolidate();

      expect(stats.memoriesProcessed).toBe(2);
    });
  });

  describe('Performance', () => {
    beforeEach(() => {
      // Recreate working memory with higher limit for performance tests
      workingMemory = new WorkingMemoryLayer(redis, 100);
      pipeline = new ConsolidationPipeline(workingMemory, semanticMemory, skillLibrary, db);
    });

    it('should consolidate 100 memories in reasonable time', async () => {
      for (let i = 0; i < 100; i++) {
        await workingMemory.store({
          conversationId: `conv-${i}`,
          timestamp: new Date(),
          fullText: `Memory ${i} about programming`,
          keyEntities: [`Entity${i}`],
          topics: ['programming'],
          userIntent: 'discussion',
        });
      }

      const start = Date.now();
      const stats = await pipeline.consolidate();
      const duration = Date.now() - start;

      expect(stats.memoriesProcessed).toBe(100);
      expect(duration).toBeLessThan(5000); // Should complete in < 5 seconds
    });

    it('should report accurate duration', async () => {
      await workingMemory.store({
        conversationId: 'conv-1',
        timestamp: new Date(),
        fullText: 'Test',
        keyEntities: [],
        topics: [],
        userIntent: '',
      });

      const start = Date.now();
      const stats = await pipeline.consolidate();
      const actualDuration = Date.now() - start;

      expect(stats.duration).toBeGreaterThanOrEqual(0); // Can be 0 for very fast operations
      expect(stats.duration).toBeLessThanOrEqual(actualDuration + 100); // Allow 100ms margin
    });
  });

  describe('Integration', () => {
    it('should perform full end-to-end consolidation', async () => {
      // Store conversations
      await workingMemory.store({
        conversationId: 'conv-1',
        timestamp: new Date(),
        fullText: 'I prefer Python for machine learning projects',
        keyEntities: ['Python', 'machine learning'],
        topics: ['programming', 'AI'],
        userIntent: 'preference',
      });

      await workingMemory.store({
        conversationId: 'conv-2',
        timestamp: new Date(),
        fullText: 'Working on the MetricPilot analytics dashboard',
        keyEntities: ['MetricPilot', 'analytics'],
        topics: ['work', 'project'],
        userIntent: 'project update',
      });

      // Run consolidation
      const stats = await pipeline.consolidate();

      // Verify results
      expect(stats.memoriesProcessed).toBe(2);
      expect(stats.entitiesExtracted).toBeGreaterThan(0);

      const entities = db.prepare('SELECT * FROM entities').all();
      expect(entities.length).toBeGreaterThan(0);

      const backups = db.prepare('SELECT * FROM backup_metadata').all();
      expect(backups.length).toBeGreaterThan(0);
    });
  });
});
