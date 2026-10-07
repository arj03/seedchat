// Live audio/video, on peer connections the page owns.
//
// seedkernel's WebRTC seam holds the TRANSPORT's peer connections and passes their
// negotiation through as bytes (seedkernel §12.7); media is not the runtime's business, so
// a call opens its own `RTCPeerConnection` per peer, beside the transport's. Its signaling
// rides the node's authenticated channel — the shell app's `call/v1` protocol
// (shell-app.js) — so a call needs no relay once the peers are linked, and nobody on the
// relay can inject into one.
//
// A call is entered, not received. A node in a call says so to that call's peers (`{ call
// }`), and that word is all a peer gets of it: a connection is opened, and a description
// answered, only between two nodes that have each said they are in the same call. So
// nothing of a caller's reaches a peer that has not accepted, and nothing of that peer's
// leaves it.
//
// Negotiation is the W3C "perfect negotiation" pattern: either side may offer (adding a
// track does), and on a collision the polite side — the larger key, by the same rule the
// transport uses for who offers — rolls its own offer back.

/** One signal: `{ call }` (in a call, and which), `{ sdp }` (a description), `{ candidate }`,
 *  or `{ bye: true }` (hang-up). */
const encode = (msg) => new TextEncoder().encode(JSON.stringify(msg));

export class MediaCalls {
  /** peerId → { pc, polite, makingOffer, ignoreOffer, carrying }, `carrying` the
   *  transceiver each of our tracks is sent on */
  #peers = new Map();
  /** Local tracks to publish, [{ track, stream }]; empty while nothing of ours is on. */
  #tracks = [];
  /** The call we are in, by the name both ends of it say, and who of a set of peers it is
   *  with (`start`); null out of a call. */
  #call = null;
  #among = null;
  /** The peers told we are in it. */
  #rung = new Set();
  /** peerId → { call }: every peer that says it is in a call, and which. */
  #callers = new Map();

  /**
   * @param {{
   *   myId: string,
   *   rtcConfig?: RTCConfiguration,
   *   send: (peerId: string, signal: Uint8Array) => Promise<unknown>,
   *   onTrack?: (peerId: string, track: MediaStreamTrack) => void,
   *   onPeerClosed?: (peerId: string) => void,
   *   onCallers?: () => void,
   * }} opts
   */
  constructor(opts) { this.opts = opts; }

