import { createRequire } from "node:module";

type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;

/**
 * Install database-level invariants that belong to the V3 runtime cutover rather
 * than to business migrations. This never creates/migrates application tables;
 * TravelStoreV3 must have already validated/created the complete fresh schema.
 */
export function installRuntimeInvariantsV3(filename: string) {
  const db = new DatabaseSync(filename);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TRIGGER IF NOT EXISTS v3_trip_generation_invalidates_stage_threads
      AFTER UPDATE OF content_generation ON trips
      WHEN NEW.content_generation <> OLD.content_generation
      BEGIN
        DELETE FROM stage_conversation_threads WHERE trip_id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS v3_stale_stage_thread_insert_is_discarded
      AFTER INSERT ON stage_conversation_threads
      WHEN NEW.context_generation <> (
        SELECT content_generation FROM trips WHERE id = NEW.trip_id
      )
      BEGIN
        DELETE FROM stage_conversation_threads
        WHERE trip_id = NEW.trip_id AND stage = NEW.stage;
      END;

      CREATE TRIGGER IF NOT EXISTS v3_stale_stage_thread_update_is_discarded
      AFTER UPDATE OF context_generation ON stage_conversation_threads
      WHEN NEW.context_generation <> (
        SELECT content_generation FROM trips WHERE id = NEW.trip_id
      )
      BEGIN
        DELETE FROM stage_conversation_threads
        WHERE trip_id = NEW.trip_id AND stage = NEW.stage;
      END;

      CREATE TRIGGER IF NOT EXISTS v3_deterministic_action_completed_means_applied
      AFTER UPDATE OF status ON ai_actions
      WHEN NEW.executor = 'deterministic' AND NEW.status = 'completed'
      BEGIN
        UPDATE ai_actions
        SET status = 'applied'
        WHERE id = NEW.id AND status = 'completed';
      END;
    `);
  } finally {
    db.close();
  }
}
