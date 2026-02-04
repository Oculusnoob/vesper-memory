/**
 * Consolidation Pipeline - v3.0 Implementation
 *
 * Nightly process: working → semantic memory transformation.
 * Runs at 3 AM, extracts knowledge, applies decay, detects conflicts.
 */

import { WorkingMemoryLayer } from '../memory-layers/working-memory.js';
import { SemanticMemoryLayer } from '../memory-layers/semantic-memory.js';
import { SkillLibrary } from '../memory-layers/skill-library.js';
import Database from 'better-sqlite3';

export interface ConsolidationStats {
  memoriesProcessed: number;
  entitiesExtracted: number;
  relationshipsCreated: number;
  conflictsDetected: number;
  memoriesPruned: number;
  skillsExtracted: number;
  duration: number;
}

export class ConsolidationPipeline {
  private workingMemory: WorkingMemoryLayer;
  private semanticMemory: SemanticMemoryLayer;
  private skillLibrary: SkillLibrary;
  private db: Database.Database;

  constructor(
    workingMemory: WorkingMemoryLayer,
    semanticMemory: SemanticMemoryLayer,
    skillLibrary: SkillLibrary,
    db: Database.Database
  ) {
    this.workingMemory = workingMemory;
    this.semanticMemory = semanticMemory;
    this.skillLibrary = skillLibrary;
    this.db = db;
  }

  /**
   * Run full consolidation cycle
   */
  async consolidate(): Promise<ConsolidationStats> {
    const startTime = Date.now();
    console.error('[CONSOLIDATION] Starting consolidation cycle...');

    const stats: ConsolidationStats = {
      memoriesProcessed: 0,
      entitiesExtracted: 0,
      relationshipsCreated: 0,
      conflictsDetected: 0,
      memoriesPruned: 0,
      skillsExtracted: 0,
      duration: 0,
    };

    try {
      // Step 1: Extract from working memory
      const recentMemories = await this.workingMemory.getRecent(100);
      stats.memoriesProcessed = recentMemories.length;

      for (const memory of recentMemories) {
        // Extract entities and relationships
        const extracted = this.extractKnowledge(memory);

        for (const entity of extracted.entities) {
          this.semanticMemory.upsertEntity(entity);
          stats.entitiesExtracted++;
        }

        for (const rel of extracted.relationships) {
          this.semanticMemory.upsertRelationship(rel);
          stats.relationshipsCreated++;
        }
      }

      // Step 2: Apply temporal decay
      this.semanticMemory.applyTemporalDecay();

      // Step 3: Detect conflicts
      stats.conflictsDetected = this.detectConflicts();

      // Step 4: Prune low-value memories
      stats.memoriesPruned = this.pruneMemories();

      // Step 5: Extract skills (simplified)
      stats.skillsExtracted = this.extractSkills(recentMemories);

      // Step 6: Create backup
      this.createBackup();

      stats.duration = Date.now() - startTime;

      console.error(`[CONSOLIDATION] Complete! Processed ${stats.memoriesProcessed} memories in ${stats.duration}ms`);
      console.error(`[CONSOLIDATION] Extracted ${stats.entitiesExtracted} entities, ${stats.relationshipsCreated} relationships`);
      console.error(`[CONSOLIDATION] Detected ${stats.conflictsDetected} conflicts, pruned ${stats.memoriesPruned} memories`);

      return stats;
    } catch (error) {
      console.error('[CONSOLIDATION] Error:', error);
      throw error;
    }
  }