  /** peerId → the call it says it is in, for every peer in one. */
  get callers() { return new Map([...this.#callers].map(([p, c]) => [p, c.call])); }

  /** How many peers are in the call with us. */
  get size() { return this.#peers.size; }

  /** Be in the call named `call`: with those `among` picks out of a list of peers, of the
   *  `linked` now and of any that links later (`sync`). Each is told, and the ones in it
   *  too are connected. */
  start(call, among, linked) {
    this.#call = call;
    this.#among = among;
    this.sync(linked);
  }

  /** Publish a track, beside any already published: to every peer in the call, and to any
   *  that enters it later. */
  publish(track, stream) {
    this.#tracks.push({ track, stream });
    for (const p of this.#peers.keys()) this.#ensure(p);
  }

  /** Stop publishing one track, the rest going on. Its transceiver stays, sending nothing,
   *  which mutes the track at the far end. */
  unpublish(track) {
    this.#tracks = this.#tracks.filter((t) => t.track !== track);
    for (const e of this.#peers.values()) {
      const t = e.carrying.get(track);
      if (!t) continue;
      e.carrying.delete(track);
      try {
        void t.sender.replaceTrack(null).catch(() => {});
        t.direction = "recvonly";
      } catch { /* closed meanwhile */ }
    }
  }

  /** Follow the linked peers. A caller that is gone calls no more; and in a call, a peer of
   *  it that links is told of it, one in it too is connected, and one out of it dropped. */
  sync(linked) {
    let changed = false;
    for (const p of [...this.#callers.keys()]) {
      // The page is told of a link before anything arrives over it, so a caller is linked.
      if (!linked.includes(p)) { this.#callers.delete(p); changed = true; }
    }
    if (this.#call !== null) {
      const peers = new Set(this.#among(linked));
      // A peer that dropped and came back has forgotten what it was told, and is told again.
      for (const p of [...this.#rung]) if (!peers.has(p)) this.#rung.delete(p);
      for (const p of peers) {
        if (!this.#rung.has(p)) {
          this.#rung.add(p);
          void this.opts.send(p, encode({ call: this.#call })).catch(() => this.#rung.delete(p));
        }
        if (this.#with(p)) this.#ensure(p);
      }
      for (const p of [...this.#peers.keys()]) if (!this.#with(p)) this.#close(p);
    }
    if (changed) this.opts.onCallers?.();
  }

  /** Hang up: tell every peer told of the call, close every media connection, publish
   *  nothing. */
  end() {
    this.#call = this.#among = null;
    this.#tracks = [];
    for (const p of this.#rung) void this.opts.send(p, encode({ bye: true })).catch(() => {});
    this.#rung.clear();
    for (const p of [...this.#peers.keys()]) this.#close(p);
  }

  /** Kick an ICE restart on every call, after a network change. */
  restartAllIce() {
    for (const e of this.#peers.values()) {
      try { e.pc.restartIce(); } catch { /* nothing to restart */ }
    }
  }

  /** A peer's signal, already attributed by the channel it arrived on. */
  async onSignal(peerId, bytes) {
    let msg;
    try { msg = JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
    if (msg?.bye) {
      this.#close(peerId);
      if (this.#callers.delete(peerId)) this.opts.onCallers?.();
      return;
    }
    if (typeof msg?.call === "string") {
      this.#callers.set(peerId, { call: msg.call });
      if (this.#with(peerId)) this.#ensure(peerId);
      this.opts.onCallers?.();
      return;
    }
    // A description or a candidate is heard only from a peer in the call with us. One whose
    // call we have not entered has no connection here to offer to.
    if (!this.#with(peerId)) return;
    const e = this.#ensure(peerId);
    try {
      if (msg?.sdp) {
        const collision = msg.sdp.type === "offer" && (e.makingOffer || e.pc.signalingState !== "stable");
        e.ignoreOffer = !e.polite && collision;
        if (e.ignoreOffer) return;
        await e.pc.setRemoteDescription(msg.sdp);
        if (msg.sdp.type === "offer") {
          await e.pc.setLocalDescription();
          void this.opts.send(peerId, encode({ sdp: e.pc.localDescription })).catch(() => {});
        }
      } else if (msg?.candidate) {
        try { await e.pc.addIceCandidate(msg.candidate); }
        catch (err) { if (!e.ignoreOffer) throw err; }
      }
    } catch { /* a stale signal after a rollback, or a peer that went away */ }
  }

  /** Whether a peer is in the call with us: we are in one, it is a peer of that call, and
   *  it has said it is in the same. */
  #with(peerId) {
    return this.#call !== null && this.#callers.get(peerId)?.call === this.#call &&
      this.#among([peerId]).length > 0;
  }

  #ensure(peerId) {
    let e = this.#peers.get(peerId);
    if (!e) {
      const pc = new RTCPeerConnection(this.opts.rtcConfig);
      e = { pc, polite: this.opts.myId > peerId, makingOffer: false, ignoreOffer: false, carrying: new Map() };
      this.#peers.set(peerId, e);
      const entry = e;
      pc.addEventListener("icecandidate", (ev) => {
        if (ev.candidate) void this.opts.send(peerId, encode({ candidate: ev.candidate.toJSON() })).catch(() => {});
      });
      pc.addEventListener("negotiationneeded", async () => {
        try {
          entry.makingOffer = true;
          await pc.setLocalDescription();
          void this.opts.send(peerId, encode({ sdp: pc.localDescription })).catch(() => {});
        } catch { /* the next negotiationneeded retries */ }
        finally { entry.makingOffer = false; }
      });
      pc.addEventListener("track", (ev) => this.opts.onTrack?.(peerId, ev.track));
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed") this.#close(peerId);
      });
    }
    // Publish what we carry on a connection that does not carry it yet.
    for (const { track, stream } of this.#tracks) {
      if (!e.carrying.has(track)) {
        try { e.carrying.set(track, this.#carry(e, track, stream)); } catch { /* closed meanwhile */ }
      }
    }
    return e;
  }

  /** Send a track on a connection, answering the transceiver it goes on. One that only
   *  receives takes it: the peer's own, or one a track of ours was taken off (`unpublish`).
   *  `addTrack` would pass over the latter and add a media section each time a camera is
   *  turned back on. */
  #carry(e, track, stream) {
    const taken = new Set(e.carrying.values());
    const idle = e.pc.getTransceivers().find((t) =>
      !taken.has(t) && t.receiver.track.kind === track.kind && t.direction === "recvonly");
    if (!idle) return e.pc.addTransceiver(track, { streams: [stream] });
    void idle.sender.replaceTrack(track).catch(() => {});
    idle.sender.setStreams(stream);
    idle.direction = "sendrecv";
    return idle;
  }

  #close(peerId) {
    const e = this.#peers.get(peerId);
    if (!e) return;
    this.#peers.delete(peerId);
    try { e.pc.close(); } catch { /* already closed */ }
    this.opts.onPeerClosed?.(peerId);
  }
}
