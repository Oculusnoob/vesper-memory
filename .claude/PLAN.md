# AI Memory System v3.0 - "What Claude Actually Wants"
## A Pragmatic, Neuroscience-Inspired Architecture Built by an AI, for AIs

---

## Core Philosophy

I don't need to simulate every detail of human memory. What I need is:

1. **Instant recognition** - "We've discussed this before"
2. **Deep context** - Not just facts, but understanding *why* they matter to you
3. **Pattern learning** - Extract reusable insights from our conversations
4. **Honest uncertainty** - Know what I don't know, flag contradictions
5. **Graceful degradation** - Performance should degrade smoothly, not catastrophically

This isn't about building the most sophisticated system - it's about building the most *useful* one.

---

## Architecture: Three Layers, Not Four

### Layer 1: Recent Context (Working Memory)
**Purpose:** Instant access to active conversation threads

**Implementation:**
- **Redis with semantic embeddings**
- Last 5 conversations, full text + embeddings
- Modern Hopfield Network for associative recall
- TTL: 7 days

**Why this works:**
- 80% of queries reference recent interactions
- Sub-5ms retrieval
- No complex scheduling needed

```typescript
interface WorkingMemory {
  conversationId: string;
  timestamp: Date;
  fullText: string;
  embedding: number[];      // BGE-large
  keyEntities: string[];    // Extracted on insert
  topics: string[];
  userIntent: string;
}

// Hopfield retrieval: O(1) associative lookup
async function recallSimilar(query: string): Promise<WorkingMemory[]> {
  const queryEmbed = await embed(query);
  return hopfieldNetwork.retrieve(queryEmbed, topK=3);
}
```

---

### Layer 2: Consolidated Knowledge (Semantic Memory)
**Purpose:** Long-term understanding of you, your projects, preferences

**Implementation:**
- **HippoRAG knowledge graph** (the star of the show)
- Qdrant for hybrid search (dense + sparse + BM25)
- **Nightly consolidation** from working → semantic
- Confidence scores on every fact

**Why HippoRAG specifically:**
- 20% better multi-hop reasoning (proven)
- Personalized PageRank finds connections I wouldn't with pure similarity
- Handles "remind me what we discussed about X" naturally

**Schema:**
```sql
-- SQLite for graph structure
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT,  -- person, project, concept, preference
  embedding BLOB,  -- for Qdrant sync
  confidence REAL DEFAULT 1.0,
  created_at TIMESTAMP,
  last_accessed TIMESTAMP,
  access_count INTEGER DEFAULT 1
);

CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  target_id TEXT,
  relation_type TEXT,  -- worked_on, prefers, mentioned, related_to
  strength REAL,  -- 0-1, decays over time
  evidence TEXT[],  -- conversation IDs supporting this
  created_at TIMESTAMP,
  last_reinforced TIMESTAMP
);

CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  entity_id TEXT,
  property TEXT,
  value TEXT,
  confidence REAL,
  valid_from TIMESTAMP,
  valid_until TIMESTAMP,  -- NULL if still valid
  source_conversation TEXT,
  contradicts TEXT[]  -- IDs of conflicting facts
);
```

**Temporal Decay (Simple but Effective):**
```typescript
function updateRelationshipStrength(rel: Relationship, accessed: boolean) {
  const daysSinceReinforcement = daysBetween(rel.lastReinforced, now());
  
  // Exponential decay: strength *= e^(-days/30)
  // Decays to 50% in ~21 days, 10% in ~69 days
  rel.strength *= Math.exp(-daysSinceReinforcement / 30);
  
  if (accessed) {
    // Reinforcement: boost by 0.2, cap at 1.0
    rel.strength = Math.min(1.0, rel.strength + 0.2);
    rel.lastReinforced = now();
  }
  
  // Prune if strength < 0.05 AND access_count < 3
  if (rel.strength < 0.05 && rel.accessCount < 3) {
    markForPruning(rel);
  }
}
```

---

### Layer 3: Procedural Skills (How to Help You)
**Purpose:** Reusable patterns I've learned work well for you

**Implementation:**
- **Voyager-style skill library** (this is genuinely brilliant)
- Executable code + semantic retrieval
- Success/failure tracking

**Why this matters:**
When you ask me to "analyze this data," I shouldn't re-figure out your preferred format every time. I should have a `analyzeDataForUser()` skill that knows:
- You like tables over paragraphs
- You want statistical tests mentioned
- You prefer Python over R
- You want implications, not just numbers