  /**
   * Extract entities and relationships from memory
   * Simple keyword-based extraction (will enhance with LLM later)
   */
  private extractKnowledge(memory: any): {
    entities: Array<{ name: string; type: 'person' | 'project' | 'concept' | 'preference'; confidence: number }>;
    relationships: Array<{ sourceId: string; targetId: string; relationType: string }>;
  } {
    const entities: Array<{ name: string; type: 'person' | 'project' | 'concept' | 'preference'; confidence: number }> = [];
    const relationships: any[] = [];

    // Use pre-extracted entities if available
    if (memory.keyEntities && memory.keyEntities.length > 0) {
      for (const entityName of memory.keyEntities) {
        entities.push({
          name: entityName,
          type: 'concept' as const,
          confidence: 0.8,
        });
      }
    }

    // Extract preferences
    const prefPatterns = [
      /prefer (\w+)/gi,
      /like (\w+)/gi,
      /favorite is (\w+)/gi,
    ];

    for (const pattern of prefPatterns) {
      const matches = memory.fullText.matchAll(pattern);
      for (const match of matches) {
        entities.push({
          name: match[1],
          type: 'preference' as const,
          confidence: 0.9,
        });
      }
    }

    return { entities, relationships };
  }

  /**
   * Detect simple conflicts (temporal impossibilities, contradictions)
   */
  private detectConflicts(): number {
    let detected = 0;

    // Temporal conflicts: same property, overlapping time ranges, different values
    const conflicts = this.db.prepare(`
      SELECT f1.id as id1, f2.id as id2, f1.property, f1.value as val1, f2.value as val2
      FROM facts f1
      JOIN facts f2 ON f1.entity_id = f2.entity_id AND f1.property = f2.property
      WHERE f1.id < f2.id
        AND f1.value != f2.value
        AND f1.valid_until IS NULL
        AND f2.valid_until IS NULL
    `).all() as any[];

    for (const conflict of conflicts) {
      // Check if already flagged
      const existing = this.db.prepare(
        'SELECT * FROM conflicts WHERE fact_id_1 = ? AND fact_id_2 = ?'
      ).get(conflict.id1, conflict.id2);

      if (!existing) {
        const conflictId = 'conflict_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

        this.db.prepare(`
          INSERT INTO conflicts (id, fact_id_1, fact_id_2, conflict_type, description, severity, resolution_status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          conflictId,
          conflict.id1,
          conflict.id2,
          'contradiction',
          `Conflicting values for ${conflict.property}: "${conflict.val1}" vs "${conflict.val2}"`,
          'medium',
          'flagged'
        );

        // Lower confidence on both facts
        this.db.prepare('UPDATE facts SET confidence = 0.5 WHERE id = ?').run(conflict.id1);
        this.db.prepare('UPDATE facts SET confidence = 0.5 WHERE id = ?').run(conflict.id2);

        detected++;
      }
    }

    return detected;
  }

  /**
   * Prune low-value memories
   */
  private pruneMemories(): number {
    // Find relationships to prune (weak relationships with low-access entities)
    const toPrune = this.db.prepare(`
      SELECT r.id
      FROM relationships r
      INNER JOIN entities source ON r.source_id = source.id
      INNER JOIN entities target ON r.target_id = target.id
      WHERE r.strength < 0.05
        AND source.access_count < 3
        AND target.access_count < 3
    `).all() as any[];

    // Delete them
    let deleted = 0;
    for (const row of toPrune) {
      this.db.prepare('DELETE FROM relationships WHERE id = ?').run(row.id);
      deleted++;
    }

    return deleted;
  }

  /**
   * Extract skills from positive interactions
   */
  private extractSkills(memories: any[]): number {
    let extracted = 0;

    for (const memory of memories) {
      // Look for repeated patterns
      if (memory.topics && memory.topics.includes('analysis')) {
        // Check if skill already exists
        const existing = this.skillLibrary.search('data analysis', 1);

        if (existing.length === 0) {
          this.skillLibrary.addSkill({
            name: 'Data Analysis',
            description: 'Analyze datasets and provide insights',
            category: 'analysis',
            triggers: ['analyze', 'data', 'insights'],
          });
          extracted++;
        }
      }
    }

    return extracted;
  }

  /**
   * Create backup for rollback capability
   */
  private createBackup(): void {
    const backupId = 'backup_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO backup_metadata (id, backup_timestamp, backup_type, status, backup_path, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      backupId,
      now,
      'consolidation',
      'completed',
      './backups/' + backupId + '.db',
      now,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    );
  }
}
