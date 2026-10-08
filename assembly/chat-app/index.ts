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

// The layout literal: the host prepends the 32-byte sender pk.
const PK_LEN: i32 = 32;

const SCRATCH_SIZE: i32 = 0x40000; // 256 KB — input (pk‖type‖body) + render output

export let scratch: i32 = 0;
// Declare the larger I/O region to the host (seedkernel PROTOCOL §4.1) so a big
// image plus its render header is not capped at the 128 KB default.
export const scratchSize: i32 = SCRATCH_SIZE;
scratch = heap.alloc(SCRATCH_SIZE) as i32;

/** The type of the frame staged at `scratch`, or -1 for an input too short to hold one. */
function frameType(inputLen: i32): i32 {
  return inputLen < PK_LEN + 1 ? -1 : load<u8>(scratch + PK_LEN) as i32;
}

/** Rebuild `scratch` as the render of the frame staged in it, in place: a render is its
 *  frame with the type moved to the front and the pk's length put behind it, so it is one
 *  byte longer. Answers the render's length, or 0 for a frame with no room for that byte. */
function render(inputLen: i32): i32 {
  if (inputLen + 1 > SCRATCH_SIZE) return 0;
  const type = load<u8>(scratch + PK_LEN);
  // The body moves up one byte, then the pk two, onto where the type was. `memory.copy`
  // copies as if through a buffer, so neither is disturbed by overlapping where it lands.
  memory.copy(scratch + 2 + PK_LEN, scratch + PK_LEN + 1, inputLen - PK_LEN - 1);
  memory.copy(scratch + 2, scratch, PK_LEN);
  store<u8>(scratch, type);
  store<u8>(scratch + 1, PK_LEN);
  return inputLen + 1;
}

export function handle(input_len: i32): i32 {
  const type = frameType(input_len);
  if (type < 3 || type > 6) return 0;
  return render(input_len);
}
