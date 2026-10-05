// Chat's module — rooms and direct chats, text and images (jpeg).
//
// A pure-transform handler (seedkernel PROTOCOL §4): the host stages the input at
// `scratch`, calls `handle`, and reads the render bytes back from `scratch`. No host
// import, no signer query, no UI bridge — the sender identity is prepended by the host
// (the AKE channel already authenticated it), and the render bytes are the return value
// the app's guest answers with, which the shell hands to the app's view.
//
// Input:   [pk 32][type u8][body ..]     a chat frame, with its sender in front
//   type 3  direct text    body = [to 32][utf-8 text]
//   type 4  direct image   body = [to 32][jpeg bytes]
//   type 5  room text      body = [room 32][utf-8 text]
//   type 6  room image     body = [room 32][jpeg bytes]
//
// Render:  [type u8][pk_len u8][pk ..][body ..]
//
// The body passes through untouched: which room a message is in, or who a direct one is
// for, is the view's to read, like the body of any other frame. What a sender is called is
// not in a frame or a render: a nick is the shell's, and the view reads it out of the
// node's context.

// The layout literals — the host prepends the 32-byte sender pk, and the app
// may start its bookkeeping at offset 0 of private memory (the module reserves
// nothing, so 0 is both the value and the intent).
const PK_LEN: i32 = 32;
const PRIV_USER_OFF: i32 = 0;

// Reserved bytes immediately before the staged input body, sized to hold the
// render header [type u8][pk_len u8][pk PK_LEN] = 34 bytes. Rounded up to 64.
const RENDER_HEADER_MAX: i32 = 64;
const STAGING_OFF: i32 = PRIV_USER_OFF;

const SCRATCH_SIZE: i32 = 0x40000; // 256 KB — input (pk‖type‖body) + render output
const PRIVATE_SIZE: i32 = 0x40000; // 256 KB

export let scratch: i32 = 0;
// Declare the larger I/O region to the host (seedkernel PROTOCOL §4.1) so a big
// image plus its render header is not capped at the 128 KB default.
export const scratchSize: i32 = SCRATCH_SIZE;
let priv: i32 = 0;
scratch = heap.alloc(SCRATCH_SIZE) as i32;
priv = heap.alloc(PRIVATE_SIZE) as i32;

/** The type of the frame staged at `scratch`, or -1 for an input too short to hold one. */
function frameType(inputLen: i32): i32 {
  return inputLen < PK_LEN + 1 ? -1 : load<u8>(scratch + PK_LEN) as i32;
}

/** Rebuild `scratch` as the render of the frame staged in it, through `priv`. Answers the
 *  render's length, or 0 for a frame too large to stage. */
function render(inputLen: i32): i32 {
  const type = load<u8>(scratch + PK_LEN);
  const bodyLen = inputLen - PK_LEN - 1;

  // Stage the input into priv so we can rebuild scratch as the render output. The pk is
  // copied out past the body (clear of the render-header region, which is written just
  // before the body).
  const stagedInput = priv + STAGING_OFF + RENDER_HEADER_MAX;
  const tailRoom = PRIVATE_SIZE - STAGING_OFF - RENDER_HEADER_MAX;
  if (inputLen + 16 + PK_LEN > tailRoom) return 0;
  memory.copy(stagedInput, scratch, inputLen);
  const stagedBody = stagedInput + PK_LEN + 1;
  const stagedPk = stagedInput + inputLen + 16;
  memory.copy(stagedPk, stagedInput, PK_LEN);

  // [type u8][pk_len u8][pk PK_LEN] — written into the reserved bytes immediately before
  // stagedBody so the body is not copied twice.
  const headerLen = 1 + 1 + PK_LEN;
  const renderBuf = stagedBody - headerLen;
  let o = renderBuf;
  store<u8>(o, type); o++;
  store<u8>(o, PK_LEN); o++;
  memory.copy(o, stagedPk, PK_LEN); o += PK_LEN;

  // Emit the render bytes as the handler response (scratch[0..len]).
  const renderLen = headerLen + bodyLen;
  memory.copy(scratch, renderBuf, renderLen);
  return renderLen;
}

export function handle(input_len: i32): i32 {
  const type = frameType(input_len);
  if (type < 3 || type > 6) return 0;
  return render(input_len);
}
