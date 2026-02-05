/**
 * Skill Library - v3.0 Voyager-Style Implementation
 *
 * Procedural memory: reusable patterns learned from conversations.
 *
 * Enhanced with lazy loading support for token efficiency.
 */

import Database from 'better-sqlite3';
import {
  SkillSummary,
  FullSkill,
  InvocationDetection,
  LazyLoadingSkillLibrary
} from './skill-lazy-loading.js';

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  triggers: string[];
  successCount: number;
  failureCount: number;
  avgSatisfaction: number;
}

// Re-export lazy loading types
export type { SkillSummary, FullSkill, InvocationDetection };

export class SkillLibrary {
  private db: Database.Database;
  private lazyLoader: LazyLoadingSkillLibrary;

  constructor(db: Database.Database) {
    this.db = db;
    this.lazyLoader = new LazyLoadingSkillLibrary(db);
  }

  addSkill(skill: Omit<Skill, 'id' | 'successCount' | 'failureCount' | 'avgSatisfaction'>): string {
    const id = 'skill_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    this.db.prepare(`
      INSERT INTO skills (id, name, description, category, triggers, success_count, failure_count, avg_user_satisfaction)
      VALUES (?, ?, ?, ?, ?, 0, 0, 0.5)
    `).run(
      id,
      skill.name,
      skill.description,
      skill.category,
      JSON.stringify(skill.triggers)
    );

    return id;
  }

  search(query: string, limit: number = 5): Skill[] {
    const queryLower = query.toLowerCase();

    const skills = this.db.prepare(
      'SELECT * FROM skills ORDER BY avg_user_satisfaction DESC, success_count DESC'
    ).all() as any[];

    const scored = skills
      .map(skill => {
        const triggers = JSON.parse(skill.triggers || '[]');
        const matchScore = triggers.some((t: string) =>
          queryLower.includes(t.toLowerCase()) || t.toLowerCase().includes(queryLower)
        ) ? 1 : 0;

        const nameMatch = skill.name.toLowerCase().includes(queryLower) ? 0.5 : 0;

        return {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          category: skill.category,
          triggers,
          successCount: skill.success_count,
          failureCount: skill.failure_count,
          avgSatisfaction: skill.avg_user_satisfaction,
          score: matchScore + nameMatch
        };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }

  recordSuccess(skillId: string, satisfaction: number): void {
    const skill = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as any;

    if (skill) {
      const newAvg = (skill.avg_user_satisfaction * skill.success_count + satisfaction) / (skill.success_count + 1);

      this.db.prepare(
        'UPDATE skills SET success_count = success_count + 1, avg_user_satisfaction = ? WHERE id = ?'
      ).run(newAvg, skillId);
    }
  }

  recordFailure(skillId: string): void {
    this.db.prepare('UPDATE skills SET failure_count = failure_count + 1 WHERE id = ?').run(skillId);
  }

  /**
   * Get skill summaries for lazy loading context injection
   *
   * Returns lightweight summaries (~50 tokens each) instead of full skills.
   * This reduces token usage by 80-90% for skill-related context.
   *
   * @param limit - Maximum number of summaries (default: 20)
   * @param category - Optional category filter
   * @returns Array of SkillSummary objects
   */
  getSummaries(limit: number = 20, category?: string): SkillSummary[] {
    return this.lazyLoader.getSummaries(limit, category);
  }

  /**
   * Load full skill implementation on-demand
   *
   * Used when a skill is explicitly invoked and full details are needed.
   * Results should be cached in working memory to avoid repeated loads.
   *
   * @param skillId - The skill ID to load
   * @returns FullSkill object or null if not found
   */
  loadFull(skillId: string): FullSkill | null {
    const fullSkill = this.lazyLoader.loadFull(skillId);

    // Update last_used timestamp when loading a skill
    if (fullSkill) {
      this.db.prepare(`
        UPDATE skills
        SET last_used = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(skillId);
    }

    return fullSkill;
  }

  /**
   * Detect if a query is attempting to invoke a specific skill
   *
   * Uses pattern matching to identify skill invocations.
   *
   * @param query - The user query
   * @returns InvocationDetection result with skill ID if detected
   */
  detectInvocation(query: string): InvocationDetection {
    const summaries = this.getSummaries(100); // Get all summaries for matching
    return this.lazyLoader.detectInvocation(query, summaries);
  }

  /**
   * Update last_used timestamp for a skill
   *
   * Called when a skill is successfully executed.
   *
   * @param skillId - The skill ID
   */
  updateLastUsed(skillId: string): void {
    this.db.prepare(`
      UPDATE skills
      SET last_used = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(skillId);
  }
}
