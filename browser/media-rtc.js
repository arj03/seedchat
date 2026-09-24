// Live audio/video, on peer connections the page owns.
//
// seedkernel's WebRTC seam holds the TRANSPORT's peer connections and passes their
// negotiation through as bytes (seedkernel §12.7); media is not the runtime's business, so
// a call opens its own `RTCPeerConnection` per peer, beside the transport's. Its signaling
// rides the node's authenticated channel — the calls app's `call/v1` protocol
// (calls-app.js) — so a call needs no relay once the peers are linked, and nobody on the
// relay can inject into one.
//
// Negotiation is the W3C "perfect negotiation" pattern: either side may offer (adding a
// track does), and on a collision the polite side — the larger key, by the same rule the
// transport uses for who offers — rolls its own offer back.

/** One signal: `{ sdp }` (a description), `{ candidate }`, or `{ bye: true }` (hang-up). */
const encode = (msg) => new TextEncoder().encode(JSON.stringify(msg));

export class MediaCalls {
  /** peerId → { pc, polite, makingOffer, ignoreOffer } */
  #peers = new Map();
  /** Local tracks to publish, [{ track, stream }]; empty when not in a call. */
  #tracks = [];

  /**
   * @param {{
   *   myId: string,
   *   rtcConfig?: RTCConfiguration,
   *   send: (peerId: string, signal: Uint8Array) => Promise<unknown>,
   *   onTrack?: (peerId: string, track: MediaStreamTrack) => void,
   *   onPeerClosed?: (peerId: string) => void,
   * }} opts
   */
  constructor(opts) { this.opts = opts; }

  get active() { return this.#tracks.length > 0; }

  /** Start publishing these tracks to every peer in `peers`, and to any peer that links
   *  later (`sync`). */
  start(tracks, peers) {
    this.#tracks = tracks;
    this.sync(peers);
  }

  /** Follow the linked set while in a call: call a newly linked peer, drop one gone. */
  sync(peers) {
    if (!this.active) return;
    const linked = new Set(peers);
    for (const p of peers) this.#ensure(p);
    for (const p of [...this.#peers.keys()]) if (!linked.has(p)) this.#close(p);
  }

  /** Hang up: tell every peer, close every media connection, publish nothing. */
  end() {
    this.#tracks = [];
    for (const p of [...this.#peers.keys()]) {
      void this.opts.send(p, encode({ bye: true })).catch(() => {});
      this.#close(p);
    }
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
    if (msg?.bye) { this.#close(peerId); return; }
    // A peer that calls us gets a connection even while we are not in a call, so its
    // tracks show; ours join only when we start one.
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

  #ensure(peerId) {
    let e = this.#peers.get(peerId);
    if (!e) {
      const pc = new RTCPeerConnection(this.opts.rtcConfig);
      e = { pc, polite: this.opts.myId > peerId, makingOffer: false, ignoreOffer: false };
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
    // Publish what this call carries on a connection that does not carry it yet.
    const sending = new Set(e.pc.getSenders().map((s) => s.track));
    for (const { track, stream } of this.#tracks) {
      if (!sending.has(track)) {
        try { e.pc.addTrack(track, stream); } catch { /* closed meanwhile */ }
      }
    }
    return e;
  }

  #close(peerId) {
    const e = this.#peers.get(peerId);
    if (!e) return;
    this.#peers.delete(peerId);
    try { e.pc.close(); } catch { /* already closed */ }
    this.opts.onPeerClosed?.(peerId);
  }
}