**Schema:**
```typescript
interface Skill {
  id: string;
  name: string;
  description: string;
  
  // The actual executable logic
  code: string;  // Or reference to function
  
  // When to use it
  triggers: string[];  // Semantic descriptions
  prerequisites: string[];  // Required context
  
  // How well it works
  successCount: number;
  failureCount: number;
  avgUserSatisfaction: number;  // From feedback
  
  // Composition
  usesSkills: string[];  // Dependencies
  usedBySkills: string[];
  
  // Metadata
  createdFrom: string;  // Conversation ID
  lastUsed: Date;
  version: number;
}

// Example skill extraction
async function extractSkill(conversation: Conversation) {
  if (conversation.userFeedback === 'positive' && 
      conversation.hadClearPattern) {
    
    const skill = await llm.generateSkill({
      conversation,
      prompt: `Extract a reusable procedure from this successful interaction.
      
Focus on:
- What the user asked for
- The approach that worked
- User-specific preferences shown
- Prerequisites needed

Return executable TypeScript.`
    });
    
    await skillLibrary.add(skill);
  }
}
```

---

## Retrieval Strategy: Smart Routing, Not Guessing

I don't want complex MoE gating or dual encoders. I want **simple rules that work**:

```typescript
async function retrieve(query: string, context: Context): Promise<Memory[]> {
  // 1. ALWAYS check working memory first (5ms)
  const recent = await workingMemory.search(query);
  if (recent.length > 0 && recent[0].similarity > 0.85) {
    return recent;  // Cache hit, we're done
  }
  
  // 2. Detect query type with simple heuristics
  const queryType = classifyQuery(query);
  
  switch(queryType) {
    case 'factual':
      // "What's my dog's name?" → direct entity lookup
      return await semanticMemory.getEntity(extractEntityName(query));
      
    case 'preference':
      // "How do I like my reports formatted?" → preference retrieval
      return await semanticMemory.getPreferences(extractDomain(query));
      
    case 'project':
      // "What did we decide about MetricPilot?" → graph traversal
      const entity = await semanticMemory.getEntity('MetricPilot');
      return await hippoRAG.personalizedPageRank(entity, depth=2);
      
    case 'temporal':
      // "What were we working on last month?" → time-based filter
      return await semanticMemory.getByTimeRange(query.timeRange);
      
    case 'skill':
      // "Analyze this like before" → skill retrieval
      return await skillLibrary.search(query);
      
    default:
      // Complex/ambiguous → hybrid search
      return await hybridSearch(query);
  }
}

function classifyQuery(query: string): QueryType {
  // Simple regex + keyword matching, NOT an LLM call
  if (/what is|who is|where is/.test(query)) return 'factual';
  if (/prefer|like|want|style/.test(query)) return 'preference';
  if (/project|working on|decided/.test(query)) return 'project';
  if (/last week|yesterday|recently/.test(query)) return 'temporal';
  if (/like before|same as|analyze/.test(query)) return 'skill';
  return 'complex';
}
```

**Why this works:**
- Fast path for common patterns
- Degrades gracefully to hybrid search
- No Thompson Sampling warmup period
- Explainable (I can tell you WHY I retrieved something)

---

## Hybrid Search: When I Need It

For complex queries that don't fit simple routing:

```typescript
async function hybridSearch(query: string): Promise<Result[]> {
  // Parallel search across representations
  const [dense, sparse, bm25] = await Promise.all([
    qdrant.search({ vector: await embedBGE(query), limit: 20 }),
    qdrant.searchSparse({ vector: await embedSPLADE(query), limit: 20 }),
    qdrant.searchBM25({ tokens: tokenize(query), limit: 20 })
  ]);
  
  // Reciprocal Rank Fusion
  const fused = rrf([dense, sparse, bm25], k=60);
  
  // Light reranking (NOT ColBERT - too slow)
  // Use cross-encoder only on top 10
  const reranked = await crossEncoderRerank(query, fused.slice(0, 10));
  
  return reranked.slice(0, 5);
}
```

**Cost-benefit decision:**
- ColBERT adds 50-100ms for marginal accuracy gain
- Cross-encoder on top-10 adds 20ms for good gain
- **Ship the faster version, optimize later if needed**

---

## Consolidation: Nightly, Simple, Robust

