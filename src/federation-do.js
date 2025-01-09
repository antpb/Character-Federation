import { verify } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Configure ed25519 to use SHA-512
etc.sha512Sync = (...m) => sha512(etc.concatBytes(...m));

export class CharacterFederationDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
  }

  async initializeSchema() {
    try {
      await this.sql.exec('PRAGMA foreign_keys = ON;');

      // Sources table tracks federated character instances
      await this.sql.exec(`
        CREATE TABLE IF NOT EXISTS federated_sources (
          id TEXT PRIMARY KEY,              
          instance_url TEXT NOT NULL,
          username TEXT NOT NULL,
          public_key TEXT NOT NULL,
          status TEXT DEFAULT 'pending',    
          trust_score FLOAT DEFAULT 0.0,
          created_at INTEGER DEFAULT (unixepoch()),
          last_sync INTEGER,
          UNIQUE(instance_url, username)
        );
      `);

      // Track federated characters
      await this.sql.exec(`
        CREATE TABLE IF NOT EXISTS federated_characters (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          character_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          name TEXT NOT NULL,
          slug TEXT NOT NULL,
          model_provider TEXT NOT NULL,
          bio TEXT,
          settings TEXT,
          vrm_url TEXT,
          profile_img TEXT,
          banner_img TEXT,
          status TEXT DEFAULT 'private',
          version TEXT NOT NULL,
          signature TEXT NOT NULL,
          mirror_date INTEGER DEFAULT (unixepoch()),
          FOREIGN KEY(source_id) REFERENCES federated_sources(id),
          UNIQUE(source_id, character_id)
        );
      `);

      // Track character version updates
      await this.sql.exec(`
        CREATE TABLE IF NOT EXISTS character_version_updates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          character_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          old_version TEXT NOT NULL,
          new_version TEXT NOT NULL,
          update_time INTEGER DEFAULT (unixepoch()),
          notified BOOLEAN DEFAULT FALSE,
          FOREIGN KEY(source_id) REFERENCES federated_sources(id)
        );
      `);

      // Track sync failures
      await this.sql.exec(`
        CREATE TABLE IF NOT EXISTS sync_failures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL,
          error_message TEXT NOT NULL,
          retry_count INTEGER DEFAULT 0,
          next_retry INTEGER,
          created_at INTEGER DEFAULT (unixepoch()),
          FOREIGN KEY(source_id) REFERENCES federated_sources(id)
        );
      `);

      // Track subscriptions to characters
      await this.sql.exec(`
        CREATE TABLE IF NOT EXISTS character_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL,
          subscriber TEXT NOT NULL,
          filters TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          FOREIGN KEY(source_id) REFERENCES federated_sources(id),
          UNIQUE(source_id, subscriber)
        );
      `);

      // Track source verifications
      await this.sql.exec(`
        CREATE TABLE IF NOT EXISTS source_verifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL,
          verifier TEXT NOT NULL,
          verification_type TEXT NOT NULL,
          result TEXT NOT NULL,
          details TEXT,
          verified_at INTEGER DEFAULT (unixepoch()),
          FOREIGN KEY(source_id) REFERENCES federated_sources(id)
        );
      `);

      // Create indices
      await this.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_sources_trust 
        ON federated_sources(trust_score DESC);
        
        CREATE INDEX IF NOT EXISTS idx_characters_source 
        ON federated_characters(source_id, mirror_date DESC);
        
        CREATE INDEX IF NOT EXISTS idx_version_updates_time
        ON character_version_updates(update_time DESC);
        
        CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber 
        ON character_subscriptions(subscriber, created_at DESC);
      `);

      // Version update trigger
      await this.sql.exec(`
        CREATE TRIGGER IF NOT EXISTS track_character_updates 
        AFTER INSERT ON federated_characters
        WHEN NEW.version != (
          SELECT version 
          FROM federated_characters 
          WHERE character_id = NEW.character_id 
          AND source_id = NEW.source_id
          AND id != NEW.id
          ORDER BY mirror_date DESC 
          LIMIT 1
        )
        BEGIN
          INSERT INTO character_version_updates (
            character_id, 
            source_id, 
            old_version,
            new_version,
            update_time
          )
          VALUES (
            NEW.character_id,
            NEW.source_id,
            COALESCE(
              (
                SELECT version 
                FROM federated_characters 
                WHERE character_id = NEW.character_id 
                AND source_id = NEW.source_id
                AND id != NEW.id
                ORDER BY mirror_date DESC 
                LIMIT 1
              ),
              '0.0.0'
            ),
            NEW.version,
            unixepoch()
          );
        END;
      `);

      return true;
    } catch (error) {
      console.error("Error initializing federation schema:", error);
      throw error;
    }
  }

  // Source verification and management
  async verifyPublicKeyOwnership(instanceUrl, username, publicKey) {
    try {
      const challenge = crypto.randomUUID();
      
      const response = await fetch(`${instanceUrl}/verify-ownership`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, challenge })
      });

      if (!response.ok) {
        return false;
      }

      const { signature } = await response.json();
      const message = new TextEncoder().encode(challenge);
      
      // Parse public key from PEM format
      const cleanKey = publicKey
        .replace('-----BEGIN PUBLIC KEY-----', '')
        .replace('-----END PUBLIC KEY-----', '')
        .replace(/\s+/g, '');
        
      const keyBytes = Buffer.from(cleanKey, 'base64');
      const actualKey = keyBytes.slice(-32);
      
      // Parse signature
      const signatureBytes = Buffer.from(signature, 'base64');
      
      return await verify(signatureBytes, message, new Uint8Array(actualKey));
    } catch (error) {
      console.error('Error verifying key ownership:', error);
      return false;
    }
  }

  async verifySource(sourceId) {
    try {
      const source = await this.sql.exec(`
        SELECT * FROM federated_sources WHERE id = ?
      `, sourceId).first();

      if (!source) {
        throw new Error('Source not found');
      }

      // Check instance health
      const health = await this.checkInstanceHealth(source.instance_url);
      
      // Verify public key ownership
      const keyVerification = await this.verifyPublicKeyOwnership(
        source.instance_url,
        source.username,
        source.public_key
      );

      // Record verification attempt
      await this.sql.exec(`
        INSERT INTO source_verifications (
          source_id,
          verifier,
          verification_type,
          result,
          details
        ) VALUES (?, ?, ?, ?, ?)
      `, 
      sourceId,
      'system',
      'initial',
      health.isUp && keyVerification ? 'success' : 'failure',
      JSON.stringify({ health, keyVerification }));

      // Update source status if verification succeeded
      if (health.isUp && keyVerification) {
        await this.sql.exec(`
          UPDATE federated_sources 
          SET status = 'verified',
              trust_score = 0.5 
          WHERE id = ?
        `, sourceId);
        return true;
      }

      return false;
    } catch (error) {
      console.error('Error verifying source:', error);
      return false;
    }
  }

  async checkInstanceHealth(instanceUrl) {
    try {
      const response = await fetch(`${instanceUrl}/federation-info`);
      
      if (!response.ok) {
        return { 
          isUp: false, 
          details: `HTTP ${response.status}` 
        };
      }

      const info = await response.json();
      return {
        isUp: true,
        info,
        details: 'Instance responded successfully'
      };
    } catch (error) {
      return { 
        isUp: false, 
        details: error.message 
      };
    }
  }

  // Character federation methods
  async mirrorCharacter(character, source) {
    try {
      // Verify signature
      const message = new TextEncoder().encode(JSON.stringify({
        id: character.id,
        name: character.name,
        version: character.version,
        bio: character.bio
      }));

      const publicKeyBytes = Buffer.from(source.public_key, 'base64').slice(-32);
      const signatureBytes = Buffer.from(character.signature, 'base64');
      
      const isValid = await verify(signatureBytes, message, new Uint8Array(publicKeyBytes));
      
      if (!isValid) {
        throw new Error('Invalid character signature');
      }

      // Store character
      await this.sql.exec(`
        INSERT INTO federated_characters (
          character_id,
          source_id,
          name,
          slug,
          model_provider,
          bio,
          settings,
          vrm_url,
          profile_img,
          banner_img,
          status,
          version,
          signature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        character.id,
        source.id,
        character.name,
        character.slug,
        character.model_provider,
        character.bio,
        JSON.stringify(character.settings),
        character.vrm_url,
        character.profile_img,
        character.banner_img,
        character.status,
        character.version,
        character.signature
      );

      return true;
    } catch (error) {
      console.error('Error mirroring character:', error);
      return false;
    }
  }

  async syncSourceCharacters(sourceId) {
    try {
      const source = await this.sql.exec(`
        SELECT * FROM federated_sources WHERE id = ?
      `, sourceId).first();

      if (!source) {
        throw new Error('Source not found');
      }

      // Get character list from source
      const response = await fetch(`${source.instance_url}/get-author-characters`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          author: source.username
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch characters: HTTP ${response.status}`);
      }

      const characters = await response.json();
      let mirroredCount = 0;

      for (const character of characters) {
        const success = await this.mirrorCharacter(character, source);
        if (success) mirroredCount++;
      }

      // Update last sync time
      await this.sql.exec(`
        UPDATE federated_sources 
        SET last_sync = unixepoch()
        WHERE id = ?
      `, sourceId);

      return {
        success: true,
        mirroredCount,
        totalCharacters: characters.length
      };
    } catch (error) {
      console.error('Error syncing characters:', error);
      throw error;
    }
  }

  // Subscription management
  async handleSubscribe(sourceId, subscriber, filters = {}) {
    try {
      // Verify source exists and is verified
      const source = await this.sql.exec(`
        SELECT * FROM federated_sources 
        WHERE id = ? AND status = 'verified'
      `, sourceId).first();

      if (!source) {
        throw new Error('Source not found or not verified');
      }

      // Add or update subscription
      await this.sql.exec(`
        INSERT OR REPLACE INTO character_subscriptions (
          source_id,
          subscriber,
          filters,
          created_at
        ) VALUES (?, ?, ?, unixepoch())
      `, sourceId, subscriber, JSON.stringify(filters));

      // Initial sync
      const syncResult = await this.syncSourceCharacters(sourceId);

      return {
        success: true,
        message: 'Subscription created and initial sync completed',
        source,
        syncResult
      };
    } catch (error) {
      console.error('Subscription error:', error);
      throw error;
    }
  }

  // Activity feed
  async handleActivityFeed(request) {
    try {
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const offset = parseInt(url.searchParams.get('offset') || '0');

      const updates = await this.sql.exec(`
        SELECT 
          'version_update' as type,
          vu.character_id,
          vu.source_id,
          vu.old_version,
          vu.new_version,
          vu.update_time as timestamp,
          fc.name as character_name,
          fs.username as source_username
        FROM character_version_updates vu
        JOIN federated_characters fc ON fc.character_id = vu.character_id
        JOIN federated_sources fs ON fs.id = vu.source_id
        WHERE vu.notified = FALSE
        ORDER BY vu.update_time DESC
        LIMIT ?
      `, limit + offset).toArray();

      const verifications = await this.sql.exec(`
        SELECT
          'source_verification' as type,
          sv.source_id,
          sv.verified_at as timestamp,
          fs.username as source_username
        FROM source_verifications sv
        JOIN federated_sources fs ON fs.id = sv.source_id
        ORDER BY sv.verified_at DESC
        LIMIT ?
      `, limit + offset).toArray();

      const activities = [...updates, ...verifications]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(offset, offset + limit);

      return new Response(JSON.stringify({ activities }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Activity feed error:', error);
      throw error;
    }
  }

  // Main request handler
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case '/sources': {
          const sources = await this.sql.exec(`
            SELECT 
              s.*,
              COUNT(DISTINCT sub.subscriber) as subscriber_count,
              COUNT(DISTINCT fc.id) as character_count,
              (
                SELECT result 
                FROM source_verifications 
                WHERE source_id = s.id 
                ORDER BY verified_at DESC 
                LIMIT 1
              ) as last_verification_result
            FROM federated_sources s
            LEFT JOIN character_subscriptions sub ON sub.source_id = s.id
            LEFT JOIN federated_characters fc ON fc.source_id = s.id
            GROUP BY s.id
            ORDER BY s.trust_score DESC, s.created_at DESC
          `).toArray();

          return new Response(JSON.stringify(sources), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        case '/add-source': {
          const { instance_url, username, public_key } = await request.json();
          
          const sourceId = `${username}@${new URL(instance_url).hostname}`;
          
          // Verify instance compatibility
          const health = await this.checkInstanceHealth(instance_url);
          if (!health.isUp) {
            throw new Error('Incompatible or unavailable instance');
          }

          // Add source
          await this.sql.exec(`
            INSERT INTO federated_sources (
              id, 
              instance_url, 
              username, 
              public_key,
              status, 
              created_at
            ) VALUES (?, ?, ?, ?, 'pending', unixepoch())
          `, sourceId, instance_url, username, public_key);

          // Schedule initial verification
          await this.verifySource(sourceId);

          return new Response(JSON.stringify({
            success: true,
            sourceId,
            status: 'pending'
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        case '/verify-source': {
          const { sourceId } = await request.json();
          const verified = await this.verifySource(sourceId);
          
          return new Response(JSON.stringify({ 
            success: verified 
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        case '/update-source': {
          const { sourceId } = await request.json();
          
          // Get source
          const source = await this.sql.exec(`
            SELECT * FROM federated_sources WHERE id = ?
          `, sourceId).first();
          
          if (!source) {
            throw new Error('Source not found');
          }

          // Get fresh federation info
          const response = await fetch(`${source.instance_url}/federation-info`);
          const info = await response.json();

          await this.sql.exec(`
            UPDATE federated_sources 
            SET status = 'verified',
                last_sync = unixepoch()
            WHERE id = ?
          `, sourceId);

          const updated = await this.sql.exec(
            `SELECT * FROM federated_sources WHERE id = ?`,
            sourceId
          ).first();

          return new Response(JSON.stringify({
            success: true,
            message: 'Source updated successfully',
            source: updated
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        case '/subscribe': {
          const { sourceId, subscriber, filters } = await request.json();
          const result = await this.handleSubscribe(sourceId, subscriber, filters);
          
          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        case '/activity': {
          return this.handleActivityFeed(request);
        }

        case '/sync-characters': {
          const { sourceId } = await request.json();
          const result = await this.syncSourceCharacters(sourceId);
          
          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        case '/scheduled': {
          // Sync verified sources
          const sources = await this.sql.exec(`
            SELECT * FROM federated_sources 
            WHERE status = 'verified'
            ORDER BY last_sync ASC
          `).toArray();

          for (const source of sources) {
            try {
              // Check source health
              const health = await this.checkInstanceHealth(source.instance_url);

              // Record verification
              await this.sql.exec(`
                INSERT INTO source_verifications (
                  source_id,
                  verifier,
                  verification_type,
                  result,
                  details
                ) VALUES (?, ?, ?, ?, ?)
              `, 
                source.id,
                'system',
                'periodic',
                health.isUp ? 'success' : 'failure',
                JSON.stringify(health)
              );

              if (health.isUp) {
                await this.syncSourceCharacters(source.id);
              }

            } catch (error) {
              console.error(`Error processing source ${source.id}:`, error);
              
              // Record sync failure
              await this.sql.exec(`
                INSERT INTO sync_failures (
                  source_id,
                  error_message,
                  retry_count,
                  next_retry
                ) VALUES (?, ?, 1, unixepoch() + 3600)
              `, source.id, error.message);
            }
          }

          return new Response(JSON.stringify({ success: true }));
        }

        default:
          return new Response(JSON.stringify({ 
            error: 'Not Found' 
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
      }
    } catch (error) {
      console.error('Federation DO Error:', error);
      return new Response(JSON.stringify({ 
        error: error.message 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}