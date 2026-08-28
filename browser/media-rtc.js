// Live audio/video over the kernel's WebRTC seam.
//
// `RtcNetwork` (seedkernel `host/net-rtc.ts`, §12.7) is raw I/O only: peer
// connections, signaling, and one data channel per peer handed to the transport
// host through its ChannelFactory sink. Media is not the runtime's business, so it
// lives here — a subclass that re-attaches the call feature to the very same
// `RTCPeerConnection`s the data channel already uses. addTrack triggers
// `negotiationneeded`, and the offer it produces flows through the kernel's
// perfect-negotiation path like any other, so a call needs no signaling of its own.
//
// The seams it needs are the ones the kernel publishes: the `peers` map (each entry's
// `pc`), `ensurePeer`, overridden to wire our per-connection listeners at the moment a
// peer entry is created, and `forget`, overridden because every teardown path — the
// kernel's own included — goes through it.
import { RtcNetwork } from "seedkernel-wasm/net-rtc";

export class MediaRtcNetwork extends RtcNetwork {
  // Local tracks to publish to every peer (now and as new ones connect). Empty
  // unless the app started a call via addLocalTrack().
  #localTracks = [];
  // peerId -> the senders we created on that peer's pc, so a hang-up can remove
  // exactly what we added. Kept here rather than on the kernel's PeerEntry.
  #callSenders = new Map();
  #onPeerConnectionClosed;

  /** Same options as RtcNetwork, plus media-only observations:
   *  `onTrack(peerId, track)` — a remote peer is sending us media;
   *  `onPeerConnectionClosed(peerId)` — that peer's physical media connection ended.
   *  Neither callback reports transport authentication; that state belongs to the
   *  transport guest and is asked of it directly (chat-shell.js `linkedPeers`). */
  constructor(opts) {
    super(opts);
    this.onRemoteTrack = opts.onTrack;
    this.#onPeerConnectionClosed = opts.onPeerConnectionClosed;
  }

  ensurePeer(peerId) {
    const known = this.peers.has(peerId);
    const e = super.ensurePeer(peerId);
    if (known) return e;   // listeners already wired for this connection
    // A remote track means the peer is sending us media; hand it to the app.
    e.pc.addEventListener("track", (ev) => this.onRemoteTrack?.(peerId, ev.track));
    e.pc.addEventListener("connectionstatechange", () => {
      // Publish any in-progress call tracks to a peer that just finished its
      // handshake. Doing it here (not at ensurePeer time) keeps clear of the
      // perfect-negotiation window — the renegotiation offer rides cleanly.
      //
      // The terminal states are deliberately NOT handled here: the base class turns
      // them into forget(), which is where the teardown is reported from — see below.
      if (e.pc.connectionState === "connected") this.#addLocalTracksTo(peerId, e);
    });
    return e;
  }

  /** Every teardown path funnels through here — the base class calls it for a failed
   *  connection, for a data channel that closed or errored, and resetPeers() calls it
   *  directly — which makes it the only honest place to report one. A listener cannot
   *  do the job: pc.close() sets connectionState to "closed" WITHOUT firing
   *  connectionstatechange, so everything but a spontaneous "failed" would go unseen
   *  and the peer's tile would sit on screen for the tab's life. Idempotent, keyed on
   *  the entry still being present, so the base class's own failed → forget and a
   *  channel-close → forget racing it report exactly once between them. */
  forget(peerId) {
    const had = this.peers.has(peerId);
    super.forget(peerId);
    if (!had) return;
    this.#callSenders.delete(peerId);
    this.#onPeerConnectionClosed?.(peerId);
  }

  /** Publish a local track to every connected peer, and to any peer that connects
   *  later (the track set is remembered until removeLocalTracks()). Idempotent per
   *  (peer, track), so adding audio then video is two safe calls. */
  addLocalTrack(track, stream) {
    this.#localTracks.push({ track, stream });
    for (const [peerId, e] of this.peers) this.#addLocalTracksTo(peerId, e);
  }

  /** Stop publishing media (hang up): remove every track we added and forget the
   *  set, so future peers get no media. Renegotiation happens automatically. */
  removeLocalTracks() {
    this.#localTracks.length = 0;
    for (const [peerId, e] of this.peers) {
      const senders = this.#callSenders.get(peerId);
      if (!senders) continue;
      for (const sender of senders) {
        try { e.pc.removeTrack(sender); } catch { /* already gone */ }
      }
      this.#callSenders.delete(peerId);
    }
  }

  /** Close the room's physical peer connections while retaining this ChannelFactory,
   *  its signaling adapter, and any local call tracks for peers in the next room. The
   *  TransportHost severs its own links separately; this method owns only WebRTC state. */
  resetPeers() {
    for (const peerId of [...this.peers.keys()]) this.forget(peerId);
  }

  /** Kick an ICE restart on every peer. Call on a network-change event (the browser
   *  going online, an interface flip) so recovery starts at once instead of waiting
   *  out ICE keepalive timeouts. Each restart's offer rides the signaling channel —
   *  so the relay must still be reachable for this to complete. */
  restartAllIce() {
    for (const e of this.peers.values()) {
      try { e.pc.restartIce(); } catch { /* ignore */ }
    }
  }

  // Add any not-yet-published local tracks to one connected peer. Skips peers that
  // are not yet "connected" (a track added mid-handshake fights perfect negotiation);
  // the connectionstatechange handler above calls back when they reach "connected".
  #addLocalTracksTo(peerId, e) {
    if (this.#localTracks.length === 0 || e.pc.connectionState !== "connected") return;
    let senders = this.#callSenders.get(peerId);
    if (!senders) this.#callSenders.set(peerId, senders = []);
    for (const { track, stream } of this.#localTracks) {
      if (senders.some((s) => s.track === track)) continue;   // already on this pc
      try { senders.push(e.pc.addTrack(track, stream)); } catch { /* ignore */ }
    }
  }
}
