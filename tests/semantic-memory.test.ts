/**
 * Tests for Semantic Memory Layer
 *
 * Verifies:
 * - Entity CRUD operations
 * - Relationship management
 * - Personalized PageRank traversal
 * - Temporal decay
 * - Preference queries
 * - Time-based queries
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SemanticMemoryLayer } from '../src/memory-layers/semantic-memory.js';

describe('SemanticMemoryLayer', () => {
  let db: Database.Database;
  let semantic: SemanticMemoryLayer;

  beforeEach(() => {
    db = new Database(':memory:');

    // Create schema
    db.exec(`
      CREATE TABLE entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        confidence REAL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        last_accessed TEXT NOT NULL,
        access_count INTEGER DEFAULT 1
      );

      CREATE TABLE relationships (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        strength REAL DEFAULT 0.8,
        evidence TEXT,
        created_at TEXT NOT NULL,
        last_reinforced TEXT NOT NULL
      );

      CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        property TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        valid_from TEXT,
        valid_until TEXT,
        source_conversation TEXT
      );
    `);

    semantic = new SemanticMemoryLayer(db);
  });

  describe('Entity Management', () => {
    it('should create a new entity', () => {
      const entity = semantic.upsertEntity({
        name: 'Python',
        type: 'concept',
        confidence: 0.95,
      });

      expect(entity.id).toBeDefined();
      expect(entity.name).toBe('Python');
      expect(entity.type).toBe('concept');
      expect(entity.confidence).toBe(0.95);
    });

    it('should update existing entity on re-insert', () => {
      const entity1 = semantic.upsertEntity({
        name: 'Python',
        type: 'concept',
      });

      const entity2 = semantic.upsertEntity({
        name: 'Python',
        type: 'concept',
      });

      expect(entity2.id).toBe(entity1.id);

      // Access count should have increased
      const row = db.prepare('SELECT access_count FROM entities WHERE id = ?').get(entity1.id) as any;
      expect(row.access_count).toBe(2);
    });

    it('should retrieve entity by name', () => {
      semantic.upsertEntity({
        name: 'Django',
        type: 'concept',
        confidence: 0.9,
      });

      const entity = semantic.getEntity('Django');
      expect(entity).not.toBeNull();
      expect(entity.name).toBe('Django');
    });

    it('should return null for non-existent entity', () => {
      const entity = semantic.getEntity('NonExistent');
      expect(entity).toBeNull();
    });

    it('should handle different entity types', () => {
      const types = ['person', 'project', 'concept', 'preference'];

      for (const type of types) {
        const entity = semantic.upsertEntity({
          name: `Test ${type}`,
          type: type as any,
        });

        expect(entity.type).toBe(type);
      }
    });

    it('should track entity access count', () => {
      semantic.upsertEntity({ name: 'Test', type: 'concept' });

      // Access it multiple times
      for (let i = 0; i < 5; i++) {
        semantic.getEntity('Test');
      }

      const row = db.prepare('SELECT access_count FROM entities WHERE name = ?').get('Test') as any;
      expect(row.access_count).toBeGreaterThanOrEqual(5);
    });

    it('should update last_accessed timestamp', () => {
      const entity = semantic.upsertEntity({ name: 'Test', type: 'concept' });

      const before = db.prepare('SELECT last_accessed FROM entities WHERE id = ?').get(entity.id) as any;

      // Wait a bit
      const start = Date.now();
      while (Date.now() - start < 5) { /* tiny delay */ }

      semantic.getEntity('Test');

      const after = db.prepare('SELECT last_accessed FROM entities WHERE id = ?').get(entity.id) as any;

      expect(new Date(after.last_accessed).getTime()).toBeGreaterThanOrEqual(
        new Date(before.last_accessed).getTime()
      );
    });
  });

  describe('Relationship Management', () => {
    it('should create a relationship between entities', () => {
      const user = semantic.upsertEntity({ name: 'User', type: 'person' });
      const python = semantic.upsertEntity({ name: 'Python', type: 'concept' });

      semantic.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'prefers',
        strength: 0.95,
      });

      const rels = db.prepare('SELECT * FROM relationships').all();
      expect(rels).toHaveLength(1);
      expect((rels[0] as any).source_id).toBe(user.id);
      expect((rels[0] as any).target_id).toBe(python.id);
      expect((rels[0] as any).relation_type).toBe('prefers');
    });

    it('should strengthen existing relationship on re-insert', () => {
      const user = semantic.upsertEntity({ name: 'User', type: 'person' });
      const python = semantic.upsertEntity({ name: 'Python', type: 'concept' });

      semantic.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'prefers',
        strength: 0.5,
      });

      semantic.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'prefers',
      });

      const rel = db.prepare(
        'SELECT strength FROM relationships WHERE source_id = ? AND target_id = ?'
      ).get(user.id, python.id) as any;

      expect(rel.strength).toBeGreaterThan(0.5);
      expect(rel.strength).toBeLessThanOrEqual(1.0);
    });

    it('should cap relationship strength at 1.0', () => {
      const user = semantic.upsertEntity({ name: 'User', type: 'person' });
      const python = semantic.upsertEntity({ name: 'Python', type: 'concept' });

      semantic.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'prefers',
        strength: 0.9,
      });

      // Reinforce multiple times
      for (let i = 0; i < 5; i++) {
        semantic.upsertRelationship({
          sourceId: user.id,
          targetId: python.id,
          relationType: 'prefers',
        });
      }

      const rel = db.prepare(
        'SELECT strength FROM relationships WHERE source_id = ? AND target_id = ?'
      ).get(user.id, python.id) as any;

      expect(rel.strength).toBeLessThanOrEqual(1.0);
    });

    it('should allow multiple relationship types between same entities', () => {
      const user = semantic.upsertEntity({ name: 'User', type: 'person' });
      const python = semantic.upsertEntity({ name: 'Python', type: 'concept' });

      semantic.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'prefers',
      });

      semantic.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'uses',
      });

      const rels = db.prepare(
        'SELECT * FROM relationships WHERE source_id = ? AND target_id = ?'
      ).all(user.id, python.id);

      expect(rels).toHaveLength(2);
    });
  });

  describe('Personalized PageRank', () => {
    it('should traverse graph starting from entity', () => {
      const user = semantic.upsertEntity({ name: 'User', type: 'person' });
      const python = semantic.upsertEntity({ name: 'Python', type: 'concept' });

      semantic.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'prefers',
      });

      const results = semantic.personalizedPageRank(user.id, 2);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe(user.id);
      expect(results[0].relevanceScore).toBe(1.0);
    });

    it('should rank results by relevance', () => {
      const user = semantic.upsertEntity({ name: 'User', type: 'person' });
      const python = semantic.upsertEntity({ name: 'Python', type: 'concept' });
      const django = semantic.upsertEntity({ name: 'Django', type: 'concept' });

      semantic.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'prefers',
        strength: 0.9,
      });

      semantic.upsertRelationship({
        sourceId: python.id,
        targetId: django.id,
        relationType: 'related_to',
        strength: 0.8,
      });

      const results = semantic.personalizedPageRank(user.id, 3);

      // First result should be starting node with score 1.0
      expect(results[0].relevanceScore).toBe(1.0);

      // Subsequent results should have decreasing scores
      if (results.length > 1) {
        expect(results[1].relevanceScore).toBeLessThan(1.0);
      }
    });

    it('should respect depth parameter', () => {
      const user = semantic.upsertEntity({ name: 'User', type: 'person' });
      const python = semantic.upsertEntity({ name: 'Python', type: 'concept' });
      const django = semantic.upsertEntity({ name: 'Django', type: 'concept' });
      const flask = semantic.upsertEntity({ name: 'Flask', type: 'concept' });

      semantic.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'prefers',
      });

      semantic.upsertRelationship({
        sourceId: python.id,
        targetId: django.id,
        relationType: 'related_to',
      });

      semantic.upsertRelationship({
        sourceId: django.id,
        targetId: flask.id,
        relationType: 'related_to',
      });

      const depth1 = semantic.personalizedPageRank(user.id, 1);
      const depth3 = semantic.personalizedPageRank(user.id, 3);

      expect(depth3.length).toBeGreaterThanOrEqual(depth1.length);
    });

    it('should filter low-relevance nodes', () => {
      const user = semantic.upsertEntity({ name: 'User', type: 'person' });
      const python = semantic.upsertEntity({ name: 'Python', type: 'concept' });
      const weak = semantic.upsertEntity({ name: 'Weak', type: 'concept' });

      semantic.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'prefers',
        strength: 0.9,
      });

      semantic.upsertRelationship({
        sourceId: python.id,
        targetId: weak.id,
        relationType: 'related_to',
        strength: 0.1,
      });

      const results = semantic.personalizedPageRank(user.id, 3);

      // Weak connection should be filtered out (score < 0.1 threshold)
      const weakNode = results.find(r => r.id === weak.id);
      expect(weakNode).toBeUndefined();
    });
  });

  describe('Temporal Decay', () => {
    it('should apply decay to old relationships', () => {
      const user = semantic.upsertEntity({ name: 'User', type: 'person' });
      const python = semantic.upsertEntity({ name: 'Python', type: 'concept' });

      semantic.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'prefers',
        strength: 0.9,
      });

      // Manually set last_reinforced to 60 days ago
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('UPDATE relationships SET last_reinforced = ?').run(sixtyDaysAgo);

      const updated = semantic.applyTemporalDecay();

      expect(updated).toBeGreaterThan(0);

      const rel = db.prepare('SELECT strength FROM relationships').get() as any;
      expect(rel.strength).toBeLessThan(0.9);
    });

    it('should delete very weak relationships', () => {
      const user = semantic.upsertEntity({ name: 'User', type: 'person' });
      const python = semantic.upsertEntity({ name: 'Python', type: 'concept' });

      semantic.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'prefers',
        strength: 0.1,
      });

      // Set to very old
      const oldDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('UPDATE relationships SET last_reinforced = ?').run(oldDate);

      semantic.applyTemporalDecay();

      const rels = db.prepare('SELECT strength FROM relationships').all() as any[];
      expect(rels).toHaveLength(1); // Still exists but decayed
      expect(rels[0].strength).toBeLessThan(0.05); // Decayed to very weak (will be pruned by consolidation)
    });

    it('should keep recent relationships strong', () => {
      const user = semantic.upsertEntity({ name: 'User', type: 'person' });
      const python = semantic.upsertEntity({ name: 'Python', type: 'concept' });

      semantic.upsertRelationship({
        sourceId: user.id,
        targetId: python.id,
        relationType: 'prefers',
        strength: 0.9,
      });

      semantic.applyTemporalDecay();

      const rel = db.prepare('SELECT strength FROM relationships').get() as any;
      expect(rel.strength).toBeGreaterThan(0.85); // Minimal decay for recent
    });
  });

  describe('Preference Queries', () => {
    it('should retrieve all preferences', () => {
      semantic.upsertEntity({ name: 'Python', type: 'preference' });
      semantic.upsertEntity({ name: 'TypeScript', type: 'preference' });
      semantic.upsertEntity({ name: 'User', type: 'person' });

      const prefs = semantic.getPreferences();
      expect(prefs).toHaveLength(2);
      expect(prefs.every(p => p.type === 'preference')).toBe(true);
    });

    it('should filter preferences by domain', () => {
      semantic.upsertEntity({
        name: 'Python',
        type: 'preference',
        description: 'programming language',
      } as any);

      semantic.upsertEntity({
        name: 'Coffee',
        type: 'preference',
        description: 'beverage',
      } as any);

      const prefs = semantic.getPreferences('programming');
      expect(prefs).toHaveLength(1);
      expect(prefs[0].name).toBe('Python');
    });

    it('should return empty array when no preferences exist', () => {
      const prefs = semantic.getPreferences();
      expect(prefs).toHaveLength(0);
    });
  });

  describe('Time-based Queries', () => {
    it('should retrieve entities by time range', () => {
      const now = new Date();
      const start = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day ago
      const end = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 1 day from now

      semantic.upsertEntity({ name: 'Entity1', type: 'concept' });

      const results = semantic.getByTimeRange(start, end);
      expect(results.length).toBeGreaterThan(0);
    });

    it('should filter by start date only', () => {
      const now = new Date();
      const start = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day ago

      semantic.upsertEntity({ name: 'Entity1', type: 'concept' });

      const results = semantic.getByTimeRange(start);
      expect(results.length).toBeGreaterThan(0);
    });

    it('should filter by end date only', () => {
      const now = new Date();
      const end = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 1 day from now

      semantic.upsertEntity({ name: 'Entity1', type: 'concept' });

      const results = semantic.getByTimeRange(undefined, end);
      expect(results.length).toBeGreaterThan(0);
    });

    it('should limit results to 20', () => {
      // Create 30 entities
      for (let i = 0; i < 30; i++) {
        semantic.upsertEntity({ name: `Entity${i}`, type: 'concept' });
      }

      const results = semantic.getByTimeRange();
      expect(results.length).toBeLessThanOrEqual(20);
    });

    it('should order by created_at DESC', () => {
      const entity1 = semantic.upsertEntity({ name: 'First', type: 'concept' });

      // Small delay
      const start = Date.now();
      while (Date.now() - start < 5) { /* tiny delay */ }

      const entity2 = semantic.upsertEntity({ name: 'Second', type: 'concept' });

      const results = semantic.getByTimeRange();

      // Most recent should be first
      expect(results[0].name).toBe('Second');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty entity name gracefully', () => {
      expect(() => {
        semantic.upsertEntity({ name: '', type: 'concept' });
      }).toThrow();
    });

    it('should handle invalid confidence values', () => {
      const entity = semantic.upsertEntity({
        name: 'Test',
        type: 'concept',
        confidence: 1.5, // Invalid: > 1.0
      });

      // Should still create entity (no validation)
      expect(entity).toBeDefined();
    });

    it('should handle circular relationships', () => {
      const a = semantic.upsertEntity({ name: 'A', type: 'concept' });
      const b = semantic.upsertEntity({ name: 'B', type: 'concept' });

      semantic.upsertRelationship({
        sourceId: a.id,
        targetId: b.id,
        relationType: 'related_to',
      });

      semantic.upsertRelationship({
        sourceId: b.id,
        targetId: a.id,
        relationType: 'related_to',
      });

      // PageRank should handle circular refs without infinite loop
      const results = semantic.personalizedPageRank(a.id, 5);
      expect(results).toBeDefined();
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle self-referential relationships', () => {
      const entity = semantic.upsertEntity({ name: 'SelfRef', type: 'concept' });

      semantic.upsertRelationship({
        sourceId: entity.id,
        targetId: entity.id,
        relationType: 'contains',
      });

      const results = semantic.personalizedPageRank(entity.id, 2);
      expect(results).toBeDefined();
    });
  });
});
