/**
 * Semantic Memory Layer - v3.0 Implementation
 *
 * SQLite knowledge graph with HippoRAG Personalized PageRank.
 */

import Database from 'better-sqlite3';

export interface Entity {
  id: string;
  name: string;
  type: 'person' | 'project' | 'concept' | 'preference';
  description?: string;
  confidence: number;
}

export class SemanticMemoryLayer {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  upsertEntity(entity: Partial<Entity> & { name: string; type: string }): Entity {
    if (!entity.name || entity.name.trim() === '') {
      throw new Error('Entity name cannot be empty');
    }

    const existing = this.db.prepare(
      'SELECT * FROM entities WHERE name = ? AND type = ?'
    ).get(entity.name, entity.type) as any;

    if (existing) {
      this.db.prepare(
        'UPDATE entities SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?'
      ).run(new Date().toISOString(), existing.id);
      return existing;
    }

    const id = 'entity_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO entities (id, name, type, description, confidence, created_at, last_accessed, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, entity.name, entity.type, entity.description || null, entity.confidence || 1.0, now, now, 1);

    return {
      id,
      name: entity.name,
      type: entity.type as any,
      description: entity.description,
      confidence: entity.confidence || 1.0
    };
  }

  getEntity(name: string): any | null {
    const result = this.db.prepare(
      'SELECT * FROM entities WHERE name = ? ORDER BY confidence DESC LIMIT 1'
    ).get(name);

    if (result) {
      this.db.prepare(
        'UPDATE entities SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?'
      ).run(new Date().toISOString(), (result as any).id);
    }

    return result || null;
  }

  upsertRelationship(rel: { sourceId: string; targetId: string; relationType: string; strength?: number }): void {
    const existing = this.db.prepare(
      'SELECT * FROM relationships WHERE source_id = ? AND target_id = ? AND relation_type = ?'
    ).get(rel.sourceId, rel.targetId, rel.relationType) as any;

    const now = new Date().toISOString();

    if (existing) {
      const newStrength = Math.min(1.0, existing.strength + 0.2);
      this.db.prepare(
        'UPDATE relationships SET strength = ?, last_reinforced = ? WHERE id = ?'
      ).run(newStrength, now, existing.id);
      return;
    }

    const id = 'rel_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    this.db.prepare(`
      INSERT INTO relationships (id, source_id, target_id, relation_type, strength, evidence, created_at, last_reinforced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, rel.sourceId, rel.targetId, rel.relationType, rel.strength || 0.8, '[]', now, now);
  }

  personalizedPageRank(entityId: string, depth: number = 2): any[] {
    const visited = new Set<string>();
    const results: any[] = [];
    let currentLayer = [{ entityId, score: 1.0 }];

    for (let d = 0; d < depth && currentLayer.length > 0; d++) {
      const nextLayer: any[] = [];

      for (const node of currentLayer) {
        if (visited.has(node.entityId)) continue;
        visited.add(node.entityId);

        const entity = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(node.entityId);
        if (entity) results.push({ ...entity, relevanceScore: node.score });

        const rels = this.db.prepare(
          'SELECT * FROM relationships WHERE source_id = ? OR target_id = ?'
        ).all(node.entityId, node.entityId) as any[];

        for (const rel of rels) {
          const nextId = rel.source_id === node.entityId ? rel.target_id : rel.source_id;
          const score = node.score * rel.strength * 0.7;

          if (!visited.has(nextId) && score > 0.1) {
            nextLayer.push({ entityId: nextId, score });
          }
        }
      }

      currentLayer = nextLayer;
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  applyTemporalDecay(): number {
    const relationships = this.db.prepare('SELECT * FROM relationships').all() as any[];
    let updated = 0;

    for (const rel of relationships) {
      const daysSince = (Date.now() - new Date(rel.last_reinforced).getTime()) / (1000 * 60 * 60 * 24);
      const newStrength = rel.strength * Math.exp(-daysSince / 30);

      // Just update strength, pruning happens later in consolidation
      this.db.prepare('UPDATE relationships SET strength = ? WHERE id = ?').run(newStrength, rel.id);
      updated++;
    }

    return updated;
  }

  getPreferences(domain?: string): any[] {
    if (domain) {
      return this.db.prepare(
        'SELECT * FROM entities WHERE type = ? AND (name LIKE ? OR description LIKE ?)'
      ).all('preference', `%${domain}%`, `%${domain}%`) as any[];
    }
    return this.db.prepare('SELECT * FROM entities WHERE type = ?').all('preference') as any[];
  }

  getByTimeRange(start?: Date, end?: Date): any[] {
    let query = 'SELECT * FROM entities WHERE 1=1';
    const params: any[] = [];

    if (start) {
      query += ' AND created_at >= ?';
      params.push(start.toISOString());
    }
    if (end) {
      query += ' AND created_at <= ?';
      params.push(end.toISOString());
    }

    query += ' ORDER BY created_at DESC LIMIT 20';
    return this.db.prepare(query).all(...params) as any[];
  }
}
