// The chat module's one transform, shared by every version of the chat app.
//
// A pure-transform handler (seedkernel PROTOCOL §4): the host stages the input at
// `scratch`, calls `handle`, and reads the render bytes back from `scratch`. No host
// import, no signer query, no UI bridge — the sender identity is prepended by the host
// (the AKE channel already authenticated it), and the render bytes are the return value
// the app's guest answers with, which the shell hands to the app's view.
//
// Input:   [pk 32][type u8][body ..]     a chat frame, with its sender in front
// Render:  [type u8][pk_len u8][pk ..][body ..]
//
// The body passes through untouched: which room a message is in, or who a direct one is
// for, is the view's to read, like the body of any other frame. Which frame types a
// version draws, and how much memory it stages them in, is that version's index.ts.

// The layout literals — the host prepends the 32-byte sender pk, and the app
// may start its bookkeeping at offset 0 of private memory (the module reserves
// nothing, so 0 is both the value and the intent).
export const PK_LEN: i32 = 32;
const PRIV_USER_OFF: i32 = 0;

// Reserved bytes immediately before the staged input body, sized to hold the
// render header [type u8][pk_len u8][pk PK_LEN] = 34 bytes. Rounded up to 64.
const RENDER_HEADER_MAX: i32 = 64;
const STAGING_OFF: i32 = PRIV_USER_OFF;

/** The type of the frame staged at `scratch`, or -1 for an input too short to hold one. */
export function frameType(scratch: i32, inputLen: i32): i32 {
  return inputLen < PK_LEN + 1 ? -1 : load<u8>(scratch + PK_LEN) as i32;
}

/** Rebuild `scratch` as the render of the frame staged in it, through `priv`, `privSize`
 *  bytes of the module's private memory. Answers the render's length, or 0 for a frame too
 *  large to stage. */
export function render(scratch: i32, priv: i32, privSize: i32, inputLen: i32): i32 {
  const type = load<u8>(scratch + PK_LEN);
  const bodyLen = inputLen - PK_LEN - 1;

  // Stage the input into priv so we can rebuild scratch as the render output. The pk is
  // copied out past the body (clear of the render-header region, which is written just
  // before the body).
  const stagedInput = priv + STAGING_OFF + RENDER_HEADER_MAX;
  const tailRoom = privSize - STAGING_OFF - RENDER_HEADER_MAX;
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
