import { Msg, decode, tags } from "@vlcn.io-community/ws-common";
import SyncConnection, { createSyncConnection } from "./SyncConnection.js";
import DBCache from "./DBCache.js";
import { WebSocket } from "ws";
import Transport from "./Trasnport.js";
import { logger } from "@vlcn.io-community/logger-provider";

export type Options = {
  ws: WebSocket;
  dbCache: DBCache;
  room: string;
};

/**
 * A connection broker maps PartyKit connections to Database Sync connections
 * and dispatches messages from the PartyKitConnection to the appropriate
 * SyncConnection methods.
 */
export default class ConnectionBroker {
  #syncConnection: SyncConnection | null = null;
  readonly #dbCache;
  readonly #ws;
  readonly #room;

  constructor({ ws, dbCache, room }: Options) {
    this.#dbCache = dbCache;
    this.#ws = ws;
    this.#room = room;

    this.#ws.on("message", async (data) => {
      // TODO: for litefs support we should just read the tag out
      // then pass the message to the primary
      const msg = decode(new Uint8Array(data as any));
      try {
        await this.#handleMessage(msg);
      } catch (e) {
        console.error(e);
        this.close();
      }
    });
    this.#ws.on("close", () => {
      this.close();
    });
    this.#ws.on("error", () => {
      this.close();
    });
    // TODO: impl ping & pong heartbeat
    // so we can force close if we don't get a close event.
    // this.#ws.on("pong", () => {});
    // this.#ws.on("ping", () => {});
  }

  async #handleMessage(msg: Msg) {
    const tag = msg._tag;
    switch (tag) {
      // Note: room could go in the `AnnouncePresence` message instead of the random headers.
      case tags.AnnouncePresence: {
        logger.info(`AnnouncePresence for: ${this.#room}`);
        if (this.#syncConnection != null) {
          throw new Error(
            `A sync connection for ${
              this.#room
            } was already started for the given websocket`
          );
        }

        const syncConnection = await createSyncConnection(
          this.#dbCache,
          new Transport(this.#ws),
          this.#room,
          msg
        );
        this.#syncConnection = syncConnection;
        syncConnection.start();
        return;
      }
      case tags.Changes: {
        // get our synced db from the cache
        // apply the changes
        // if no inbound stream is started, this'll start one.
        const syncConn = this.#syncConnection!;
        await syncConn.receiveChanges(msg);
        return;
      }
      case tags.RejectChanges: {
        // get our synced db, tell it changes were rejected
        const syncConn = this.#syncConnection!;
        syncConn.changesRejected(msg);
        return;
      }
      case tags.StartStreaming: {
        throw new Error(
          `Illegal state -- servers do not process the "StartTreaming" message`
        );
        // the server does not process this message. It sends this message
        // to a client after a client has announced its presence.
        return;
      }
    }
  }

  close() {
    this.#syncConnection?.close();
  }
}
