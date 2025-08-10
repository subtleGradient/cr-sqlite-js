import net from "net";
import {
  CreateDbOnPrimaryResponse,
  ApplyChangesOnPrimaryResponse,
  decode,
  encode,
  tags,
  CreateDbOnPrimary,
  ApplyChangesOnPrimary,
  Err,
} from "@vlcn.io-community/ws-common";
import logger from "../logger.js";

export class PrimarySocket {
  readonly #currentPrimaryInstanceId;
  #socket;
  readonly #pingPongHandle;
  readonly #onPrematurelyClosed;
  #lastPong;
  // since we multiplex requests over a single socket, we need to keep track of
  // which request is which.
  readonly #createDbRequests = new Map<
    number,
    (msg: CreateDbOnPrimaryResponse | Err) => void
  >();
  readonly #applyChangesRequests = new Map<
    number,
    (msg: ApplyChangesOnPrimaryResponse | Err) => void
  >();
  #closed = false;
  readonly #port;
  readonly #appName;

  constructor(
    port: number,
    appName: string | null,
    currentPrimaryInstanceId: string,
    onPrematurelyClosed: () => void
  ) {
    this.#appName = appName;
    this.#currentPrimaryInstanceId = currentPrimaryInstanceId;
    this.#port = port;
    this.#socket = this.#connect();
    this.#pingPongHandle = setInterval(this.#sendPing, 1000);
    this.#lastPong = Date.now();
    this.#onPrematurelyClosed = onPrematurelyClosed;
  }

  sendCreateDb(msg: CreateDbOnPrimary): Promise<CreateDbOnPrimaryResponse> {
    logger.info("Sending create db message over primary socket");
    return new Promise((resolve, reject) => {
      this.#createDbRequests.set(
        msg._reqid,
        (msg: CreateDbOnPrimaryResponse | Err) => {
          this.#createDbRequests.delete(msg._reqid);
          if (msg._tag == tags.Err) {
            reject(msg);
          } else {
            resolve(msg);
          }
        }
      );
      logger.info("writing to socket");
      this.#socket.write(encode(msg), (e) => {
        if (e) {
          this.#createDbRequests.delete(msg._reqid);
          reject(e);
        }
      });
      logger.info("wrote to socket");
    });
  }

  sendApplyChanges(
    msg: ApplyChangesOnPrimary
  ): Promise<ApplyChangesOnPrimaryResponse> {
    return new Promise((resolve, reject) => {
      this.#applyChangesRequests.set(
        msg._reqid,
        (msg: ApplyChangesOnPrimaryResponse | Err) => {
          this.#applyChangesRequests.delete(msg._reqid);
          if (msg._tag == tags.Err) {
            reject(msg);
          } else {
            resolve(msg);
          }
        }
      );
      this.#socket.write(encode(msg), (e) => {
        if (e) {
          this.#applyChangesRequests.delete(msg._reqid);
          reject(e);
        }
      });
    });
  }

  #connect() {
    const socket = new net.Socket();

    socket.connect(
      this.#port,
      this.#appName == null
        ? this.#currentPrimaryInstanceId
        : `${this.#currentPrimaryInstanceId}.vm.${this.#appName}.internal`
    );
    socket.on("data", this.#handleMessage);
    socket.on("error", this.#onError);
    socket.on("close", this.#onClose);
    this.#lastPong = Date.now();
    return socket;
  }

  #handleMessage = (data: Buffer) => {
    const msg = decode(data);
    switch (msg._tag) {
      case tags.Pong:
        this.#lastPong = Date.now();
        return;
      case tags.CreateDbOnPrimaryResponse:
        const createDbRequest = this.#createDbRequests.get(msg._reqid);
        if (createDbRequest == null) {
          throw new Error(
            `Received a response for a request that doesn't exist: ${msg._reqid}`
          );
        }
        createDbRequest(msg);
        return;
      case tags.Err:
        const createRequest = this.#createDbRequests.get(msg._reqid);
        if (createRequest != null) {
          createRequest(msg);
          return;
        }
        const applyRequest = this.#applyChangesRequests.get(msg._reqid);
        if (applyRequest != null) {
          applyRequest(msg);
          return;
        }
        throw new Error(
          `Received an error response for a request that doesn't exist: ${msg._reqid}`
        );
      case tags.ApplyChangesOnPrimaryResponse:
        const applyChangesRequest = this.#applyChangesRequests.get(msg._reqid);
        if (applyChangesRequest == null) {
          throw new Error(
            `Received a response for a request that doesn't exist: ${msg._reqid}`
          );
        }
        applyChangesRequest(msg);
        return;
      default:
        throw new Error(`Unexpected message type: ${msg._tag}`);
    }
  };

  #onError = (e: Error) => {
    logger.error(e);
    if (!this.#closed) {
      this.#rejectPending();
      this.#onPrematurelyClosed();
    }
  };
  #onClose = () => {
    if (!this.#closed) {
      this.#rejectPending();
      this.#onPrematurelyClosed();
    }
  };

  #sendPing = () => {
    if (Date.now() - this.#lastPong > 5000) {
      this.#socket.destroy();
      clearInterval(this.#pingPongHandle);
      return;
    }
    this.#socket.write(
      encode({
        _tag: tags.Ping,
      }),
      (e) => {
        if (e) {
          console.error(e);
        }
      }
    );
  };

  #rejectPending() {
    for (const [_, reject] of this.#createDbRequests) {
      reject({
        _tag: tags.Err,
        _reqid: -1,
        err: "Primary connection closed",
      });
    }
    this.#createDbRequests.clear();

    for (const [_, reject] of this.#applyChangesRequests) {
      reject({
        _tag: tags.Err,
        _reqid: -1,
        err: "Primary connection closed",
      });
    }
    this.#applyChangesRequests.clear();
  }

  get currentPrimaryInstanceId() {
    return this.#currentPrimaryInstanceId;
  }

  close() {
    this.#closed = true;
    this.#socket.destroy();
    clearInterval(this.#pingPongHandle);
    this.#rejectPending();
  }
}