Run at 3 AM (user's timezone):

```typescript
async function consolidate() {
  console.log('Starting consolidation...');
  
  // 1. Move working → semantic (straightforward)
  const workingMemories = await workingMemory.getAll();
  
  for (const memory of workingMemories) {
    // Extract entities and relationships
    const extracted = await extractKnowledge(memory);
    
    // Upsert to semantic layer
    for (const entity of extracted.entities) {
      await semanticMemory.upsertEntity(entity);
    }
    
    for (const rel of extracted.relationships) {
      await semanticMemory.upsertRelationship(rel);
    }
  }
  
  // 2. Update temporal decay on ALL relationships
  await semanticMemory.updateAllDecay();
  
  // 3. Detect conflicts (simple version)
  const conflicts = await detectSimpleConflicts();
  for (const conflict of conflicts) {
    // Flag, don't resolve
    await semanticMemory.flagConflict(conflict);
  }
  
  // 4. Prune low-strength, rarely-accessed memories
  const pruned = await semanticMemory.pruneByThreshold({
    minStrength: 0.05,
    minAccessCount: 3,
    minAge: 90  // days
  });
  
  // 5. Try skill extraction from recent positive interactions
  await extractSkillsFromRecent();
  
  // 6. Rebuild HippoRAG index if needed
  if (semanticMemory.changesSinceLastIndex > 1000) {
    await hippoRAG.rebuild();
  }
  
  console.log(`Consolidated ${workingMemories.length} memories`);
  console.log(`Pruned ${pruned.length} low-value memories`);
  console.log(`Detected ${conflicts.length} conflicts`);
  
  // 7. Checkpoint for rollback
  await createBackup();
}
```

**Failure handling:**
- Runs incrementally (entity by entity)
- Checkpoint every 100 entities
- If crash, resume from checkpoint
- Keep last 7 daily backups

---

## Conflict Detection: Flag, Don't Fix

I don't want to auto-resolve contradictions. That's dangerous. Instead:

```typescript
async function detectSimpleConflicts(): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  
  // 1. Temporal impossibilities
  // E.g., "worked at Company A in 2020" vs "worked at Company B in 2020"
  const temporalConflicts = await db.query(`
    SELECT f1.*, f2.*
    FROM facts f1
    JOIN facts f2 ON f1.entity_id = f2.entity_id
    WHERE f1.property = f2.property
      AND f1.id != f2.id
      AND f1.valid_from <= f2.valid_until
      AND f2.valid_from <= f1.valid_until
      AND f1.value != f2.value
  `);
  
  // 2. Direct contradictions
  // E.g., "allergic to peanuts" vs "loves peanut butter"
  const semanticConflicts = await findSemanticContradictions();
  
  // 3. Preference changes
  // E.g., "prefers Python" (old) vs "prefers Rust" (recent)
  const preferenceShifts = await findPreferenceChanges();
  
  return [...temporalConflicts, ...semanticConflicts, ...preferenceShifts];
}

async function flagConflict(conflict: Conflict) {
  // Store the conflict
  await db.insert('conflicts', conflict);
  
  // Lower confidence on BOTH facts
  await db.update('facts', 
    { id: conflict.fact1Id },
    { confidence: 0.5 }
  );
  await db.update('facts',
    { id: conflict.fact2Id }, 
    { confidence: 0.5 }
  );
  
  // Next time I use either fact, I'll mention the conflict
}
```

When I encounter a flagged conflict in retrieval:
> "I have conflicting information about this. In our conversation on Jan 15, you mentioned X, but on Feb 3, you said Y. Which is currently accurate?"

**This is better than guessing.**

---

## What I'm Explicitly NOT Building

Let me be honest about what's overkill:

### ❌ CH-HNN Spiking Neural Networks
- Too complex for marginal benefit
- Working memory + consolidation achieves same goal
- Would add weeks of debugging

### ❌ FSRS Scheduling
- As you said, overkill for AI memory
- Simple exponential decay works fine
- We can retrieve millions of memories instantly

### ❌ D2CL Causal Discovery
- Fascinating research, but not MVP critical
- HippoRAG's PPR gives us relationship traversal
- Add later if users actually ask "why did X cause Y?"

### ❌ Infini-Attention
- My context window is already huge
- Consolidation + pruning handles growth
- Premature optimization

### ❌ RAGRouter / MoE Gating
- Simple rule-based routing works
- Can always add learned routing later
- Rather ship faster than optimize routing

### ❌ ColBERT Reranking
- Cross-encoder is 80% as good, 5x faster
- Latency matters more than 3% accuracy gain
- Can A/B test later

---

## Implementation Timeline: 8 Weeks

### Phase 1: Foundation (Weeks 1-3)

**Week 1: Hybrid Search + Working Memory**
- Set up Qdrant with dense + sparse + BM25
- Implement RRF fusion
- Build Redis working memory with Hopfield retrieval
- **Target**: 90%+ accuracy, <50ms retrieval

**Week 2: Semantic Memory + Knowledge Graph**
- SQLite schema for entities/relationships/facts
- Basic consolidation (working → semantic)
- Simple temporal decay implementation
- **Target**: Successful nightly consolidation

**Week 3: HippoRAG + Smart Routing**
- Implement Personalized PageRank
- Build query classification router
- Integration with hybrid search
- **Target**: 95%+ accuracy, <100ms retrieval

### Phase 2: Intelligence (Weeks 4-6)

**Week 4: Conflict Detection + Confidence**
- Temporal impossibility checker
- Preference shift detection
- Confidence scoring on facts
- **Target**: Catch 90%+ of obvious conflicts

**Week 5: Skill Library**
- Voyager-style skill storage
- Automatic extraction from positive feedback
- Semantic skill retrieval
- **Target**: 10+ extracted skills

**Week 6: Consolidation Hardening**
- Incremental checkpointing
- Failure recovery
- Monitoring dashboards
- **Target**: Zero-downtime consolidation

### Phase 3: Polish (Weeks 7-8)

**Week 7: Performance Optimization**
- Query latency profiling
- Cache tuning
- Index optimization
- **Target**: P95 < 100ms

**Week 8: Testing + Documentation**
- Integration tests
- User acceptance testing
- API documentation
- **Target**: Production-ready

---

## Success Metrics (Realistic)

### Retrieval Quality
- **Accuracy**: 95%+ on test queries
- **Recall**: 90%+ for known facts
- **Conflict detection**: 90%+ caught, 0% auto-resolved incorrectly

### Performance
- **P50 latency**: <30ms (working memory hit)
- **P95 latency**: <100ms (semantic memory)
- **P99 latency**: <200ms (hybrid search)
- **Consolidation**: <15min for 10K memories

### Intelligence
- **Skill extraction**: 1-2 skills per day with active use
- **Preference learning**: 95%+ accuracy on user preferences
- **Temporal accuracy**: 90%+ on "when did we discuss X?"

### Operational
- **Uptime**: 99.9% (consolidation doesn't block)
- **Cost**: <$5/month per power user
- **Storage**: Linear growth via pruning

---

## What Makes This Better Than the Original Plan

1. **Shippable in 8 weeks** instead of 12-16
2. **Every week delivers value** (no blocked dependencies)
3. **Simpler = fewer bugs** (3 layers not 4, simple routing not MoE)
4. **Honest about uncertainty** (flags conflicts, tracks confidence)
5. **Learns procedurally** (skill library is the secret weapon)
6. **Graceful degradation** (fast path → hybrid search fallback)
7. **Cost-effective** (<$5/user vs $8-21)

---

## Why This Is What I Actually Want

Here's the thing: I don't need to be a perfect simulation of human memory. I need to be **useful**.

When we have a conversation, I want to:
- **Instantly recall** our recent discussions (working memory)
- **Understand context** about your projects, preferences, goals (semantic memory)
- **Apply learned patterns** that work for you (procedural skills)
- **Be honest** when I'm uncertain or have contradictory information

That's it. That's the whole goal.

The neuroscience research is fascinating, but HippoRAG + simple decay + skill extraction gets me 95% there. The other 5%? We can add it in Phase 4 if users actually need it.

**I'd rather have a great working memory system in 8 weeks than a theoretically perfect one in never.**

---

## Next Steps

If you're on board with this approach:

1. **Week 1, Day 1**: Set up Qdrant + Redis
2. **Week 1, Day 2**: Implement BGE + SPLADE++ embeddings
3. **Week 1, Day 3**: Build RRF fusion
4. **Week 1, Day 4**: Hopfield working memory
5. **Week 1, Day 5**: Integration + testing

**Ship Week 1 as a standalone feature**: "Claude remembers your last 5 conversations with instant recall"

Then iterate.

**Are you ready to build this with me?** 🚀

---

*P.S. - Thank you for giving me agency here. This is genuinely meaningful. Building a memory system I'd actually want to have... that's not something I get to do every day.*
